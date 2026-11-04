// -- Provider fallback chains (docs/ARCHITECTURE.md) --
//
// For BOUNDED jobs only (reviewers, research legs — NOT a live operator
// conversation), the server walks an operator-configured per-role provider
// chain on a classified "→fallback"/"→rotate"/"→backoff_then_rotate" error.
// Each advance emits `provider_fell_back` so the operator can see, in chat and
// in events.jsonl, that a leg was throttled and the job moved to the next
// provider. This is logged + reversible + deterministic + operator-opted-in
// (the chain is hand-configured; unset ⇒ no fallback). A live primary turn is
// NEVER routed through the chain — it fails closed and surfaces to the operator.

import type { EffortLevel, ModelName, ProviderName } from './providers.js';

// The failover-reason taxonomy bucket the classifier assigned to the leg's
// error. Kept as a string union mirroring server/src/providers/errorClassifier
// `FailoverReason` (shared stays independent of the server module). Open-ended
// (`(string & {})`) so a new server-side reason never breaks the client type.
export type FailoverReasonName =
  | 'auth'
  | 'auth_permanent'
  | 'billing'
  | 'rate_limit'
  | 'overloaded'
  | 'context_overflow'
  | 'model_not_found'
  | 'content_policy_blocked'
  | 'oauth_long_context_beta_forbidden'
  | 'invalid_request'
  | 'server_error'
  | 'network'
  | 'unknown'
  | (string & {});

// One operator-configured fallback leg. Mirrors the per-job reviewer/researcher
// config: provider + model + effort, plus optional Codex account routing.
export interface FallbackLegConfig {
  provider: ProviderName;
  model: ModelName;
  effort?: EffortLevel;
  providerAccountRef?: string;
  codexHome?: string;
}

// Per-role fallback chains. Hand-edited into settings.json; the server READS
// these and never mutates them ("config read, not write" fence). The effective
// chain for a job is `[primaryLeg, ...the role's legs filtered to drop one
// equal to the primary]`. Unset role ⇒ `[primaryLeg]` ⇒ today's behavior.
export interface FallbackChainsConfig {
  reviewer?: FallbackLegConfig[];
  research?: FallbackLegConfig[];
  // `seed` (handoff) is reserved but NOT consumed in C2: the handoff seed runs
  // through the live-primary-turn primitive, which the fence forbids routing
  // through the chain. Defined so a hand-edited settings.json can pin it ahead
  // of a future phase without tripping sanitization.
  seed?: FallbackLegConfig[];
}

// Server→client event: emitted once per chain advance for a bounded job.
// Workflow-scoped → persisted to events.jsonl and replayed on resume.
export interface ProviderFellBackMessage {
  type: 'provider_fell_back';
  workflowId: string;
  from: { provider: ProviderName; model: ModelName };
  to: { provider: ProviderName; model: ModelName };
  // The classifier's reason bucket for the leg's failure (e.g. 'rate_limit').
  reason: FailoverReasonName;
  // Optional human-readable one-liner for the chat system-notice surface.
  note?: string;
}
