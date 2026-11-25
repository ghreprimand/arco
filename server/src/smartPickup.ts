// Smart AUTO-PICKUP session supervision: arming validation, session expiry
// and restart recovery. Evaluator calls and wakes come later; this module only
// keeps the armed state honest so no Smart work can outlive its session.
import {
  isSmartPickupMode,
  sanitizeSmartPickupEvaluator,
  sanitizeSmartPickupLimits,
  sanitizeRulePickupLimits,
  RULE_PICKUP_LIMIT_KEYS,
  SMART_PICKUP_LIMIT_KEYS,
  SMART_PICKUP_LIMIT_SPECS,
  type AutoPickupMode,
  type ClusterAutoPickupState,
  type SmartPickupEvaluator,
  type SmartPickupLimits,
} from '@arco/shared';
import * as ruleAutoTurn from './clusterAutoTurn.js';
import * as clusterStore from './clusterStore.js';
import { pickupSmartWaitingMail } from './smartPickupObserver.js';
import { evaluatorAdapter } from './smartPickupAdapters.js';
import {
  recordSmartPickupDecision,
  recoverSmartPickupLedger,
  smartPickupSnapshot,
  SmartPickupLedgerUnreadable,
} from './smartPickupLedger.js';

type Changed = (clusterId: string) => void;
let onChanged: Changed = () => {};
let timer: NodeJS.Timeout | null = null;

export const SMART_PICKUP_SWEEP_MS = (() => {
  const raw = Number(process.env.ARCO_SMART_PICKUP_SWEEP_MS);
  return Number.isInteger(raw) && raw >= 50 ? raw : 15_000;
})();

export type ArmProblem = 'unknown_cluster' | 'invalid_mode' | 'invalid_pause' | 'evaluator_required' | 'evaluator_provider_disabled' | 'evaluator_unavailable' | 'ledger_unreadable';

// Validate and apply an operator's AUTO-PICKUP choice. A Smart mode needs an
// evaluator whose provider is enabled and a readable budget ledger; arming
// always starts a fresh session. Every change is logged in the ledger.
export async function applyAutoPickup(
  clusterId: string,
  request: { mode: unknown; paused?: unknown; evaluator?: unknown; limits?: unknown; customLimits?: unknown; ruleLimits?: unknown; resumeRule?: boolean; remindBusy?: boolean },
  isProviderEnabled: (provider: SmartPickupEvaluator['provider']) => boolean,
  now = Date.now(),
): Promise<{ ok: true; mode: AutoPickupMode } | { ok: false; problem: ArmProblem }> {
  const mode = request.mode;
  if (mode !== 'off' && mode !== 'rule' && mode !== 'smart-observe' && mode !== 'smart-auto') return { ok: false, problem: 'invalid_mode' };
  const state = clusterStore.getClusterCached(clusterId) ?? await clusterStore.readCluster(clusterId).catch(() => null);
  if (!state) return { ok: false, problem: 'unknown_cluster' };
  if (request.paused !== undefined) {
    if (typeof request.paused !== 'boolean' || mode === 'off' || mode !== clusterStore.autoPickupModeOf(state)
      || request.resumeRule || request.evaluator !== undefined || request.limits !== undefined || request.customLimits !== undefined || request.ruleLimits !== undefined || request.remindBusy !== undefined) return { ok: false, problem: 'invalid_pause' };
    const session = state.smartPickup?.session;
    if (isSmartPickupMode(mode) && (!session || (state.autoPickupPausedAt ?? now) >= session.expiresAt)) {
      await disarm(clusterId, session ? 'session_expired' : 'session_missing', now);
      return { ok: true, mode: 'off' };
    }
    const updated = await clusterStore.setAutoPickup(clusterId, { mode, paused: request.paused, now });
    if (!updated) return { ok: false, problem: 'invalid_pause' };
    await recordSmartPickupDecision(clusterId, { at: now, action: null, reason: request.paused ? 'operator_paused' : 'operator_resumed', outcome: 'none' }).catch(() => undefined);
    if (state.autoPickupPausedAt !== undefined && !request.paused) {
      // Reply with the new control state promptly; evaluator requests may take
      // time. Both scans use the same admission path as ordinary waiting mail.
      setImmediate(() => {
        void (mode === 'rule' ? ruleAutoTurn.pickupWaitingMail(clusterId) : pickupSmartWaitingMail(clusterId)).catch((error) => console.error('[arco] auto-pickup resume failed:', error));
      });
    }
    return { ok: true, mode };
  }
  if (request.resumeRule && state.autoPickupPausedAt !== undefined) return { ok: false, problem: 'invalid_pause' };
  let evaluator: SmartPickupEvaluator | undefined;
  if (isSmartPickupMode(mode)) {
    evaluator = sanitizeSmartPickupEvaluator(request.evaluator) ?? undefined;
    if (!evaluator) return { ok: false, problem: 'evaluator_required' };
    if (!isProviderEnabled(evaluator.provider)) return { ok: false, problem: 'evaluator_provider_disabled' };
    // Refuse a provider its adapter cannot run tool-free (Codex) or that lacks
    // the needed sign-in, instead of arming a session that fails closed on
    // every call and spends reservations.
    const capability = await evaluatorAdapter(evaluator.provider).capability().catch(() => ({ available: false }));
    if (!capability.available) return { ok: false, problem: 'evaluator_unavailable' };
    try { await smartPickupSnapshot(clusterId, undefined, now); }
    catch (err) { if (err instanceof SmartPickupLedgerUnreadable) return { ok: false, problem: 'ledger_unreadable' }; throw err; }
  }
  const limits = request.limits && typeof request.limits === 'object'
    ? pickLimits(request.limits as Record<string, unknown>)
    : undefined;
  const ruleLimits = request.ruleLimits && typeof request.ruleLimits === 'object' ? pickRuleLimits(request.ruleLimits as Record<string, unknown>) : undefined;
  const rawCustom = request.customLimits && typeof request.customLimits === 'object' ? request.customLimits as Record<string, unknown> : undefined;
  const customLimits = rawCustom && SMART_PICKUP_LIMIT_KEYS.every((key) => {
    const value = rawCustom[key];
    const spec = SMART_PICKUP_LIMIT_SPECS[key];
    return typeof value === 'number' && Number.isInteger(value) && value >= spec.min && value <= spec.max;
  }) ? sanitizeSmartPickupLimits(rawCustom) : undefined;
  const updated = await clusterStore.setAutoPickup(clusterId, { mode, evaluator, limits, customLimits, ruleLimits, remindBusy: request.remindBusy, now });
  if (!updated) return { ok: false, problem: 'unknown_cluster' };
  try {
    if (mode === 'rule' && (request.resumeRule === true || clusterStore.autoPickupModeOf(state) !== 'rule')) ruleAutoTurn.resumeRulePickup(clusterId);
  } catch { return { ok: false, problem: 'ledger_unreadable' }; }
  await recordSmartPickupDecision(clusterId, {
    at: now, action: null, reason: isSmartPickupMode(mode) ? `armed_${mode}` : `set_${mode}`, outcome: 'none',
  }).catch(() => undefined);
  return { ok: true, mode };
}

function pickRuleLimits(raw: Record<string, unknown>): Partial<import('@arco/shared').RulePickupLimits> {
  const sane = sanitizeRulePickupLimits(raw);
  const out: Partial<import('@arco/shared').RulePickupLimits> = {};
  for (const key of RULE_PICKUP_LIMIT_KEYS) if (raw[key] === sane[key]) out[key] = sane[key];
  return out;
}

// Only keys the operator sent, each already bounded; the store merges them
// over the saved limits.
function pickLimits(raw: Record<string, unknown>): Partial<SmartPickupLimits> {
  const sane = sanitizeSmartPickupLimits(raw);
  const out: Partial<SmartPickupLimits> = {};
  for (const key of Object.keys(sane) as (keyof SmartPickupLimits)[]) {
    if (raw[key] === sane[key]) out[key] = sane[key];
  }
  return out;
}

// State echo for cluster_state. Counters are read from the ledger; an
// unreadable ledger reports no counters (the supervisor disarms Smart).
export async function autoPickupStateFor(state: clusterStore.ClusterState, now = Date.now()): Promise<ClusterAutoPickupState> {
  const mode = clusterStore.autoPickupModeOf(state);
  const smart = state.smartPickup ?? {};
  const out: ClusterAutoPickupState = {
    mode,
    paused: state.autoPickupPausedAt !== undefined,
    ...(state.autoPickupPausedAt !== undefined ? { pausedAt: state.autoPickupPausedAt } : {}),
    remindBusy: state.remindBusy === true,
    limits: clusterStore.smartPickupLimitsOf(state),
    ...(smart.customLimits ? { customLimits: sanitizeSmartPickupLimits(smart.customLimits) } : {}),
    ...(process.env.ARCO_CLUSTER_AUTO_TURN_MAX_CHAIN_DEPTH ? { effectiveMaxChainDepth: ruleAutoTurn.smartChainDepthLimit(clusterStore.smartPickupLimitsOf(state).maxChainDepth) } : {}),
    ruleLimits: sanitizeRulePickupLimits(state.rulePickupLimits),
    ruleStatus: ruleAutoTurn.rulePickupStatus(state.clusterId),
    ...(smart.lastEvaluator ? { lastEvaluator: smart.lastEvaluator } : {}),
  };
  if (isSmartPickupMode(mode)) {
    if (smart.evaluator) out.evaluator = smart.evaluator;
    if (smart.session) out.session = smart.session;
  }
  if (isSmartPickupMode(mode) || smart.lastEvaluator) {
    try {
      const snap = await smartPickupSnapshot(state.clusterId, isSmartPickupMode(mode) ? smart.session?.id : undefined, now);
      out.counters = snap.counters;
      if (snap.lastDecision) out.lastDecision = snap.lastDecision;
    } catch { /* unreadable: no counters */ }
  }
  return out;
}

async function disarm(clusterId: string, reason: string, now: number): Promise<void> {
  await clusterStore.setAutoPickup(clusterId, { mode: 'off', now }).catch(() => null);
  await recordSmartPickupDecision(clusterId, { at: now, action: null, reason, outcome: 'none' }).catch(() => undefined);
  console.log(`[arco] cluster ${clusterId.slice(0, 8)} smart auto-pickup disarmed: ${reason}`);
  onChanged(clusterId);
}

// A Smart cluster stays armed only while its session is valid and its
// ledger is readable.
export async function sweepSmartPickup(now = Date.now()): Promise<void> {
  for (const clusterId of clusterStore.listKnownClusterIds()) {
    const state = clusterStore.getClusterCached(clusterId);
    if (!state || !isSmartPickupMode(clusterStore.autoPickupModeOf(state))) continue;
    const session = state.smartPickup?.session;
    if (!session || !state.smartPickup?.evaluator) { await disarm(clusterId, 'session_missing', now); continue; }
    if (state.autoPickupPausedAt === undefined && now >= session.expiresAt) { await disarm(clusterId, 'session_expired', now); continue; }
    try { await smartPickupSnapshot(clusterId, session.id, now); }
    catch { await disarm(clusterId, 'ledger_unreadable', now); }
  }
}

// Restart: open reservations become spent; a Smart cluster whose ledger
// cannot be read, or whose session ended while the server was down, is
// disarmed rather than given a fresh budget.
export async function recoverSmartPickupOnBoot(now = Date.now()): Promise<void> {
  const clusters = await clusterStore.loadAllClustersFromDisk().catch(() => []);
  for (const state of clusters) {
    const smart = isSmartPickupMode(clusterStore.autoPickupModeOf(state));
    if (!smart && !state.smartPickup) continue;
    try {
      await recoverSmartPickupLedger(state.clusterId, now);
    } catch {
      if (smart) await disarm(state.clusterId, 'ledger_unreadable', now);
      continue;
    }
  }
  await sweepSmartPickup(now);
}

export function startSmartPickupSupervisor(changed: Changed): void {
  onChanged = changed;
  if (timer) return;
  void recoverSmartPickupOnBoot().catch((err) => console.error('[arco] smart auto-pickup recovery failed:', err));
  timer = setInterval(() => { void sweepSmartPickup().catch(() => undefined); }, SMART_PICKUP_SWEEP_MS);
  timer.unref?.();
}

export function stopSmartPickupSupervisor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
