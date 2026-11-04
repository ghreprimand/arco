import type { ChatMessage } from '@arco/shared';
import type { JobState } from '../stores/appStore';

// A tab is waiting on the operator while it holds an unanswered question or an
// unresolved approval gate. One definition, shared by the window title count
// and any per-tab status.
export function isMessageWaiting(m: ChatMessage): boolean {
  if (m.operatorQuestion?.status === 'pending') return true;
  const input = m.toolUse?.tool === 'Gate' ? (m.toolUse.input as { status?: string } | undefined) : undefined;
  return input?.status === 'pending';
}

export function isJobWaiting(job: Pick<JobState, 'messages'> | undefined): boolean {
  return !!job && job.messages.some(isMessageWaiting);
}

export function waitingJobIds(jobs: Record<string, Pick<JobState, 'messages'>>): string[] {
  return Object.keys(jobs).filter((id) => isJobWaiting(jobs[id]));
}

export function titleWithWaiting(base: string, count: number): string {
  return count > 0 ? `(${count}) ${base}` : base;
}
