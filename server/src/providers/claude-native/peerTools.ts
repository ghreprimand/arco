// CLUSTER_MODE_PLAN.md Phase 1 — Native peer tools.
//
// Three tools registered into the worker's tool list ONLY when
// worker.config.clusterId is set (plan §6.1d acceptance: leaking peer
// tools into non-cluster workflows breaks the no-orchestrator
// invariant). Tool names use underscores, not the plan's `peer.*`
// dotted form — Anthropic's tool name regex is
// `^[a-zA-Z0-9_-]{1,64}$`, periods get rejected at API call time.
// Decision logged in CLUSTER_MODE_PLAN.md §13.
//
// Phase 3 — handler bodies moved to server/src/clusterPeerOps.ts so the
// REST surface used by the CLI MCP child fires identical events. This
// file is the Native tool-descriptor + dispatch glue; clusterPeerOps is
// the wire surface.

import type { ClaudeToolDef } from './tools.js';
import type { ClusterMemberAccessMode, ServerMessage, LedgerTaskStatus, TaskLink } from '@arco/shared';
import * as peerOps from '../../clusterPeerOps.js';
import { formatBoardForModel } from '../../project/taskLedger.js';

export interface PeerToolContext {
  workflowId: string;     // calling member's workflowId
  clusterId: string;      // calling member's cluster
  taskBoardAttached?: boolean;
  accessMode?: ClusterMemberAccessMode;
  // Workflow-scoped event broadcaster wired by the worker (same channel
  // as hook_rewrote_input / tool_filtered etc). peer.send fires
  // peer_message_sent here on success and peer_send_rejected on budget
  // violation; peer.read also fires peer_message_received per drained
  // item on the recipient's channel — `broadcastRecipient` is supplied
  // by the worker so the recipient's events.jsonl carries the delivery
  // record same as the pre-turn injection path.
  broadcast: (msg: ServerMessage) => void;
  broadcastRecipient?: (toWfId: string, msg: ServerMessage) => void;
  // Cluster-scoped broadcaster (fans out to every WS subscribed to this
  // cluster). Used by cluster_plan_tick to emit cluster_plan_changed so all
  // members + the cluster tab re-render. When the worker doesn't supply
  // this, peer_plan_tick falls back to the workflow-scoped `broadcast`
  // (still observable in the sender's events.jsonl, just not cluster-wide).
  broadcastCluster?: (msg: ServerMessage) => void;
}

const PEER_TOOL_NAMES = new Set([
  'peer_list',
  'peer_send',
  'peer_read',
  'cluster_plan_read',
  'cluster_plan_tick',
  'cluster_plan_write',
  // §D3 task-board peer-tools. Underscores only (Anthropic name regex); the
  // MCP-prefixed form on CLI/Codex is mcp__arco-cluster__cluster_task_*.
  'cluster_task_list',
  'cluster_task_show',
  'cluster_task_create',
  'cluster_task_claim',
  'cluster_task_update',
  'cluster_task_heartbeat',
  'cluster_task_link',
  'cluster_task_unlink',
  'cluster_task_comment',
  'cluster_task_block',
  'cluster_task_complete',
]);

const TASK_TOOL_NAMES = new Set([
  'cluster_task_list',
  'cluster_task_show',
  'cluster_task_create',
  'cluster_task_claim',
  'cluster_task_update',
  'cluster_task_heartbeat',
  'cluster_task_link',
  'cluster_task_unlink',
  'cluster_task_comment',
  'cluster_task_block',
  'cluster_task_complete',
]);

export function isPeerTool(name: string): boolean {
  return PEER_TOOL_NAMES.has(name);
}

export function getPeerToolDefinitions(opts?: {
  taskBoardAttached?: boolean;
  accessMode?: ClusterMemberAccessMode;
}): ClaudeToolDef[] {
  const defs: ClaudeToolDef[] = [
    {
      name: 'peer_list',
      description:
        'List the other members of the cluster you belong to. Returns each peer\'s workflowId, 8-char display name, pending mailbox depth, optional role, optional builder-tier hint, and optional focus string (sub-specialty). Use `role` to identify coordinator/director/reviewer responsibilities; use `tier` to match task complexity to builder capability: `light` = quick edits, renames, simple commands; `standard` = normal feature work; `heavy` = architectural changes, complex refactors. Use `focus` to disambiguate same-role peers — it\'s a free-form description of what THIS specific peer specializes in (e.g. "React frontend, Zustand patterns" or "database performance, sqlc"). When choosing between similar peers, prefer the one whose focus matches the task. Role/tier/focus are absent when the operator hasn\'t set them. Cluster mode only.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'peer_send',
      description:
        'Send a note to a peer in your cluster. `to` accepts the peer\'s full workflowId, unique 8-char prefix, unique displayName, or unique role text such as "Coordinator" when only one peer has that role. Prefer peer_list first, then use displayName/workflowId when possible. `content` is up to 16 KB. The recipient sees the message as a system block prepended to their next operator turn. There is a hard per-sender per-turn send cap (it tightens at higher cluster efficiency levels); the budget resets each time the operator advances your turn, and a rejected send returns budget_exhausted with the current count and cap.\n\nWhen the operator asks you to "send" / "share" / "deliver" a document, review, plan, or other artifact to a peer, paste the FULL body inline as `content` — do not summarize unless the operator explicitly asked for a summary. Up to 16 KB fits a typical review or plan. If the content exceeds 16 KB, split it across multiple peer_send calls in order (e.g. "Part 1/3", "Part 2/3").',
      input_schema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Peer 8-char display name or full workflowId.' },
          content: { type: 'string', description: 'Message body (≤ 16 KB UTF-8).' },
          artifact_paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'ISOLATED members only: up to 8 paths inside the private workspace (256 KB total) to copy into the recipient workspace.',
          },
        },
        required: ['to', 'content'],
      },
    },
    {
      name: 'peer_read',
      description:
        'Drain your own mailbox NOW (mid-turn). Returns any peer messages that arrived since your last operator turn. Same messages that would auto-inject as a system block on your next operator turn — calling peer_read consumes them so they will not re-inject.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'cluster_plan_read',
      description:
        'Read the full shared cluster plan (markdown body + title + updatedAt). The plan copy injected into your context at turn start may be an OUTLINE (headings, checkbox lines, and labelled standing-directive sections; other prose omitted) when the full plan is large — call this whenever you need the complete text, e.g. before cluster_plan_write or when an outline item needs its surrounding detail. Read-only; cluster mode only.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'cluster_plan_tick',
      description:
        "Toggle a single checkbox in the shared cluster plan. Use this when you complete (or un-complete) a plan item. Match by `taskText` (a unique substring of the item's text) — that's stable across plan edits. Use `lineIndex` only when you read the plan yourself and pulled a fresh line number this turn. Returns the before/after state so you can confirm the toggle landed.\n\nDoes NOT replace text or add items — only flips the leading `[ ]` ↔ `[x]`. Use cluster_plan_write to author/rewrite the plan body.",
      input_schema: {
        type: 'object',
        // Anthropic does NOT support oneOf/allOf/anyOf at the top level of
        // input_schema (returns 400 invalid_request_error on the
        // messages.create). Flatten to both fields optional, and let the
        // dispatcher enforce "exactly one of lineIndex / taskText" via the
        // `invalid_matcher` error code. The description encodes the
        // either/or contract verbatim so the model still picks one.
        properties: {
          lineIndex: { type: 'number', description: '0-based line offset in the plan body. Use only when you read the plan yourself and pulled a fresh line number this turn.' },
          taskText: { type: 'string', description: 'Unique case-insensitive substring of the checkbox item text. Preferred — stable across plan edits.' },
        },
      },
    },
    {
      name: 'cluster_plan_write',
      description:
        "Write the shared cluster plan body (markdown). Use this to author the initial plan or append/restructure its tasks as scope evolves. The plan holds standing rules and tasks only: never write progress/status notes, evidence, commit hashes, CI ids, test counts, or dates into it (those belong on board tasks or in artifacts). Model-driven writes are additive: if a plan already exists, the server rejects writes that remove existing checkbox tasks or change their `[ ]`/`[x]` status. Use cluster_plan_tick for status changes, and ask the operator to replace/clear the plan from the PLAN tab for destructive edits. Body cannot be empty and is capped at 32768 chars.\n\nConvention: only the cluster director should call this. Other members should propose plan changes via peer_send to the director rather than writing directly.\n\nIMPORTANT: if the plan copy in your context is marked as an outline (prose omitted), call cluster_plan_read FIRST and base your rewrite on the full body — rewriting from the outline would silently delete the plan's prose.",
      input_schema: {
        type: 'object',
        properties: {
          body: { type: 'string', description: 'New markdown body for the plan. Must be non-empty, ≤32768 chars.' },
        },
        required: ['body'],
      },
    },
    {
      name: 'cluster_task_list',
      description:
        "List the shared task board for your cluster (the cwd-scoped project task ledger). Returns each task's id, title, status (triage / todo / ready / in_progress / blocked / review / done / archived), assignee (the workflowId of the member who claimed it, if any), links, and kernel metadata. Use this to find unclaimed work before claiming, or to check who owns what. Read-only — does not mutate. Cluster mode only.",
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'cluster_task_show',
      description:
        'Show full detail for one shared task: task fields, parent tasks, child tasks, durable comments, and recent run records, plus referenceDocs (the plan reference docs the task links — read them before starting). Call this before starting assigned work so you have the latest handoff thread and spec.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from cluster_task_list.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'cluster_task_create',
      description:
        'Create a non-terminal task on the shared cluster board. New tasks start as todo; done/archived remain operator-only. Use title plus optional body/notes, assignee, priority, parentIds, links, reviewRequired, goalMode, and goalMaxTurns. parentIds must refer to existing tasks. When the task implements a plan item, start the title with that item\'s id or text (e.g. \'P6.9 Live tab drag follow on X11\'): cluster_task_show then resolves the item\'s reference docs (its own ref links, its sub-bullets, its phase intro) for whoever works it. Add any extra ref:slug links the task needs to notes.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title. Required and non-empty.' },
          body: { type: 'string', description: 'Initial task body. Alias for notes when notes is absent.' },
          notes: { type: 'string', description: 'Initial task notes.' },
          assignee: { type: 'string', description: 'Optional assignee workflowId or unique workflowId prefix in this cluster.' },
          priority: { type: 'number', description: 'Optional integer priority. Higher numbers sort earlier where supported.' },
          parentIds: { type: 'array', items: { type: 'string' }, description: 'Optional existing parent task ids this task depends on.' },
          links: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['plan', 'review', 'workflow', 'url'] },
                ref: { type: 'string' },
                label: { type: 'string' },
              },
              required: ['kind', 'ref'],
            },
          },
          reviewRequired: { type: 'boolean' },
          goalMode: { type: 'boolean' },
          goalMaxTurns: { type: 'number' },
        },
        required: ['title'],
      },
    },
    {
      name: 'cluster_task_claim',
      description:
        "Claim a task on the shared cluster board: takes ownership (sets assignee to YOU) and moves it to in_progress. Pass the task `id` from cluster_task_list. If the task is already claimed by a different member, the claim is REJECTED (already_claimed) — coordinate via peer_send before taking it over rather than stomping their work. Re-claiming a task you already own is a no-op.",
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from cluster_task_list.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'cluster_task_update',
      description:
        "Update a task on the shared cluster board. Change its `status` (triage / todo / ready / in_progress / blocked / review), append/replace `notes`, and/or record a `signoff` verdict. IMPORTANT: `done` and `archived` are OPERATOR-ONLY — those statuses are REJECTED here (operator_gated). When you finish work, move the task to review or report completion to the director via peer_send; the operator marks done from the LEDGER tab.\n\nSIGN-OFF (director): when you review a peer's completed task (e.g. one in `review`), set `signoff` to your verdict on whether it met its target — `met`, `not_met`, or `partial` — with a one-line `summary`. This is ADVISORY: it does NOT mark the task done (that stays operator-only); it surfaces a recommendation on the board so the operator can accept at a glance. Sign off as part of the same update where you move the task to `review`. Only the reviewing member (the director) should set this.",
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from cluster_task_list.' },
          status: { type: 'string', enum: ['triage', 'todo', 'ready', 'in_progress', 'blocked', 'review'], description: "New status. 'done' and 'archived' are rejected — operator-only." },
          notes: { type: 'string', description: 'Replacement notes body for the task.' },
          signoff: {
            type: 'object',
            description: 'Advisory director verdict on whether the task met its target. Does NOT mark it done.',
            properties: {
              state: { type: 'string', enum: ['met', 'not_met', 'partial'], description: 'Your verdict: met / not_met / partial.' },
              summary: { type: 'string', description: 'One-line reason shown on the board card.' },
            },
            required: ['state'],
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'cluster_task_heartbeat',
      description:
        'Record that you are still actively working on a task. Updates or creates your run heartbeat record so cluster_task_show exposes recent run activity. Optional note is stored durably as a heartbeat comment and run metadata.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from cluster_task_list.' },
          note: { type: 'string', description: 'Optional short heartbeat note.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'cluster_task_comment',
      description:
        'Append a durable comment to a shared task. Use this for handoffs, findings, status notes, or questions that should survive across workers and sessions.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from cluster_task_list.' },
          body: { type: 'string', description: 'Comment body.' },
        },
        required: ['id', 'body'],
      },
    },
    {
      name: 'cluster_task_link',
      description:
        'Add a dependency link: childId depends on parentId. The server rejects self-links and cycles. Use this to build a task graph for dispatcher/reviewer workflows.',
      input_schema: {
        type: 'object',
        properties: {
          parentId: { type: 'string', description: 'Task id that must be completed first.' },
          childId: { type: 'string', description: 'Task id that depends on parentId.' },
        },
        required: ['parentId', 'childId'],
      },
    },
    {
      name: 'cluster_task_unlink',
      description:
        'Remove a dependency link: childId no longer depends on parentId. Use carefully; the event is logged and visible to the operator.',
      input_schema: {
        type: 'object',
        properties: {
          parentId: { type: 'string', description: 'Parent dependency task id.' },
          childId: { type: 'string', description: 'Child task id.' },
        },
        required: ['parentId', 'childId'],
      },
    },
    {
      name: 'cluster_task_block',
      description:
        'Block a task with a human-readable reason. Moves the task to blocked, stores blockedReason, and appends a durable BLOCKED comment. Use this when you need operator input, missing context, or a dependency.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from cluster_task_list.' },
          reason: { type: 'string', description: 'Why this task is blocked.' },
        },
        required: ['id', 'reason'],
      },
    },
    {
      name: 'cluster_task_complete',
      description:
        "Submit a completion report for a task YOU OWN. Moves the task to review and appends a durable COMPLETION REPORT comment. You can only complete a task currently assigned to you — completing an unknown id is rejected (not_found) and completing another member's or an unassigned task is rejected (not_owner); claim it first (cluster_task_claim) or coordinate via peer_send. It does NOT mark done; done remains operator-only.",
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from cluster_task_list.' },
          summary: { type: 'string', description: 'What changed, tests run, files touched, and follow-ups.' },
        },
        required: ['id', 'summary'],
      },
    },
  ];
  if (opts?.accessMode && opts.accessMode !== 'standard') {
    return defs.filter((def) => def.name === 'peer_send' || def.name === 'peer_read');
  }
  return opts?.taskBoardAttached === true ? defs : defs.filter((def) => !TASK_TOOL_NAMES.has(def.name));
}

function asString(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`argument "${name}" must be a string`);
  return v;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((item): item is string => typeof item === 'string');
}

export async function executePeerTool(
  name: string,
  args: Record<string, unknown>,
  ctx: PeerToolContext,
): Promise<string> {
  if (ctx.accessMode && ctx.accessMode !== 'standard' && name !== 'peer_send' && name !== 'peer_read') {
    return `[error] access_denied: ${ctx.accessMode} cluster members only have peer_send and peer_read.`;
  }
  if (TASK_TOOL_NAMES.has(name) && ctx.taskBoardAttached !== true) {
    return '[error] board_detached: the project task board is not attached to this cluster.';
  }
  // Recipient-side delivery events default to the same workflow-scoped
  // broadcaster the sender uses when the worker doesn't supply a per-
  // recipient channel (the in-process Native path can route both through
  // the global broadcastWorkflow because every workflow's events ride the
  // same `wf.observers` set).
  const opsCtx: peerOps.PeerOpsContext = {
    workflowId: ctx.workflowId,
    clusterId: ctx.clusterId,
    broadcastSender: ctx.broadcast,
    broadcastRecipient: ctx.broadcastRecipient ?? ((_to, msg) => ctx.broadcast(msg)),
  };
  switch (name) {
    case 'peer_list': {
      const rows = await peerOps.peerList(opsCtx);
      return JSON.stringify(rows, null, 2);
    }
    case 'peer_send': {
      const to = asString(args.to, 'to');
      const content = asString(args.content, 'content');
      const result = await peerOps.peerSend(opsCtx, {
        to,
        content,
        ...(Array.isArray(args.artifact_paths)
          ? { artifactPaths: args.artifact_paths.filter((p): p is string => typeof p === 'string') }
          : {}),
      });
      if (!result.ok) return `[error] ${result.message}`;
      return JSON.stringify(
        { msgId: result.msgId, to: result.to, deliveredImmediately: result.deliveredImmediately },
        null,
        2,
      );
    }
    case 'peer_read': {
      const projected = await peerOps.peerRead(opsCtx);
      return JSON.stringify(projected, null, 2);
    }
    case 'cluster_plan_read': {
      const result = await peerOps.peerPlanRead(opsCtx);
      if (!result.ok) return `[error] ${result.code}: ${result.message}`;
      return JSON.stringify(
        { title: result.title, body: result.body, updatedAt: result.updatedAt, byteLength: result.byteLength },
        null,
        2,
      );
    }
    case 'cluster_plan_tick': {
      // The model may pass either field; validate without throwing so the
      // dispatcher can surface a structured error code instead of a runtime
      // exception. Empty / both-present payloads fall through to
      // peerPlanTick which returns `invalid_matcher`.
      const matcher = typeof args.lineIndex === 'number'
        ? { lineIndex: args.lineIndex }
        : typeof args.taskText === 'string'
          ? { taskText: args.taskText }
          : ({} as peerOps.PeerPlanTickMatcher);
      // Fall back to the workflow-scoped broadcaster when the worker didn't
      // supply a cluster-scoped one; the event still lands in the sender's
      // events.jsonl so the audit trail isn't lost.
      const bcastCluster = ctx.broadcastCluster ?? ctx.broadcast;
      const result = await peerOps.peerPlanTick(opsCtx, matcher, bcastCluster);
      if (!result.ok) return `[error] ${result.code}: ${result.message}`;
      return JSON.stringify(
        { toggledLine: result.toggledLine, before: result.before, after: result.after },
        null,
        2,
      );
    }
    case 'cluster_plan_write': {
      const body = asString(args.body, 'body');
      const bcastCluster = ctx.broadcastCluster ?? ctx.broadcast;
      const result = await peerOps.peerPlanWrite(opsCtx, body, bcastCluster);
      if (!result.ok) return `[error] ${result.code}: ${result.message}`;
      return JSON.stringify(
        { bodyLength: result.bodyLength, updatedAt: result.updatedAt },
        null,
        2,
      );
    }
    case 'cluster_task_list': {
      const result = await peerOps.peerTaskList(opsCtx);
      if (!result.ok) return `[error] ${result.code}: ${result.message}`;
      // Compact, always-valid board view — the raw full-ledger dump blew the
      // 64KB tool-output cap and truncated away the active rows. See
      // taskLedger.formatBoardForModel.
      return formatBoardForModel(result.tasks);
    }
    case 'cluster_task_show': {
      const id = asString(args.id, 'id');
      const result = await peerOps.peerTaskShow(opsCtx, { id });
      if (!result.ok) return `[error] ${result.code}: ${result.message}`;
      return JSON.stringify(result.details, null, 2);
    }
    case 'cluster_task_create': {
      const title = asString(args.title, 'title');
      const bcastCluster = ctx.broadcastCluster ?? ctx.broadcast;
      const result = await peerOps.peerTaskCreate(
        opsCtx,
        {
          title,
          ...(typeof args.body === 'string' ? { body: args.body } : {}),
          ...(typeof args.notes === 'string' ? { notes: args.notes } : {}),
          ...(typeof args.assignee === 'string' ? { assignee: args.assignee } : {}),
          ...(typeof args.priority === 'number' ? { priority: args.priority } : {}),
          ...(Array.isArray(args.parentIds) ? { parentIds: asStringArray(args.parentIds) } : {}),
          ...(Array.isArray(args.links) ? { links: args.links as TaskLink[] } : {}),
          ...(typeof args.reviewRequired === 'boolean' ? { reviewRequired: args.reviewRequired } : {}),
          ...(typeof args.goalMode === 'boolean' ? { goalMode: args.goalMode } : {}),
          ...(typeof args.goalMaxTurns === 'number' ? { goalMaxTurns: args.goalMaxTurns } : {}),
          ...(typeof args.status === 'string' ? { status: args.status as LedgerTaskStatus } : {}),
        },
        bcastCluster,
      );
      if (!result.ok) return `[error] ${result.code}: ${result.message}`;
      return JSON.stringify(result.task, null, 2);
    }
    case 'cluster_task_claim': {
      const id = asString(args.id, 'id');
      const bcastCluster = ctx.broadcastCluster ?? ctx.broadcast;
      const result = await peerOps.peerTaskClaim(opsCtx, { id }, bcastCluster);
      if (!result.ok) return `[error] ${result.code}: ${result.message}`;
      return JSON.stringify(result.task, null, 2);
    }
    case 'cluster_task_heartbeat': {
      const id = asString(args.id, 'id');
      const bcastCluster = ctx.broadcastCluster ?? ctx.broadcast;
      const result = await peerOps.peerTaskHeartbeat(
        opsCtx,
        { id, ...(typeof args.note === 'string' ? { note: args.note } : {}) },
        bcastCluster,
      );
      if (!result.ok) return `[error] ${result.code}: ${result.message}`;
      return JSON.stringify({ run: result.run, ...(result.comment ? { comment: result.comment } : {}) }, null, 2);
    }
    case 'cluster_task_comment': {
      const id = asString(args.id, 'id');
      const body = asString(args.body, 'body');
      const bcastCluster = ctx.broadcastCluster ?? ctx.broadcast;
      const result = await peerOps.peerTaskComment(opsCtx, { id, body }, bcastCluster);
      if (!result.ok) return `[error] ${result.code}: ${result.message}`;
      return JSON.stringify(result.comment, null, 2);
    }
    case 'cluster_task_link': {
      const parentId = asString(args.parentId, 'parentId');
      const childId = asString(args.childId, 'childId');
      const bcastCluster = ctx.broadcastCluster ?? ctx.broadcast;
      const result = await peerOps.peerTaskLink(opsCtx, { parentId, childId }, bcastCluster);
      if (!result.ok) return `[error] ${result.code}: ${result.message}`;
      return JSON.stringify(result.task, null, 2);
    }
    case 'cluster_task_unlink': {
      const parentId = asString(args.parentId, 'parentId');
      const childId = asString(args.childId, 'childId');
      const bcastCluster = ctx.broadcastCluster ?? ctx.broadcast;
      const result = await peerOps.peerTaskUnlink(opsCtx, { parentId, childId }, bcastCluster);
      if (!result.ok) return `[error] ${result.code}: ${result.message}`;
      return JSON.stringify(result.task, null, 2);
    }
    case 'cluster_task_block': {
      const id = asString(args.id, 'id');
      const reason = asString(args.reason, 'reason');
      const bcastCluster = ctx.broadcastCluster ?? ctx.broadcast;
      const result = await peerOps.peerTaskBlock(opsCtx, { id, reason }, bcastCluster);
      if (!result.ok) return `[error] ${result.code}: ${result.message}`;
      return JSON.stringify(result.task, null, 2);
    }
    case 'cluster_task_complete': {
      const id = asString(args.id, 'id');
      const summary = asString(args.summary, 'summary');
      const bcastCluster = ctx.broadcastCluster ?? ctx.broadcast;
      const result = await peerOps.peerTaskComplete(opsCtx, { id, summary }, bcastCluster);
      if (!result.ok) return `[error] ${result.code}: ${result.message}`;
      return JSON.stringify(result.task, null, 2);
    }
    case 'cluster_task_update': {
      const id = asString(args.id, 'id');
      const bcastCluster = ctx.broadcastCluster ?? ctx.broadcast;
      const result = await peerOps.peerTaskUpdate(
        opsCtx,
        {
          id,
          // Cast is safe: peerTaskUpdate validates + rejects 'done' (and any
          // non-status string falls through to applyUpdate's VALID_STATUS gate).
          ...(typeof args.status === 'string' ? { status: args.status as LedgerTaskStatus } : {}),
          ...(typeof args.notes === 'string' ? { notes: args.notes } : {}),
          // §D3 — advisory sign-off; peerTaskUpdate validates state + stamps author.
          ...(args.signoff !== undefined ? { signoff: args.signoff as { state?: string; summary?: string } | null } : {}),
        },
        bcastCluster,
      );
      if (!result.ok) return `[error] ${result.code}: ${result.message}`;
      return JSON.stringify(result.task, null, 2);
    }
    default:
      return `[error] unknown peer tool "${name}"`;
  }
}
