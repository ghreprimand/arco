// Workbench Expansion C2 — provider fallback chains (bounded jobs only).
//
// A deterministic, operator-readable runner that walks an ordered list of
// provider "legs" for a BOUNDED job (reviewer / research / compare leg — NOT
// a live operator conversation). It spawns leg 0; if that leg fails with a
// classified error whose action says "this provider can't serve us, move on",
// it advances to leg 1, and so on. The first leg that succeeds wins; if every
// leg is exhausted, the LAST leg's error result is returned verbatim so the
// caller's existing error-surfacing path fires unchanged.
//
// Why this layer (and not WorkerManager.fallbackModel): `fallbackModel` is a
// SAME-provider model swap inside ONE spawn (Claude opus→sonnet on a
// model_not_found, say). The chain is a HIGHER-level construct — a sequence of
// full spawn() calls across DIFFERENT {provider, model} legs. The two compose:
// each chain leg may itself carry a per-spawn fallbackModel.
//
// Fence (CLAUDE.md four-question test):
//   1. Operator-initiated  — only runs for operator-triggered bounded jobs, and
//      only advances past leg 0 when the operator opted in by configuring a
//      chain in settings.json (unset ⇒ single-leg ⇒ today's behavior).
//   2. Deterministic        — advancing is a pure rule: classifyError's action
//      ∈ ADVANCING_ACTIONS AND another leg exists. No LLM decides anything.
//   3. Logged               — onFellBack emits a `provider_fell_back` event for
//      every advance (broadcast → events.jsonl by the caller).
//   4. Reversible           — chain config is operator-owned (read, never
//      mutated). Remove the chain → fallback stops. A failed run still surfaces
//      the last leg's error to the operator.
//
// HARD fence: this runner is NEVER wired into the live primary turn. A live
// primary turn fails closed and surfaces to the operator instead (the spec's
// "never swap the provider mid-live-conversation"). It also NEVER advances on a
// `context_overflow` (action 'compress') — that routes to compaction/handoff,
// not fallback (a sibling provider has the same window problem with the same
// payload). See ADVANCING_ACTIONS below for the exact action set.

import { classifyError } from './errorClassifier.js';
import type { FailoverAction, FailoverReason } from './errorClassifier.js';
import type { EffortLevel, ModelName, ProviderName } from '@arco/shared';

// ── Leg shape ─────────────────────────────────────────────────────────────

// One provider attempt. Mirrors the per-job config the bounded primitives
// already pass (reviewer / researcher): provider + model + effort, plus the
// optional Codex account routing fields.
export interface FallbackLeg {
  provider: ProviderName;
  model: ModelName;
  effort?: EffortLevel;
  providerAccountRef?: string;
  codexHome?: string;
}

export interface FallbackResult<T> {
  /** The settling result of the leg that ran last (success, or last-leg error). */
  result: T;
  /** The leg whose result is returned. */
  legUsed: FallbackLeg;
  /** Zero-based index of `legUsed` in the input `legs` array. */
  legIndex: number;
  /** True when at least one advance happened (we did not succeed on leg 0). */
  fellBack: boolean;
}

// ── The advancing rule (single source of truth) ────────────────────────────
//
// Which FailoverActions cause the chain to advance to the next leg:
//
//   fallback            → ADVANCE. A model/provider swap is exactly what the
//                         chain is for (e.g. model_not_found).
//   rotate              → ADVANCE. "this provider/account can't serve us" —
//                         auth (transient), billing — move to the next leg.
//   backoff_then_rotate → ADVANCE. The binding case for this phase: a throttle
//                         (rate_limit). We do NOT sit and backoff in-place for a
//                         bounded job; we move on to the next configured leg.
//
// Which do NOT advance (return the leg's error so the caller surfaces it):
//
//   backoff   → NO. A bare backoff (overloaded / server_error / network /
//               unknown) is a same-leg retry concern, not a fallback. For this
//               phase we do not implement in-place retry — we just surface.
//   compress  → NO. context_overflow → compaction/handoff, never fallback.
//   no_retry  → NO. content_policy / invalid_request — verbatim retry anywhere
//               fails the same way.
//   fail      → NO. auth_permanent / forbidden beta — human step; surface.
//
// Kept as a Set so the doc, the smoke, and this runner reference one truth.
const ADVANCING_ACTIONS: ReadonlySet<FailoverAction> = new Set<FailoverAction>([
  'fallback',
  'rotate',
  'backoff_then_rotate',
]);

/** Pure predicate: does this classified action advance the chain? Exported for the smoke. */
export function actionAdvances(action: FailoverAction): boolean {
  return ADVANCING_ACTIONS.has(action);
}

// ── The runner ──────────────────────────────────────────────────────────────

/**
 * Run a bounded job across an ordered fallback chain.
 *
 * Spawns each leg in order via `spawnLeg`. After each leg settles, `isError`
 * decides whether it failed (returns the error string) or succeeded (returns
 * undefined). On a failure, the error is classified via `classifyError` against
 * the leg's provider; if the action advances (see ADVANCING_ACTIONS) AND there
 * is another leg, `onFellBack` fires with {from, to, reason, action} and the
 * next leg runs. Otherwise the failing leg's result is returned as-is (so the
 * caller's existing error path — e.g. review_artifact_ready{error} — fires
 * unchanged). The first success short-circuits and is returned immediately.
 *
 * Always returns a FallbackResult (never throws on a classified job error) —
 * an empty `legs` array is a programmer error and throws.
 */
export async function runWithFallbackChain<T>(opts: {
  legs: FallbackLeg[];
  /** Returns the error string if the leg failed, else undefined for success. */
  isError: (r: T) => string | undefined;
  /** The provider to classify the error against (usually `(leg) => leg.provider`). */
  provider: (leg: FallbackLeg) => ProviderName;
  /** Spawn one leg. `legIndex` is its position in `legs` (for logging). */
  spawnLeg: (leg: FallbackLeg, legIndex: number) => Promise<T>;
  /** Fired BEFORE each advance with the leg we're leaving and the leg we're trying next. */
  onFellBack: (info: { from: FallbackLeg; to: FallbackLeg; reason: FailoverReason; action: FailoverAction }) => void;
}): Promise<FallbackResult<T>> {
  const { legs, isError, provider, spawnLeg, onFellBack } = opts;
  if (legs.length === 0) throw new Error('runWithFallbackChain: legs is empty');

  let fellBack = false;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const result = await spawnLeg(leg, i);
    const err = isError(result);
    if (err === undefined) {
      // Success — return this leg's result.
      return { result, legUsed: leg, legIndex: i, fellBack };
    }

    const hasNext = i + 1 < legs.length;
    if (!hasNext) {
      // Last leg failed — surface its error verbatim (no more legs to try).
      return { result, legUsed: leg, legIndex: i, fellBack };
    }

    const { reason, action } = classifyError(provider(leg), err);
    if (!actionAdvances(action)) {
      // Classified as a non-advancing action (compress / no_retry / fail /
      // bare backoff) — do NOT fall back; surface this leg's error so the
      // caller's normal error path runs. This guards the context_overflow
      // fence: a 'compress' never advances even with legs remaining.
      return { result, legUsed: leg, legIndex: i, fellBack };
    }

    // Advance: log the fall-back, then try the next leg.
    const to = legs[i + 1];
    fellBack = true;
    onFellBack({ from: leg, to, reason, action });
  }

  // Unreachable in practice (the loop returns on the last leg above), but keep
  // the type checker happy and fail loudly if the invariant ever breaks.
  /* istanbul ignore next */
  throw new Error('runWithFallbackChain: exhausted legs without returning');
}

// ── Chain construction from operator config ─────────────────────────────────

// Resolve the effective chain for a bounded job: the primary leg followed by
// the operator-configured fallback legs, de-duped so a configured leg equal to
// the primary (same provider+model) is dropped (running the same leg twice on a
// throttle is pointless). When `configured` is unset/empty the chain is just
// `[primary]` — i.e. current behavior, no fallback, no regression.
export function buildChain(primary: FallbackLeg, configured: FallbackLeg[] | undefined): FallbackLeg[] {
  const chain: FallbackLeg[] = [primary];
  if (!configured) return chain;
  for (const leg of configured) {
    if (chain.some((c) => c.provider === leg.provider && c.model === leg.model)) continue;
    chain.push(leg);
  }
  return chain;
}
