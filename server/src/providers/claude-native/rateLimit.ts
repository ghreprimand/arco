// H10 — Claude-native rate-limit header parsing.
//
// Anthropic returns retry timing on the error response. Before this, the
// Native worker ignored those headers and slept a fixed 15/30/60s ladder
// (RETRY_BACKOFF_MS) — sometimes far longer than Anthropic actually wanted,
// sometimes shorter than a genuine quota reset. Worse, the SDK's own
// `maxRetries` (default 2) was left un-overridden, so on a 429/529 the SDK
// retried twice INTERNALLY before throwing, and THEN our 3-attempt ladder ran
// — compounding into ~6 attempts and minutes of stacked backoff per turn.
// The worker now sets maxRetries:0 (our ladder is the single retry path) and
// this module reads the server's own timing hints.
//
// Anthropic does NOT emit Nous's `x-ratelimit-*` suite. The headers that
// matter here are:
//   • `retry-after`                       — seconds, or an HTTP-date
//   • `anthropic-ratelimit-*-reset`       — RFC-3339 timestamp the bucket refills
// We read retry-after first (the explicit "wait this long"), then fall back to
// the soonest *-reset. A standalone helper so it's unit-testable without an
// HTTP round-trip; the worker passes `err.headers` straight through.

// Upper bound on a header-driven wait. A misconfigured/hostile server can't
// park a turn for an unbounded time; past this we cap and let the operator
export const MAX_RATE_LIMIT_WAIT_MS = 5 * 60_000;

// Header bags arrive in three shapes across SDK versions: a web `Headers`
// object (has `.get`), a plain record, or a Map. Normalize to a
// case-insensitive lookup that returns the first value or null.
export function getHeader(headers: unknown, name: string): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  // web Headers / anything with a .get(name)
  const withGet = headers as { get?: (n: string) => string | null };
  if (typeof withGet.get === 'function') {
    try {
      const v = withGet.get(name) ?? withGet.get(lower);
      if (v != null) return String(v);
    } catch {
      /* fall through to record scan */
    }
  }
  if (headers instanceof Map) {
    for (const [k, v] of headers.entries()) {
      if (String(k).toLowerCase() === lower) return v == null ? null : String(v);
    }
    return null;
  }
  if (typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (k.toLowerCase() === lower) {
        if (Array.isArray(v)) return v.length ? String(v[0]) : null;
        return v == null ? null : String(v);
      }
    }
  }
  return null;
}

// Parse a single `retry-after`-style value: either delta-seconds or an
// absolute HTTP/RFC-3339 date. Returns ms-from-now (never negative), or null
// when it can't be parsed. `nowMs` is injectable for deterministic tests.
export function retryAfterMs(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

// The Anthropic per-bucket reset headers we honor, in the order we prefer them
// when retry-after is absent. They all carry an RFC-3339 timestamp.
const RESET_HEADERS = [
  'anthropic-ratelimit-tokens-reset',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-output-tokens-reset',
  'anthropic-ratelimit-requests-reset',
];

export interface RateLimitTiming {
  // ms to wait before the next attempt, capped at MAX_RATE_LIMIT_WAIT_MS. null
  // when no usable header was present (caller falls back to its fixed ladder).
  waitMs: number | null;
  // which header drove the decision, for the operator-facing notice/log.
  source: string | null;
  // true when the wait had to be clamped down to the cap.
  capped: boolean;
}

// Resolve the wait from a header bag. retry-after wins; otherwise the soonest
// *-reset. The result is capped; `source`/`capped` are surfaced in the notice.
export function resolveRateLimitWait(headers: unknown, nowMs: number): RateLimitTiming {
  const direct = retryAfterMs(getHeader(headers, 'retry-after'), nowMs);
  if (direct !== null) {
    return clamp(direct, 'retry-after');
  }
  let best: { ms: number; source: string } | null = null;
  for (const h of RESET_HEADERS) {
    const ms = retryAfterMs(getHeader(headers, h), nowMs);
    if (ms === null) continue;
    if (!best || ms < best.ms) best = { ms, source: h };
  }
  if (best) return clamp(best.ms, best.source);
  return { waitMs: null, source: null, capped: false };
}

function clamp(ms: number, source: string): RateLimitTiming {
  if (ms > MAX_RATE_LIMIT_WAIT_MS) return { waitMs: MAX_RATE_LIMIT_WAIT_MS, source, capped: true };
  return { waitMs: ms, source, capped: false };
}

// Split a genuine quota exhaustion (429 with the requests/tokens bucket at 0)
// from a transient server-side overload (529 / overloaded_error). Both retry,
// but the operator-facing wording and — when present — the honored header
// differ, and a genuine 429 with no remaining is the one worth a louder notice.
export function classifyRateLimit(
  status: number,
  errType: string,
  headers: unknown,
): 'genuine' | 'transient' {
  if (status === 529 || errType === 'overloaded_error') return 'transient';
  if (status === 429 || errType === 'rate_limit_error') {
    const remaining =
      getHeader(headers, 'anthropic-ratelimit-requests-remaining') ??
      getHeader(headers, 'anthropic-ratelimit-tokens-remaining');
    if (remaining !== null && Number(remaining) === 0) return 'genuine';
    return 'genuine';
  }
  return 'transient';
}
