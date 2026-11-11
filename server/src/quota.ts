// Slot 4 — per-provider throttle tracking. Process-local (NOT persisted to
// disk per §6.2); server restart resets every provider to `available` and
// observed errors re-flip them as needed.
//
// Providers mark observed limits and successful recovery. Goal-run continuation
// consults isAvailable; manual turns, queues and cluster routing do not.
// Known resets have unref'ed timers; lazy reads remain a fallback. Operators
// can explicitly clear a remembered limit without claiming provider recovery.
//
// Broadcasts: state mutations fire the change listener; index.ts wires it up
// to send a QuotaStatusMessage to all connected sessions (§6.6). The listener
// plumbing stays abstract so quota.ts has no WebSocket import.

import type { ProviderName } from '@arco/shared';

export type ThrottleSource = 'observed-error' | 'parsed-header' | 'manual-probe' | 'manual-clear' | 'default-available';

export interface QuotaState {
  throttled: boolean;
  resetsAt?: number;           // epoch ms; undefined when not known
  lastError?: string;
  lastErrorAt?: number;
  sourceOfTruth: ThrottleSource;
}

const PROVIDERS: ProviderName[] = ['claude', 'cursor', 'ollama', 'codex',  'llamacpp', 'lmstudio', 'strata', 'deepseek'];

function defaultState(): QuotaState {
  return { throttled: false, sourceOfTruth: 'default-available' };
}

const state = new Map<ProviderName, QuotaState>();
for (const p of PROVIDERS) state.set(p, defaultState());

const resetTimers = new Map<ProviderName, ReturnType<typeof setTimeout>>();
const MAX_TIMER_MS = 2_147_483_647;
function cancelReset(provider: ProviderName): void {
  const timer = resetTimers.get(provider);
  if (timer) clearTimeout(timer);
  resetTimers.delete(provider);
}
function scheduleReset(provider: ProviderName): void {
  cancelReset(provider);
  const current = state.get(provider);
  if (!current?.throttled || current.resetsAt === undefined || !Number.isFinite(current.resetsAt)) return;
  const delay = Math.max(0, Math.min(MAX_TIMER_MS, current.resetsAt - Date.now()));
  const timer = setTimeout(() => {
    resetTimers.delete(provider);
    const latest = state.get(provider);
    if (!latest?.throttled || latest.resetsAt === undefined) return;
    if (latest.resetsAt <= Date.now()) markAvailable(provider, 'parsed-header');
    else scheduleReset(provider); // chunk dates beyond the platform timer limit
  }, delay);
  timer.unref();
  resetTimers.set(provider, timer);
}

type ChangeListener = (provider: ProviderName, state: QuotaState) => void;
let listener: ChangeListener | null = null;

/** Wire a change listener (index.ts broadcasts QuotaStatusMessage from here). */
export function setChangeListener(fn: ChangeListener | null): void {
  listener = fn;
}

export function markThrottled(provider: ProviderName, errorText: string, resetsAt?: number): void {
  const prev = state.get(provider) ?? defaultState();
  // Each observation updates the error, replaces its reset timer and broadcasts.
  const next: QuotaState = {
    throttled: true,
    resetsAt: resetsAt ?? prev.resetsAt,
    lastError: errorText.slice(0, 500),
    lastErrorAt: Date.now(),
    sourceOfTruth: resetsAt !== undefined ? 'parsed-header' : 'observed-error',
  };
  state.set(provider, next);
  scheduleReset(provider);
  const resetTag = next.resetsAt ? ` (resets ${new Date(next.resetsAt).toISOString()})` : '';
  if (!prev.throttled) {
    console.log(`[arco] quota: ${provider} → throttled${resetTag}`);
  }
  // Broadcast on every mark — operator should see the latest error text even
  // if the throttled bit didn't flip.
  listener?.(provider, next);
}

export function markAvailable(provider: ProviderName, source: ThrottleSource = 'observed-error'): void {
  cancelReset(provider);
  const prev = state.get(provider);
  if (prev && !prev.throttled) return;
  const next: QuotaState = { throttled: false, sourceOfTruth: source };
  state.set(provider, next);
  console.log(`[arco] quota: ${provider} → available`);
  listener?.(provider, next);
}

/**
 * Whether a state change is a recovery worth a "quota recovered" notice.
 * Manual Clear and a usage recheck only forget the remembered limit; the
 * meter does not prove the limited account or model recovered.
 */
export function announcesRecovery(next: Pick<QuotaState, 'throttled' | 'sourceOfTruth'>): boolean {
  return !next.throttled && next.sourceOfTruth !== 'manual-clear' && next.sourceOfTruth !== 'manual-probe';
}

export function isAvailable(provider: ProviderName): boolean {
  const s = state.get(provider);
  if (!s || !s.throttled) return true;
  // Lazy fallback for reads racing the scheduled reset callback.
  if (s.resetsAt !== undefined && Date.now() >= s.resetsAt) {
    markAvailable(provider, 'parsed-header');
    return true;
  }
  return false;
}

export function getState(provider: ProviderName): QuotaState {
  isAvailable(provider);
  return state.get(provider) ?? defaultState();
}

export function snapshot(): Record<ProviderName, QuotaState> {
  const out = {} as Record<ProviderName, QuotaState>;
  for (const p of PROVIDERS) {
    isAvailable(p); // trigger lazy clear before snapshot
    out[p] = state.get(p) ?? defaultState();
  }
  return out;
}

/** Wire-shape snapshot for QuotaStatusMessage.providers. */
export function wireSnapshot(): Record<ProviderName, { throttled: boolean; resetsAt?: number }> {
  const full = snapshot();
  const out = {} as Record<ProviderName, { throttled: boolean; resetsAt?: number }>;
  for (const p of PROVIDERS) {
    out[p] = { throttled: full[p].throttled, ...(full[p].resetsAt !== undefined ? { resetsAt: full[p].resetsAt } : {}) };
  }
  return out;
}

/**
 * Legacy PROVIDER STATUS formatter, currently without live callers. Returns empty string when every
 * provider is available — no need to clutter the prompt when routing is
 * unconstrained. See §6.4 for the format.
 */
export function buildQuotaInjection(): string {
  const snap = snapshot();
  const anyThrottled = PROVIDERS.some((p) => snap[p].throttled);
  if (!anyThrottled) return '';
  const lines: string[] = ['## PROVIDER STATUS'];
  for (const p of PROVIDERS) {
    const s = snap[p];
    if (s.throttled) {
      const suffix = s.resetsAt
        ? ` until ${new Date(s.resetsAt).toISOString()}`
        : ' (no reset time known)';
      lines.push(`- ${p}: THROTTLED${suffix}`);
    } else {
      lines.push(`- ${p}: available`);
    }
  }
  lines.push('');
  lines.push('Dispatch AWAY from throttled providers. If a capable worker from an available provider can cover the task, pick that one. Throttled-provider spawns will fail — the cost of retrying is wasted tokens and a stuck workflow.');
  return lines.join('\n');
}

/**
 * §5.4 cross-family reviewer fallback. Maps a primary model to a cross-family
 * reviewer used when the preferred reviewer's provider is throttled. Returns
 * null for models that intentionally skip review (ollama / heretic).
 *
 * Legacy helper, currently without live callers. Kept for a separate cleanup.
 */
export interface ReviewerFallback {
  model: string;
  provider: ProviderName;
}

export function crossFamilyFallback(primaryModel: string): ReviewerFallback | null {
  // Codex → Claude
  if (primaryModel === 'gpt-5.4-mini') return { model: 'opus', provider: 'claude' };
  if (primaryModel === 'gpt-5.3-codex') return { model: 'opus', provider: 'claude' };
  if (primaryModel === 'gpt-5.2-codex') return { model: 'opus', provider: 'claude' };
  if (primaryModel === 'gpt-5.5') return { model: 'opus', provider: 'claude' };
  if (primaryModel === 'gpt-5.4') return { model: 'opus', provider: 'claude' };
  if (primaryModel === 'gpt-5.1-codex-max') return { model: 'opus', provider: 'claude' };
  // Heretic (ollama) — review intentionally skipped.
  return null;
}
