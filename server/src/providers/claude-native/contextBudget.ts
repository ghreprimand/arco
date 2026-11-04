// §2.3 — Token-budget meter (Claude Native).
//
// A deterministic per-turn reading of how full the context window is, computed
// from ground-truth inputs: the count_tokens prompt size the worker already
// measures (`lastPromptTokens`), the model's real context window (KNOWN_CTX via
// lookupCtx), and the output budget the next turn reserves (chooseMaxTokens).
//
// The load-bearing delta over the existing `context_usage` percent is the
// **effective window**: the denominator is `window − reservedOutput`, not the
// raw window. The reserved output tokens are not usable for input — a 1M-window
// Opus that reserves ~64K for its reply can only ever fill ~936K with prompt —
// so a percent against the raw window systematically under-reports how close
// the prompt is to the wall the API actually enforces. The meter measures
// usable input pressure, which is what the Fold/handoff triggers care about.
//
// Pure + no LLM call: callers pass the three numbers; this only does
// arithmetic and threshold comparison. That keeps it unit-testable and keeps
// the meter itself off the model-judgment side of the fence.

export interface ContextBudget {
  /** Ground-truth prompt size the last round sent (count_tokens). */
  usedTokens: number;
  /** Model's real context window (KNOWN_CTX / lookupCtx). */
  windowSize: number;
  /** Output tokens the next turn reserves (chooseMaxTokens). */
  reservedOutput: number;
  /** Usable input space: max(1, windowSize − reservedOutput). */
  effectiveWindow: number;
  /** round(usedTokens / effectiveWindow * 100), clamped to [0, 100]. */
  pct: number;
}

export interface BudgetThresholds {
  warnAt: number;
  autoAt: number;
  // §2.1 wires this from autoFold config; undefined ⇒ fold crossing never fires.
  foldAt?: number;
}

export interface ThresholdCrossings {
  warn: boolean;
  auto: boolean;
  fold: boolean;
}

// Compute the budget from ground-truth inputs. Defensive against junk: a
// non-positive / non-finite window or used count yields a 0% reading rather
// than NaN, and reservedOutput is clamped so the effective window is always ≥1
// (a degenerate reserved ≥ window can't drive the denominator to zero).
export function computeContextBudget(
  usedTokens: number,
  windowSize: number,
  reservedOutput: number,
): ContextBudget {
  const used = Number.isFinite(usedTokens) && usedTokens > 0 ? Math.round(usedTokens) : 0;
  const window = Number.isFinite(windowSize) && windowSize > 0 ? Math.round(windowSize) : 0;
  const reserved = Number.isFinite(reservedOutput) && reservedOutput > 0 ? Math.round(reservedOutput) : 0;
  // Effective window can never exceed the real window and never drops below 1.
  const effectiveWindow = window > 0 ? Math.max(1, window - Math.min(reserved, window - 1)) : 1;
  const pct = window > 0
    ? Math.max(0, Math.min(100, Math.round((used / effectiveWindow) * 100)))
    : 0;
  return { usedTokens: used, windowSize: window, reservedOutput: reserved, effectiveWindow, pct };
}

// Which thresholds the current pct has crossed. A threshold is "crossed" when
// pct is at or above it. fold only fires when a foldAt is configured.
export function crossedThresholds(pct: number, t: BudgetThresholds): ThresholdCrossings {
  return {
    warn: pct >= t.warnAt,
    auto: pct >= t.autoAt,
    fold: typeof t.foldAt === 'number' && pct >= t.foldAt,
  };
}
