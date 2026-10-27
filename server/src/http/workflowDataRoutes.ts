import { resolveWorkflowDocument } from './readConfinement.js';
import type { ChatMessage } from '@arco/shared';
import { readFile, stat } from 'fs/promises';
import { IncomingMessage, ServerResponse } from 'http';
import { homedir } from 'os';
import { join, resolve, sep } from 'path';
import {
  createPlan,
  deletePlan,
  deletePlanRef,
  listPlanRefs,
  listPlans,
  movePlan,
  readPlan,
  readPlanRef,
  readPlanSummary,
  touchPlan,
  updatePlan,
  writePlanRef,
} from '../planStore.js';
import * as clusterStore from '../clusterStore.js';
import { resolveProviderAccount } from '../providerAccounts.js';
import { broadcastCluster, broadcastWorkflow, buildClusterStatePayload } from '../server/broadcast.js';
import { PORT, UUID_PATTERN } from '../server/constants.js';
import {
  plansWatchers,
  workflowCwds,
  workflows,
} from '../server/state.js';
import { listWorkflowMetas, readMeta, WFID_PATTERN } from '../workflowMeta.js';
import { purgeWorkflow } from '../workflows/purgeWorkflow.js';
import { readEventsPageBefore as readWorkflowEventsPageBefore } from '../workflowStore.js';
import { discoverSessions } from '../workflows/sessionDiscovery.js';
import {
  readSessionIndex,
  backfillSessionIndex,
  renameSession,
  setSessionPinned,
  setSessionArchived,
  type SessionSelector,
} from '../workflows/sessionIndex.js';
import type { ProviderName } from '@arco/shared';
import {
  findCodexRolloutPath,
  loadCodexTranscript,
  loadTranscript,
} from '../workflows/transcripts.js';
import { encodeProjectDir } from './fileRead.js';
import type { HttpDeps } from './router.js';
import { listSavedChats } from '../chatMode.js';

// A ref write/delete is a plan change: bump updatedAt and tell every attached
// workflow (plan_attached doubles as "plan changed") and every cluster bound
// to the plan (cluster_state), so open Plan tabs refetch their refs list.
async function announcePlanTouched(cwd: string, planId: string): Promise<void> {
  const summary = await touchPlan(cwd, planId);
  if (!summary) return;
  for (const [wfid, wf] of workflows) {
    if (wf.planId !== planId || workflowCwds.get(wfid) !== cwd) continue;
    broadcastWorkflow(wfid, { type: 'plan_attached', workflowId: wfid, planId, title: summary.title, updatedAt: summary.updatedAt });
  }
  for (const cid of clusterStore.listKnownClusterIds()) {
    const cluster = await clusterStore.readCluster(cid).catch(() => null);
    if (!cluster || cluster.cwd !== cwd || cluster.planId !== planId) continue;
    const payload = await buildClusterStatePayload(cid);
    if (payload) broadcastCluster(cid, { type: 'cluster_state', clusterId: cid, state: payload });
  }
}

function jsonReply(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// §H3 — shared body-reader for the session-index mutation routes. Parses
// { provider, sessionId, ...rest } from the POST body + `path` from the query,
// runs `op`, and replies { entry } (or a 4xx). Mutations select an entry by its
// (provider, sessionId) key; a miss returns { entry: null } (200 — the picker
// just refetches).
async function handleSessionIndexMutation(
  req: IncomingMessage,
  res: ServerResponse,
  op: (cwd: string, sel: SessionSelector, parsed: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const cwd = url.searchParams.get('path');
    if (!cwd) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path query required' }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || '{}') as Record<string, unknown>;
    const provider = typeof parsed.provider === 'string' ? parsed.provider : '';
    const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : '';
    if (!provider || !sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'provider and sessionId required' }));
      return;
    }
    const entry = await op(cwd, { provider: provider as ProviderName, sessionId }, parsed);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entry: entry ?? null }));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}

// Workflow-data route group — transcripts, sessions, workflow listing/events,
// handoff + artifact readers, and the plans REST CRUD. Peeled verbatim from
// router.ts (see docs/ARCHITECTURE.md). Returns true when a route
// in this group matched (request answered), false otherwise so the caller
// falls through to the next route group.
export async function tryHandleWorkflowDataRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpDeps,
): Promise<boolean> {
  // Machine-global Chat history. Incognito chats never create meta.json and
  // therefore cannot appear here by construction.
  if (req.url?.match(/^\/api\/chats(\?|$)/) && req.method === 'GET') {
    try {
      const chats = await listSavedChats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ chats }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ chats: [] }));
    }
    return true;
  }

  if (req.url?.startsWith('/api/transcript') && !req.url.startsWith('/api/transcript-export') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const cwd = url.searchParams.get('path') || '';
      const sessionId = url.searchParams.get('sessionId') || '';
      const providerParam = (url.searchParams.get('provider') || 'claude').toLowerCase();
      // Tail-first pagination. `limit` caps the returned window size; `before`
      // is an exclusive-upper message-index cursor (set to the previous page's
      // earlierCursor to walk backward through history). Omit both on the
      // initial fetch to get the most recent page.
      const limitRaw = parseInt(url.searchParams.get('limit') || '', 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;
      const beforeRaw = parseInt(url.searchParams.get('before') || '', 10);
      const before = Number.isFinite(beforeRaw) ? beforeRaw : Number.POSITIVE_INFINITY;
      if (!cwd || !sessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path and sessionId required' }));
        return true;
      }
      if (!UUID_PATTERN.test(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid sessionId' }));
        return true;
      }
      let allMessages: ChatMessage[] = [];
      if (providerParam === 'codex') {
        const account = url.searchParams.get('account') || undefined;
        const resolvedAccount = account ? await resolveProviderAccount('codex', account, cwd).catch(() => null) : null;
        const filePath = await findCodexRolloutPath(sessionId, resolvedAccount?.codexHome);
        if (filePath) allMessages = await loadCodexTranscript(filePath);
      } else {
        const projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(cwd));
        const filePath = join(projectDir, `${sessionId}.jsonl`);
        allMessages = await loadTranscript(filePath);
      }
      const total = allMessages.length;
      // End is exclusive — `before` is the first index we do NOT include.
      const end = Math.min(total, before);
      const start = Math.max(0, end - limit);
      const messages = allMessages.slice(start, end);
      const hasEarlier = start > 0;
      const earlierCursor = start; // feed back as `before` on the next request
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages, hasEarlier, earlierCursor, total }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message, messages: [] }));
    }
    return true;
  }

  if (req.url?.startsWith('/api/transcript-export') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const cwd = url.searchParams.get('path') || '';
      const sessionId = url.searchParams.get('sessionId') || '';
      if (!cwd || !sessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path and sessionId required' }));
        return true;
      }
      const projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(cwd));
      const filePath = join(projectDir, `${sessionId}.jsonl`);
      const messages = await loadTranscript(filePath);
      const exportedAt = new Date().toISOString();
      const lines: string[] = [
        `# Conversation Export`,
        ``,
        `**Session:** \`${sessionId}\`  `,
        `**Directory:** \`${cwd}\`  `,
        `**Exported:** ${exportedAt}`,
        ``,
        `---`,
        ``,
      ];
      for (const msg of messages) {
        if (msg.role === 'user') {
          lines.push(`## Operator`, ``, msg.content, ``);
        } else if (msg.role === 'assistant') {
          lines.push(`## Arco`, ``, msg.content, ``);
        } else {
          lines.push(`> ${msg.content}`, ``);
        }
      }
      const markdown = lines.join('\n');
      const filename = `arco-${sessionId.slice(0, 8)}-${exportedAt.slice(0, 10)}.md`;
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
      res.end(markdown);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return true;
  }

  if (req.url?.startsWith('/api/sessions') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const dir = url.searchParams.get('path') || '';
      const sessions = await discoverSessions(dir);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: [] }));
    }
    return true;
  }

  // §H3 — the resume-picker's session-index read. Awaits a backfill first so the
  // file is authoritative even for workflows that haven't taken a turn this run
  // (discoverSessions backfills fire-and-forget; this read can't race it).
  if (req.url?.startsWith('/api/session-index') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('path') || '';
      if (cwd) await backfillSessionIndex(cwd, readMeta).catch(() => { /* projection — read what's there */ });
      const index = cwd ? await readSessionIndex(cwd) : { version: 1, updatedAt: 0, entries: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries: index.entries }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries: [] }));
    }
    return true;
  }

  // §H3 — operator mutations on a session-index entry (rename / pin / archive).
  if (req.url?.startsWith('/api/session-index/rename') && req.method === 'POST') {
    await handleSessionIndexMutation(req, res, (cwd, sel, parsed) =>
      renameSession(cwd, sel, typeof parsed.title === 'string' ? parsed.title : ''));
    return true;
  }
  if (req.url?.startsWith('/api/session-index/pin') && req.method === 'POST') {
    await handleSessionIndexMutation(req, res, (cwd, sel, parsed) =>
      setSessionPinned(cwd, sel, parsed.pinned === true));
    return true;
  }
  if (req.url?.startsWith('/api/session-index/archive') && req.method === 'POST') {
    await handleSessionIndexMutation(req, res, (cwd, sel, parsed) =>
      setSessionArchived(cwd, sel, parsed.archived === true));
    return true;
  }

  // Arco workflow listing — drives the Resume picker.
  if (req.url?.match(/^\/api\/workflows(\?|$)/) && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('path') || '';
      const workflows = await listWorkflowMetas(cwd);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ workflows }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ workflows: [] }));
    }
    return true;
  }

  // Conversation purge — irreversibly delete a workflow's on-disk footprint.
  //   DELETE /api/workflows/<wfid>?path=<cwd>&mode=arco|nuclear
  //   body: { confirm: true }  (nuclear also requires { confirmName: <name> })
  // 'arco' removes everything Arco wrote; 'nuclear' also removes the bound
  // provider session files (~/.claude/projects/…, codex rollout). The
  // type-the-name check on nuclear is the secondary verification (no undo).
  if (req.url?.match(/^\/api\/workflows\/[^/?]+(\?|$)/) && req.method === 'DELETE') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const wfid = decodeURIComponent(url.pathname.replace(/^\/api\/workflows\//, ''));
      const cwd = url.searchParams.get('path') || '';
      const nuclear = url.searchParams.get('mode') === 'nuclear';
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}') as { confirm?: boolean; confirmName?: string };
      if (!cwd || !WFID_PATTERN.test(wfid)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path query and a valid workflowId are required' }));
        return true;
      }
      if (parsed.confirm !== true) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'confirm:true required' }));
        return true;
      }
      if (nuclear) {
        // Secondary verification: the typed name must match the workflow's name.
        const meta = await readMeta(cwd, wfid).catch(() => null);
        const expected = meta?.name ?? '';
        if (!parsed.confirmName || parsed.confirmName !== expected) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'confirmName must match the workflow name for a nuclear purge', expected }));
          return true;
        }
      }
      const result = await purgeWorkflow(cwd, wfid, { nuclear });
      res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  if (req.url?.startsWith('/api/workflows/events') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('path') || '';
      const workflowId = url.searchParams.get('workflowId') || '';
      const limitRaw = parseInt(url.searchParams.get('limit') || '', 10);
      const beforeRaw = parseInt(url.searchParams.get('beforeSeq') || '', 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 250;
      const beforeSeq = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : Number.POSITIVE_INFINITY;
      if (!cwd || !workflowId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path and workflowId query required' }));
        return true;
      }
      if (!UUID_PATTERN.test(workflowId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid workflowId' }));
        return true;
      }
      const page = await readWorkflowEventsPageBefore(cwd, workflowId, beforeSeq, limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(page));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err), events: [] }));
    }
    return true;
  }

  // Phase 6 handoff artifact reader. Handoff documents live under
  // `<cwd>/.arco/workflows/<wfid>/handoffs/`. Mirrors the /artifact
  // endpoint's shape + sanitization; separate root to avoid loosening the
  // /artifact endpoint's path-traversal guard.
  if (req.url?.startsWith('/api/workflows/handoff') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('path');
      const workflowId = url.searchParams.get('workflowId');
      const name = url.searchParams.get('name');
      if (!cwd || !workflowId || !name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path, workflowId, and name query required' }));
        return true;
      }
      if (name.includes('/') || name.includes('\\') || name.includes('\0') || name === '.' || name === '..' || name.startsWith('.')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid handoff name' }));
        return true;
      }
      const target = await resolveWorkflowDocument(cwd, workflowId, 'handoffs', name);
      let stats;
      try {
        stats = await stat(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'handoff not found' }));
          return true;
        }
        throw err;
      }
      const MAX_BYTES = 2 * 1024 * 1024;
      if (stats.size > MAX_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `handoff too large (${stats.size} bytes > ${MAX_BYTES} cap)`, bytes: stats.size }));
        return true;
      }
      const contents = await readFile(target, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ contents, bytes: stats.size, name }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  // Raw artifact bytes (images etc.). Same sanitization + escape guards as the
  // JSON reader below, but streams the raw file with a type-by-extension header
  // so an <img src> can render it directly (G1 preview screenshots). Must be
  // matched BEFORE the JSON route, whose prefix `/api/workflows/artifact` also
  // matches this longer path.
  if (req.url?.startsWith('/api/workflows/artifact-raw') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('path');
      const workflowId = url.searchParams.get('workflowId');
      const name = url.searchParams.get('name');
      if (!cwd || !workflowId || !name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path, workflowId, and name query required' }));
        return true;
      }
      if (name.includes('/') || name.includes('\\') || name.includes('\0') || name === '.' || name === '..' || name.startsWith('.')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid artifact name' }));
        return true;
      }
      const target = await resolveWorkflowDocument(cwd, workflowId, 'artifacts', name);
      let stats;
      try {
        stats = await stat(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'artifact not found' }));
          return true;
        }
        throw err;
      }
      const MAX_RAW_BYTES = 16 * 1024 * 1024;
      if (stats.size > MAX_RAW_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `artifact too large (${stats.size} bytes > ${MAX_RAW_BYTES} cap)`, bytes: stats.size }));
        return true;
      }
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
      const type =
        ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.png' ? 'image/png'
        : ext === '.webp' ? 'image/webp'
        : ext === '.gif' ? 'image/gif'
        : 'application/octet-stream';
      const bytes = await readFile(target);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(stats.size), 'Cache-Control': 'no-store' });
      res.end(bytes);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  // Per-workflow artifact reader. Workers write report-shaped outputs into
  // `<cwd>/.arco/workflows/<wfid>/artifacts/`; the client fetches them on
  // demand when chat contains `[artifact:<name>]`. Name is strictly sanitized.
  if (req.url?.startsWith('/api/workflows/artifact') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('path');
      const workflowId = url.searchParams.get('workflowId');
      const name = url.searchParams.get('name');
      if (!cwd || !workflowId || !name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path, workflowId, and name query required' }));
        return true;
      }
      if (name.includes('/') || name.includes('\\') || name.includes('\0') || name === '.' || name === '..' || name.startsWith('.')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid artifact name' }));
        return true;
      }
      const target = await resolveWorkflowDocument(cwd, workflowId, 'artifacts', name);
      let stats;
      try {
        stats = await stat(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'artifact not found' }));
          return true;
        }
        throw err;
      }
      const MAX_BYTES = 2 * 1024 * 1024;
      if (stats.size > MAX_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `artifact too large (${stats.size} bytes > ${MAX_BYTES} cap)`, bytes: stats.size }));
        return true;
      }
      const contents = await readFile(target, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ contents, bytes: stats.size, name }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  // ── Plans REST ──
  // List, read, create, update plans stored at <cwd>/.arco/plans/.
  //
  // Attach is reachable BOTH ways and both land the same `plan_attached`
  // event: the PLAN tab uses the WS `plan_attach` message, while `POST
  // /api/plans` (`attach:true` + `workflowId`) and `POST /api/plans/attach`
  // call the same `deps.handlePlanAttach`. The REST pair is what an agent
  // uses — it has a shell, not a websocket. (This comment used to claim
  // attach was WS-only; it was already false, and workers burned turns
  // reverse-engineering the route. `planAuthoringNote` in turnEngine now
  // tells them outright.)
  // ── Plan reference docs ──
  // <cwd>/.arco/plans/<planId>.refs/<slug>.md. Ahead of every generic
  // startsWith('/api/plans') handler below (route order decides). Agent-
  // callable like /api/plans (wsAuth AGENT_TOOL_PATHS) — the plan_ref_* MCP
  // tools are thin wrappers over these.
  if (req.url?.startsWith('/api/plans/refs')) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const cwd = url.searchParams.get('path');
    const planId = url.searchParams.get('planId');
    const slug = url.searchParams.get('slug');
    if (!cwd || !planId) {
      jsonReply(res, 400, { error: 'path and planId query required' });
      return true;
    }
    try {
      if (url.pathname === '/api/plans/refs/body' && req.method === 'GET') {
        if (!slug) { jsonReply(res, 400, { error: 'slug query required' }); return true; }
        const ref = await readPlanRef(cwd, planId, slug);
        if (!ref) { jsonReply(res, 404, { error: 'ref not found' }); return true; }
        jsonReply(res, 200, { ref });
        return true;
      }
      if (url.pathname !== '/api/plans/refs') return false;
      if (req.method === 'GET') {
        jsonReply(res, 200, { refs: await listPlanRefs(cwd, planId) });
        return true;
      }
      if (req.method === 'PUT') {
        if (!slug) { jsonReply(res, 400, { error: 'slug query required' }); return true; }
        let body = '';
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body || '{}') as { body?: unknown };
        if (typeof parsed.body !== 'string') { jsonReply(res, 400, { error: 'body (string) required' }); return true; }
        const result = await writePlanRef(cwd, planId, slug, parsed.body);
        if (!result.ok) { jsonReply(res, result.error === 'plan not found' ? 404 : 400, { error: result.error }); return true; }
        await announcePlanTouched(cwd, planId);
        jsonReply(res, 200, { ref: result.ref, created: result.created });
        return true;
      }
      if (req.method === 'DELETE') {
        if (!slug) { jsonReply(res, 400, { error: 'slug query required' }); return true; }
        const ok = await deletePlanRef(cwd, planId, slug);
        if (!ok) { jsonReply(res, 404, { error: 'ref not found' }); return true; }
        await announcePlanTouched(cwd, planId);
        jsonReply(res, 200, { deleted: true });
        return true;
      }
      jsonReply(res, 405, { error: 'method not allowed' });
    } catch (err) {
      jsonReply(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (req.url?.startsWith('/api/plans/body') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('path');
      const planId = url.searchParams.get('planId');
      if (!cwd || !planId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path and planId query required' }));
        return true;
      }
      const plan = await readPlan(cwd, planId);
      if (!plan) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'plan not found' }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ plan }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  if (req.url?.startsWith('/api/plans') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('path');
      if (!cwd) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path query required' }));
        return true;
      }
      const plans = await listPlans(cwd);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ plans }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  // Move a plan from one cwd to another. MUST come before the generic POST
  // /api/plans handler below — startsWith('/api/plans') matches both, and
  // route order decides which one runs. Detaches any workflows in the
  // source cwd (so observers see plan_detached), writes target body+index
  // first, then removes source. Plan id stays the same; attachments do
  // not carry over since they reference workflows in the old cwd.
  if (req.url?.startsWith('/api/plans/move') && req.method === 'POST') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const sourceCwd = url.searchParams.get('path');
      const planId = url.searchParams.get('planId');
      if (!sourceCwd || !planId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path and planId query required' }));
        return true;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}') as { targetCwd?: string };
      const targetCwd = parsed.targetCwd?.trim();
      if (!targetCwd) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'targetCwd required in body' }));
        return true;
      }
      // Detach any workflows currently using this plan in the source cwd —
      // observers receive plan_detached before the file vanishes.
      await deps.detachAllForPlan(sourceCwd, planId);
      // Tell both watchers to skip the next file event for this id so we
      // don't get redundant reconcile broadcasts (we own the move).
      const sourceWatcher = plansWatchers.get(sourceCwd);
      const targetWatcher = plansWatchers.get(targetCwd);
      if (sourceWatcher) sourceWatcher.skipNext.add(planId);
      if (targetWatcher) targetWatcher.skipNext.add(planId);
      const result = await movePlan(sourceCwd, planId, targetCwd);
      if (!result.ok) {
        if (sourceWatcher) sourceWatcher.skipNext.delete(planId);
        if (targetWatcher) targetWatcher.skipNext.delete(planId);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.error }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ plan: result.plan }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return true;
  }

  if (req.url?.startsWith('/api/plans/attach') && req.method === 'POST') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('path');
      const planId = url.searchParams.get('planId');
      const workflowId = url.searchParams.get('workflowId');
      if (!cwd || !planId || !workflowId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path, planId, and workflowId query required' }));
        return true;
      }
      const wfCwd = workflowCwds.get(workflowId);
      if (wfCwd !== cwd) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'workflowId is not active in this cwd' }));
        return true;
      }
      const summary = await readPlanSummary(cwd, planId);
      if (!summary) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'plan not found' }));
        return true;
      }
      await deps.handlePlanAttach(workflowId, planId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, plan: summary }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return true;
  }

  if (req.url?.startsWith('/api/plans') && req.method === 'POST') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('path');
      if (!cwd) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path query required' }));
        return true;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}') as { title?: string; body?: string; workflowId?: string; attach?: boolean };
      const plan = await createPlan(cwd, {
        title: parsed.title ?? '',
        body: parsed.body ?? '',
      });
      if (parsed.attach === true && parsed.workflowId) {
        const wfCwd = workflowCwds.get(parsed.workflowId);
        if (wfCwd === cwd) {
          await deps.handlePlanAttach(parsed.workflowId, plan.id);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ plan }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return true;
  }

  if (req.url?.startsWith('/api/plans') && req.method === 'PATCH') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('path');
      const planId = url.searchParams.get('planId');
      if (!cwd || !planId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path and planId query required' }));
        return true;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}') as { title?: string; body?: string; completedAt?: number | null };
      // Tell the plans watcher to ignore the next file change for this id —
      // we're about to write the body ourselves and broadcast plan_attached
      // directly; without the skip the watcher would fire a second redundant
      // broadcast 200ms later. (No-op when patch is just completedAt — no
      // .md write happens in that case.)
      const watcherState = plansWatchers.get(cwd);
      if (watcherState && typeof parsed.body === 'string') watcherState.skipNext.add(planId);
      const plan = await updatePlan(cwd, planId, parsed);
      if (!plan) {
        if (watcherState) watcherState.skipNext.delete(planId);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'plan not found' }));
        return true;
      }
      // Mark-complete also auto-detaches: a completed plan shouldn't keep
      // getting injected into any workflow's per-turn header. Reopen
      // (completedAt: null) leaves attachments alone — the operator can
      // choose whether to re-attach manually.
      if (typeof parsed.completedAt === 'number') {
        await deps.detachAllForPlan(cwd, planId);
      }
      // Notify any workflow currently attached to this plan so other tabs
      // viewing it pick up the new title/updatedAt. Reuses plan_attached as
      // the "plan changed" notification — its payload (id, title, updatedAt)
      // is exactly what attached observers need.
      for (const [wfid, wf] of workflows) {
        if (wf.planId === planId) {
          broadcastWorkflow(wfid, {
            type: 'plan_attached',
            workflowId: wfid,
            planId: plan.id,
            title: plan.title,
            updatedAt: plan.updatedAt,
          });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ plan }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return true;
  }

  if (req.url?.startsWith('/api/plans') && req.method === 'DELETE') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('path');
      const planId = url.searchParams.get('planId');
      if (!cwd || !planId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path and planId query required' }));
        return true;
      }
      // Detach any workflows currently using the plan first, so observers
      // receive plan_detached before the file vanishes. Then mark the
      // watcher to skip its delete-reconcile (we're handling it).
      await deps.detachAllForPlan(cwd, planId);
      const watcherState = plansWatchers.get(cwd);
      if (watcherState) watcherState.skipNext.add(planId);
      const ok = await deletePlan(cwd, planId);
      if (!ok) {
        if (watcherState) watcherState.skipNext.delete(planId);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'plan not found' }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: true }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return true;
  }

  return false;
}
