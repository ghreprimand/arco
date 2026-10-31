import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { isClusterOpen } from '../workspace.js';
import { IncomingMessage, ServerResponse } from 'http';
import * as clusterMailbox from '../clusterMailbox.js';
import * as clusterPeerOps from '../clusterPeerOps.js';
import * as clusterStore from '../clusterStore.js';
import { getSandboxDbPath, getSandboxStore } from '../providers/claude-native/sandboxStore.js';
import {
  broadcastCluster,
  broadcastWorkflow,
  notifyClusterStateForWorkflow,
} from '../server/broadcast.js';
import { PORT } from '../server/constants.js';
import {
  workflowCwds,
  workflows,
} from '../server/state.js';
import { updateMeta } from '../workflowMeta.js';
import { formatBoardForModel } from '../project/taskLedger.js';
import type { HttpDeps } from './router.js';
import type { LedgerTaskStatus, TaskLink } from '@arco/shared';

// Cluster / sandbox / codebase-memory route group — peeled verbatim from
// router.ts (see docs/ARCHITECTURE.md). Returns true when a route
// in this group matched (request answered), false otherwise so the caller
// falls through to the next route group.
export async function tryHandleClusterRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpDeps,
): Promise<boolean> {
  // Durable live-cluster catalog. Cluster tabs are a browser-side working set,
  // while ~/.arco/clusters is authoritative; this read-only surface lets an
  // operator reopen an intact cluster whose localStorage tab was lost without
  // forking from an older snapshot.
  if (req.url === '/api/clusters' && req.method === 'GET') {
    try {
      // `open`: in the server-authoritative workspace (some browser has the
      // tab). `cwdExists`: false for clusters whose project folder is gone —
      // mostly /tmp/arco-smoke-* leftovers — so the creator can flag them
      // and offer a bulk clean-up instead of listing them as reopenable.
      const clusters = await Promise.all((await clusterStore.loadAllClustersFromDisk())
        .map(async (cluster) => ({
          clusterId: cluster.clusterId,
          name: cluster.name,
          cwd: cluster.cwd,
          memberCount: cluster.members.length,
          createdAt: cluster.createdAt,
          open: isClusterOpen(cluster.clusterId),
          cwdExists: await fs.stat(cluster.cwd).then((st) => st.isDirectory(), () => false),
        })));
      clusters.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ clusters }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  // docs/PROTOCOL_CLUSTER.md - REST shim for cluster lifecycle. No
  // WS surface, no UI yet — operator wires Native tabs to a cluster via
  // curl, then drives turns through the existing chat composer per tab.
  // Phase 2 replaces this with proper WS messages.
  if (req.url === '/api/clusters' && req.method === 'POST') {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
        cwd?: string;
        memberWorkflowIds?: unknown;
      };
      const cwd = typeof body.cwd === 'string' ? body.cwd : '';
      const memberIds = Array.isArray(body.memberWorkflowIds)
        ? body.memberWorkflowIds.filter((m): m is string => typeof m === 'string')
        : [];
      if (!cwd || memberIds.length < 2) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'cwd and memberWorkflowIds (≥2) are required' }));
        return true;
      }
      // docs/PROTOCOL_CLUSTER.md - Native-transport fence. Phase 1
      // substrate ships peer tools only in the Native worker; CLI / Codex
      // parity lands in Phase 3+. Reject early so the operator gets a clear
      // error instead of a cluster that quietly never works for non-Native
      // members. Skipped when the workflow lookup misses entirely (CLI
      // operator may legitimately POST against workflows the server hasn't
      // hydrated yet — but at least one of them being unhydrated is also
      // suspect, so we still surface the code).
      const fence = await deps.assertAllMembersClaudeOrCodex(memberIds);
      if (fence) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: fence }));
        return true;
      }
      // Hard fence (plan §6.2): refuse if any candidate member is itself
      // a cluster. Phase 1 has no nested-cluster shape — every workflow
      // is "primary" — but defend the invariant for forward-compat.
      const cluster = await clusterStore.createCluster({ cwd, memberWorkflowIds: memberIds });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ clusterId: cluster.clusterId, members: cluster.members, cwd: cluster.cwd, createdAt: cluster.createdAt }));
    } catch (err) {
      const code = (err as { code?: string })?.code ?? 'create_failed';
      const status = code === 'invalid_cwd' || code === 'too_few_members' || code === 'member_already_in_cluster' ? 400 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: code, message: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  // docs/PROTOCOL_CLUSTER.md - peer-ops REST surface consumed by the
  // CLI MCP stdio child (`server/src/mcp/clusterMcpServer.ts`). One endpoint
  // per peer tool; each delegates to `clusterPeerOps` so Native + CLI
  // members fire identical WS events. Caller identity is the `workflowId`
  // in the body (send / read) or query (list) — trusted because the MCP
  // child has the workflowId baked into its argv at spawn time and the
  // loopback HTTP surface has no public attack vector. Any future remote-
  // access mode must add authentication here.
  //
  // URL shape: `/api/clusters/:id/peer/(list|send|read)`. Comes before the
  // bare `/api/clusters/:id` GET/DELETE handlers so the prefix match
  // doesn't swallow the `:id/peer/...` segments as a clusterId.
  if (req.url?.startsWith('/api/clusters/') && req.url.includes('/peer/')) {
    const path = req.url.split(/[?#]/)[0];
    const segments = path.split('/'); // ['', 'api', 'clusters', '<id>', 'peer', '<op>']
    if (segments.length === 6 && segments[1] === 'api' && segments[2] === 'clusters' && segments[4] === 'peer') {
      const clusterId = segments[3];
      const op = segments[5];
      const cluster = await clusterStore.readCluster(clusterId).catch(() => null);
      if (!cluster) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown_cluster' }));
        return true;
      }
      const taskOps = new Set([
        'task-list',
        'task-show',
        'task-create',
        'task-claim',
        'task-heartbeat',
        'task-comment',
        'task-link',
        'task-unlink',
        'task-block',
        'task-complete',
        'task-update',
      ]);
      if (taskOps.has(op) && !clusterStore.isTaskBoardEnabledForState(cluster)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'board_detached', message: 'no task board is enabled for this cluster.' }));
        return true;
      }
      const makeCtx = (workflowId: string): clusterPeerOps.PeerOpsContext => ({
        workflowId,
        clusterId,
        broadcastSender: (msg) => broadcastWorkflow(workflowId, msg),
        broadcastRecipient: (toWfId, msg) => broadcastWorkflow(toWfId, msg),
      });
      try {
        if (op === 'list' && req.method === 'GET') {
          const url = new URL(req.url, `http://localhost:${PORT}`);
          const workflowId = url.searchParams.get('workflowId') || '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const rows = await clusterPeerOps.peerList(makeCtx(workflowId));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(rows));
          return true;
        }
        if (op === 'send' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            from?: string; to?: string; content?: string;
          };
          const from = typeof body.from === 'string' ? body.from : '';
          const to = typeof body.to === 'string' ? body.to : '';
          const content = typeof body.content === 'string' ? body.content : '';
          if (!from || !cluster.members.includes(from)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'from must be a cluster member' }));
            return true;
          }
          if (!to || !content) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'to and content are required' }));
            return true;
          }
          const result = await clusterPeerOps.peerSend(makeCtx(from), { to, content });
          if (!result.ok) {
            // 400 for policy rejections — the MCP child translates these
            // into `isError: true` MCP results so the model sees a tool
            // error rather than a silent success.
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message, count: result.count, cap: result.cap }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ msgId: result.msgId, to: result.to, deliveredImmediately: result.deliveredImmediately, ...(result.guard ? { guard: result.guard } : {}) }));
          return true;
        }
        if (op === 'read' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const drained = await clusterPeerOps.peerRead(makeCtx(workflowId));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(drained));
          return true;
        }
        // Peer tool `cluster_plan_read` — return the full canonical plan
        // body. Body shape: `{ workflowId }`. Read-only: the injected
        // per-turn copy may be an outline for oversize plans (2026-07-09
        // truncation incident), so members need a pull channel to the
        // full body.
        if (op === 'plan-read' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const reqBody = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string;
          };
          const workflowId = typeof reqBody.workflowId === 'string' ? reqBody.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerPlanRead(makeCtx(workflowId));
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            title: result.title,
            body: result.body,
            updatedAt: result.updatedAt,
            byteLength: result.byteLength,
          }));
          return true;
        }
        // Peer tool `cluster_plan_tick` — toggle a single checkbox in the
        // shared cluster plan. Body shape: `{ workflowId, lineIndex }` or
        // `{ workflowId, taskText }`. Mirrors the Native peer-tool surface
        // exactly so the CLI Claude MCP child (which posts here) sees the
        // same error codes the Native dispatcher returns.
        if (op === 'plan-tick' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string; lineIndex?: number; taskText?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const matcher: clusterPeerOps.PeerPlanTickMatcher = (typeof body.lineIndex === 'number')
            ? { lineIndex: body.lineIndex }
            : (typeof body.taskText === 'string')
              ? { taskText: body.taskText }
              : ({} as clusterPeerOps.PeerPlanTickMatcher);
          const result = await clusterPeerOps.peerPlanTick(
            makeCtx(workflowId),
            matcher,
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message, matches: result.matches }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            toggledLine: result.toggledLine,
            before: result.before,
            after: result.after,
          }));
          return true;
        }
        // 2026-05-11 — `cluster_plan_write`. Model-driven writes are
        // additive by default; destructive replacement stays operator-only
        // through the PLAN tab.
        // Body shape: `{ workflowId, body }`. Same HTTP shape the MCP
        // child posts when proxying the model's tool call. Convention:
        // only the director calls this (enforced via role preset, not
        // server-side).
        if (op === 'plan-write' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string; body?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerPlanWrite(
            makeCtx(workflowId),
            typeof body.body === 'string' ? body.body : '',
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: result.code,
              message: result.message,
              limit: result.limit,
              actual: result.actual,
              removed: result.removed,
              statusChanged: result.statusChanged,
            }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ bodyLength: result.bodyLength, updatedAt: result.updatedAt }));
          return true;
        }
        // §D3 task-board peer-ops. `cluster_task_list` reads the cwd's ledger;
        // `cluster_task_claim` / `cluster_task_update` mutate it and broadcast a
        // fresh task_ledger_snapshot cluster-wide. Same HTTP shape the MCP child
        // posts; mutations carry the caller's workflowId so peerTaskClaim can
        // stamp assignee. done stays operator-gated (peerTaskUpdate rejects it).
        if (op === 'task-list' && req.method === 'GET') {
          const url = new URL(req.url, `http://localhost:${PORT}`);
          const workflowId = url.searchParams.get('workflowId') || '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerTaskList(makeCtx(workflowId));
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          // Compact, always-valid board view (drops done/archived, strips fat
          // notes, bounds size) — the raw dump blew the CLI/Codex worker's
          // tool-output cap. Native uses the same formatter. The operator UI
          // reads task_ledger_snapshot WS broadcasts, not this endpoint.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(formatBoardForModel(result.tasks));
          return true;
        }
        if (op === 'task-show' && req.method === 'GET') {
          const url = new URL(req.url, `http://localhost:${PORT}`);
          const workflowId = url.searchParams.get('workflowId') || '';
          const id = url.searchParams.get('id') || '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerTaskShow(makeCtx(workflowId), { id });
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.details));
          return true;
        }
        if (op === 'task-create' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string;
            title?: string;
            body?: string;
            notes?: string;
            assignee?: string;
            priority?: number;
            parentIds?: unknown;
            links?: unknown;
            reviewRequired?: boolean;
            goalMode?: boolean;
            goalMaxTurns?: number;
            status?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerTaskCreate(
            makeCtx(workflowId),
            {
              title: typeof body.title === 'string' ? body.title : '',
              ...(typeof body.body === 'string' ? { body: body.body } : {}),
              ...(typeof body.notes === 'string' ? { notes: body.notes } : {}),
              ...(typeof body.assignee === 'string' ? { assignee: body.assignee } : {}),
              ...(typeof body.priority === 'number' ? { priority: body.priority } : {}),
              ...(Array.isArray(body.parentIds) ? { parentIds: body.parentIds.filter((id): id is string => typeof id === 'string') } : {}),
              ...(Array.isArray(body.links) ? { links: body.links as TaskLink[] } : {}),
              ...(typeof body.reviewRequired === 'boolean' ? { reviewRequired: body.reviewRequired } : {}),
              ...(typeof body.goalMode === 'boolean' ? { goalMode: body.goalMode } : {}),
              ...(typeof body.goalMaxTurns === 'number' ? { goalMaxTurns: body.goalMaxTurns } : {}),
              ...(typeof body.status === 'string' ? { status: body.status as LedgerTaskStatus } : {}),
            },
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.task));
          return true;
        }
        if (op === 'task-claim' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string; id?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerTaskClaim(
            makeCtx(workflowId),
            { id: typeof body.id === 'string' ? body.id : '' },
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.task));
          return true;
        }
        if (op === 'task-heartbeat' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string; id?: string; note?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerTaskHeartbeat(
            makeCtx(workflowId),
            {
              id: typeof body.id === 'string' ? body.id : '',
              ...(typeof body.note === 'string' ? { note: body.note } : {}),
            },
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ run: result.run, ...(result.comment ? { comment: result.comment } : {}) }));
          return true;
        }
        if (op === 'task-comment' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string; id?: string; body?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerTaskComment(
            makeCtx(workflowId),
            { id: typeof body.id === 'string' ? body.id : '', body: typeof body.body === 'string' ? body.body : '' },
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.comment));
          return true;
        }
        if ((op === 'task-link' || op === 'task-unlink') && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string; parentId?: string; childId?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const fn = op === 'task-link' ? clusterPeerOps.peerTaskLink : clusterPeerOps.peerTaskUnlink;
          const result = await fn(
            makeCtx(workflowId),
            {
              parentId: typeof body.parentId === 'string' ? body.parentId : '',
              childId: typeof body.childId === 'string' ? body.childId : '',
            },
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.task));
          return true;
        }
        if (op === 'task-block' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string; id?: string; reason?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerTaskBlock(
            makeCtx(workflowId),
            { id: typeof body.id === 'string' ? body.id : '', reason: typeof body.reason === 'string' ? body.reason : '' },
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.task));
          return true;
        }
        if (op === 'task-complete' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string; id?: string; summary?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerTaskComplete(
            makeCtx(workflowId),
            { id: typeof body.id === 'string' ? body.id : '', summary: typeof body.summary === 'string' ? body.summary : '' },
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.task));
          return true;
        }
        if (op === 'task-update' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string; id?: string; status?: string; notes?: string;
            signoff?: { state?: string; summary?: string } | null;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerTaskUpdate(
            makeCtx(workflowId),
            {
              id: typeof body.id === 'string' ? body.id : '',
              ...(typeof body.status === 'string' ? { status: body.status as LedgerTaskStatus } : {}),
              ...(typeof body.notes === 'string' ? { notes: body.notes } : {}),
              // §D3 — advisory sign-off; peerTaskUpdate validates + stamps author.
              ...(body.signoff !== undefined ? { signoff: body.signoff } : {}),
            },
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.task));
          return true;
        }
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'method_not_allowed', op, method: req.method }));
        return true;
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'peer_op_failed', message: err instanceof Error ? err.message : String(err) }));
        return true;
      }
    }
  }

  // Mailbox modal endpoints — operator-only peek + cancel surface for the
  // Mailbox tab's expand → modal flow.
  //   GET    /api/clusters/:id/mailbox/:wfid          → peek (no drain)
  //   DELETE /api/clusters/:id/mailbox/:wfid/:msgId   → discard pending msg
  // Peek is destructive-free (drain is the model's path); discard removes the
  // file and pushes a fresh cluster_state so the depth indicator follows.
  if (req.url?.startsWith('/api/clusters/') && req.url.includes('/mailbox')) {
    const path = req.url.split(/[?#]/)[0];
    const segs = path.split('/'); // ['', 'api', 'clusters', '<id>', 'mailbox', '<wfid>', '<msgId>?']
    if (segs.length >= 6 && segs[1] === 'api' && segs[2] === 'clusters' && segs[4] === 'mailbox') {
      const clusterId = segs[3];
      const wfid = segs[5];
      const cluster = await clusterStore.readCluster(clusterId).catch(() => null);
      if (!cluster || !cluster.members.includes(wfid)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown_cluster_or_member' }));
        return true;
      }
      try {
        if (segs.length === 6 && req.method === 'GET') {
          const pending = await clusterMailbox.peek(wfid);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(pending));
          return true;
        }
        if (segs.length === 7 && req.method === 'DELETE') {
          const msgId = segs[6];
          const removed = await clusterMailbox.discard(wfid, msgId);
          if (!removed) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unknown_message' }));
            return true;
          }
          // Re-emit cluster_state so the depth chip + Mailbox modal observers
          // drop the cancelled message without a refetch.
          void notifyClusterStateForWorkflow(wfid);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, msgId }));
          return true;
        }
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'method_not_allowed', method: req.method }));
        return true;
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mailbox_op_failed', message: err instanceof Error ? err.message : String(err) }));
        return true;
      }
    }
  }

  // docs/PROVIDERS.md - per-tab sandbox endpoints. Three ops
  // live here:
  //   POST /api/workflows/:wfId/sandbox/clear       — truncate chunks table
  //   GET  /api/workflows/:wfId/sandbox/stats       — { chunkCount, totalBytes, dbPath, recent[] }
  //   POST /api/workflows/:wfId/sandbox/_test_insert — dev-only synthetic insert (smoke harness)
  // The clear op fires `sandbox_db_cleared` on the workflow channel so the
  // Files-tab sub-section drops to zero without a refetch.
  if (req.url?.startsWith('/api/workflows/') && req.url.includes('/sandbox')) {
    const path = req.url.split(/[?#]/)[0];
    const segs = path.split('/'); // ['', 'api', 'workflows', '<wfid>', 'sandbox', '<op>']
    if (segs.length === 6 && segs[1] === 'api' && segs[2] === 'workflows' && segs[4] === 'sandbox') {
      const wfid = segs[3];
      const op = segs[5];
      const wf = workflows.get(wfid);
      const cwd = wf?.config.workingDirectory ?? workflowCwds.get(wfid) ?? null;
      if (!cwd) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown_workflow' }));
        return true;
      }
      try {
        if (op === 'clear' && req.method === 'POST') {
          const store = getSandboxStore(cwd, wfid);
          store.clear();
          broadcastWorkflow(wfid, { type: 'sandbox_db_cleared', workflowId: wfid });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, dbPath: getSandboxDbPath(cwd, wfid) }));
          return true;
        }
        if (op === 'stats' && req.method === 'GET') {
          const store = getSandboxStore(cwd, wfid);
          const stats = store.stats();
          const recent = store.recentChunks(20);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...stats, recent }));
          return true;
        }
        if (op === '_test_insert' && req.method === 'POST') {
          // Test-only escape hatch used by `scripts/smoke/phase-e.ts` to
          // exercise the clear / stats / teardown paths without paying for
          // a real Anthropic round-trip. Gated by NODE_ENV so production
          // builds reject the route outright.
          if (process.env.NODE_ENV === 'production') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not_found' }));
            return true;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            language?: string; content?: string;
          };
          const language = typeof body.language === 'string' ? body.language : 'shell';
          const content = typeof body.content === 'string' ? body.content : '';
          if (!content) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'content required' }));
            return true;
          }
          const store = getSandboxStore(cwd, wfid);
          const info = store.insertChunk(language, content);
          broadcastWorkflow(wfid, {
            type: 'sandbox_chunk_added',
            workflowId: wfid,
            chunkId: info.chunkId,
            byteLen: info.byteLen,
            language,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(info));
          return true;
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'sandbox_op_failed', message: err instanceof Error ? err.message : String(err) }));
        return true;
      }
    }
  }

  if (req.url?.startsWith('/api/clusters/') && req.method === 'GET') {
    const clusterId = req.url.slice('/api/clusters/'.length).split(/[?#]/)[0];
    if (!clusterId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'clusterId required' }));
      return true;
    }
    const state = await clusterStore.readCluster(clusterId).catch(() => null);
    if (!state) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return true;
    }
    const mailboxDepth: Record<string, number> = {};
    for (const wfid of state.members) {
      mailboxDepth[wfid] = await clusterMailbox.depthFor(wfid).catch(() => 0);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...state, mailboxDepth }));
    return true;
  }

  if (req.url?.startsWith('/api/clusters/') && req.method === 'DELETE') {
    const clusterId = req.url.slice('/api/clusters/'.length).split(/[?#]/)[0];
    if (!clusterId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'clusterId required' }));
      return true;
    }
    try {
      // Reuse the WS-side handler so mcp-config cleanup + cluster_deleted
      // broadcast fire identically regardless of which surface initiated
      // the delete. REST and WS converge on `handleClusterDelete`.
      await deps.handleClusterDelete(clusterId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: clusterId }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  // docs/PROVIDERS.md - operator clicked "Re-index now" in the
  // CONFIG-tab CodebaseMemorySection. One-shot spawn of the operator-
  // installed `codebase-memory-mcp` binary with `--skip-config` so it
  // doesn't auto-edit other agent configs. Returns 503 (not 500) when the
  // binary isn't on PATH so the client toast can point at OPERATIONS.md.
  // Phase F ships UX wiring only; the long-lived MCP attachment at CLI
  // spawn time lands in a follow-up after Cluster 3's `mcpConfigWriter`.
  const reindexMatch = req.url?.match(/^\/api\/workflows\/([^/]+)\/codebase-memory\/reindex(?:\?|$)/);
  if (reindexMatch && req.method === 'POST') {
    const workflowId = decodeURIComponent(reindexMatch[1]);
    const wf = workflows.get(workflowId);
    if (!wf) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown_workflow' }));
      return true;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as { indexPath?: string };
      const indexPath = (typeof body.indexPath === 'string' && body.indexPath.trim())
        ? body.indexPath.trim()
        : (wf.config.codebaseMemory?.indexPath || wf.config.workingDirectory);
      if (!indexPath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'index_path_required' }));
        return true;
      }
      // One-shot spawn. The binary auto-edits agent config files unless
      // --skip-config is passed — that's a hard invariant for Arco.
      const child = spawn('codebase-memory-mcp', ['reindex', '--path', indexPath, '--skip-config'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
      child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
      const exit = await new Promise<{ code: number | null; err?: NodeJS.ErrnoException }>((resolve) => {
        child.on('error', (err) => resolve({ code: null, err: err as NodeJS.ErrnoException }));
        child.on('close', (code) => resolve({ code }));
      });
      if (exit.err && (exit.err.code === 'ENOENT' || exit.err.code === 'EACCES')) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'binary_not_installed', message: 'codebase-memory-mcp not installed — see docs/OPERATIONS.md' }));
        return true;
      }
      if (exit.code !== 0) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'reindex_failed', code: exit.code, stderr: stderr.slice(0, 2000) }));
        return true;
      }
      // Best-effort: the binary's stdout may carry a JSON summary with
      // fileCount. Treat parse failures as "no data" — the timestamp alone
      // is still useful.
      let fileCount: number | undefined;
      try {
        const trimmed = stdout.trim();
        if (trimmed.startsWith('{')) {
          const parsed = JSON.parse(trimmed) as { fileCount?: number };
          if (typeof parsed.fileCount === 'number') fileCount = parsed.fileCount;
        }
      } catch { /* not JSON — ignore */ }
      const now = Date.now();
      const prev = wf.config.codebaseMemory ?? { attached: false };
      wf.config.codebaseMemory = {
        attached: prev.attached === true,
        indexPath,
        lastIndexedAt: now,
        fileCount,
      };
      const cwd = wf.config.workingDirectory;
      if (cwd) {
        try {
          const codebaseMemory = { ...wf.config.codebaseMemory };
          await updateMeta(cwd, workflowId, (meta) => {
            meta.codebaseMemory = codebaseMemory;
            meta.lastActiveAt = now;
          });
        } catch (err) {
          console.error(`[arco] [${workflowId.slice(0, 8)}] reindex meta write failed:`, err);
        }
      }
      broadcastWorkflow(workflowId, {
        type: 'codebase_memory_state',
        workflowId,
        attached: wf.config.codebaseMemory.attached,
        indexPath,
        lastIndexedAt: now,
        fileCount,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ indexPath, lastIndexedAt: now, fileCount }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal', message: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  return false;
}
