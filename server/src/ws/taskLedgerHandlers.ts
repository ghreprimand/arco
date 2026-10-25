// server/src/ws/taskLedgerHandlers.ts — Project task ledger WS handlers
// (ARCO_OPS_PLAN.md §D1, Part D).
//
// The ledger is cwd-scoped. Mutations arrive tagged with a workflowId; we
// resolve the cwd from that workflow, mutate via the load()/save() boundary in
// project/taskLedger.ts, append the durable `task_ledger_event` to the
// workflow's events.jsonl (via broadcastWorkflow, which persists + fans out),
// then re-snapshot every observer in the cwd.
//
// Mutations are serialized per-cwd through a promise chain so concurrent
// operator actions (two tabs sharing one cwd) can't clobber each other's
// load-mutate-save round.

import { WebSocket } from 'ws';
import type {
  LedgerTask,
  TaskBoardKey,
  TaskComment,
  TaskLedgerEventOp,
  TaskLedgerCreateMessage,
  TaskLedgerUpdateMessage,
  TaskLedgerDeleteMessage,
  TaskLedgerListMessage,
  TaskRun,
  TaskRunRecoverAction,
  TaskRunRecoverMessage,
} from '@arco/shared';
import * as clusterStore from '../clusterStore.js';
import * as taskLedger from '../project/taskLedger.js';
import { workflows, workflowCwds } from '../server/state.js';
import { broadcastWorkflow, send } from '../server/broadcast.js';

// Per-cwd mutation serialization. Each cwd gets a tail promise; a new mutation
// chains off it so the load-mutate-save sequence never interleaves.
const cwdLocks = new Map<string, Promise<unknown>>();

function lockKey(cwd: string, boardKey?: TaskBoardKey): string {
  return taskLedger.taskBoardStoreKey(cwd, boardKey);
}

function withCwdLock<T>(cwd: string, fn: () => Promise<T>, boardKey?: TaskBoardKey): Promise<T> {
  const key = lockKey(cwd, boardKey);
  const prev = cwdLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain alive but don't leak rejections into the next link's catch.
  cwdLocks.set(key, next.catch(() => undefined));
  return next;
}

export function cwdForWorkflow(workflowId: string): string | null {
  const wf = workflows.get(workflowId);
  const cwd = wf?.config.workingDirectory ?? workflowCwds.get(workflowId);
  return cwd && cwd.length > 0 ? cwd : null;
}

// §D3 — shared persist+emit primitive for ledger mutations. Both the operator
// WS path (above) and the cluster peer-ops (clusterPeerOps.ts) MUST funnel
// through here so the durable `task_ledger_event` is appended identically and
// the projection stays single-source. It does NOT broadcast the snapshot —
// the caller decides scope (operator path = workflow-scoped; peer-ops =
// cluster-scoped fanout) — but it DOES persist + emit the durable event under
// the per-cwd lock so concurrent claims can't clobber each other. Returns the
// post-mutation task list, or null when the task is missing (update/delete).
export async function persistLedgerMutation(
  workflowId: string,
  cwd: string,
  op: TaskLedgerEventOp,
  mutate: (tasks: LedgerTask[]) =>
    | { tasks: LedgerTask[]; id: string; task?: LedgerTask; payload?: Record<string, unknown> }
    | null,
  opts?: { boardKey?: TaskBoardKey },
): Promise<{ tasks: LedgerTask[]; id: string; task?: LedgerTask; payload?: Record<string, unknown> } | null> {
  return withCwdLock(cwd, async () => {
    const tasks = await taskLedger.load(cwd, opts?.boardKey);
    const result = mutate(tasks);
    if (!result) return null;
    await taskLedger.save(cwd, result.tasks, opts?.boardKey);
    emitEvent(workflowId, cwd, op, result.id, result.task, result.payload, opts?.boardKey);
    return result;
  }, opts?.boardKey);
}

export async function persistLedgerKernelMutation(
  workflowId: string,
  cwd: string,
  op: TaskLedgerEventOp,
  mutate: (state: Awaited<ReturnType<typeof taskLedger.loadKernel>>) =>
    | {
      state: Awaited<ReturnType<typeof taskLedger.loadKernel>>;
      id: string;
      task?: LedgerTask;
      payload?: Record<string, unknown>;
    }
    | null,
  opts?: { boardKey?: TaskBoardKey },
): Promise<{
  state: Awaited<ReturnType<typeof taskLedger.loadKernel>>;
  id: string;
  task?: LedgerTask;
  payload?: Record<string, unknown>;
} | null> {
  return withCwdLock(cwd, async () => {
    const state = await taskLedger.loadKernel(cwd, opts?.boardKey);
    const result = mutate(state);
    if (!result) return null;
    await taskLedger.saveKernel(cwd, result.state, opts?.boardKey);
    emitEvent(workflowId, cwd, op, result.id, result.task, result.payload, opts?.boardKey);
    return result;
  }, opts?.boardKey);
}

// Append one comment to the kernel snapshot under the same per-board lock the
// mutations hold. Loads FRESH state inside the lock: the peer-ops / proposal
// comment paths used to loadKernel + saveKernel outside it and write back the
// task list they'd captured before — a claim landing in between was reverted
// and two concurrent comments lost one.
export async function appendLedgerComment(
  cwd: string,
  comment: TaskComment,
  boardKey?: TaskBoardKey,
): Promise<void> {
  await withCwdLock(cwd, async () => {
    const state = await taskLedger.loadKernel(cwd, boardKey);
    await taskLedger.saveKernel(cwd, {
      tasks: state.tasks,
      comments: [...state.comments, comment],
      runs: state.runs,
    }, boardKey);
  }, boardKey);
}

// Re-snapshot the cwd to every observer of the originating workflow. We
// broadcast on the originating workflow so the snapshot fans out to the tab(s)
// looking at this cwd; the client keys it by `cwd`.
export function broadcastSnapshot(workflowId: string, cwd: string, tasks: LedgerTask[], boardKey?: TaskBoardKey): void {
  broadcastWorkflow(workflowId, {
    type: 'task_ledger_snapshot',
    workflowId,
    cwd,
    ...(boardKey ? { boardKey } : {}),
    tasks,
  });
}

// Append the durable per-mutation event to the workflow's events.jsonl (this is
// the projection's source of truth — rebuildFromEvents folds these). Goes
// through broadcastWorkflow so it both persists and reaches observers.
function emitEvent(
  workflowId: string,
  cwd: string,
  op: TaskLedgerEventOp,
  id: string,
  task?: LedgerTask,
  payload?: Record<string, unknown>,
  boardKey?: TaskBoardKey,
): void {
  broadcastWorkflow(workflowId, {
    type: 'task_ledger_event',
    workflowId,
    cwd,
    ...(boardKey ? { boardKey } : {}),
    op,
    id,
    ...(task ? { task } : {}),
    ...(payload ? { payload } : {}),
    at: Date.now(),
  });
}

export async function handleTaskLedgerCreate(
  ws: WebSocket,
  msg: TaskLedgerCreateMessage,
): Promise<void> {
  const cwd = cwdForWorkflow(msg.workflowId);
  if (!cwd) {
    send(ws, { type: 'error', message: 'Task ledger: workflow has no working directory.' });
    return;
  }
  const title = (msg.title ?? '').trim();
  if (!title) {
    send(ws, { type: 'error', message: 'Task title is required.' });
    return;
  }
  await withCwdLock(cwd, async () => {
    const tasks = await taskLedger.load(cwd, msg.boardKey);
    const task = taskLedger.newTask({
      title,
      notes: msg.notes,
      links: msg.links,
      priority: msg.priority,
      parentIds: msg.parentIds,
      reviewRequired: msg.reviewRequired,
      goalMode: msg.goalMode,
      goalMaxTurns: msg.goalMaxTurns,
      worktreeRequired: msg.worktreeRequired,
      createdBy: msg.workflowId,
    });
    const next = [...tasks, task];
    await taskLedger.save(cwd, next, msg.boardKey);
    emitEvent(msg.workflowId, cwd, 'create', task.id, task, undefined, msg.boardKey);
    broadcastSnapshot(msg.workflowId, cwd, next, msg.boardKey);
  }, msg.boardKey);
}

export async function handleTaskLedgerUpdate(
  ws: WebSocket,
  msg: TaskLedgerUpdateMessage,
): Promise<void> {
  const cwd = cwdForWorkflow(msg.workflowId);
  if (!cwd) {
    send(ws, { type: 'error', message: 'Task ledger: workflow has no working directory.' });
    return;
  }
  await withCwdLock(cwd, async () => {
    const tasks = await taskLedger.load(cwd, msg.boardKey);
    // applyUpdate is the ONLY path that may set status: 'done' — it honors the
    // operator's update message verbatim. No other handler infers done.
    const result = taskLedger.applyUpdate(tasks, msg.id, {
      title: msg.title,
      status: msg.status,
      notes: msg.notes,
      links: msg.links,
      priority: msg.priority,
      parentIds: msg.parentIds,
      blockedReason: msg.blockedReason,
      reviewRequired: msg.reviewRequired,
      goalMode: msg.goalMode,
      goalMaxTurns: msg.goalMaxTurns,
      worktreeRequired: msg.worktreeRequired,
      assignee: msg.assignee,
      updatedBy: msg.workflowId,
    });
    if (!result) {
      send(ws, { type: 'error', message: `Task ${msg.id.slice(0, 8)} not found.` });
      return;
    }
    await taskLedger.save(cwd, result.tasks, msg.boardKey);
    emitEvent(msg.workflowId, cwd, 'update', msg.id, result.updated, undefined, msg.boardKey);
    broadcastSnapshot(msg.workflowId, cwd, result.tasks, msg.boardKey);
  }, msg.boardKey);
}

export async function handleTaskLedgerDelete(
  ws: WebSocket,
  msg: TaskLedgerDeleteMessage,
): Promise<void> {
  const cwd = cwdForWorkflow(msg.workflowId);
  if (!cwd) {
    send(ws, { type: 'error', message: 'Task ledger: workflow has no working directory.' });
    return;
  }
  await withCwdLock(cwd, async () => {
    const tasks = await taskLedger.load(cwd, msg.boardKey);
    const next = taskLedger.removeTask(tasks, msg.id);
    if (!next) {
      send(ws, { type: 'error', message: `Task ${msg.id.slice(0, 8)} not found.` });
      return;
    }
    await taskLedger.save(cwd, next, msg.boardKey);
    emitEvent(msg.workflowId, cwd, 'delete', msg.id, undefined, undefined, msg.boardKey);
    broadcastSnapshot(msg.workflowId, cwd, next, msg.boardKey);
  }, msg.boardKey);
}

const OPEN_RUN_STATUSES = new Set<TaskRun['status']>(['claimed', 'running']);
const FAILURE_BREAKER_STATUSES = new Set<TaskRun['status']>(['failed', 'timed_out', 'terminated']);

function runRecoveryOp(action: TaskRunRecoverAction): TaskLedgerEventOp {
  if (action === 'terminate') return 'run_terminated';
  if (action === 'fail') return 'run_failed';
  return 'run_reclaimed';
}

function normalizeRecoveryReason(reason: unknown, fallback: string): string {
  return typeof reason === 'string' && reason.trim().length > 0
    ? reason.trim().slice(0, 4096)
    : fallback;
}

function consecutiveFailures(runs: TaskRun[], taskId: string): number {
  const sorted = runs
    .filter((run) => run.taskId === taskId)
    .sort((a, b) => (b.endedAt ?? b.lastHeartbeatAt ?? b.startedAt) - (a.endedAt ?? a.lastHeartbeatAt ?? a.startedAt));
  let count = 0;
  for (const run of sorted) {
    if (!FAILURE_BREAKER_STATUSES.has(run.status)) break;
    count += 1;
  }
  return count;
}

export async function handleTaskRunRecover(
  ws: WebSocket,
  msg: TaskRunRecoverMessage,
): Promise<void> {
  const cwd = cwdForWorkflow(msg.workflowId);
  if (!cwd) {
    send(ws, { type: 'error', message: 'Task run recovery: workflow has no working directory.' });
    return;
  }
  if (!['reclaim', 'terminate', 'reassign', 'fail'].includes(msg.action)) {
    send(ws, { type: 'error', message: `Task run recovery rejected: invalid action ${String(msg.action)}` });
    return;
  }
  const failureLimit = typeof msg.failureLimit === 'number' && Number.isFinite(msg.failureLimit) && msg.failureLimit > 0
    ? Math.trunc(msg.failureLimit)
    : 3;
  const staleAfterMs = typeof msg.staleAfterMs === 'number' && Number.isFinite(msg.staleAfterMs) && msg.staleAfterMs > 0
    ? Math.trunc(msg.staleAfterMs)
    : 30 * 60 * 1000;
  const reason = normalizeRecoveryReason(msg.reason, `operator_${msg.action}`);
  let rejection: string | null = null;
  const result = await persistLedgerKernelMutation(msg.workflowId, cwd, runRecoveryOp(msg.action), (state) => {
    const runIndex = state.runs.findIndex((run) => run.id === msg.runId);
    if (runIndex === -1) {
      rejection = `Task run recovery rejected: run ${msg.runId.slice(0, 8)} not found.`;
      return null;
    }
    const run = state.runs[runIndex];
    if (run.taskId !== msg.taskId) {
      rejection = `Task run recovery rejected: run ${msg.runId.slice(0, 8)} does not belong to task ${msg.taskId.slice(0, 8)}.`;
      return null;
    }
    const task = state.tasks.find((t) => t.id === msg.taskId);
    if (!task) {
      rejection = `Task run recovery rejected: task ${msg.taskId.slice(0, 8)} not found.`;
      return null;
    }
    if (run.endedAt || !OPEN_RUN_STATUSES.has(run.status)) {
      rejection = `Task run recovery rejected: run ${msg.runId.slice(0, 8)} is not open.`;
      return null;
    }
    if (msg.staleOnly === true) {
      const last = run.lastHeartbeatAt ?? run.startedAt;
      if (Date.now() - last < staleAfterMs) {
        rejection = `Task run recovery rejected: run ${msg.runId.slice(0, 8)} is not stale.`;
        return null;
      }
    }
    let reassignee: string | undefined;
    if (msg.action === 'reassign') {
      const requested = typeof msg.reassignToWorkflowId === 'string' ? msg.reassignToWorkflowId.trim() : '';
      if (!requested) {
        rejection = 'Task run recovery rejected: reassignToWorkflowId is required for reassign.';
        return null;
      }
      if (run.clusterId) {
        const resolved = clusterStore.resolvePeer(run.clusterId, requested);
        if (!resolved) {
          rejection = `Task run recovery rejected: ${requested.slice(0, 8)} is not a member of cluster ${run.clusterId.slice(0, 8)}.`;
          return null;
        }
        reassignee = resolved;
      } else {
        reassignee = requested;
      }
    }
    const now = Date.now();
    const recoveredRun: TaskRun = {
      ...run,
      status: msg.action === 'terminate' ? 'terminated' : (msg.action === 'fail' ? 'failed' : 'reclaimed'),
      endedAt: now,
      lastHeartbeatAt: run.lastHeartbeatAt ?? now,
      ...(msg.action === 'terminate' || msg.action === 'fail' ? { error: reason } : { outcome: reason }),
      metadata: {
        ...(run.metadata && typeof run.metadata === 'object' ? run.metadata : {}),
        recoveredBy: msg.workflowId,
        recoveryAction: msg.action,
        recoveredAt: now,
      },
    };
    const runs = [...state.runs];
    runs[runIndex] = recoveredRun;
    const taskPatch = (() => {
      if (msg.action === 'terminate' || msg.action === 'fail') {
        const count = consecutiveFailures(runs, msg.taskId);
        const shouldBlock = msg.action === 'terminate' || count >= failureLimit;
        return shouldBlock
          ? {
              status: 'blocked' as const,
              blockedReason: msg.action === 'terminate'
                ? `Run terminated: ${reason}`
                : `Failure breaker: ${count} consecutive failed runs. Last error: ${reason}`,
              updatedBy: msg.workflowId,
            }
          : { status: 'ready' as const, updatedBy: msg.workflowId };
      }
      if (msg.action === 'reassign') {
        return { status: 'ready' as const, assignee: reassignee, updatedBy: msg.workflowId };
      }
      return { status: 'ready' as const, assignee: '', updatedBy: msg.workflowId };
    })();
    const applied = taskLedger.applyUpdate(state.tasks, msg.taskId, taskPatch);
    if (!applied) {
      rejection = `Task run recovery rejected: task ${msg.taskId.slice(0, 8)} update failed.`;
      return null;
    }
    return {
      state: { tasks: applied.tasks, comments: state.comments, runs },
      id: msg.taskId,
      task: applied.updated,
      payload: { run: recoveredRun, action: msg.action, reason, recoveredBy: msg.workflowId },
    };
  }, { boardKey: msg.boardKey });
  if (!result) {
    send(ws, { type: 'error', message: rejection ?? 'Task run recovery failed.' });
    return;
  }
  broadcastSnapshot(msg.workflowId, cwd, result.state.tasks, msg.boardKey);
}

// List → push the current snapshot to the requesting workflow's observers.
// Sent on tab open / manual refresh; also called on connect/rehydrate (see
// sendTaskLedgerSnapshot) so a reconnecting client gets current state.
export async function handleTaskLedgerList(
  _ws: WebSocket,
  msg: TaskLedgerListMessage,
): Promise<void> {
  const cwd = cwdForWorkflow(msg.workflowId);
  if (!cwd) return;
  const tasks = await taskLedger.load(cwd, msg.boardKey);
  broadcastSnapshot(msg.workflowId, cwd, tasks, msg.boardKey);
}

// Rehydrate helper: push the cwd's ledger snapshot for a freshly-(re)registered
// workflow. Called from the rehydrate path so a reconnecting client mirrors the
// current ledger without an explicit list request.
export async function sendTaskLedgerSnapshot(workflowId: string): Promise<void> {
  const cwd = cwdForWorkflow(workflowId);
  if (!cwd) return;
  const tasks = await taskLedger.load(cwd);
  broadcastSnapshot(workflowId, cwd, tasks);
}
