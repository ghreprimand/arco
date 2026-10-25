// Workbench Expansion C1 — error-classifier taxonomy.
//
// A pure, dependency-light mapping from a provider error to a FailoverReason
// and the FailoverAction the retry/fallback layer should take. Ported from
// Hermes's `error_classifier.py` (Arco runs the same Anthropic / OpenAI /
// Gemini providers, so the substring/status mapping carries over almost
// verbatim).
//
// Scope (C1): this module is the classifier ONLY. It does NOT touch quota
// tracking (`quota.ts` tracks *availability*; this classifies the *action*)
// and it does NOT rewire any live provider error path — wiring the result
// into fallback control flow is C2. Keep it side-effect-free and importable
// from a unit smoke with no server boot.
//
// Shape: classifyError(provider, err) → { reason, action, permanent }.
//   - `reason` is the taxonomy bucket (what kind of failure this is).
//   - `action` is what the caller should do (the C2 consumer switches on it).
//   - `permanent` is a convenience flag: true when retrying the *same request*
//     against the *same provider* can never succeed (auth revoked, billing
//     dead, content blocked, beta forbidden). C2 uses it to fail closed fast
//     rather than burn the backoff ladder.
//
// Matching strategy: we inspect both a numeric status code (401/403/429/5xx)
// AND a lowercased message/code string. Status is checked first where it's
// unambiguous, but a more specific substring (e.g. `invalid_api_key` inside a
// 401) refines an `auth` into an `auth_permanent`. Unknown errors fall through
// to `{ reason: 'unknown', action: 'backoff' }` — conservative: a transient
// blip gets one or two retries rather than being treated as fatal.

import type { ProviderName } from '@arco/shared';

// ── Taxonomy ────────────────────────────────────────────────────────────────

export type FailoverReason =
  | 'auth' // credential rejected, but possibly transient/refreshable (e.g. expired token)
  | 'auth_permanent' // credential is structurally invalid/revoked — re-auth required
  | 'billing' // payment/credit/subscription problem — provider can't serve this account
  | 'rate_limit' // 429 / usage limit — back off, then try elsewhere
  | 'overloaded' // provider-side capacity (503 / overloaded_error) — back off in place
  | 'context_overflow' // request exceeds the model's context window — compress, don't failover
  | 'model_not_found' // requested model unavailable/decommissioned — fall back to another model
  | 'content_policy_blocked' // safety/content filter refused — retrying is pointless
  | 'oauth_long_context_beta_forbidden' // Anthropic OAuth subscription can't use the long-context beta
  | 'invalid_request' // malformed request (400) not otherwise classified — don't blindly retry
  | 'server_error' // generic 5xx — transient, back off
  | 'network' // connection reset / timeout / DNS — transient, back off
  | 'unknown'; // unclassified — conservative backoff

export type FailoverAction =
  | 'fail' // give up on this turn; surface to operator (no automatic recovery)
  | 'backoff' // retry the same provider after a delay
  | 'rotate' // switch to a different provider/account now (this one can't serve us)
  | 'backoff_then_rotate' // wait, retry once or twice here, then rotate if still failing
  | 'fallback' // switch to a different *model* (same or other provider)
  | 'compress' // shrink the context (handoff / compaction), then retry — do NOT failover
  | 'no_retry'; // the request itself is rejected; retrying verbatim will always fail

export interface Classification {
  reason: FailoverReason;
  action: FailoverAction;
  /** True when retrying the same request against the same provider cannot succeed. */
  permanent: boolean;
}

// ── Error-shape normalization ─────────────────────────────────────────────────

interface NormalizedError {
  status?: number; // HTTP-ish status code if we can find one
  text: string; // lowercased haystack: message + code + type + nested error fields
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

// Pull a status code and a flat lowercased text haystack out of whatever shape
// the provider threw: a raw string, an Error, an Anthropic/OpenAI-style
// `{ status, error: { type, message } }`, or a Codex `{ code, message }`.
function normalize(err: unknown): NormalizedError {
  if (err == null) return { text: '' };
  if (typeof err === 'string') return { text: err.toLowerCase() };

  const parts: string[] = [];
  let status: number | undefined;

  const visit = (o: unknown, depth: number): void => {
    if (o == null || depth > 4) return;
    if (typeof o === 'string') {
      parts.push(o);
      return;
    }
    if (typeof o === 'number') {
      parts.push(String(o));
      return;
    }
    if (typeof o !== 'object') return;

    const rec = o as Record<string, unknown>;
    // Status-ish fields (first non-undefined wins; don't let a nested 200 clobber a top-level 429).
    if (status === undefined) {
      status =
        asNumber(rec.status) ??
        asNumber(rec.statusCode) ??
        asNumber(rec.code === undefined ? undefined : typeof rec.code === 'number' ? rec.code : undefined);
    }
    // Text-ish fields.
    for (const key of ['message', 'type', 'reason', 'detail', 'details', 'error_type']) {
      const v = rec[key];
      if (typeof v === 'string') parts.push(v);
    }
    // String `code` is a haystack token (e.g. "invalid_api_key"); numeric code already handled above.
    if (typeof rec.code === 'string') parts.push(rec.code);
    // Recurse into nested error containers.
    for (const key of ['error', 'cause', 'data', 'response', 'body', 'codexErrorInfo']) {
      if (rec[key] !== undefined) visit(rec[key], depth + 1);
    }
  };

  if (err instanceof Error) {
    parts.push(err.message);
    // Errors often carry status/code/cause as own props.
    visit(err as unknown, 0);
  } else {
    visit(err, 0);
  }

  return { status, text: parts.join(' ').toLowerCase() };
}

function has(text: string, ...needles: string[]): boolean {
  return needles.some((n) => text.includes(n));
}

// ── The classifier ────────────────────────────────────────────────────────────

// Deterministic mapping from reason → default action. Kept as a table so the
// taxonomy doc and the C2 consumer can both reference one source of truth.
const ACTION_FOR_REASON: Record<FailoverReason, FailoverAction> = {
  auth: 'rotate', // bad creds here — try another account/provider
  auth_permanent: 'fail', // re-auth is a human step; don't loop
  billing: 'rotate', // this account can't pay — rotate to another
  rate_limit: 'backoff_then_rotate', // wait a bit, then move on if still limited
  overloaded: 'backoff', // provider capacity blip — wait in place
  context_overflow: 'compress', // shrink context; failover wouldn't help (same window elsewhere)
  model_not_found: 'fallback', // pick a different model
  content_policy_blocked: 'no_retry', // filter won't change its mind on a verbatim retry
  oauth_long_context_beta_forbidden: 'fail', // config-level — operator must adjust the request/beta
  invalid_request: 'no_retry', // malformed; retrying verbatim repeats the 400
  server_error: 'backoff', // transient 5xx
  network: 'backoff', // transient connectivity
  unknown: 'backoff', // conservative default
};

const PERMANENT_REASONS = new Set<FailoverReason>([
  'auth_permanent',
  'billing',
  'content_policy_blocked',
  'oauth_long_context_beta_forbidden',
  'invalid_request',
]);

function make(reason: FailoverReason): Classification {
  return { reason, action: ACTION_FOR_REASON[reason], permanent: PERMANENT_REASONS.has(reason) };
}

/**
 * Classify a provider error into a {reason, action, permanent} triple.
 *
 * Pure and side-effect-free. `provider` is accepted for provider-specific
 * disambiguation (and forward-compat) but the current taxonomy is largely
 * provider-agnostic — the same Anthropic/OpenAI/Gemini error strings recur.
 */
export function classifyError(provider: ProviderName, err: unknown): Classification {
  const { status, text } = normalize(err);

  // ── Most-specific substring buckets first (they refine ambiguous statuses) ──

  // Anthropic OAuth subscription cannot use the long-context (1M) beta. Very
  // specific and permanent for the current request config — surface, don't loop.
  if (has(text, 'oauth_long_context_beta', 'long context beta', 'long_context_beta')) {
    return make('oauth_long_context_beta_forbidden');
  }

  // Content / safety policy refusals. No verbatim retry will pass the filter.
  if (
    has(
      text,
      'content_policy',
      'content policy',
      'safety',
      'blocked by content',
      'content_filter',
      'responsible ai',
      'output_blocked',
      'prohibited_content',
    )
  ) {
    return make('content_policy_blocked');
  }

  // Context window exceeded. Compress (handoff/compaction), do NOT failover —
  // another provider has the same window problem with the same payload.
  if (
    has(
      text,
      'context_length_exceeded',
      'context length',
      'maximum context',
      'prompt is too long',
      'too many tokens',
      'context window',
      'input is too long',
      'request too large', // Anthropic 413-style oversize
      'exceeds the maximum',
    )
  ) {
    return make('context_overflow');
  }

  // Model unavailable / decommissioned → fall back to a different model.
  if (has(text, 'model_not_found', 'model not found', 'does not exist', 'unknown model', 'unsupported model', 'deprecated model', 'has been deprecated')) {
    return make('model_not_found');
  }

  // Billing / payment / credit / subscription exhaustion → rotate account.
  if (
    has(
      text,
      'billing',
      'payment',
      'insufficient_quota',
      'insufficient funds',
      'credit balance',
      'exceeded your current quota',
      'past_due',
      'account is not active',
      'spending limit',
    )
  ) {
    return make('billing');
  }

  // Permanent auth: structurally invalid / revoked credential.
  if (has(text, 'invalid_api_key', 'invalid x-api-key', 'invalid_key', 'revoked', 'no auth credentials', 'authentication_error', 'api key not valid')) {
    return make('auth_permanent');
  }

  // Rate limit / usage limit. Anthropic `rate_limit_error`, OpenAI 429, CLI
  // "usage limit reached", Codex "too many requests".
  if (has(text, 'rate_limit', 'rate limit', 'too many requests', 'usage limit', 'overloaded_error')) {
    // overloaded_error is capacity, not quota — fall through to overloaded below
    // only when it's the *sole* signal. If both appear, treat as rate_limit
    // (the limit is the binding constraint).
    if (has(text, 'rate_limit', 'rate limit', 'too many requests', 'usage limit')) {
      return make('rate_limit');
    }
  }

  // Provider overloaded / capacity (Anthropic overloaded_error, "overloaded",
  // 529). Back off in place — it usually clears in seconds.
  if (has(text, 'overloaded_error', 'overloaded', 'capacity', 'engine is currently overloaded', 'service unavailable')) {
    return make('overloaded');
  }

  // Transient auth (token expired but refreshable) — distinct from permanent.
  if (has(text, 'token expired', 'expired token', 'token_expired', 'session expired', 'reauthenticate', 'login again')) {
    return make('auth');
  }

  // ── Status-code fallbacks (substring didn't pin it down) ──

  if (status !== undefined) {
    if (status === 401) return make('auth');
    if (status === 403) {
      // Permission denied. Anthropic `permission_error` → treat as auth-ish
      // permanent (the credential lacks access); generic 403 → auth.
      if (has(text, 'permission_error', 'permission denied', 'forbidden', 'not authorized', 'access denied')) {
        return make('auth_permanent');
      }
      return make('auth');
    }
    if (status === 402) return make('billing'); // Payment Required
    if (status === 404) {
      // A 404 on a model route is a missing model; otherwise it's a bad request.
      if (has(text, 'model')) return make('model_not_found');
      return make('invalid_request');
    }
    if (status === 413) return make('context_overflow'); // Payload Too Large
    if (status === 422) return make('invalid_request');
    if (status === 429) return make('rate_limit');
    if (status === 529) return make('overloaded'); // Anthropic capacity status
    if (status === 503) return make('overloaded');
    if (status === 400) return make('invalid_request');
    if (status >= 500) return make('server_error');
  }

  // ── Network / connectivity (no usable status) ──
  if (has(text, 'econnreset', 'etimedout', 'enotfound', 'econnrefused', 'socket hang up', 'network error', 'fetch failed', 'connection reset', 'timed out', 'timeout')) {
    return make('network');
  }

  // ── Generic auth/permission strings with no status ──
  if (has(text, 'unauthorized', 'authentication', '401')) return make('auth');
  if (has(text, 'forbidden', '403')) return make('auth');

  // Unknown → conservative backoff (a transient blip, not a fatal config error).
  void provider; // reserved for future provider-specific disambiguation
  return make('unknown');
}
