// Smart AUTO-PICKUP observer: decides, for one idle member at a time, what
// the chosen evaluator proposes for its waiting mail, and records it. In
// Observe-only mode that record is the whole effect. In Automatic mode a wake
// proposal goes through the deterministic gate below, which rechecks
// everything under the mailbox lock before the normal turn path admits it.
// Mail is never read destructively: the worker's own turn delivers it.
//
// Per recipient: one evaluation at a time, after a short debounce; one
// decision per unchanged mail fingerprint per session; an evaluator slot is
// reserved before any request and always counts. A result is discarded when
// the session or mode changed while it was running.
import {
  isSmartPickupMode,
  presetForText,
  sanitizeSmartPickupLimits,
  type SmartPickupAction,
} from '@arco/shared';
import * as clusterStore from './clusterStore.js';
import * as clusterMailbox from './clusterMailbox.js';
import * as taskLedger from './project/taskLedger.js';
import { recordSmartPickupDecision, reserveSmartPickup, settleSmartPickup, setSmartPickupHold, smartPickupHoldActive } from './smartPickupLedger.js';
import { buildSnapshot, EVALUATOR_INSTRUCTIONS, isOpenTaskStatus, evaluatorUserPrompt, mailFingerprint, parseEvaluatorAnswer, type SnapshotInput } from './smartPickupEvaluator.js';
import { sharedGuardProblem, stampSharedGuards } from './clusterAutoTurn.js';
import { withFileLock } from './atomicFile.js';
import { buildClusterAutoPickup } from '@arco/shared';
import { evaluatorAdapter, isStartupFailure } from './smartPickupAdapters.js';
import { recentSentTo } from './smartPickupThread.js';

export interface ObservedDecision {
  clusterId: string;
  recipientWorkflowId: string;
  sessionId: string;
  fingerprint: string;
  action: SmartPickupAction | null;
  reason: string;
  outcome: string;
}

interface Deps {
  isBusy: (workflowId: string) => boolean;
  readSnapshot: (clusterId: string, workflowId: string, busy: boolean) => Promise<SnapshotInput>;
  // Called after a decision is recorded (cluster_state refresh, and the
  // Automatic gate in a later slice).
  onDecision: (decision: ObservedDecision) => void | Promise<void>;
  // Starts the member's turn only if the guard's claim succeeds (the
  // conditional-admission path of handleUserMessage). Absent: no wakes.
  dispatchGuarded?: (workflowId: string, content: string, guard: (claim: () => boolean) => Promise<boolean>) => Promise<boolean>;
  // One operator alert per ask decision.
  notifyAsk?: (decision: ObservedDecision) => void;
  now: () => number;
  debounceMs: number;
  // How long a defer for unchanged mail stands before it is evaluated again.
  deferMs: number;
}

const defaultDebounce = (() => {
  const raw = Number(process.env.ARCO_SMART_PICKUP_DEBOUNCE_MS);
  return Number.isInteger(raw) && raw >= 0 ? raw : 2000;
})();

let deps: Deps = {
  isBusy: () => false,
  readSnapshot: readSnapshotInput,
  onDecision: () => {},
  now: () => Date.now(),
  debounceMs: defaultDebounce,
  deferMs: (() => {
    const raw = Number(process.env.ARCO_SMART_PICKUP_DEFER_MS);
    return Number.isInteger(raw) && raw >= 0 ? raw : 10 * 60_000;
  })(),
};

const running = new Map<string, Promise<void>>();
const rerun = new Set<string>();
// Last decision per recipient: session, fingerprint, the action, when a
// defer lapses, and whether an admissible wake is still owed.
interface Decided { sessionId: string; fingerprint: string; action: SmartPickupAction | null; reason?: string; deferUntil?: number; wakeOwed?: boolean; retryEvaluation?: boolean; startupRetried?: boolean }
const decided = new Map<string, Decided>();
// Highest chain depth of peer mail that triggered evaluation since the last
// wake, for the shared chain guard.
const depthSeen = new Map<string, number>();

export function configureSmartPickupObserver(next: Partial<Deps>): void {
  deps = { ...deps, ...next };
}

export function resetSmartPickupObserverForTest(): void {
  running.clear(); rerun.clear(); decided.clear(); depthSeen.clear();
}

const key = (clusterId: string, workflowId: string) => `${clusterId}:${workflowId}`;

function roleLabel(clusterId: string, workflowId: string): string {
  const role = clusterStore.getMemberRole(clusterId, workflowId) ?? '';
  return presetForText(role)?.label ?? (role.trim() ? 'Member' : 'Member');
}

// Pending mail, roles and the recipient's open tasks. The mailbox is read
// twice: a strict id listing (which refuses invalid records) and the
// message bodies; any disagreement makes the snapshot unverifiable.
export async function readSnapshotInput(clusterId: string, workflowId: string, busy: boolean): Promise<SnapshotInput> {
  const recipientRole = roleLabel(clusterId, workflowId);
  let unreadable = false;
  let messages: SnapshotInput['messages'] = [];
  try {
    const strict = await clusterMailbox.pendingIdsStrict(clusterId, workflowId);
    const pending = await clusterMailbox.peek(workflowId);
    const ids = pending.map((m) => m.msgId).sort();
    if (ids.length !== strict.length || ids.some((id, i) => id !== strict[i])) unreadable = true;
    messages = pending.map((m) => ({ id: m.msgId, senderId: m.fromWorkflowId, senderRole: roleLabel(clusterId, m.fromWorkflowId), body: m.content, createdAt: m.createdAt }));
  } catch {
    unreadable = true;
  }
  let tasks: SnapshotInput['tasks'] = [];
  const state = clusterStore.getClusterCached(clusterId);
  const boardKey = state ? clusterStore.taskBoardKeyForState(state) : undefined;
  if (state && boardKey) {
    const all = await taskLedger.load(state.cwd, boardKey).catch(() => []);
    tasks = all.filter((t) => t.assignee === workflowId && isOpenTaskStatus(t.status)).slice(0, 5).map((t) => ({ id: t.id, title: t.title, status: t.status }));
  }
  const sentTo = [...new Set(messages.map((m) => m.senderId).filter((id): id is string => Boolean(id)))]
    .flatMap((to) => recentSentTo(workflowId, to).map((m) => ({ to, body: m.body, createdAt: m.createdAt })));
  return { recipientRole, recipientStatus: busy ? 'busy' : 'idle', messages, tasks, ...(sentTo.length ? { sentTo } : {}), ...(unreadable ? { unreadable: true } : {}) };
}

// Armed Smart session for a cluster, or null.
function armed(clusterId: string): { sessionId: string; mode: 'smart-observe' | 'smart-auto' } | null {
  const state = clusterStore.getClusterCached(clusterId);
  if (!state) return null;
  const mode = clusterStore.autoPickupModeOf(state);
  const session = state.smartPickup?.session;
  if (!isSmartPickupMode(mode) || !session || !state.smartPickup?.evaluator) return null;
  if (deps.now() >= session.expiresAt) return null;
  return { sessionId: session.id, mode };
}

// Mail arrived for a member (or a sweep found pending mail). Runs at most one
// evaluation per recipient at a time; a trigger during a run schedules one
// more pass afterwards.
export function onSmartPickupMail(clusterId: string, workflowId: string, chainDepth = 0): Promise<void> {
  if (!armed(clusterId)) return Promise.resolve();
  const k = key(clusterId, workflowId);
  if (chainDepth > (depthSeen.get(k) ?? 0)) depthSeen.set(k, chainDepth);
  const current = running.get(k);
  if (current) { rerun.add(k); return current; }
  const run = (async () => {
    try {
      do {
        rerun.delete(k);
        if (deps.debounceMs > 0) await new Promise((r) => setTimeout(r, deps.debounceMs));
        await evaluateOnce(clusterId, workflowId);
      } while (rerun.has(k));
    } finally {
      running.delete(k);
    }
  })();
  running.set(k, run);
  return run;
}

async function record(d: ObservedDecision, extra: Partial<Decided> = {}): Promise<void> {
  decided.set(key(d.clusterId, d.recipientWorkflowId), { sessionId: d.sessionId, fingerprint: d.fingerprint, action: d.action, reason: d.reason, ...extra });
  await recordSmartPickupDecision(d.clusterId, { at: deps.now(), recipientWorkflowId: d.recipientWorkflowId, action: d.action, reason: d.reason, outcome: d.outcome }).catch(() => undefined);
  console.log(`[arco] smart auto-pickup ${d.clusterId.slice(0, 8)}/${d.recipientWorkflowId.slice(0, 8)}: ${d.action ?? 'none'} (${d.reason}) -> ${d.outcome}`);
  await deps.onDecision(d);
}

export async function evaluateOnce(clusterId: string, workflowId: string): Promise<ObservedDecision | null> {
  const arm = armed(clusterId);
  if (!arm) return null;
  const state = clusterStore.getClusterCached(clusterId);
  if (!state || !state.members.includes(workflowId)) return null;
  // Busy members are not evaluated; the turn in progress reads its mail.
  if (deps.isBusy(workflowId)) return null;
  const limits = sanitizeSmartPickupLimits(state.smartPickup?.limits);
  const snapshot = buildSnapshot(await deps.readSnapshot(clusterId, workflowId, false), limits.maxInputBytes);
  if (snapshot.messageCount === 0 && !snapshot.preDecision?.reason.startsWith('unverifiable')) return null;
  const k = key(clusterId, workflowId);
  const prior = decided.get(k);
  const base = { clusterId, recipientWorkflowId: workflowId, sessionId: arm.sessionId, fingerprint: snapshot.fingerprint };
  if (prior && prior.sessionId === arm.sessionId && prior.fingerprint === snapshot.fingerprint) {
    // An admitted-in-principle wake that was blocked by a passing condition
    // (busy, cooldown) is retried without asking the evaluator again.
    if (prior.wakeOwed && arm.mode === 'smart-auto') return gateAndRecord({ ...base, action: 'wake', reason: 'retry', outcome: 'pending' }, arm);
    // A defer lapses after deferMs so unchanged mail is looked at again; an
    // evaluation refused by a passing limit is attempted again.
    const deferLapsed = prior.action === 'defer' && prior.deferUntil !== undefined && deps.now() >= prior.deferUntil;
    if (!deferLapsed && !prior.retryEvaluation) return null;
  }
  // STOP hold: mail the member already had when STOP was pressed is left
  // alone; an unreadable hold record counts as a hold.
  const held = await smartPickupHoldActive(clusterId, workflowId, (await deps.readSnapshot(clusterId, workflowId, false)).messages.map((m) => m.id), deps.now()).catch(() => true);
  if (held) {
    const d = { ...base, action: null, reason: 'stop_hold', outcome: 'skipped' };
    await record(d);
    return d;
  }
  if (snapshot.preDecision) {
    const d = { ...base, ...snapshot.preDecision, outcome: 'logged' };
    await record(d);
    return d;
  }
  const evaluator = state.smartPickup!.evaluator!;
  const slot = await reserveSmartPickup(clusterId, { kind: 'evaluator', memberId: workflowId, sessionId: arm.sessionId, limits, now: deps.now() }).catch(() => ({ ok: false as const, reason: 'ledger_unreadable' }));
  if (!slot.ok) {
    const d = { ...base, action: null, reason: slot.reason, outcome: 'skipped' };
    // Hourly and in-flight limits pass with time: try again later, but log a
    // given refusal once per mailbox.
    if (prior?.fingerprint === snapshot.fingerprint && prior.sessionId === arm.sessionId && prior.reason === slot.reason) {
      decided.set(k, { ...prior, retryEvaluation: true });
      return null;
    }
    await record(d, { retryEvaluation: true });
    return d;
  }
  let raw: string | null = null;
  let failure: string | null = null;
  try {
    raw = await evaluatorAdapter(evaluator.provider).evaluate({
      model: evaluator.model,
      instructions: EVALUATOR_INSTRUCTIONS,
      prompt: evaluatorUserPrompt(snapshot.payload!),
      timeoutMs: limits.timeoutSeconds * 1000,
      maxOutputTokens: limits.maxOutputTokens,
    });
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  await settleSmartPickup(clusterId, slot.id, failure ? 'error' : 'answered', deps.now()).catch(() => undefined);
  // The operator may have turned Smart off or re-armed meanwhile.
  const still = armed(clusterId);
  if (!still || still.sessionId !== arm.sessionId) {
    const d = { ...base, action: null, reason: 'session_changed', outcome: 'discarded' };
    await recordSmartPickupDecision(clusterId, { at: deps.now(), recipientWorkflowId: workflowId, action: null, reason: d.reason, outcome: d.outcome }).catch(() => undefined);
    return d;
  }
  if (failure !== null) {
    const d = { ...base, action: null, reason: `evaluator_error:${failure}`.slice(0, 64), outcome: 'none' };
    // A failure before the evaluator session was ready (a cold agent start)
    // says nothing about this mail: evaluate the same mail once more, with a
    // new reservation counted against the limits. Any other failure, or a
    // second start-up failure, stands until the mail changes.
    const sameMail = prior?.fingerprint === snapshot.fingerprint && prior.sessionId === arm.sessionId;
    if (isStartupFailure(failure) && !(sameMail && prior?.startupRetried)) {
      await record(d, { retryEvaluation: true, startupRetried: true });
      return d;
    }
    await record(d);
    return d;
  }
  const parsed = parseEvaluatorAnswer(raw);
  if (!parsed.ok) {
    const d = { ...base, action: null, reason: `invalid_answer:${parsed.problem}`, outcome: 'none' };
    await record(d);
    return d;
  }
  if (still.mode === 'smart-auto' && parsed.action === 'wake') return gateAndRecord({ ...base, action: 'wake', reason: parsed.reason, outcome: 'pending' }, still);
  const d = { ...base, action: parsed.action, reason: parsed.reason, outcome: 'logged' };
  await record(d, parsed.action === 'defer' ? { deferUntil: deps.now() + deps.deferMs } : {});
  if (parsed.action === 'ask' && still.mode === 'smart-auto') {
    try { deps.notifyAsk?.(d); } catch { /* alert is best-effort */ }
  }
  return d;
}

// Conditions that pass with time; a wake blocked by one stays owed.
const TRANSIENT = new Set(['busy', 'cooldown', 'rate_capped', 'limit_wakes_member_hour']);

async function gateAndRecord(proposal: ObservedDecision, arm: { sessionId: string; mode: 'smart-observe' | 'smart-auto' }): Promise<ObservedDecision> {
  const result = await gateWake(proposal, arm);
  const d = { ...proposal, outcome: result.outcome, ...(result.reason ? { reason: proposal.reason === 'retry' ? result.reason : `${proposal.reason}:${result.reason}` } : {}) };
  const owed = result.outcome !== 'woke' && result.reason !== undefined && TRANSIENT.has(result.reason);
  await record(d, owed ? { wakeOwed: true } : {});
  return d;
}

// The deterministic gate for an Automatic wake. Cheap checks first (busy,
// shared guards) so a blocked wake does not consume budget; then a wake slot
// is reserved and always counts; then, under the mailbox lock, the session,
// mode, membership, exact pending mail, STOP hold and busy state are checked
// again and the turn is claimed only if all still hold.
async function gateWake(p: ObservedDecision, arm: { sessionId: string }): Promise<{ outcome: string; reason?: string }> {
  const { clusterId, recipientWorkflowId: wfid } = p;
  if (!deps.dispatchGuarded) return { outcome: 'skipped', reason: 'no_dispatcher' };
  if (deps.isBusy(wfid)) return { outcome: 'skipped', reason: 'busy' };
  const k = key(clusterId, wfid);
  const depth = depthSeen.get(k) ?? 0;
  const shared = sharedGuardProblem(clusterId, wfid, depth, deps.now());
  if (shared) return { outcome: 'skipped', reason: shared };
  const state = clusterStore.getClusterCached(clusterId);
  const limits = sanitizeSmartPickupLimits(state?.smartPickup?.limits);
  const slot = await reserveSmartPickup(clusterId, { kind: 'wake', memberId: wfid, sessionId: arm.sessionId, limits, now: deps.now() }).catch(() => ({ ok: false as const, reason: 'ledger_unreadable' }));
  if (!slot.ok) return { outcome: 'skipped', reason: slot.reason };
  let refusal = 'refused';
  const prompt = buildClusterAutoPickup(clusterStore.getEfficiencyLevel(clusterId), clusterStore.getMemberRole(clusterId, wfid));
  let accepted = false;
  try {
    accepted = await deps.dispatchGuarded(wfid, prompt, (claim) => withFileLock(clusterStore.clusterMailboxRoot(clusterId), async () => {
      const now = armed(clusterId);
      if (!now || now.sessionId !== arm.sessionId || now.mode !== 'smart-auto') { refusal = 'session_changed'; return false; }
      if (!clusterStore.getClusterCached(clusterId)?.members.includes(wfid)) { refusal = 'member_changed'; return false; }
      let ids: string[];
      try { ids = await clusterMailbox.pendingIdsStrict(clusterId, wfid); } catch { refusal = 'unverifiable'; return false; }
      if (mailFingerprint(ids) !== p.fingerprint) { refusal = 'mail_changed'; return false; }
      if (await smartPickupHoldActive(clusterId, wfid, ids, deps.now()).catch(() => true)) { refusal = 'stop_hold'; return false; }
      if (sharedGuardProblem(clusterId, wfid, depth, deps.now())) { refusal = 'rate_capped'; return false; }
      if (!claim()) { refusal = 'busy'; return false; }
      stampSharedGuards(clusterId, wfid, depth, deps.now());
      depthSeen.delete(k);
      return true;
    }));
  } catch {
    accepted = false;
    refusal = 'dispatch_failed';
  }
  await settleSmartPickup(clusterId, slot.id, accepted ? 'woke' : refusal, deps.now()).catch(() => undefined);
  return accepted ? { outcome: 'woke' } : { outcome: 'skipped', reason: refusal };
}

// The operator pressed STOP on a member: hold Automatic pickup for the mail
// it has now. Any member of an armed Smart cluster is recorded; others are
// ignored.
export async function noteSmartPickupStop(workflowId: string): Promise<void> {
  const clusterId = clusterStore.getClusterIdForWorkflow(workflowId);
  if (!clusterId || !isSmartPickupMode(clusterStore.getAutoPickupMode(clusterId))) return;
  const ids = await clusterMailbox.pendingIdsStrict(clusterId, workflowId).catch(() => null);
  if (!ids || ids.length === 0) return;
  await setSmartPickupHold(clusterId, workflowId, ids, deps.now()).catch(() => undefined);
}

// Idle members with pending mail in armed Smart clusters, visited in a
// stable order so one busy mailbox cannot starve another.
let sweeping = false;
export async function sweepSmartPickupMail(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const clusterId of clusterStore.listKnownClusterIds().sort()) {
      if (!armed(clusterId)) continue;
      const members = [...(clusterStore.getClusterCached(clusterId)?.members ?? [])].sort();
      // One member at a time per cluster, in a stable order, so the
      // in-flight limit is respected and no mailbox starves another.
      for (const wfid of members) {
        if (deps.isBusy(wfid)) continue;
        const depth = await clusterMailbox.depthFor(wfid).catch(() => 0);
        if (depth > 0) await onSmartPickupMail(clusterId, wfid).catch(() => undefined);
      }
    }
  } finally {
    sweeping = false;
  }
}

let mailTimer: NodeJS.Timeout | null = null;
const MAIL_SWEEP_MS = (() => {
  const raw = Number(process.env.ARCO_SMART_PICKUP_MAIL_SWEEP_MS);
  return Number.isInteger(raw) && raw >= 50 ? raw : 5000;
})();

export function startSmartPickupObserver(next: Partial<Deps>): void {
  configureSmartPickupObserver(next);
  if (mailTimer) return;
  mailTimer = setInterval(() => { void sweepSmartPickupMail().catch(() => undefined); }, MAIL_SWEEP_MS);
  mailTimer.unref?.();
}
