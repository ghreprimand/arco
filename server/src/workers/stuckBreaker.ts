// §3.1 — the stuck-worker breaker. The detector the cluster watchdog work has
// circled for months: action-pattern loop-detection was FALSIFIED on real logs
// (a model legitimately re-runs the same shape of command); the signal that
// actually holds is ERROR-PERSISTENCE — the same tool call returning the same
// FAILING result over and over, with no success interleaved. That is the
// "stuck" signature, and it's fully deterministic, so it clears the fence:
// no model judges quality, a counter does.
//
// Scope vs H9 (toolLoopGuard.ts): H9 is IN-turn, Native-only, in the worker's
// own dispatch loop. THIS breaker is CROSS-turn and CROSS-provider — it consumes
// the `worker_tool_use` stream that every transport carrying outputHash emits
// (claude-native + codex today), keyed per workflow. The two compose: H9 catches
// a tight same-turn spin in a few iterations; this catches a worker that keeps
// failing the same way across turns / autonomous continuations.
//
// Signature = `toolName | inputHash | outputHash`. outputHash is the watchdog's
// NORMALIZED hash (../providers/outputSignature.ts) — its digit/timestamp/ANSI
// fuzziness is what lets "the same error" recur to one signature. A success, or
// a DIFFERENT signature, breaks the streak (that's progress). Escalation:
//   streak ≥ DETECT_AT   → 'nudge'  (heal first — surface it once)
//   streak ≥ ESCALATE_AT → 'pause'  (recommend a reversible pause, not a kill)
// A success at any point → 'recovered' (clears the latch — reversibility).
//
// This module is the deterministic core + a per-workflow singleton (mirrors
// clusterBudget.ts). It NEVER kills or prompts a worker itself; it returns a
// verdict the caller turns into a visible `worker_stuck` event. Auto-actions
// (steer injection, autonomous-continue gating) are the caller's, and stay
// operator-visible + reversible.

import { createHash } from 'crypto';

// Stable, secret-free hash of a tool's input string (the provider hands us the
// already-serialized input). Truncated before hashing to cap work on huge
// inputs. Keeps raw args out of this module and out of events.jsonl.
export function inputHash(input: string): string {
  return createHash('sha1').update(input.slice(0, 16384)).digest('hex').slice(0, 12);
}

// same failing signature this many times in a row → first breaker trip (nudge).
export const DETECT_AT = 3;
// continued to this streak after the nudge → recommend pausing (not killing).
export const ESCALATE_AT = 5;

export type StuckAction = 'none' | 'nudge' | 'pause' | 'recovered';

export interface StuckObservation {
  toolName: string;
  // hash of the tool input (caller supplies; keeps raw args out of this module).
  inputHash: string;
  // normalized output hash (outputSignature.outputHash). Absent → can't judge
  // persistence for this call (treated as a streak-breaker, i.e. progress).
  outputHash?: string;
  // did this call fail? (Bash non-zero exit, status 'failed', [error] sentinel).
  failing: boolean;
}

export interface StuckVerdict {
  action: StuckAction;
  // current consecutive count of the identical failing signature.
  streak: number;
  // the signature that is repeating (for the event; already hash-only).
  signature: string | null;
  // true while the workflow is latched paused by the breaker.
  paused: boolean;
}

interface BreakerState {
  lastSig: string | null;
  streak: number;
  nudged: boolean;
  paused: boolean;
}

// Pure transition — exported for unit testing without the singleton. Mutates and
// returns the verdict for one observation. `detectAt`/`escalateAt` injectable.
export function step(
  state: BreakerState,
  obs: StuckObservation,
  detectAt = DETECT_AT,
  escalateAt = ESCALATE_AT,
): StuckVerdict {
  // Success — or any non-failing call — is progress. Break the streak and, if we
  // were latched, report recovery so the caller can clear the pause.
  if (!obs.failing) {
    const wasPaused = state.paused;
    state.lastSig = null;
    state.streak = 0;
    state.nudged = false;
    state.paused = false;
    return { action: wasPaused ? 'recovered' : 'none', streak: 0, signature: null, paused: false };
  }

  // A failing call with no usable outputHash can't be compared for persistence;
  // treat as a streak-breaker (don't accuse a worker of looping on evidence we
  // don't have).
  if (!obs.outputHash) {
    state.lastSig = null;
    state.streak = 0;
    state.nudged = false;
    return { action: 'none', streak: 0, signature: null, paused: state.paused };
  }

  const sig = `${obs.toolName}|${obs.inputHash}|${obs.outputHash}`;
  if (sig === state.lastSig) {
    state.streak += 1;
  } else {
    state.lastSig = sig;
    state.streak = 1;
    state.nudged = false;
  }

  // Escalate first (the stronger threshold), then the one-time nudge.
  if (state.streak >= escalateAt && !state.paused) {
    state.paused = true;
    return { action: 'pause', streak: state.streak, signature: sig, paused: true };
  }
  if (state.streak >= detectAt && !state.nudged) {
    state.nudged = true;
    return { action: 'nudge', streak: state.streak, signature: sig, paused: state.paused };
  }
  return { action: 'none', streak: state.streak, signature: sig, paused: state.paused };
}

function fresh(): BreakerState {
  return { lastSig: null, streak: 0, nudged: false, paused: false };
}

// ── Per-workflow singleton (mirrors clusterBudget.ts) ──
const states = new Map<string, BreakerState>();

// Record one tool observation for a workflow; returns the breaker verdict.
export function observe(workflowId: string, obs: StuckObservation): StuckVerdict {
  let s = states.get(workflowId);
  if (!s) { s = fresh(); states.set(workflowId, s); }
  return step(s, obs);
}

// True while this workflow is latched paused. Autonomous-continue paths consult
// this before starting another unattended turn.
export function isPaused(workflowId: string): boolean {
  return states.get(workflowId)?.paused === true;
}

// Operator-driven reset — a new operator turn means the human is back in the
// loop, so clear any latch (reversibility) and the streak. Called from the
// turn-start path alongside the other per-turn resets.
export function clearOnOperatorTurn(workflowId: string): void {
  const s = states.get(workflowId);
  if (!s) return;
  s.lastSig = null;
  s.streak = 0;
  s.nudged = false;
  s.paused = false;
}

// Drop all state for a finished/torn-down workflow.
export function dispose(workflowId: string): void {
  states.delete(workflowId);
}
