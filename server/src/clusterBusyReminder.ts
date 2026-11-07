import { buildClusterNudge, isAutoPickupAcknowledgement } from '@arco/shared';
import * as store from './clusterStore.js';
import * as mailbox from './clusterMailbox.js';

export const BUSY_REMINDER_GAP_MS = 5 * 60_000;
interface ReminderState { at?: number; seen: Set<string> }
const states = new Map<string, ReminderState>();
const pending = new Set<string>();
export interface BusyReminderDeps {
  isBusy: (workflowId: string) => boolean;
  // True only when the ordinary steering path accepted the reminder while busy.
  dispatch: (workflowId: string, content: string, allow?: () => boolean) => Promise<boolean>;
}
function enabled(clusterId: string, workflowId: string, now: number): boolean {
  const state = store.getClusterCached(clusterId);
  if (state?.remindBusy !== true || !state.members.includes(workflowId)) return false;
  const mode = store.autoPickupModeOf(state);
  return mode === 'rule' || (mode === 'smart-auto' && (state.smartPickup?.session?.expiresAt ?? 0) > now);
}

export async function remindBusyMember(clusterId: string, workflowId: string, deps: BusyReminderDeps): Promise<void> {
  const key = `${clusterId}:${workflowId}`;
  if (pending.has(key) || !enabled(clusterId,workflowId,Date.now()) || !deps.isBusy(workflowId)) return;
  pending.add(key);
  try {
    const mail = await mailbox.peek(workflowId);
    const actionable = mail.filter(m => m.artifacts?.length || !isAutoPickupAcknowledgement(m.content));
    const ids = new Set(actionable.map(m=>m.msgId));
    const prior = states.get(key) ?? {seen:new Set<string>()};
    // Forget read mail, retaining the rate limit across successive batches.
    prior.seen = new Set([...prior.seen].filter(id=>ids.has(id)));
    states.set(key,prior);
    const now = Date.now();
    if (!ids.size || ![...ids].some(id=>!prior.seen.has(id)) || (prior.at !== undefined && now-prior.at < BUSY_REMINDER_GAP_MS)) return;
    if (!enabled(clusterId,workflowId,now) || !deps.isBusy(workflowId)) return;
    const prompt = buildClusterNudge(store.getEfficiencyLevel(clusterId),true,store.getMemberRole(clusterId,workflowId));
    if (await deps.dispatch(workflowId,prompt,() => enabled(clusterId,workflowId,Date.now()) && deps.isBusy(workflowId))) {
      prior.at = Date.now();
      for (const id of ids) prior.seen.add(id);
    }
  } catch { /* Unreadable mail or refused steering never sends a replacement turn. */ }
  finally { pending.delete(key); }
}
