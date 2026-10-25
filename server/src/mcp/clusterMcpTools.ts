// CLUSTER_MODE_PLAN.md Phase 3 / CURSOR_TRANSPORT_PLAN.md Phase 6 — the shared
// arco-cluster tool registration, transport-agnostic.
//
// Extracted from `clusterMcpServer.ts` (the stdio child) so the SAME tool set
// backs two transports without drift:
//   - stdio  (Claude CLI / Codex members): `clusterMcpServer.ts` spawns a child
//     process, connects a StdioServerTransport, and calls registerClusterTools.
//   - loopback HTTP (Cursor members): `clusterMcpLoopback.ts` stands up an
//     in-process StreamableHTTP server — Cursor ACP advertises
//     `mcpCapabilities:{http,sse}` and NO stdio, so its peer tools must ride a
//     network transport (spike-8 + Phase-6 SSE micro-probe).
//
// Every tool is a thin translation to Arco's local REST peer API
// (`/api/clusters/:id/peer/*`), so the (clusterId, workflowId, port,
// taskBoardAttached) tuple is all the context a registration needs — passed as
// `ClusterMcpToolCtx` rather than read from argv, so an in-process caller works
// the same as the child.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ClusterMemberAccessMode } from '@arco/shared';

export interface ClusterMcpToolCtx {
  clusterId: string;
  workflowId: string;
  arcoPort: number;
  taskBoardAttached: boolean;
  accessMode?: ClusterMemberAccessMode;
  // Where diagnostics go. The stdio child MUST log to stderr (stdout is the MCP
  // wire); the in-process loopback passes a tagged console.error. Defaults to
  // console.error.
  logErr?: (...args: unknown[]) => void;
}

interface PeerSendUpstreamError {
  error?: string;
  message?: string;
  count?: number;
  cap?: number;
}
interface PlanTickUpstreamError { error?: string; message?: string; matches?: number[] }
interface PlanWriteUpstreamError {
  error?: string;
  message?: string;
  limit?: number;
  actual?: number;
  removed?: string[];
  statusChanged?: Array<{ text: string; before: '[ ]' | '[x]'; after: '[ ]' | '[x]' }>;
}
interface TaskUpstreamError { error?: string; message?: string }

function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

// Register the full arco-cluster tool set onto `server`, bound to `ctx`. The
// tool bodies + descriptions are verbatim from the original stdio child; only
// the BASE_URL / WORKFLOW_ID / logErr are now closed over ctx instead of
// module-level argv globals.
export function registerClusterTools(server: McpServer, ctx: ClusterMcpToolCtx): void {
  if (ctx.accessMode && ctx.accessMode !== 'standard') {
    const original = server.registerTool.bind(server);
    server.registerTool = ((name: string, ...args: unknown[]) => {
      if (name !== 'peer_send' && name !== 'peer_read') return undefined;
      return (original as (...xs: unknown[]) => unknown)(name, ...args);
    }) as typeof server.registerTool;
  }
  const { clusterId, workflowId, arcoPort, taskBoardAttached } = ctx;
  const logErr = ctx.logErr ?? ((...args: unknown[]) => console.error('[arco-cluster-mcp]', ...args));
  const BASE_URL = `http://127.0.0.1:${arcoPort}/api/clusters/${encodeURIComponent(clusterId)}/peer`;

  async function callPeerList(): Promise<unknown> {
    const url = `${BASE_URL}/list?workflowId=${encodeURIComponent(workflowId)}`;
    const r = await fetch(url, { method: 'GET' });
    if (!r.ok) throw new Error(`peer_list http_${r.status}: ${await r.text()}`);
    return r.json();
  }

  async function callPeerSend(args: { to: string; content: string }): Promise<{ ok: true; body: unknown } | { ok: false; err: PeerSendUpstreamError }> {
    const r = await fetch(`${BASE_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: workflowId, to: args.to, content: args.content }),
    });
    const body = await r.json().catch(() => ({})) as PeerSendUpstreamError | unknown;
    if (!r.ok) return { ok: false, err: body as PeerSendUpstreamError };
    return { ok: true, body };
  }

  async function callPeerRead(): Promise<unknown> {
    const r = await fetch(`${BASE_URL}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId }),
    });
    if (!r.ok) throw new Error(`peer_read http_${r.status}: ${await r.text()}`);
    return r.json();
  }

  async function callPlanRead(): Promise<unknown> {
    const r = await fetch(`${BASE_URL}/plan-read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId }),
    });
    if (!r.ok) throw new Error(`cluster_plan_read http_${r.status}: ${await r.text()}`);
    return r.json();
  }

  async function callPlanWrite(body: string): Promise<{ ok: true; body: unknown } | { ok: false; err: PlanWriteUpstreamError }> {
    const r = await fetch(`${BASE_URL}/plan-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId, body }),
    });
    const respBody = await r.json().catch(() => ({})) as PlanWriteUpstreamError | unknown;
    if (!r.ok) return { ok: false, err: respBody as PlanWriteUpstreamError };
    return { ok: true, body: respBody };
  }

  async function callPlanTick(args: { lineIndex?: number; taskText?: string }): Promise<{ ok: true; body: unknown } | { ok: false; err: PlanTickUpstreamError }> {
    const payload: Record<string, unknown> = { workflowId };
    if (typeof args.lineIndex === 'number') payload.lineIndex = args.lineIndex;
    if (typeof args.taskText === 'string') payload.taskText = args.taskText;
    const r = await fetch(`${BASE_URL}/plan-tick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({})) as PlanTickUpstreamError | unknown;
    if (!r.ok) return { ok: false, err: body as PlanTickUpstreamError };
    return { ok: true, body };
  }

  async function callTaskList(): Promise<unknown> {
    const url = `${BASE_URL}/task-list?workflowId=${encodeURIComponent(workflowId)}`;
    const r = await fetch(url, { method: 'GET' });
    if (!r.ok) throw new Error(`cluster_task_list http_${r.status}: ${await r.text()}`);
    return r.json();
  }

  async function callTaskShow(id: string): Promise<unknown> {
    const url = `${BASE_URL}/task-show?workflowId=${encodeURIComponent(workflowId)}&id=${encodeURIComponent(id)}`;
    const r = await fetch(url, { method: 'GET' });
    if (!r.ok) throw new Error(`cluster_task_show http_${r.status}: ${await r.text()}`);
    return r.json();
  }

  async function callTaskCreate(args: {
    title: string;
    body?: string;
    notes?: string;
    assignee?: string;
    priority?: number;
    parentIds?: string[];
    links?: unknown[];
    reviewRequired?: boolean;
    goalMode?: boolean;
    goalMaxTurns?: number;
  }): Promise<{ ok: true; body: unknown } | { ok: false; err: TaskUpstreamError }> {
    const payload: Record<string, unknown> = { workflowId, title: args.title };
    if (typeof args.body === 'string') payload.body = args.body;
    if (typeof args.notes === 'string') payload.notes = args.notes;
    if (typeof args.assignee === 'string') payload.assignee = args.assignee;
    if (typeof args.priority === 'number') payload.priority = args.priority;
    if (Array.isArray(args.parentIds)) payload.parentIds = args.parentIds;
    if (Array.isArray(args.links)) payload.links = args.links;
    if (typeof args.reviewRequired === 'boolean') payload.reviewRequired = args.reviewRequired;
    if (typeof args.goalMode === 'boolean') payload.goalMode = args.goalMode;
    if (typeof args.goalMaxTurns === 'number') payload.goalMaxTurns = args.goalMaxTurns;
    const r = await fetch(`${BASE_URL}/task-create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({})) as TaskUpstreamError | unknown;
    if (!r.ok) return { ok: false, err: body as TaskUpstreamError };
    return { ok: true, body };
  }

  async function callTaskClaim(id: string): Promise<{ ok: true; body: unknown } | { ok: false; err: TaskUpstreamError }> {
    const r = await fetch(`${BASE_URL}/task-claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId, id }),
    });
    const body = await r.json().catch(() => ({})) as TaskUpstreamError | unknown;
    if (!r.ok) return { ok: false, err: body as TaskUpstreamError };
    return { ok: true, body };
  }

  async function callTaskUpdate(args: { id: string; status?: string; notes?: string; signoff?: { state: string; summary?: string } }): Promise<{ ok: true; body: unknown } | { ok: false; err: TaskUpstreamError }> {
    const payload: Record<string, unknown> = { workflowId, id: args.id };
    if (typeof args.status === 'string') payload.status = args.status;
    if (typeof args.notes === 'string') payload.notes = args.notes;
    if (args.signoff && typeof args.signoff === 'object') payload.signoff = args.signoff;
    const r = await fetch(`${BASE_URL}/task-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({})) as TaskUpstreamError | unknown;
    if (!r.ok) return { ok: false, err: body as TaskUpstreamError };
    return { ok: true, body };
  }

  async function callTaskHeartbeat(args: { id: string; note?: string }): Promise<{ ok: true; body: unknown } | { ok: false; err: TaskUpstreamError }> {
    const payload: Record<string, unknown> = { workflowId, id: args.id };
    if (typeof args.note === 'string') payload.note = args.note;
    const r = await fetch(`${BASE_URL}/task-heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({})) as TaskUpstreamError | unknown;
    if (!r.ok) return { ok: false, err: body as TaskUpstreamError };
    return { ok: true, body };
  }

  async function callTaskComment(args: { id: string; body: string }): Promise<{ ok: true; body: unknown } | { ok: false; err: TaskUpstreamError }> {
    const r = await fetch(`${BASE_URL}/task-comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId, id: args.id, body: args.body }),
    });
    const body = await r.json().catch(() => ({})) as TaskUpstreamError | unknown;
    if (!r.ok) return { ok: false, err: body as TaskUpstreamError };
    return { ok: true, body };
  }

  async function callTaskLink(args: { parentId: string; childId: string }): Promise<{ ok: true; body: unknown } | { ok: false; err: TaskUpstreamError }> {
    const r = await fetch(`${BASE_URL}/task-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId, parentId: args.parentId, childId: args.childId }),
    });
    const body = await r.json().catch(() => ({})) as TaskUpstreamError | unknown;
    if (!r.ok) return { ok: false, err: body as TaskUpstreamError };
    return { ok: true, body };
  }

  async function callTaskUnlink(args: { parentId: string; childId: string }): Promise<{ ok: true; body: unknown } | { ok: false; err: TaskUpstreamError }> {
    const r = await fetch(`${BASE_URL}/task-unlink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId, parentId: args.parentId, childId: args.childId }),
    });
    const body = await r.json().catch(() => ({})) as TaskUpstreamError | unknown;
    if (!r.ok) return { ok: false, err: body as TaskUpstreamError };
    return { ok: true, body };
  }

  async function callTaskBlock(args: { id: string; reason: string }): Promise<{ ok: true; body: unknown } | { ok: false; err: TaskUpstreamError }> {
    const r = await fetch(`${BASE_URL}/task-block`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId, id: args.id, reason: args.reason }),
    });
    const body = await r.json().catch(() => ({})) as TaskUpstreamError | unknown;
    if (!r.ok) return { ok: false, err: body as TaskUpstreamError };
    return { ok: true, body };
  }

  async function callTaskComplete(args: { id: string; summary: string }): Promise<{ ok: true; body: unknown } | { ok: false; err: TaskUpstreamError }> {
    const r = await fetch(`${BASE_URL}/task-complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId, id: args.id, summary: args.summary }),
    });
    const body = await r.json().catch(() => ({})) as TaskUpstreamError | unknown;
    if (!r.ok) return { ok: false, err: body as TaskUpstreamError };
    return { ok: true, body };
  }

  server.registerTool(
    'peer_list',
    {
      description:
        'List the other members of the cluster you belong to. Returns each peer\'s workflowId, 8-char display name, pending mailbox depth, optional role, optional builder-tier hint, and optional focus string (sub-specialty). Use `role` to identify coordinator/director/reviewer responsibilities; use `tier` to match task complexity to builder capability: `light` = quick edits, renames, simple commands; `standard` = normal feature work; `heavy` = architectural changes, complex refactors. Use `focus` to disambiguate same-role peers — it\'s a free-form description of what THIS specific peer specializes in. When choosing between similar peers, prefer the one whose focus matches the task. Role/tier/focus are absent when the operator hasn\'t set them. Cluster mode only.',
      inputSchema: {},
    },
    async () => {
      try {
        const rows = await callPeerList();
        return textResult(rows);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr('peer_list failed:', msg);
        return textResult(`[error] peer_list failed: ${msg}`, true);
      }
    },
  );

  server.registerTool(
    'peer_send',
    {
      description:
        'Send a short note to a peer in your cluster. `to` accepts the peer\'s full workflowId, unique 8-char prefix, unique displayName, or unique role text such as "Coordinator" when only one peer has that role. Prefer peer_list first, then use displayName/workflowId when possible. `content` is up to 16 KB. The recipient sees the message as a system block prepended to their next operator turn. There is a hard per-sender per-turn send cap (it tightens at higher cluster efficiency levels); the budget resets each time the operator advances your turn, and a rejected send returns budget_exhausted with the current count and cap.',
      inputSchema: {
        to: z.string().describe('Peer full workflowId, unique 8-char prefix, unique displayName, or unique role text.'),
        content: z.string().describe('Message body (≤ 16 KB UTF-8).'),
      },
    },
    async (args) => {
      try {
        const r = await callPeerSend({ to: args.to, content: args.content });
        if (!r.ok) {
          // Translate the REST 400 into an MCP isError result so the model
          // sees a tool error (same shape Native's peer_send returns).
          const detail = r.err.message ?? r.err.error ?? 'unknown_error';
          return textResult(`[error] ${detail}`, true);
        }
        return textResult(r.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr('peer_send failed:', msg);
        return textResult(`[error] peer_send failed: ${msg}`, true);
      }
    },
  );

  server.registerTool(
    'cluster_plan_read',
    {
      description:
        'Read the full shared cluster plan (markdown body + title + updatedAt). The plan copy injected into your context at turn start may be an OUTLINE (headings, checkbox lines, and labelled standing-directive sections; other prose omitted) when the full plan is large — call this whenever you need the complete text, e.g. before cluster_plan_write or when an outline item needs its surrounding detail. Read-only; cluster mode only.',
      inputSchema: {},
    },
    async () => {
      try {
        const body = await callPlanRead();
        return textResult(body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr('cluster_plan_read failed:', msg);
        return textResult(`[error] cluster_plan_read failed: ${msg}`, true);
      }
    },
  );

  server.registerTool(
    'cluster_plan_tick',
    {
      description:
        "Toggle a single checkbox in the shared cluster plan. Use this when you complete (or un-complete) a plan item. Match by `taskText` (a unique substring of the item's text) — that's stable across plan edits. Use `lineIndex` only when you read the plan yourself and pulled a fresh line number this turn. Returns the before/after state so you can confirm the toggle landed.\n\nDoes NOT replace text or add items — only flips the leading `[ ]` ↔ `[x]`. Use cluster_plan_write to author/rewrite the plan body.",
      inputSchema: {
        lineIndex: z.number().int().nonnegative().optional().describe('0-based line offset in the plan body. Mutually exclusive with taskText.'),
        taskText: z.string().min(1).optional().describe('Unique case-insensitive substring of the checkbox item text. Mutually exclusive with lineIndex.'),
      },
    },
    async (args) => {
      try {
        const r = await callPlanTick({ lineIndex: args.lineIndex, taskText: args.taskText });
        if (!r.ok) {
          const detail = r.err.message ?? r.err.error ?? 'unknown_error';
          return textResult(`[error] ${r.err.error ?? 'plan_tick_failed'}: ${detail}`, true);
        }
        return textResult(r.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr('cluster_plan_tick failed:', msg);
        return textResult(`[error] cluster_plan_tick failed: ${msg}`, true);
      }
    },
  );

  server.registerTool(
    'cluster_plan_write',
    {
      description:
        "Write the shared cluster plan body (markdown). Use this to author the initial plan or append/restructure its tasks as scope evolves. The plan holds standing rules and tasks only: never write progress/status notes, evidence, commit hashes, CI ids, test counts, or dates into it (those belong on board tasks or in artifacts). Model-driven writes are additive: if a plan already exists, the server rejects writes that remove existing checkbox tasks or change their `[ ]`/`[x]` status. Use cluster_plan_tick for status changes, and ask the operator to replace/clear the plan from the PLAN tab for destructive edits. Body cannot be empty and is capped at 32768 chars.\n\nConvention: only the cluster director should call this. Other members should propose plan changes via peer_send to the director rather than writing directly.\n\nIMPORTANT: if the plan copy in your context is marked as an outline (prose omitted), call cluster_plan_read FIRST and base your rewrite on the full body — rewriting from the outline would silently delete the plan's prose.",
      inputSchema: {
        body: z.string().min(1).max(32768).describe('New markdown body for the plan. Must be non-empty, ≤32768 chars.'),
      },
    },
    async (args) => {
      try {
        const r = await callPlanWrite(args.body);
        if (!r.ok) {
          const detail = r.err.message ?? r.err.error ?? 'unknown_error';
          return textResult(`[error] ${r.err.error ?? 'plan_write_failed'}: ${detail}`, true);
        }
        return textResult(r.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr('cluster_plan_write failed:', msg);
        return textResult(`[error] cluster_plan_write failed: ${msg}`, true);
      }
    },
  );

  server.registerTool(
    'peer_read',
    {
      description:
        'Drain your own mailbox NOW (mid-turn). Returns any peer messages that arrived since your last operator turn. Same messages that would auto-inject as a system block on your next operator turn — calling peer_read consumes them so they will not re-inject.',
      inputSchema: {},
    },
    async () => {
      try {
        const drained = await callPeerRead();
        return textResult(drained);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr('peer_read failed:', msg);
        return textResult(`[error] peer_read failed: ${msg}`, true);
      }
    },
  );

  if (!taskBoardAttached) return;

  server.registerTool(
    'cluster_task_list',
    {
      description:
        "List the shared task board for your cluster (the cwd-scoped project task ledger). Returns each task's id, title, status (triage / todo / ready / in_progress / blocked / review / done / archived), assignee (the workflowId of the member who claimed it, if any), links, and kernel metadata. Use this to find unclaimed work before claiming, or to check who owns what. Read-only. Cluster mode only.",
      inputSchema: {},
    },
    async () => {
      try {
        const rows = await callTaskList();
        return textResult(rows);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr('cluster_task_list failed:', msg);
        return textResult(`[error] cluster_task_list failed: ${msg}`, true);
      }
    },
  );

  server.registerTool(
    'cluster_task_claim',
    {
      description:
        "Claim a task on the shared cluster board: takes ownership (sets assignee to YOU) and moves it to in_progress. Pass the task `id` from cluster_task_list. If the task is already claimed by a different member, the claim is REJECTED (already_claimed) — coordinate via peer_send before taking it over. Re-claiming a task you already own is a no-op.",
      inputSchema: {
        id: z.string().min(1).describe('Task id from cluster_task_list.'),
      },
    },
    async (args) => {
      try {
        const r = await callTaskClaim(args.id);
        if (!r.ok) {
          const detail = r.err.message ?? r.err.error ?? 'unknown_error';
          return textResult(`[error] ${r.err.error ?? 'task_claim_failed'}: ${detail}`, true);
        }
        return textResult(r.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr('cluster_task_claim failed:', msg);
        return textResult(`[error] cluster_task_claim failed: ${msg}`, true);
      }
    },
  );

  server.registerTool(
    'cluster_task_create',
    {
      description:
        'Create a non-terminal task on the shared cluster board. New tasks start as todo; done/archived remain operator-only. Use title plus optional body/notes, assignee, priority, parentIds, links, reviewRequired, goalMode, and goalMaxTurns. parentIds must refer to existing tasks. When the task implements a plan item, start the title with that item\'s id or text (e.g. \'P6.9 Live tab drag follow on X11\'): cluster_task_show then resolves the item\'s reference docs (its own ref links, its sub-bullets, its phase intro) for whoever works it. Add any extra ref:slug links the task needs to notes.',
      inputSchema: {
        title: z.string().min(1).describe('Task title. Required and non-empty.'),
        body: z.string().optional().describe('Initial task body. Alias for notes when notes is absent.'),
        notes: z.string().optional().describe('Initial task notes.'),
        assignee: z.string().optional().describe('Optional assignee workflowId or unique workflowId prefix in this cluster.'),
        priority: z.number().optional().describe('Optional integer priority.'),
        parentIds: z.array(z.string()).optional().describe('Optional existing parent task ids this task depends on.'),
        links: z.array(z.object({
          kind: z.enum(['plan', 'review', 'workflow', 'url']),
          ref: z.string(),
          label: z.string().optional(),
        })).optional().describe('Optional Arco references linked from this task.'),
        reviewRequired: z.boolean().optional(),
        goalMode: z.boolean().optional(),
        goalMaxTurns: z.number().optional(),
      },
    },
    async (args) => {
      try {
        const r = await callTaskCreate({
          title: args.title,
          body: args.body,
          notes: args.notes,
          assignee: args.assignee,
          priority: args.priority,
          parentIds: args.parentIds,
          links: args.links,
          reviewRequired: args.reviewRequired,
          goalMode: args.goalMode,
          goalMaxTurns: args.goalMaxTurns,
        });
        if (!r.ok) {
          const detail = r.err.message ?? r.err.error ?? 'unknown_error';
          return textResult(`[error] ${r.err.error ?? 'task_create_failed'}: ${detail}`, true);
        }
        return textResult(r.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr('cluster_task_create failed:', msg);
        return textResult(`[error] cluster_task_create failed: ${msg}`, true);
      }
    },
  );

  server.registerTool(
    'cluster_task_show',
    {
      description:
        'Show full detail for one shared task: task fields, parent tasks, child tasks, durable comments, and recent run records, plus referenceDocs (the plan reference docs the task links — read them before starting). Call this before starting assigned work so you have the latest handoff thread and spec.',
      inputSchema: {
        id: z.string().min(1).describe('Task id from cluster_task_list.'),
      },
    },
    async (args) => {
      try {
        const details = await callTaskShow(args.id);
        return textResult(details);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr('cluster_task_show failed:', msg);
        return textResult(`[error] cluster_task_show failed: ${msg}`, true);
      }
    },
  );

  server.registerTool(
    'cluster_task_heartbeat',
    {
      description:
        'Record that you are still actively working on a task. Updates or creates your run heartbeat record so cluster_task_show exposes recent run activity. Optional note is stored durably as a heartbeat comment and run metadata.',
      inputSchema: {
        id: z.string().min(1).describe('Task id from cluster_task_list.'),
        note: z.string().optional().describe('Optional short heartbeat note.'),
      },
    },
    async (args) => {
      try {
        const r = await callTaskHeartbeat({ id: args.id, note: args.note });
        if (!r.ok) {
          const detail = r.err.message ?? r.err.error ?? 'unknown_error';
          return textResult(`[error] ${r.err.error ?? 'task_heartbeat_failed'}: ${detail}`, true);
        }
        return textResult(r.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr('cluster_task_heartbeat failed:', msg);
        return textResult(`[error] cluster_task_heartbeat failed: ${msg}`, true);
      }
    },
  );

  server.registerTool(
    'cluster_task_update',
    {
      description:
        "Update a task on the shared cluster board. Change its `status` (triage / todo / ready / in_progress / blocked / review), replace `notes`, and/or record a `signoff` verdict. IMPORTANT: `done` and `archived` are OPERATOR-ONLY — those statuses are REJECTED here (operator_gated). When you finish work, move the task to review or report completion via peer_send to the director; the operator marks done from the LEDGER tab.\n\nSIGN-OFF (director): when you review a peer's completed task, set `signoff` to your verdict — `met`, `not_met`, or `partial` — with a one-line `summary`. ADVISORY only: it does NOT mark the task done; it surfaces a recommendation on the board so the operator can accept at a glance. Only the reviewing member (the director) should set this.",
      inputSchema: {
        id: z.string().min(1).describe('Task id from cluster_task_list.'),
        status: z.enum(['triage', 'todo', 'ready', 'in_progress', 'blocked', 'review']).optional().describe("New status. 'done' and 'archived' are rejected — operator-only."),
        notes: z.string().optional().describe('Replacement notes body for the task.'),
        signoff: z.object({
          state: z.enum(['met', 'not_met', 'partial']).describe('Your verdict: met / not_met / partial.'),
          summary: z.string().optional().describe('One-line reason shown on the board card.'),
        }).optional().describe('Advisory director verdict on whether the task met its target. Does NOT mark it done.'),
      },
    },
    async (args) => {
      try {
        const r = await callTaskUpdate({ id: args.id, status: args.status, notes: args.notes, signoff: args.signoff });
        if (!r.ok) {
          const detail = r.err.message ?? r.err.error ?? 'unknown_error';
          return textResult(`[error] ${r.err.error ?? 'task_update_failed'}: ${detail}`, true);
        }
        return textResult(r.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr('cluster_task_update failed:', msg);
        return textResult(`[error] cluster_task_update failed: ${msg}`, true);
      }
    },
  );

  server.registerTool(
    'cluster_task_comment',
    {
      description:
        'Append a durable comment to a shared task. Use this for handoffs, findings, status notes, or questions that should survive across workers and sessions.',
      inputSchema: {
        id: z.string().min(1).describe('Task id from cluster_task_list.'),
        body: z.string().min(1).describe('Comment body.'),
      },
    },
    async (args) => {
      try {
        const r = await callTaskComment({ id: args.id, body: args.body });
        if (!r.ok) {
          const detail = r.err.message ?? r.err.error ?? 'unknown_error';
          return textResult(`[error] ${r.err.error ?? 'task_comment_failed'}: ${detail}`, true);
        }
        return textResult(r.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr('cluster_task_comment failed:', msg);
        return textResult(`[error] cluster_task_comment failed: ${msg}`, true);
      }
    },
  );

  server.registerTool(
    'cluster_task_link',
    {
      description:
        'Add a dependency link: childId depends on parentId. The server rejects self-links and cycles. Use this to build a task graph for dispatcher/reviewer workflows.',
      inputSchema: {
        parentId: z.string().min(1).describe('Task id that must be completed first.'),
        childId: z.string().min(1).describe('Task id that depends on parentId.'),
      },
    },
    async (args) => {
      try {
        const r = await callTaskLink({ parentId: args.parentId, childId: args.childId });
        if (!r.ok) {
          const detail = r.err.message ?? r.err.error ?? 'unknown_error';
          return textResult(`[error] ${r.err.error ?? 'task_link_failed'}: ${detail}`, true);
        }
        return textResult(r.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr('cluster_task_link failed:', msg);
        return textResult(`[error] cluster_task_link failed: ${msg}`, true);
      }
    },
  );

  server.registerTool(
    'cluster_task_unlink',
    {
      description:
        'Remove a dependency link: childId no longer depends on parentId. Use carefully; the event is logged and visible to the operator.',
      inputSchema: {
        parentId: z.string().min(1).describe('Parent dependency task id.'),
        childId: z.string().min(1).describe('Child task id.'),
      },
    },
    async (args) => {
      try {
        const r = await callTaskUnlink({ parentId: args.parentId, childId: args.childId });
        if (!r.ok) {
          const detail = r.err.message ?? r.err.error ?? 'unknown_error';
          return textResult(`[error] ${r.err.error ?? 'task_unlink_failed'}: ${detail}`, true);
        }
        return textResult(r.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr('cluster_task_unlink failed:', msg);
        return textResult(`[error] cluster_task_unlink failed: ${msg}`, true);
      }
    },
  );

  server.registerTool(
    'cluster_task_block',
    {
      description:
        'Block a task with a human-readable reason. Moves the task to blocked, stores blockedReason, and appends a durable BLOCKED comment. Use this when you need operator input, missing context, or a dependency.',
      inputSchema: {
        id: z.string().min(1).describe('Task id from cluster_task_list.'),
        reason: z.string().min(1).describe('Why this task is blocked.'),
      },
    },
    async (args) => {
      try {
        const r = await callTaskBlock({ id: args.id, reason: args.reason });
        if (!r.ok) {
          const detail = r.err.message ?? r.err.error ?? 'unknown_error';
          return textResult(`[error] ${r.err.error ?? 'task_block_failed'}: ${detail}`, true);
        }
        return textResult(r.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr('cluster_task_block failed:', msg);
        return textResult(`[error] cluster_task_block failed: ${msg}`, true);
      }
    },
  );

  server.registerTool(
    'cluster_task_complete',
    {
      description:
        "Submit a completion report for a task. Moves the task to review and appends a durable COMPLETION REPORT comment. It does NOT mark done; done remains operator-only.",
      inputSchema: {
        id: z.string().min(1).describe('Task id from cluster_task_list.'),
        summary: z.string().min(1).describe('What changed, tests run, files touched, and follow-ups.'),
      },
    },
    async (args) => {
      try {
        const r = await callTaskComplete({ id: args.id, summary: args.summary });
        if (!r.ok) {
          const detail = r.err.message ?? r.err.error ?? 'unknown_error';
          return textResult(`[error] ${r.err.error ?? 'task_complete_failed'}: ${detail}`, true);
        }
        return textResult(r.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr('cluster_task_complete failed:', msg);
        return textResult(`[error] cluster_task_complete failed: ${msg}`, true);
      }
    },
  );
}
