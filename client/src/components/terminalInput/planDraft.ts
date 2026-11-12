import { PUBLIC_DRAFT_REQUEST, hasGuardrails } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';

export function planDraftPrompt(goal = '', mode: 'review' | 'autosave' = 'review', cluster = false, publicProject = false): string {
  const aim = goal.trim() ? `\nProject purpose supplied by the operator:\n${goal.trim()}\n` : '';
  const base = `Please synthesize ${cluster ? 'a shared cluster' : 'a project'} plan from everything discussed in this conversation.${aim}
Cover the goal, current state, open questions, and actionable next steps. Begin with one # Title, use ### headings for phases, and put each task on a top-level - [ ] checkbox line. Use durable language.

Do not write testing, gate or CI standing rules unless the operator asked for them. Reply with the complete plan inline. Do not create, update, attach, or write any plan or project file. ${mode === 'review' ? 'The operator will review the draft before deciding whether to save it.' : 'Arco will save the draft after the turn.'}`;
  return publicProject ? `${base}\n\n${PUBLIC_DRAFT_REQUEST}` : base;
}

// A plan review is always a new idle turn; never arm a capture for a queued
// instruction or a rejected send, which could capture an unrelated reply.
export function beginPlanReview(workflowId: string, send: (content: string) => boolean | void, goal = '', cluster = false, publicProject = false): boolean {
  const store = useAppStore.getState();
  const job = store.jobs[workflowId];
  if (!job || job.busy || job.pendingPlanCapture || job.planCandidate || job.messages.some((message) => message.isStreaming) || Object.values(job.workers).some((worker) => worker.status === 'running' || worker.status === 'spawning')) return false;
  store.setPendingPlanCapture(workflowId, 'review');
  try {
    if (send(planDraftPrompt(goal, 'review', cluster, publicProject)) !== false) return true;
  } catch { /* clear the capture and let the caller report failure */ }
  useAppStore.getState().setPendingPlanCapture(workflowId, null);
  return false;
}

export function planRefinePrompt(draft: string, note: string, cluster = false, publicProject = false): string {
  return `Please revise the ${cluster ? 'shared cluster' : 'project'} plan draft below according to the operator's note. Keep what the note does not touch.

Operator note:
${note.trim()}

Current draft:
${draft.trim()}

${hasGuardrails(draft) ? 'Keep the "Privacy and public safety" section unless the note says otherwise.\n\n' : publicProject ? `${PUBLIC_DRAFT_REQUEST}\n\n` : ''}Do not write testing, gate or CI standing rules unless the operator asked for them. Reply with the complete revised plan inline. Begin with one # Title, use ### headings for phases, and put each task on a top-level - [ ] checkbox line. Do not create, update, attach, or write any plan or project file. The operator will review the revision before deciding whether to save it.`;
}

// Refinement is a new idle plan-review turn that carries the current draft. The
// existing draft stays in place until the revised reply replaces it, so a
// failed or rejected send loses nothing.
export function beginPlanRefine(workflowId: string, send: (content: string) => boolean | void, note: string, cluster = false, publicProject = false): boolean {
  const store = useAppStore.getState();
  const job = store.jobs[workflowId];
  if (!job || !job.planCandidate || !note.trim() || job.busy || job.pendingPlanCapture || job.messages.some((message) => message.isStreaming) || Object.values(job.workers).some((worker) => worker.status === 'running' || worker.status === 'spawning')) return false;
  store.setPendingPlanCapture(workflowId, 'review');
  try {
    if (send(planRefinePrompt(job.planCandidate.body, note, cluster, publicProject)) !== false) return true;
  } catch { /* clear the capture and let the caller report failure */ }
  useAppStore.getState().setPendingPlanCapture(workflowId, null);
  return false;
}
