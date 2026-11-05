import { buildClusterNudge } from '@arco/shared';
export { buildClusterNudge } from '@arco/shared';
export const NUDGE_PROMPT = buildClusterNudge();
export const ACTIVE_NUDGE_PROMPT = buildClusterNudge(undefined, true);

// NUDGE ALL WITH MAIL: the members with waiting mail, in roster order. A
// mailbox count for a member that left the cluster is ignored.
export function membersWithMail(members: ReadonlyArray<{ workflowId: string }>, depth: Record<string, number> | undefined): string[] {
  return members.filter((m) => (depth?.[m.workflowId] ?? 0) > 0).map((m) => m.workflowId);
}

export const NUDGE_ALL_NONE = 'No member has waiting mail';

// The command palette asks the cluster tab to nudge everyone with mail. The
// tab that owns the cluster answers and marks the request handled.
const NUDGE_ALL_EVENT = 'arco:cluster-nudge-all';
interface NudgeAllRequest { clusterId: string; handled: boolean }

export function requestNudgeAll(clusterId: string): boolean {
  if (typeof window === 'undefined') return false;
  const detail: NudgeAllRequest = { clusterId, handled: false };
  window.dispatchEvent(new CustomEvent<NudgeAllRequest>(NUDGE_ALL_EVENT, { detail }));
  return detail.handled;
}

export function onNudgeAllRequest(handler: (clusterId: string) => boolean): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<NudgeAllRequest>).detail;
    if (!detail || detail.handled) return;
    if (handler(detail.clusterId)) detail.handled = true;
  };
  window.addEventListener(NUDGE_ALL_EVENT, listener);
  return () => window.removeEventListener(NUDGE_ALL_EVENT, listener);
}
