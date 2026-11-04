import type { QueueItem, WorkflowState } from '../workflows/types.js';

// An interrupt is its own next turn. Older instructions must not be merged
// into the correction, or drained by the worker being cancelled.
export function takeQueuedTurn(queue: WorkflowState['queue']): QueueItem[] {
  const priority = queue.steering.filter((item) => item.interrupt);
  if (priority.length) {
    queue.steering = queue.steering.filter((item) => !item.interrupt);
    return priority;
  }
  return [...queue.steering.splice(0), ...queue.followUp.splice(0)];
}
