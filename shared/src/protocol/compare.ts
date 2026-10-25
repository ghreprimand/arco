// ── Compare primitive (WORKBENCH_EXPANSION_PLAN.md §B1) ──
//
// An operator-initiated, BOUNDED multi-provider answer race. ONE prompt fans
// out to N independent legs, each {provider, model, effort}. Each leg runs as a
// short-lived, READ-ONLY worker with NO shared session (a fresh spawn per leg —
// they never see each other's output) and streams its answer into its own pane.
// Optionally "blind": the panes hide the provider/model labels until the
// operator votes, so the choice isn't anchored on the brand name.
//
// Fence note (CLAUDE.md "hard fences"): there is NO orchestrator LLM and NO
// "LLM judges the winner" step. The legs are bounded jobs (read-only, no tools
// by default — same contract as the reviewer / research primitives), never a
// live tool-using conversation and never wired into the primary turn loop. The
// winner is chosen by an OPERATOR vote, recorded to events.jsonl. The optional
// synthesize step is an operator-chosen follow-up (one more bounded leg seeded
// with the answers), not an automatic verdict. Operator-initiated + bounded +
// operator-voted + replayable ⇒ clears the four-question test.

import type { EffortLevel, ModelName, ProviderName } from './providers.js';

// Hard ceiling on the number of legs in one race. Keeps the fan-out bounded and
// the grid legible. Operator-set count is clamped to [2, COMPARE_MAX_LEGS].
export const COMPARE_MIN_LEGS = 2;
export const COMPARE_MAX_LEGS = 6;

// One leg's agent config — resolved by the dialog's RUN AS pickers. Codex legs
// arrive with providerAccountRef so the server can route the right account.
export interface CompareLegConfig {
  provider: ProviderName;
  model: ModelName;
  effort: EffortLevel;
  providerAccountRef?: string;
}

// ── Client → server ──

export interface CompareRequestMessage {
  type: 'compare_request';
  workflowId: string;
  // The single prompt every leg answers.
  prompt: string;
  // N legs (2..COMPARE_MAX_LEGS). Each runs as an independent read-only worker.
  legs: CompareLegConfig[];
  // When true, the client hides leg identities until a vote is cast. Purely a
  // client-side display hint (the server still labels events for replay) — but
  // echoed back on compare_started so a reconnecting client honors it.
  blind: boolean;
}

// Record the operator's winner pick. Recorded to events.jsonl (the audit trail
// + the "blind reveal" trigger client-side). Operator action only — nothing
// auto-selects.
export interface CompareVoteMessage {
  type: 'compare_vote';
  workflowId: string;
  compareId: string;
  // Index into the original `legs` array (0-based).
  winnerLegIndex: number;
}

// Operator-chosen follow-up: have ONE leg synthesize a combined answer from all
// the legs' outputs (graft the best of the others onto the winner). This is an
// explicit operator action, never automatic. Runs as one more bounded leg.
export interface CompareSynthesizeMessage {
  type: 'compare_synthesize';
  workflowId: string;
  compareId: string;
  // Which leg's agent does the synthesis (index into the original legs).
  synthesizerLegIndex: number;
}

// Cancel an in-flight race — kills every still-running leg worker. Mirrors
// cancel_review / cancel_research.
export interface CancelCompareMessage {
  type: 'cancel_compare';
  workflowId: string;
  compareId: string;
}

// ── Server → client (all workflow-scoped → persisted to events.jsonl) ──

export interface CompareStartedMessage {
  type: 'compare_started';
  workflowId: string;
  compareId: string;
  prompt: string;
  // Echoes the resolved legs (in order) so the grid can build a pane per leg.
  legs: CompareLegConfig[];
  blind: boolean;
  startedAt: number;
}

// Streaming answer text for one leg. The client appends `text` to that pane.
// Keyed by (compareId, legIndex) so concurrent leg streams never interleave.
export interface CompareLegDeltaMessage {
  type: 'compare_leg_delta';
  workflowId: string;
  compareId: string;
  legIndex: number;
  text: string;
}

// One leg finished (or failed). `text` is the full final answer (authoritative
// — the client replaces any streamed accumulation with it). On error, `error`
// is set and `text` may be partial/empty.
export interface CompareLegCompleteMessage {
  type: 'compare_leg_complete';
  workflowId: string;
  compareId: string;
  legIndex: number;
  text: string;
  durationMs: number;
  error?: string;
  completedAt: number;
}

// All legs settled. The grid flips to "vote" affordance.
export interface CompareCompleteMessage {
  type: 'compare_complete';
  workflowId: string;
  compareId: string;
  // Count of legs that produced an answer without error.
  succeededLegs: number;
  completedAt: number;
}

// The operator's vote, recorded. Carries the winning leg's identity so a
// replaying client can show the reveal even in blind mode.
export interface CompareVoteRecordedMessage {
  type: 'compare_vote_recorded';
  workflowId: string;
  compareId: string;
  winnerLegIndex: number;
  winner: CompareLegConfig;
  votedAt: number;
}
