// -- Project task ledger (docs/ARCHITECTURE.md) --
//
// A durable, cwd-scoped task list that is a *rebuildable projection over
// events.jsonl*, NOT a source of truth (Appendix B). Every mutation appends a
// `task_ledger_event` to the originating workflow's events.jsonl AND atomically
// rewrites the JSON snapshot at <cwd>/.arco/project/tasks.json; the snapshot
// is a cache that can be rebuilt by folding the events.
//
// DISTINCT from the two existing transcript-bound surfaces:
//   - the Plan tab is plan-scoped review (a markdown brief per cwd);
//   - the Tasks panel (Phase 7b) is in-turn subagent children (a single
//     turn's Task fan-out).
// The ledger is the persistent cross-session backbone neither of those
// provides — see docs/TASK_LEDGER.md.

export const TASK_KERNEL_VERSION = 1;

// Optional namespace for task ledgers under the same cwd. Absent / undefined
// is the normal project board at <cwd>/.arco/project/tasks.json. Cluster
// boards use a stable key so cluster work can stay private without pretending
// it lives in a different working directory.
export type TaskBoardKey = string;

// Stage B task-kernel status enum. `done` and `archived` are load-bearing:
// they may ONLY be set by an explicit operator-originated update — see the
// §D1 acceptance invariant guarded in server/src/project/taskLedger.ts.
export type LedgerTaskStatus =
  | 'triage'
  | 'todo'
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'done'
  | 'archived';

// A small typed reference from a task to something else in Arco. D2 extends
// the *usage* (bidirectional plan/review/workflow links); D1 just defines the
// shape so the storage + protocol carry it forward without a later migration.
export interface TaskLink {
  kind: 'plan' | 'review' | 'workflow' | 'url';
  ref: string;        // plan id / review artifact name / workflow id / url
  label?: string;     // optional human label for the UI
}

// §K5 — an optional isolated git worktree pinned to a task, so parallel work on
// one repo doesn't collide. Server-set only (the worktree lifecycle runs on the
// server via `git worktree add/remove`); clients never mint this — they ask for
// it via the worktree messages below. Absent = the task has no worktree (the
// common case). Additive + projection-safe: pre-K5 tasks never carry it, and the
// field rides through the ledger projection (load/rebuild spread the task as-is).
export interface TaskWorktree {
  path: string;       // absolute managed path (under ~/.arco/worktrees/…) — NEVER inside the user's tree
  branch: string;     // the branch the worktree checked out (arco/task/<short>)
  baseRef: string;    // the commit the worktree branched from (resolved HEAD sha)
  createdAt: number;  // ms epoch
}

export interface LedgerTask {
  id: string;
  title: string;
  status: LedgerTaskStatus;
  links: TaskLink[];
  notes: string;
  // Stage B task-kernel fields. Defaults are materialized by taskLedger.load()
  // so pre-kernel snapshots/events continue to replay cleanly.
  priority: number;
  parentIds: string[];
  blockedReason: string;
  reviewRequired: boolean;
  goalMode: boolean;
  goalMaxTurns?: number;
  createdBy?: string;
  updatedBy?: string;
  createdAt: number;  // ms epoch
  updatedAt: number;  // ms epoch
  // §D3 — claimant/assignee workflowId. Absent = unassigned. Set by the
  // `cluster_task_claim` peer-tool, optionally by `cluster_task_create`, or
  // cleared by an operator update with `assignee: ''`. Additive +
  // projection-safe: old tasks never carry it and reads treat it as optional.
  assignee?: string;
  // §K5 — optional isolated git worktree for this task. See TaskWorktree.
  worktree?: TaskWorktree;
  // Director/workers Stage J — task should run isolated. Dispatcher skips
  // until a worktree exists unless the operator armed autoWorktree.
  worktreeRequired?: boolean;
  // §D3 — the director's advisory sign-off verdict. See TaskSignoff. Absent =
  // not yet reviewed (the board renders PENDING). Additive + projection-safe.
  signoff?: TaskSignoff;
}

// §D3 — the director's advisory verdict on whether a task met its target.
// ADVISORY ONLY: `done`/`archived` stay operator-gated; a sign-off never moves
// a task to a terminal status — it's a recommendation the operator reads at a
// glance before accepting. Written by whichever member reviews the task (the
// director) via cluster_task_update; `byWorkflowId`/`at` are server-stamped so
// the verdict is attributable and the RECHECK button knows who to ask.
export type TaskSignoffState = 'met' | 'not_met' | 'partial';

export interface TaskSignoff {
  state: TaskSignoffState;
  summary?: string;        // one-line reason, surfaced on the card tooltip
  byWorkflowId?: string;   // server-stamped: the member who signed off
  at: number;              // ms epoch, server-stamped
}

export interface TaskKernelSnapshot {
  version: typeof TASK_KERNEL_VERSION;
  tasks: LedgerTask[];
  comments?: TaskComment[];
  runs?: TaskRun[];
}

export interface TaskComment {
  id: string;
  taskId: string;
  authorWorkflowId?: string;
  authorLabel: string;
  body: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export type TaskRunStatus =
  | 'claimed'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'reclaimed'
  | 'terminated'
  | 'timed_out';

export interface TaskRun {
  id: string;
  taskId: string;
  workflowId: string;
  clusterId?: string;
  status: TaskRunStatus;
  outcome?: string;
  claimLock?: string;
  startedAt: number;
  lastHeartbeatAt?: number;
  endedAt?: number;
  sessionId?: string;
  workerId?: string;
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskDetails {
  task: LedgerTask;
  comments: TaskComment[];
  runs: TaskRun[];
  parents: LedgerTask[];
  children: LedgerTask[];
  // Plan reference docs the task links (`ref:slug` in title / notes /
  // comments), resolved server-side for cluster_task_show. Absent when the
  // task links none.
  referenceDocs?: {
    instruction: string;
    refs: Array<{ planId: string; slug: string; title?: string; path: string; bytes?: number; exists: boolean }>;
  };
}

export type TaskLedgerEventOp =
  | 'create'
  | 'update'
  | 'delete'
  | 'archive'
  | 'link'
  | 'unlink'
  | 'comment'
  | 'claim'
  | 'heartbeat'
  | 'run_started'
  | 'run_completed'
  | 'run_failed'
  | 'run_reclaimed'
  | 'run_terminated'
  | 'promote'
  | 'dispatch_fired'
  | 'dispatch_skipped';

// ── Client → Server ──

// Create a task in the cwd of `workflowId`. The server derives the cwd from the
// workflow, stamps id/createdAt/updatedAt, and persists. New tasks are always
// `todo` — there is no create-as-done path (the operator-confirmed-done
// invariant).
export interface TaskLedgerCreateMessage {
  type: 'task_ledger_create';
  workflowId: string;
  boardKey?: TaskBoardKey;
  title: string;
  notes?: string;
  links?: TaskLink[];
  priority?: number;
  parentIds?: string[];
  reviewRequired?: boolean;
  goalMode?: boolean;
  goalMaxTurns?: number;
  worktreeRequired?: boolean;
}

// Patch an existing task. Any subset of fields. `status: 'done'` is honored
// here (this is the explicit operator-originated path); no other message may
// set done.
export interface TaskLedgerUpdateMessage {
  type: 'task_ledger_update';
  workflowId: string;
  boardKey?: TaskBoardKey;
  id: string;
  title?: string;
  status?: LedgerTaskStatus;
  notes?: string;
  links?: TaskLink[];
  priority?: number;
  parentIds?: string[];
  blockedReason?: string;
  reviewRequired?: boolean;
  goalMode?: boolean;
  goalMaxTurns?: number | null;
  worktreeRequired?: boolean;
  // §D3 — operator-side (re)assignment from the LEDGER tab. Empty string
  // clears the claim (→ unassigned). Workers never reach this message; they
  // claim/release through the `cluster_task_*` peer-tools.
  assignee?: string;
}

export interface TaskLedgerDeleteMessage {
  type: 'task_ledger_delete';
  workflowId: string;
  boardKey?: TaskBoardKey;
  id: string;
}

// §K5 — spin an isolated git worktree for a task. The server resolves the cwd
// from `workflowId`, requires a git repo with at least one commit, creates the
// worktree under a managed path, sets the task's `worktree` field through the
// same event-sourced ledger mutation path, and re-snapshots. Idempotent: a task
// that already has a live worktree returns it unchanged.
export interface TaskWorktreeCreateMessage {
  type: 'task_worktree_create';
  workflowId: string;
  id: string;
}

// §K5 — tear the worktree down (`git worktree remove` + prune; the branch is
// left in place so committed work isn't lost) and clear the task's `worktree`
// field. No-op if the task has none.
export interface TaskWorktreeRemoveMessage {
  type: 'task_worktree_remove';
  workflowId: string;
  id: string;
}

export type TaskRunRecoverAction = 'reclaim' | 'terminate' | 'reassign' | 'fail';

// Director/workers Stage H — operator recovery control for one selected run.
// The server mutates exactly `runId` and then applies the task-level recovery
// implied by the action. It never marks tasks done/archived.
export interface TaskRunRecoverMessage {
  type: 'task_run_recover';
  workflowId: string;
  boardKey?: TaskBoardKey;
  taskId: string;
  runId: string;
  action: TaskRunRecoverAction;
  reason?: string;
  reassignToWorkflowId?: string;
  staleOnly?: boolean;
  staleAfterMs?: number;
  failureLimit?: number;
}

// Request the current cwd-scoped snapshot (used on tab open / manual refresh;
// the server also pushes a snapshot on connect/rehydrate without being asked).
export interface TaskLedgerListMessage {
  type: 'task_ledger_list';
  workflowId: string;
  boardKey?: TaskBoardKey;
}

// ── Server → Client ──

// The full cwd-scoped list. Broadcast after every mutation (re-snapshot keeps
// the client simple and consistent — the working set is small) and on
// connect/rehydrate. `workflowId` is the workflow that triggered the broadcast
// (or any workflow in the cwd on the rehydrate push) so it fans out to that
// workflow's observers; `cwd` is the authoritative key the client stores under.
export interface TaskLedgerSnapshotMessage {
  type: 'task_ledger_snapshot';
  workflowId: string;
  cwd: string;
  boardKey?: TaskBoardKey;
  tasks: LedgerTask[];
}

// The durable per-mutation event. This is what lands in events.jsonl and what
// rebuildFromEvents() folds to reconstruct tasks.json. The snapshot above is a
// convenience for live clients; THIS is the projection's source. `op` mirrors
// the mutation kind; `task` carries the resulting task for create/update,
// `id` alone for delete.
export interface TaskLedgerEventMessage {
  type: 'task_ledger_event';
  workflowId: string;
  cwd: string;
  boardKey?: TaskBoardKey;
  op: TaskLedgerEventOp;
  id: string;
  task?: LedgerTask; // present for create/update; absent for delete
  payload?: Record<string, unknown>;
  at: number;        // ms epoch — fold order tiebreaker alongside seq
}
