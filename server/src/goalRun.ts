// docs/GOTCHAS.md - operator-armed north-star auto-continue.
//
// While armed, a deterministic continuation turn is dispatched after each
// settled turn, so a tab keeps working toward its north star without the
// operator retyping "continue". The tick logic itself lives in turnEngine
// (`maybeGoalRun`) next to maybeAutoHandoff / maybeAutoCompactNative — the
// same post-settle site every other armed per-tab action fires from. This
// module holds the parts worth keeping pure + testable: arming normalization,
// the stop decision, and the prompt text.
//
// The four-question test (CLAUDE.md § Non-goals):
//   1. Operator-initiated — armed per tab via `/goal run <n>` or the chip,
//      default absent ⇒ OFF. There is NO model tool that arms it.
//   2. Bounded by deterministic rules — a finite iteration budget (mandatory),
//      an optional token ceiling, and the stop table in `evaluateGoalRun`.
//      Nothing here consults a model.
//   3. Visible — every tick and every stop emits a persisted system_notice
//      carrying iteration / remaining / tokens, and each tick is a real turn
//      in events.jsonl. Nothing happens off-transcript.
//   4. Reversible — `/goal run stop` or the chip disarms immediately; the
//      in-flight turn finishes normally and no further tick fires.
//
// What it is NOT: Codex's native `create_goal` (the 2026-07-28 incident in
// docs/GOTCHAS.md § Codex app-server). That one was armed by the model, ran
// with a NULL token budget, was invisible to Arco, and could only be undone
// by editing a sqlite file. Each of those is inverted above — deliberately.
//
// Note the one thing this loop must never gain: a model verdict on whether the
// work is done. The run continues because budget remains and stops because it
// doesn't. A model signal may only ever SHORTEN a run (the operator stopping
// it is the same shape) — never extend one, never route work, never spawn.

// Iteration budget bounds. The default is small enough to be a natural
// checkpoint and large enough to be worth arming; the cap is a runaway
// backstop, not a recommendation.
export const GOAL_RUN_DEFAULT_ITERATIONS = 10;
export const GOAL_RUN_MAX_ITERATIONS = 500;

// Context-fill ceiling. Past this the model is working in a degraded window
// and further unattended turns mostly burn tokens re-reading a crowded
// transcript — stop and let the operator decide between Fold / Handoff /
// re-arm. Deliberately ABOVE autoHandoff.warnAt so an armed auto-handoff gets
// first refusal.
export const GOAL_RUN_CONTEXT_STOP_PCT = 92;

export type GoalRunState = {
  enabled: boolean;
  total: number;
  remaining: number;
  tokensUsed: number;
  tokenBudget?: number;
};

// Why a run stopped. Rendered to the operator verbatim, so keep the strings
// operator-readable rather than machine-terse.
export type GoalRunStopReason =
  | 'iterations_exhausted'
  | 'token_budget_exhausted'
  | 'turn_error'
  | 'provider_throttled'
  | 'context_high'
  | 'no_north_star';

export const GOAL_RUN_STOP_TEXT: Record<GoalRunStopReason, string> = {
  iterations_exhausted: 'iteration budget spent',
  token_budget_exhausted: 'token budget spent',
  turn_error: 'the last turn ended in an error',
  provider_throttled: 'the provider is rate-limited',
  context_high: `context passed ${GOAL_RUN_CONTEXT_STOP_PCT}%`,
  no_north_star: 'the north star was cleared',
};

// Normalize an arm request into stored state. Returns a string on refusal so
// the caller can surface it verbatim. Re-arming an active run is how the
// operator extends it — counters reset rather than accumulate.
export function normalizeGoalRunArm(
  req: { enabled: boolean; total?: number; tokenBudget?: number },
  hasNorthStar: boolean,
): GoalRunState | string {
  if (!req.enabled) {
    return { enabled: false, total: 0, remaining: 0, tokensUsed: 0 };
  }
  if (!hasNorthStar) {
    return 'Set a north star first — a goal run continues toward it, so there is nothing to run without one.';
  }
  const raw = typeof req.total === 'number' && Number.isFinite(req.total)
    ? Math.floor(req.total)
    : GOAL_RUN_DEFAULT_ITERATIONS;
  if (raw < 1) return 'A goal run needs at least 1 iteration.';
  const total = Math.min(raw, GOAL_RUN_MAX_ITERATIONS);
  const tokenBudget = typeof req.tokenBudget === 'number' && Number.isFinite(req.tokenBudget) && req.tokenBudget > 0
    ? Math.floor(req.tokenBudget)
    : undefined;
  return {
    enabled: true,
    total,
    remaining: total,
    tokensUsed: 0,
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
  };
}

// Accumulate a settled turn's spend into an active run. Called from
// seedWorker's `primary_turn_token_usage` broadcast — the one place every
// provider's per-turn usage lands in a normalized shape. Cache reads are
// deliberately included: a goal run's whole cost profile is a huge cached
// prefix replayed every tick, and hiding that would make the chip lie about
// what the run is spending. No-op when nothing is armed.
export function addGoalRunTokens(
  state: GoalRunState | undefined,
  tokens: { input: number; output: number; cacheRead?: number; cacheCreate?: number },
): void {
  if (!state || !state.enabled) return;
  state.tokensUsed +=
    (tokens.input || 0) + (tokens.output || 0) + (tokens.cacheRead || 0) + (tokens.cacheCreate || 0);
}

export type GoalRunDecision =
  | { action: 'idle' }                                  // not armed — no-op
  | { action: 'skip' }                                  // armed, but not this moment (busy / queued)
  | { action: 'stop'; reason: GoalRunStopReason }
  | { action: 'tick'; iteration: number };              // 1-based index of the tick to dispatch

// The whole decision, in one pure function. Every input is a fact the server
// already holds — no model call, no heuristic, no judgment about the work.
//
// Ordering matters: stop conditions are checked before the tick so a run can
// never dispatch one last turn past its budget, and `skip` sits between them
// so a busy tab neither ticks nor burns a stop.
export function evaluateGoalRun(input: {
  state: GoalRunState | undefined;
  hasNorthStar: boolean;
  busy: boolean;
  queuedMessages: number;
  lastTurnErrored: boolean;
  providerThrottled: boolean;
  contextPercent?: number;
}): GoalRunDecision {
  const s = input.state;
  if (!s || !s.enabled) return { action: 'idle' };

  // The north star can be cleared mid-run (CONFIG field or `/goal clear`).
  // Continuing would dispatch turns pointing at nothing.
  if (!input.hasNorthStar) return { action: 'stop', reason: 'no_north_star' };
  if (s.remaining <= 0) return { action: 'stop', reason: 'iterations_exhausted' };
  if (typeof s.tokenBudget === 'number' && s.tokensUsed >= s.tokenBudget) {
    return { action: 'stop', reason: 'token_budget_exhausted' };
  }
  // An errored turn means the NEXT turn would most likely error the same way.
  // Looping on that is the one failure mode that spends without progressing.
  if (input.lastTurnErrored) return { action: 'stop', reason: 'turn_error' };
  if (input.providerThrottled) return { action: 'stop', reason: 'provider_throttled' };
  if (typeof input.contextPercent === 'number' && input.contextPercent >= GOAL_RUN_CONTEXT_STOP_PCT) {
    return { action: 'stop', reason: 'context_high' };
  }

  // Not a stop — just not now. A turn in flight or operator messages waiting
  // to drain both mean the tab is already going to do something; the next
  // settle re-evaluates. No iteration is consumed.
  if (input.busy || input.queuedMessages > 0) return { action: 'skip' };

  return { action: 'tick', iteration: s.total - s.remaining + 1 };
}

// The continuation prompt. Fixed, Arco-authored, and surfaced in the
// transcript exactly as sent — the operator must be able to read what the loop
// says on their behalf. It deliberately does NOT tell the model to keep going
// on its own: each tick is one bounded turn, and the loop (not the model)
// decides whether another follows.
export function goalRunContinuePrompt(iteration: number, total: number): string {
  return (
    `(goal run ${iteration}/${total} — automated continuation, no operator typed this)\n\n` +
    `Continue toward the session north-star. Pick the single next concrete slice of work, ` +
    `carry it far enough to be verifiable, and stop there with a short note on what you did ` +
    `and what you'd pick up next. Don't re-summarize the whole plan, don't re-review work ` +
    `that is already done, and don't wait for confirmation before starting the slice.`
  );
}
