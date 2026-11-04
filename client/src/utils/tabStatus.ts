// One status per tab. Derived only from state the client already holds: whether a
// turn is running, whether a structured question waits, and whether a turn
// finished while the tab was not on screen.
export type TabStatus = 'needs-you' | 'working' | 'new-reply' | 'idle';

export const TAB_STATUS_LABEL: Record<TabStatus, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  'new-reply': 'New reply',
  idle: 'Idle',
};

export const TAB_STATUS_HINT: Record<TabStatus, string> = {
  'needs-you': 'A worker is waiting for your answer.',
  working: 'A turn is running.',
  'new-reply': 'A turn finished while you were elsewhere. Opening the tab clears this.',
  idle: 'Nothing is running and nothing is waiting.',
};

/** Needs you outranks Working, which outranks New reply. */
export function tabStatus(input: { waiting: boolean; busy: boolean; unviewed: boolean }): TabStatus {
  if (input.waiting) return 'needs-you';
  if (input.busy) return 'working';
  if (input.unviewed) return 'new-reply';
  return 'idle';
}

/** A member that is idle while messages wait for it: it needs a nudge from the operator. */
export function idleWithMail(member: { status: string; workflowId: string }, depth: unknown, jobBusy: boolean | undefined): boolean {
  return member.status !== 'busy' && !jobBusy && typeof depth === 'number' && Number.isSafeInteger(depth) && depth > 0;
}

export function clusterHasIdleMail(
  cluster: { members: { status: string; workflowId: string }[]; mailboxDepth?: Record<string, number> },
  jobs: Record<string, { busy?: boolean } | undefined>,
): boolean {
  return cluster.members.some((m) => idleWithMail(m, cluster.mailboxDepth?.[m.workflowId], jobs[m.workflowId]?.busy));
}
