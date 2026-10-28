// Slot 4 — per-provider throttle tracking. Process-local (NOT persisted to
// disk per §6.2); server restart resets every provider to `available` and
// observed errors re-flip them as needed.
//
// API: providers call markThrottled on detected throttle, markAvailable on
// successful init/completion. Orchestrator consults buildQuotaInjection at
// first-turn context build to route away from throttled providers. Review
// layer consults isAvailable to pick a reviewer.
//
// No active probing (§6.5) — recovery is detected passively: lazy scheduled
// clear at resetsAt when known, observed-success clear regardless.
//
// Broadcasts: state mutations fire the change listener; index.ts wires it up
// to send a QuotaStatusMessage to all connected sessions (§6.6). The listener
// plumbing stays abstract so quota.ts has no WebSocket import.

import type { ProviderName } from '@arco/shared';

export type ThrottleSource = 'observed-error' | 'parsed-header' | 'manual-probe' | 'default-available';

export interface QuotaState {
  throttled: boolean;
  resetsAt?: number;           // epoch ms; undefined when not known
  lastError?: string;
  lastErrorAt?: number;
  sourceOfTruth: ThrottleSource;
}

const PROVIDERS: ProviderName[] = ['claude', 'gemini', 'ollama', 'codex', 'antigravity', 'llamacpp', 'lmstudio', 'strata', 'deepseek'];

function defaultState(): QuotaState {
  return { throttled: false, sourceOfTruth: 'default-available' };
}

const state = new Map<ProviderName, QuotaState>();
for (const p of PROVIDERS) state.set(p, defaultState());

type ChangeListener = (provider: ProviderName, state: QuotaState) => void;
let listener: ChangeListener | null = null;

/** Wire a change listener (index.ts broadcasts QuotaStatusMessage from here). */
export function setChangeListener(fn: ChangeListener | null): void {
  listener = fn;
}

export function markThrottled(provider: ProviderName, errorText: string, resetsAt?: number): void {
  const prev = state.get(provider) ?? defaultState();
  // Debounce: if already throttled with the same reset time, skip the broadcast
  // churn. Fresh observed error always updates lastError/lastErrorAt though.
  const next: QuotaState = {
    throttled: true,
    resetsAt: resetsAt ?? prev.resetsAt,
    lastError: errorText.slice(0, 500),
    lastErrorAt: Date.now(),
    sourceOfTruth: resetsAt !== undefined ? 'parsed-header' : 'observed-error',
  };
  state.set(provider, next);
  const resetTag = next.resetsAt ? ` (resets ${new Date(next.resetsAt).toISOString()})` : '';
  if (!prev.throttled) {
    console.log(`[arco] quota: ${provider} → throttled${resetTag}`);
  }
  // Broadcast on every mark — operator should see the latest error text even
  // if the throttled bit didn't flip.
  listener?.(provider, next);
}

export function markAvailable(provider: ProviderName): void {
  const prev = state.get(provider);
  if (prev && !prev.throttled) return;
  const next: QuotaState = { throttled: false, sourceOfTruth: 'observed-error' };
  state.set(provider, next);
  console.log(`[arco] quota: ${provider} → available`);
  listener?.(provider, next);
}

export function isAvailable(provider: ProviderName): boolean {
  const s = state.get(provider);
  if (!s || !s.throttled) return true;
  // Lazy scheduled clear: if we know when the throttle expires and we're past
  // it, flip to available. Broadcasts via markAvailable so UI + injection
  // catch up on next state change.
  if (s.resetsAt && Date.now() >= s.resetsAt) {
    markAvailable(provider);
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
 * First-turn PROVIDER STATUS block injected into the orchestrator context
 * alongside memory + build-log + catalog. Returns empty string when every
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
 * Used by modes/review.ts when a preferred reviewer is unavailable. Keep the
 * table next to quota-state so the fallback logic sits with the throttle
 * surface it's reacting to.
 */
export interface ReviewerFallback {
  model: string;
  provider: ProviderName;
}

export function crossFamilyFallback(primaryModel: string): ReviewerFallback | null {
  // Claude → Gemini
  if (primaryModel === 'haiku') return { model: 'gemini-3-flash-preview', provider: 'gemini' };
  if (primaryModel === 'sonnet') return { model: 'gemini-3.1-pro-preview', provider: 'gemini' };
  if (primaryModel === 'opus' || primaryModel === 'opus[1m]') return { model: 'gemini-3.1-pro-preview', provider: 'gemini' };
  // Gemini → Claude (except pro which falls back within family per §5.4)
  if (primaryModel === 'gemini-3.1-flash-lite-preview') return { model: 'sonnet', provider: 'claude' };
  if (primaryModel === 'gemini-3-flash-preview') return { model: 'opus', provider: 'claude' };
  if (primaryModel === 'gemini-3.1-pro-preview') return { model: 'gemini-3.1-pro-preview', provider: 'gemini' };
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
