import type { OperatorQuestionState } from '@archon/shared';
import { useAppStore } from '../stores/appStore';

export const questionMessageId = (requestId: string) => `operator-question-${requestId}`;
export function applyOperatorQuestion(workflowId: string, question: OperatorQuestionState): void {
  const store = useAppStore.getState();
  const id = questionMessageId(question.requestId);
  const prior = store.jobs[workflowId]?.messages.find((m) => m.id === id);
  const content = `[${question.provider.toUpperCase()} QUESTION · ${question.status}] ` + question.questions.map((q) => q.question).join('\n');
  if (prior) {
    // A delayed replay cannot reopen a question already settled locally.
    if (prior.operatorQuestion?.status !== 'pending' && question.status === 'pending') return;
    store.updateMessage(workflowId, id, { content, operatorQuestion: question, operatorQuestionError: undefined });
  } else {
    store.addMessage(workflowId, { id, role: 'system', content, operatorQuestion: question, isStreaming: false, timestamp: question.createdAt });
  }
}

export function reconcileOperatorQuestions(workflowId: string, questions: OperatorQuestionState[]): void {
  const ids = new Set(questions.map((q) => q.requestId));
  for (const m of useAppStore.getState().jobs[workflowId]?.messages ?? []) {
    const q = m.operatorQuestion;
    if (q?.status === 'pending' && !ids.has(q.requestId)) {
      applyOperatorQuestion(workflowId, { ...q, status: 'cancelled', reason: 'This question is no longer pending on the server.' });
    }
  }
  for (const q of questions) applyOperatorQuestion(workflowId, q);
}
