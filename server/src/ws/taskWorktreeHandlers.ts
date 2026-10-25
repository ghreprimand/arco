// server/src/ws/taskWorktreeHandlers.ts — git worktrees per task (ARCHON_OPS_PLAN.md §K5).
//
// Spin / tear down an isolated `git worktree` for a ledger task, then record the
// result on the task by funnelling an update through the SAME event-sourced
// ledger mutation path the ordinary ledger handlers use (persistLedgerMutation),
// so the `worktree` field is durable + projection-safe. The git lifecycle lives
// in project/taskWorktree.ts; this file is the WS glue.

import { WebSocket } from 'ws';
import type { TaskWorktreeCreateMessage, TaskWorktreeRemoveMessage } from '@archon/shared';
import { send } from '../server/broadcast.js';
import {
  cwdForWorkflow,
  persistLedgerMutation,
  broadcastSnapshot,
} from './taskLedgerHandlers.js';
import { applyUpdate } from '../project/taskLedger.js';
import {
  createTaskWorktree,
  removeTaskWorktree,
  TaskWorktreeError,
} from '../project/taskWorktree.js';

export async function handleTaskWorktreeCreate(
  ws: WebSocket,
  msg: TaskWorktreeCreateMessage,
): Promise<void> {
  const cwd = cwdForWorkflow(msg.workflowId);
  if (!cwd) {
    send(ws, { type: 'error', message: 'Task worktree: workflow has no working directory.' });
    return;
  }

  // Create the worktree on disk FIRST (this is the operation that can fail for
  // operator reasons — not a repo, no commit). Only on success do we mutate the
  // ledger, so a failed create never leaves a dangling `worktree` field.
  let worktree;
  try {
    worktree = await createTaskWorktree(cwd, msg.id);
  } catch (err) {
    const message = err instanceof TaskWorktreeError
      ? err.message
      : `Failed to create worktree: ${(err as Error).message}`;
    send(ws, { type: 'error', message });
    return;
  }

  const result = await persistLedgerMutation(msg.workflowId, cwd, 'update', (tasks) => {
    const r = applyUpdate(tasks, msg.id, { worktree });
    return r ? { tasks: r.tasks, id: msg.id, task: r.updated } : null;
  });
  if (!result) {
    // The task vanished between the create and the mutation — clean up the
    // orphaned worktree rather than leaving it on disk.
    await removeTaskWorktree(cwd, msg.id).catch(() => undefined);
    send(ws, { type: 'error', message: `Task ${msg.id.slice(0, 8)} not found.` });
    return;
  }
  broadcastSnapshot(msg.workflowId, cwd, result.tasks);
}

export async function handleTaskWorktreeRemove(
  ws: WebSocket,
  msg: TaskWorktreeRemoveMessage,
): Promise<void> {
  const cwd = cwdForWorkflow(msg.workflowId);
  if (!cwd) {
    send(ws, { type: 'error', message: 'Task worktree: workflow has no working directory.' });
    return;
  }

  // Remove from disk (idempotent / no-op-safe), then clear the field. We remove
  // first so a failed git remove surfaces before we drop the pointer.
  try {
    await removeTaskWorktree(cwd, msg.id);
  } catch (err) {
    const message = err instanceof TaskWorktreeError
      ? err.message
      : `Failed to remove worktree: ${(err as Error).message}`;
    send(ws, { type: 'error', message });
    return;
  }

  const result = await persistLedgerMutation(msg.workflowId, cwd, 'update', (tasks) => {
    const r = applyUpdate(tasks, msg.id, { worktree: null });
    return r ? { tasks: r.tasks, id: msg.id, task: r.updated } : null;
  });
  // A missing task here is benign — the worktree is already gone. Re-snapshot
  // only when the mutation actually applied.
  if (result) broadcastSnapshot(msg.workflowId, cwd, result.tasks);
}
