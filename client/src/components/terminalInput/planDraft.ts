import { useAppStore } from '../../stores/appStore';

export function planDraftPrompt(goal = '', mode: 'review' | 'autosave' = 'review', cluster = false): string {
  const aim = goal.trim() ? `\nProject purpose supplied by the operator:\n${goal.trim()}\n` : '';
  return `Please synthesize ${cluster ? 'a shared cluster' : 'a project'} plan from everything discussed in this conversation.${aim}
Cover the goal, current state, open questions, and actionable next steps. Begin with one # Title, use ### headings for phases, and put each task on a top-level - [ ] checkbox line. Use durable language.

Reply with the complete plan inline. Do not create, update, attach, or write any plan or project file. ${mode === 'review' ? 'The operator will review the draft before deciding whether to save it.' : 'Arco will save the draft after the turn.'}`;
}

// A plan review is always a new idle turn; never arm a capture for a queued
// instruction or a rejected send, which could capture an unrelated reply.
export function beginPlanReview(workflowId: string, send: (content: string) => boolean | void, goal = '', cluster = false): boolean {
  const store = useAppStore.getState();
  const job = store.jobs[workflowId];
  if (!job || job.busy || job.pendingPlanCapture || job.planCandidate || job.messages.some((message) => message.isStreaming) || Object.values(job.workers).some((worker) => worker.status === 'running' || worker.status === 'spawning')) return false;
  store.setPendingPlanCapture(workflowId, 'review');
  try {
    if (send(planDraftPrompt(goal, 'review', cluster)) !== false) return true;
  } catch { /* clear the capture and let the caller report failure */ }
  useAppStore.getState().setPendingPlanCapture(workflowId, null);
  return false;
}
