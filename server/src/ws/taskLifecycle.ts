// Task card lifecycle outside a live turn (Claude Native Task children).
import type { TaskStartedMessage, TaskStatusMessage } from '@arco/shared';

/**
 * Messages a turn may still deliver after STOP revoked it. A Task child's final
 * status is keyed by its task id, so it cannot be mistaken for output of a
 * newer turn, and dropping it leaves the card RUNNING forever.
 */
export function deliverAfterTurnRevoked(msg: { type: string }): boolean {
  return msg.type === 'task_status';
}

/**
 * The parent-tab broadcast for a Task child's start. `background` marks a
 * run_in_background child: the row shows BACKGROUND and a reload after a
 * restart settles it as stopped.
 */
export function taskStartedBroadcast(workflowId: string, ev: Omit<TaskStartedMessage, 'type' | 'workflowId'>): TaskStartedMessage {
  return {
    type: 'task_started',
    workflowId,
    taskId: ev.taskId,
    childWorkflowId: ev.childWorkflowId,
    phase: ev.phase,
    model: ev.model,
    toolUseId: ev.toolUseId,
    description: ev.description,
    startedAt: ev.startedAt,
    ...(ev.background ? { background: true } : {}),
  };
}

type LifecycleEvent = { type?: string; taskId?: string; childWorkflowId?: string; toolUseId?: string; startedAt?: number; phase?: string; endedAt?: number; background?: boolean };

/**
 * Final statuses for Task cards whose log has a start but no final status and
 * whose child is not running now. Sent to one browser on reload, never written:
 * the elapsed time runs to the parent's next recorded turn end, else zero.
 * A background child is not tied to a turn: it was stopped by a restart.
 */
export function unsettledTaskStatuses(workflowId: string, events: readonly unknown[], childRunning: (childWorkflowId: string) => boolean, taskWaiting: (taskId: string) => boolean = () => false): TaskStatusMessage[] {
  const started = new Map<string, { toolUseId: string; childWorkflowId?: string; startedAt: number; background?: boolean }>();
  const settled = new Set<string>();
  const turnEnds: number[] = [];
  for (const raw of events) {
    const ev = raw as LifecycleEvent;
    if (ev.type === 'task_started' && ev.taskId && ev.toolUseId && (ev.childWorkflowId || ev.phase === 'queued') && typeof ev.startedAt === 'number') {
      started.set(ev.taskId, { toolUseId: ev.toolUseId, childWorkflowId: ev.childWorkflowId, startedAt: ev.startedAt, background: ev.background === true || started.get(ev.taskId)?.background === true });
    } else if (ev.type === 'task_status' && ev.taskId && ev.phase && ev.phase !== 'running') {
      settled.add(ev.taskId);
    } else if (ev.type === 'primary_turn_ended' && typeof ev.endedAt === 'number') {
      turnEnds.push(ev.endedAt);
    }
  }
  const out: TaskStatusMessage[] = [];
  for (const [taskId, task] of started) {
    if (settled.has(taskId) || taskWaiting(taskId) || (task.childWorkflowId && childRunning(task.childWorkflowId))) continue;
    if (task.background) {
      out.push({ type: 'task_status', workflowId, taskId, toolUseId: task.toolUseId, phase: 'cancelled', elapsedMs: 0, summary: 'Stopped by restart.' });
      continue;
    }
    const end = turnEnds.filter((at) => at >= task.startedAt).sort((a, b) => a - b)[0];
    out.push({ type: 'task_status', workflowId, taskId, toolUseId: task.toolUseId, phase: 'cancelled', elapsedMs: end === undefined ? 0 : end - task.startedAt, summary: 'Ended without a recorded result.' });
  }
  return out;
}
