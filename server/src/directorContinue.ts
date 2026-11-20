// Continue the Director on an approved task (docs/PROTOCOL_CLUSTER.md
// "Continue the Director").
//
// When a Director turn ends, Arco looks at structured state only: the
// operator's approval on each board task (LedgerTask.operatorApproval, set by
// the operator's task_ledger_update), the handoff records peer_send writes when
// it carries task_id (task comments with metadata kind 'handoff', bound to the
// approval current when they were sent), the
// recipients' mailboxes, member busy state and the AUTO-PICKUP setting. It
// picks at most one approved task and offers the operator, in the Director's
// chat, either CONTINUE DIRECTOR (no member has been handed the task) or a
// pointer to NUDGE (the handoff waits in an idle member's queue and nothing
// will wake it). Anything uncertain stays quiet.
//
// The operator's click is the only thing that starts a Director turn here.
// The click is checked again, the offer is consumed once for every client, and
// the turn goes through the ordinary operator turn path with a claim guard, so
// STOP, operator questions and AUTO-PICKUP keep their behaviour. No retries.

import { randomUUID } from 'node:crypto';
import {
  isTaskApprovalCurrent,
  type DirectorContinueOffer,
  type LedgerTask,
  type ServerMessage,
  type TaskComment,
} from '@arco/shared';
import * as clusterStore from './clusterStore.js';
import * as clusterMailbox from './clusterMailbox.js';
import { isClusterDirectorRole } from './clusterDirector.js';
import { loadClusterBoardKernel } from './clusterPeerOps.js';
import { persistLedgerMutation } from './ws/taskLedgerHandlers.js';
import * as taskLedger from './project/taskLedger.js';
import { setDirectorContinueObserver } from './directorContinueHook.js';

export type ContinuePick =
  | { kind: 'continue'; taskId: string; approvalId: string }
  | { kind: 'nudge'; taskId: string; approvalId: string; memberWorkflowId: string };

export interface ContinueState {
  directorId: string;
  members: readonly string[];
  tasks: readonly LedgerTask[];
  comments: readonly TaskComment[];
  // Unread mail per member: message ids and senders. A member left out has a
  // mailbox that could not be read, so its delivery state is unknown.
  pending: ReadonlyMap<string, ReadonlyArray<{ msgId: string; fromWorkflowId: string }>>;
  // true working, false idle, undefined unknown.
  busy: (workflowId: string) => boolean | undefined;
  autoPickupWakes: boolean;
}

const RUNNABLE = new Set<LedgerTask['status']>(['todo', 'ready']);

// Handoffs recorded for this approval of the task. A handoff sent under an
// earlier approval, or before any, delivered a different scope and does not
// count for the current one.
function handoffsFor(taskId: string, approvalId: string, comments: readonly TaskComment[]): Array<{ to: string; msgId: string; at: number }> {
  const out: Array<{ to: string; msgId: string; at: number }> = [];
  for (const c of comments) {
    const m = c.metadata;
    if (c.taskId !== taskId || !m || m.kind !== 'handoff' || m.approvalId !== approvalId) continue;
    if (typeof m.toWorkflowId === 'string' && typeof m.msgId === 'string') out.push({ to: m.toWorkflowId, msgId: m.msgId, at: c.createdAt });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** What, if anything, to offer for one task. null means stay quiet: not
 * approved, not runnable, already underway, or uncertain. */
export function evaluateTask(task: LedgerTask, state: ContinueState): ContinuePick | null {
  // DISMISS closes everything for this approval; after CONTINUE DIRECTOR only
  // the NUDGE pointer can still appear, never a second continue.
  if (!isTaskApprovalCurrent(task) || task.operatorApproval?.offer === 'dismissed') return null;
  if (!RUNNABLE.has(task.status)) return null;
  // The same dependency rule as the task dispatcher: every parent exists and
  // is done, so approved work is never handed off early.
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  if (task.parentIds.some((id) => byId.get(id)?.status !== 'done')) return null;
  const approvalId = task.operatorApproval!.id;
  const handoffs = handoffsFor(task.id, approvalId, state.comments);
  const last = handoffs[handoffs.length - 1];
  if (last) {
    // A recorded handoff: quiet unless it still sits unread with an idle
    // member that nothing will wake.
    if (!state.members.includes(last.to)) return null;
    const queued = (state.pending.get(last.to) ?? []).some((m) => m.msgId === last.msgId);
    if (!queued || state.autoPickupWakes || state.busy(last.to) !== false) return null;
    return { kind: 'nudge', taskId: task.id, approvalId, memberWorkflowId: last.to };
  }
  // No recorded handoff. Mail from the Director already waiting with the
  // task's assignee may be an unrecorded handoff, and an assignee whose
  // mailbox could not be read is unknown: stay quiet in both cases.
  if (task.assignee && task.assignee !== state.directorId) {
    const mail = state.pending.get(task.assignee);
    if (!mail || mail.some((m) => m.fromWorkflowId === state.directorId)) return null;
  }
  if (task.operatorApproval?.offer === 'continued') return null;
  return { kind: 'continue', taskId: task.id, approvalId };
}

/** At most one offer: highest priority first, then the oldest approval. */
export function pickContinueOffer(state: ContinueState): ContinuePick | null {
  const ordered = [...state.tasks]
    .filter((t) => t.operatorApproval)
    .sort((a, b) => b.priority - a.priority || a.operatorApproval!.at - b.operatorApproval!.at);
  for (const task of ordered) {
    const pick = evaluateTask(task, state);
    if (pick) return pick;
  }
  return null;
}

// ── Live state ──

interface Deps {
  sendLive: (workflowId: string, msg: ServerMessage) => void;
  isBusy: (workflowId: string) => boolean | undefined;
  startTurn: (workflowId: string, content: string, guard: (claim: () => boolean) => Promise<boolean>) => Promise<boolean>;
}

let deps: Deps | undefined;
const offers = new Map<string, DirectorContinueOffer>();
const revalidating = new Set<string>();

export function configure(d: Deps): void {
  deps = d;
  setDirectorContinueObserver(observe);
}

function directorOf(clusterId: string): string | undefined {
  return (clusterStore.getMembers(clusterId) ?? []).find((id) => isClusterDirectorRole(clusterStore.getMemberRole(clusterId, id)));
}

async function loadState(clusterId: string, directorId: string): Promise<(ContinueState & { cwd: string; boardKey?: string }) | null> {
  if (!deps || !clusterStore.isTaskBoardAttached(clusterId)) return null;
  const board = await loadClusterBoardKernel(clusterId).catch(() => null);
  if (!board) return null;
  const members = clusterStore.getMembers(clusterId) ?? [];
  const pending = new Map<string, Array<{ msgId: string; fromWorkflowId: string }>>();
  for (const id of members) {
    const mail = await clusterMailbox.peek(id).catch(() => null);
    // An unreadable mailbox makes delivery uncertain: it is left out, which
    // evaluateTask reads as unknown and keeps quiet.
    if (mail) pending.set(id, mail.map((m) => ({ msgId: m.msgId, fromWorkflowId: m.fromWorkflowId })));
  }
  return {
    cwd: board.cwd,
    ...(board.boardKey ? { boardKey: board.boardKey } : {}),
    directorId,
    members,
    tasks: board.tasks,
    comments: board.comments,
    pending,
    busy: (id) => deps!.isBusy(id),
    autoPickupWakes: clusterStore.isAutoPickupWaking(clusterId) && !clusterStore.isAutoPickupPaused(clusterId),
  };
}

function toOffer(clusterId: string, pick: ContinuePick, tasks: readonly LedgerTask[]): DirectorContinueOffer {
  const task = tasks.find((t) => t.id === pick.taskId)!;
  return {
    id: randomUUID(),
    clusterId,
    taskId: pick.taskId,
    taskTitle: task.title,
    approvalId: pick.approvalId,
    kind: pick.kind,
    ...(pick.kind === 'nudge' ? { memberWorkflowId: pick.memberWorkflowId, memberName: clusterStore.displayNameFor(pick.memberWorkflowId) } : {}),
    createdAt: Date.now(),
  };
}

function publish(directorId: string, offer: DirectorContinueOffer | null, notice?: string): void {
  if (offer) offers.set(directorId, offer);
  else offers.delete(directorId);
  deps?.sendLive(directorId, { type: 'director_continue_offer', workflowId: directorId, offer, ...(notice ? { notice } : {}) });
}

/** The Director's open offer, if any, for a client that attaches. */
export function currentOffer(workflowId: string): DirectorContinueOffer | undefined {
  return offers.get(workflowId);
}

/** Send the current offer to a (re)connecting client of this workflow. */
export function sendCurrentOffer(workflowId: string): void {
  const offer = offers.get(workflowId);
  if (offer) deps?.sendLive(workflowId, { type: 'director_continue_offer', workflowId, offer });
}

/** Compute the offer when a Director turn ends. */
export async function onDirectorTurnEnded(workflowId: string): Promise<void> {
  const clusterId = clusterStore.getClusterIdForWorkflow(workflowId);
  if (!clusterId || directorOf(clusterId) !== workflowId) return;
  // The end of a turn is announced just before its busy flag clears; give it
  // a moment. Still busy after that means a queued message started a new turn.
  for (let i = 0; i < 10 && deps?.isBusy(workflowId); i++) await new Promise((r) => setTimeout(r, 200));
  if (deps?.isBusy(workflowId)) return;
  const state = await loadState(clusterId, workflowId);
  const pick = state ? pickContinueOffer(state) : null;
  // The Director may have started another turn while the state loaded.
  if (deps?.isBusy(workflowId)) return;
  const current = offers.get(workflowId);
  if (!pick) { if (current) publish(workflowId, null); return; }
  if (current && current.taskId === pick.taskId && current.approvalId === pick.approvalId && current.kind === pick.kind
    && current.memberWorkflowId === (pick.kind === 'nudge' ? pick.memberWorkflowId : undefined)) return;
  publish(workflowId, toOffer(clusterId, pick, state!.tasks));
}

/** Clear the Director's offer when its task is picked up or no longer
 * qualifies. Never creates a new offer. */
export async function revalidate(clusterId: string): Promise<void> {
  const directorId = directorOf(clusterId);
  const offer = directorId ? offers.get(directorId) : undefined;
  if (!directorId || !offer || revalidating.has(directorId)) return;
  revalidating.add(directorId);
  try {
    const state = await loadState(clusterId, directorId);
    const task = state?.tasks.find((t) => t.id === offer.taskId);
    const pick = state && task ? evaluateTask(task, state) : null;
    const same = pick && pick.kind === offer.kind && pick.approvalId === offer.approvalId && (pick.kind !== 'nudge' || pick.memberWorkflowId === offer.memberWorkflowId);
    if (!same && offers.get(directorId)?.id === offer.id) publish(directorId, null);
  } finally {
    revalidating.delete(directorId);
  }
}

const pendingRevalidate = new Set<string>();
function scheduleRevalidate(clusterId: string): void {
  if (pendingRevalidate.has(clusterId)) return;
  pendingRevalidate.add(clusterId);
  setTimeout(() => {
    pendingRevalidate.delete(clusterId);
    void revalidate(clusterId).catch(() => undefined);
  }, 250).unref?.();
}

// Wired into broadcastWorkflow through directorContinueHook.ts.
function observe(workflowId: string, message: ServerMessage): void {
  if (message.type !== 'primary_turn_started' && message.type !== 'primary_turn_ended'
    && message.type !== 'task_ledger_event' && message.type !== 'peer_message_received') return;
  const clusterId = clusterStore.getClusterIdForWorkflow(workflowId);
  if (!clusterId) return;
  const directorId = directorOf(clusterId);
  if (message.type === 'primary_turn_started' && directorId === workflowId) {
    // A new Director turn makes the last turn's offer moot; the turn's end
    // computes a fresh one.
    if (offers.has(workflowId)) publish(workflowId, null);
    return;
  }
  if (message.type === 'primary_turn_ended' && directorId === workflowId) {
    setImmediate(() => { void onDirectorTurnEnded(workflowId).catch((err) => console.error('[arco] director continue check failed:', err)); });
    return;
  }
  if (directorId && offers.has(directorId)) scheduleRevalidate(clusterId);
}

export function continuePrompt(taskId: string): string {
  return `(continue) The operator pressed CONTINUE DIRECTOR for approved board task ${taskId}, which no member has been handed yet. Read it with cluster_task_show, then hand it to its owner with peer_send and task_id ${taskId} in this turn. If it cannot be handed off now, say why in one line.`;
}

async function markOffer(directorId: string, state: { cwd: string; boardKey?: string }, offer: DirectorContinueOffer, outcome: 'dismissed' | 'continued'): Promise<void> {
  const taskId = offer.taskId;
  await persistLedgerMutation(directorId, state.cwd, 'update', (tasks) => {
    // Only the approval the offer was made for: a withdrawn, re-approved or
    // edited approval is left as it is.
    const current = tasks.find((t) => t.id === taskId);
    if (!current || !isTaskApprovalCurrent(current) || current.operatorApproval?.id !== offer.approvalId) return null;
    const result = taskLedger.applyUpdate(tasks, taskId, { approvalOffer: outcome, approvalOfferFor: offer.approvalId });
    return result ? { tasks: result.tasks, id: taskId, task: result.updated } : null;
  }, state.boardKey ? { boardKey: state.boardKey } : undefined);
}

/** The operator's CONTINUE DIRECTOR or DISMISS. */
export async function act(workflowId: string, offerId: string, action: 'continue' | 'dismiss'): Promise<void> {
  const offer = offers.get(workflowId);
  if (!offer || offer.id !== offerId) {
    deps?.sendLive(workflowId, { type: 'director_continue_offer', workflowId, offer: offers.get(workflowId) ?? null, notice: 'This offer is no longer open.' });
    return;
  }
  // Consume before any await, so a second click or another client finds
  // nothing to act on.
  publish(workflowId, null);
  const state = await loadState(offer.clusterId, workflowId);
  if (action === 'dismiss') {
    if (state) await markOffer(workflowId, state, offer, 'dismissed').catch(() => undefined);
    return;
  }
  if (offer.kind !== 'continue') return;
  const notStarted = (why: string) => deps?.sendLive(workflowId, { type: 'director_continue_offer', workflowId, offer: null, notice: `Director not continued: ${why}` });
  if (!state || !deps) { notStarted('the task board could not be read.'); return; }
  let reason = '';
  const accepted = await deps.startTurn(workflowId, continuePrompt(offer.taskId), async (claim) => {
    // Checked again at the moment the turn would start.
    const fresh = await loadState(offer.clusterId, workflowId);
    const task = fresh?.tasks.find((t) => t.id === offer.taskId);
    const pick = fresh && task ? evaluateTask(task, fresh) : null;
    if (directorOf(offer.clusterId) !== workflowId) { reason = 'this tab is no longer the Director.'; return false; }
    if (!pick || pick.kind !== 'continue' || pick.approvalId !== offer.approvalId) { reason = 'the task no longer needs a handoff.'; return false; }
    if (!claim()) { reason = 'the Director is busy.'; return false; }
    return true;
  }).catch(() => false);
  if (!accepted) { notStarted(reason || 'the Director is busy.'); return; }
  await markOffer(workflowId, state, offer, 'continued').catch(() => undefined);
}
