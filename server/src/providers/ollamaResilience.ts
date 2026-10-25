// M4 (LOCAL_AI_MASTER_PLAN) — Multi-backend Ollama routing + reactive
// resilience. Absorbs Hardening Phase 2 (single-host resilience) and Phase 8
// (Tailscale hostname fallback), built once in multi-backend form per the
// master plan's reconciliation note.
//
// Reference algorithm: litellm's Router (mined, NOT depended on) —
// simple-shuffle weighted selection, reactive per-host cooldown with a SHORT
// TTL + lazy recovery (no background prober), error-type retryability gate,
// instant zero-backoff failover to a healthy peer + jittered exponential
// backoff only when forced onto the last/only host. The distributed/cost/quota
// machinery litellm layers on top is explicitly rejected for a 1–3 host setup
// (Excellence-plan §"Deliberately rejected").
//
// DESIGN SHAPE: this module owns the *decision* surface — which backend to try
// next, whether an error is retryable, when to cool a host, when NOT to cool
// it. It deliberately does NOT own the HTTP fetch or the NDJSON parse — that
// stays in ollama.ts so the streaming/tool-loop code is unchanged. The chat
// path calls `selectBackend()`, attempts the request, and on failure calls
// `reportFailure()` then `selectBackend()` again. Every decision is surfaced
// to the caller as a structured event so it lands in events.jsonl (guardrail:
// visible + reversible — cooldowns auto-expire, the operator edits the list).
//
// LOAD-BEARING INVARIANT — never cool the only/last healthy backend. Cooling
// your sole remaining host is self-sabotage: the operator then sees "no
// backend available" when the host was about to recover. litellm calls this
// the SINGLE_DEPLOYMENT rule. We keep using it and let the per-request error
// surface instead. See docs/GOTCHAS.md §Ollama multi-backend cooldown guard.

import { execFile } from 'child_process';

// ── Backend descriptor (resolved from settings) ──────────────────────────

export interface ResolvedBackend {
  // Canonical base URL, trailing slashes stripped (e.g. http://host:11434).
  baseUrl: string;
  // Relative selection weight in the weighted shuffle. >= 1 after resolution.
  weight: number;
  // Friendly name for events.jsonl + the model-host affinity map. Defaults to
  // host:port of baseUrl when the operator didn't set one.
  label: string;
  // Optional explicit Tailscale machine name for the Phase 8 DNS fallback.
  // Defaults to the baseUrl hostname when unset.
  tailscaleHost?: string;
  // True for a loopback/127.0.0.1/::1 host — a restarting local daemon
  // recovers fast, so it gets a shorter cooldown (Hardening §4: "give local
  // endpoints a shorter cool"). It also must NEVER be the target of a
  // Tailscale lookup.
  isLocal: boolean;
}

// ── Cooldown TTLs (Hardening §4: SHORT 5–15s, not minutes) ────────────────
//
// A blipped Tailscale host must rejoin selection fast — odysseus's hard-won
// lesson: "a SINGLE transient blip used to trip a full 60s lockout — the user
// saw a 503 and thought the model died when it was fine a second later." We
// cool reactively on the failure itself (no per-minute %-failure math — at low
// local request volume a single failure IS the whole signal, per Excellence
// §"Deliberately rejected") and recover lazily once the TTL lapses.
const COOLDOWN_MS_REMOTE = 12_000; // remote/Tailscale host: 12s
const COOLDOWN_MS_LOCAL = 6_000; // local daemon (restarts fast): 6s
const COOLDOWN_MS_RATE_LIMIT_CAP = 60_000; // honor Retry-After up to 60s

// ── Backoff (only when forced onto the last/only host) ────────────────────
// litellm `_time_to_sleep_before_retry`: instant retry when a healthy peer
// exists; jittered exponential ONLY when down to the last host.
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
const BACKOFF_JITTER_MS = 750;

// ── Connect timeout (Hardening §4 piece 1) ────────────────────────────────
// Distinct from the overall stream/read budget (decode can legitimately take
// minutes). A dead host must fail fast on TCP, not hang. The caller aborts the
// request if the response HEADERS don't arrive within this window, then clears
// the timer once streaming starts.
export const OLLAMA_CONNECT_TIMEOUT_MS = (() => {
  const env = process.env.ARCHON_OLLAMA_CONNECT_TIMEOUT_MS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 500 && n <= 30_000) return n;
  }
  return 3_000;
})();

// Headers-arrival budget for the interactive streaming /api/chat request.
// A cold large model load can take well over the short connect timeout before
// Ollama sends response headers, even though the daemon is healthy. Callers
// should first probe /api/version with OLLAMA_CONNECT_TIMEOUT_MS, then allow
// this larger budget for model load + stream startup.
export const OLLAMA_STREAM_START_TIMEOUT_MS = (() => {
  const env = process.env.ARCHON_OLLAMA_STREAM_START_TIMEOUT_MS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 5_000 && n <= 600_000) return n;
  }
  return 180_000;
})();

// ── Error retryability table (litellm `_should_retry` / `_is_cooldown_required`)
//
// Connection-level errors (refused / timeout / reset / DNS) and 5xx/429 are
// retryable AND trigger cooldown. 4xx (except 429) — validation, context
// overflow (400) — are NOT retryable and NEVER cool the host: a 400 is the
// transcript's fault, not the host's, and Phase-4 compaction / M9 ctx-fallback
// own that path. Operator abort is never retryable.
export type RetryDecision = {
  retryable: boolean;
  // True ⇒ this failure should cool the failing backend (subject to the
  // never-cool-last guard). False ⇒ retryable-but-don't-cool (none today) or
  // not-retryable.
  cooldown: boolean;
  // Human-readable reason for the events.jsonl line.
  reason: string;
  // Parsed Retry-After seconds (rate-limit), if present.
  retryAfterMs?: number;
  // M9 — context-overflow discriminator. True for the Ollama context-overflow
  // 400 (a prompt that exceeds the model's loaded num_ctx). It is deliberately
  // NOT retryable and NOT cooling (overflow-400-is-not-a-host-fault — the host
  // is fine, the transcript was too big), so it falls through M4's failover/
  // cooldown logic untouched. M9's ctx-fallback seam reads THIS flag at the
  // terminal point to escalate to a larger window instead of failing. Carried
  // here (vs re-parsing the error string at the seam) so the single classifier
  // owns the labeling. See ollamaCtxFallback.ts.
  contextOverflow?: boolean;
};

export function classifyOllamaError(err: unknown, httpStatus?: number): RetryDecision {
  // HTTP status path (the fetch resolved but the daemon returned non-2xx).
  if (typeof httpStatus === 'number') {
    if (httpStatus === 429) {
      return { retryable: true, cooldown: true, reason: `HTTP 429 rate-limited` };
    }
    if (httpStatus >= 500) {
      return { retryable: true, cooldown: true, reason: `HTTP ${httpStatus} server error` };
    }
    // 4xx other than 429 — client/validation error. 400 is context overflow on
    // Ollama; that's NOT a host fault and must not cool the backend. Flag the
    // 400 as contextOverflow so M9's ctx-fallback seam can escalate to a larger
    // window instead of failing the turn (the host stays HOT — see the field
    // comment + ollamaCtxFallback.ts). Other 4xx (404 missing model, 422, ...)
    // are genuine client errors with no window escalation to offer.
    if (httpStatus === 400) {
      return { retryable: false, cooldown: false, contextOverflow: true, reason: `HTTP 400 context overflow` };
    }
    return { retryable: false, cooldown: false, reason: `HTTP ${httpStatus} (non-retryable client error)` };
  }

  // Abort — operator cancel or our own connect-timeout abort. The connect
  // timeout IS retryable (the host is dead/slow); a plain operator abort is
  // not. We distinguish via the marker set by the connect-timeout aborter.
  if (err && typeof err === 'object') {
    const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } };
    if (e.name === 'AbortError') {
      if (e.message && e.message.includes(CONNECT_TIMEOUT_MARKER)) {
        if (e.message.includes('stream start timeout')) {
          return { retryable: true, cooldown: true, reason: 'stream start timeout (model load or daemon stalled)' };
        }
        return { retryable: true, cooldown: true, reason: 'connect timeout (host unreachable)' };
      }
      // Genuine operator abort — bail, never retry/cool.
      return { retryable: false, cooldown: false, reason: 'operator abort' };
    }
    const code = e.code || e.cause?.code || '';
    const msg = (e.message || '').toLowerCase();
    if (
      code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' ||
      code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EPIPE' ||
      msg.includes('econnrefused') || msg.includes('econnreset') ||
      msg.includes('etimedout') || msg.includes('fetch failed') ||
      msg.includes('network') || msg.includes('socket hang up')
    ) {
      return { retryable: true, cooldown: true, reason: `connection error (${code || 'network'})` };
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || msg.includes('enotfound') || msg.includes('getaddrinfo')) {
      // DNS failure — retryable AND the trigger for the Tailscale fallback
      // (Phase 8). Cool the host so we don't hammer a name that won't resolve.
      return { retryable: true, cooldown: true, reason: 'DNS resolution failed' };
    }
  }
  // Unknown error — treat conservatively as retryable+cool so a flaky host
  // doesn't pin the turn, but the caller's retry cap bounds it.
  return { retryable: true, cooldown: true, reason: `unknown error: ${err instanceof Error ? err.message : String(err)}` };
}

// Marker the connect-timeout aborter stamps into its AbortController reason so
// classifyOllamaError can tell a timeout-abort from an operator-abort.
export const CONNECT_TIMEOUT_MARKER = '[archon-connect-timeout]';

// ── Cooldown state (module-level, shared across workflows hitting the same
// daemon — a dead host is dead for everyone). In-memory Map only — one Node
// process; the distributed Redis-backed cooldown litellm uses is rejected.
interface CooldownEntry {
  until: number; // epoch ms; selectable again once now > until
  reason: string;
}
const cooldowns = new Map<string, CooldownEntry>(); // key: baseUrl

// Test seam — the smoke harness clears state between scenarios.
export function _resetCooldownsForTest(): void {
  cooldowns.clear();
}

// Exported read-only probe: is this backend currently cooled? Used by the
// chat path to count "healthy" backends for the never-cool-last guard and the
// peer-available backoff decision. Does NOT lazily delete (a pure query).
export function isBackendCooled(baseUrl: string, now: number): boolean {
  const entry = cooldowns.get(baseUrl);
  return !!entry && now <= entry.until;
}

function isCooled(baseUrl: string, now: number): CooldownEntry | null {
  const entry = cooldowns.get(baseUrl);
  if (!entry) return null;
  if (now > entry.until) {
    cooldowns.delete(baseUrl); // lazy recovery — expired, drop it
    return null;
  }
  return entry;
}

// ── Routing events (surfaced to the caller → events.jsonl) ────────────────
export type OllamaRoutingEvent =
  | { kind: 'selected'; backend: string; reason: string; healthyCount: number; candidateCount: number }
  | { kind: 'cooldown_start'; backend: string; reason: string; untilMs: number; ttlMs: number }
  | { kind: 'cooldown_skip_last'; backend: string; reason: string } // never-cool-last guard fired
  | { kind: 'cooldown_expired'; backend: string }
  | { kind: 'failover'; from: string; to: string; reason: string; backoffMs: number }
  | { kind: 'tailscale_fallback'; backend: string; resolved: string }
  | { kind: 'exhausted'; reason: string };

export type RoutingEventSink = (e: OllamaRoutingEvent) => void;

// ── Selection ─────────────────────────────────────────────────────────────
//
// Weighted shuffle (litellm simple-shuffle): among the healthy backends that
// can serve the requested model, pick one with probability proportional to its
// weight. Deterministic and readable — we compute a cumulative-weight roll, so
// the choice is reasoned-about (not opaque). `rng` is injectable for tests so
// selection is reproducible; default Math.random in production.
//
// `servesModel(backend) => boolean | undefined`: caller's per-backend model
// knowledge (live /api/tags ∪ modelHostMap hint). `undefined` = unknown (no
// tags fetched yet) → treated as a candidate (optimistic; the request itself
// will reveal a missing model as a 404 the retry loop handles).

export interface SelectionInput {
  backends: ResolvedBackend[];
  // Backends already attempted this turn (exclude from re-selection so we
  // don't pin to a host that just failed when a peer exists).
  exclude: ReadonlySet<string>;
  servesModel: (backend: ResolvedBackend) => boolean | undefined;
  now: number;
  rng?: () => number;
}

export interface SelectionResult {
  backend: ResolvedBackend;
  reason: string;
  healthyCount: number; // healthy & model-serving, excluding `exclude`
  candidateCount: number; // total enabled & model-serving (ignoring cooldown/exclude)
}

export function selectBackend(input: SelectionInput): SelectionResult | null {
  const { backends, exclude, servesModel, now } = input;
  const rng = input.rng ?? Math.random;

  // Stage 1: enabled backends that (might) serve the model.
  const serving = backends.filter((b) => {
    const s = servesModel(b);
    return s === true || s === undefined; // optimistic on unknown
  });

  // Stage 2: drop cooled + already-attempted. These are the *preferred*
  // candidates.
  const healthy = serving.filter((b) => !exclude.has(b.baseUrl) && !isCooled(b.baseUrl, now));

  if (healthy.length > 0) {
    const chosen = weightedPick(healthy, rng);
    return {
      backend: chosen,
      reason: healthy.length === serving.length
        ? 'weighted-shuffle among healthy backends'
        : `weighted-shuffle among ${healthy.length}/${serving.length} healthy (others cooled/attempted)`,
      healthyCount: healthy.length,
      candidateCount: serving.length,
    };
  }

  // Stage 3: nothing healthy & un-attempted. If a serving backend exists but
  // is cooled and NOT yet attempted this turn, fall back to it anyway — the
  // never-cool-last guard means a cooled-but-only host is still usable; better
  // to try it and surface the real error than to claim "no backend". Prefer
  // one not in `exclude`.
  const cooledUnattempted = serving.filter((b) => !exclude.has(b.baseUrl));
  if (cooledUnattempted.length > 0) {
    const chosen = weightedPick(cooledUnattempted, rng);
    return {
      backend: chosen,
      reason: 'all candidates cooled; trying least-bad cooled backend (no healthy peer left)',
      healthyCount: 0,
      candidateCount: serving.length,
    };
  }

  // Stage 4: every serving backend has already been attempted this turn. The
  // retry loop is exhausted — caller surfaces the last error.
  return null;
}

// Cumulative-weight roll. Weights are clamped >= 0; an all-zero set degrades to
// uniform so a misconfigured weight can't make a backend unselectable.
function weightedPick(backends: ResolvedBackend[], rng: () => number): ResolvedBackend {
  const total = backends.reduce((s, b) => s + Math.max(0, b.weight), 0);
  if (total <= 0) return backends[Math.floor(rng() * backends.length)] ?? backends[0];
  let roll = rng() * total;
  for (const b of backends) {
    roll -= Math.max(0, b.weight);
    if (roll < 0) return b;
  }
  return backends[backends.length - 1];
}

// ── Failure reporting (cooldown + the never-cool-last guard) ───────────────
//
// `aliveCount` = how many enabled, model-serving backends remain that are NOT
// currently cooled (counted by the caller BEFORE this failure is recorded). If
// cooling this backend would take that count to zero, we DON'T — the
// never-cool-last guard. We still mark the failure as observed (so the retry
// loop's backoff applies) but leave the host selectable.
export interface FailureReport {
  backend: ResolvedBackend;
  decision: RetryDecision;
  // Count of enabled, model-serving, currently-healthy backends (incl. this
  // one) as the caller saw them before this failure.
  healthyServingCount: number;
  now: number;
  emit?: RoutingEventSink;
}

export function reportFailure(report: FailureReport): void {
  const { backend, decision, healthyServingCount, now, emit } = report;
  if (!decision.cooldown) return; // non-cooling error (e.g. 400 / abort)

  // LOAD-BEARING: never cool the only/last healthy backend. If this host is the
  // sole remaining healthy one, cooling it strands the operator. Keep it hot.
  if (healthyServingCount <= 1) {
    emit?.({ kind: 'cooldown_skip_last', backend: backend.label, reason: decision.reason });
    return;
  }

  const ttl = decision.retryAfterMs !== undefined
    ? Math.min(decision.retryAfterMs, COOLDOWN_MS_RATE_LIMIT_CAP)
    : backend.isLocal ? COOLDOWN_MS_LOCAL : COOLDOWN_MS_REMOTE;
  const until = now + ttl;
  cooldowns.set(backend.baseUrl, { until, reason: decision.reason });
  emit?.({ kind: 'cooldown_start', backend: backend.label, reason: decision.reason, untilMs: until, ttlMs: ttl });
}

// Backoff to apply BEFORE re-attempting. Zero when a healthy peer exists
// (instant failover — the litellm shortcut that makes failover feel instant);
// jittered exponential only when we're down to retrying the same/last host.
// `attempt` is 0-based (the upcoming retry's index among same-host retries).
export function backoffMs(hasHealthyPeer: boolean, attempt: number, rng: () => number = Math.random): number {
  if (hasHealthyPeer) return 0;
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, attempt));
  return Math.round(exp + rng() * BACKOFF_JITTER_MS);
}

// ── Tailscale hostname fallback (Phase 8) ─────────────────────────────────
//
// BEST-EFFORT, cross-platform-guarded. On a DNS failure, shell out to
// `tailscale status --json` and resolve the configured host to its Tailscale
// IP, then the caller retries against the IP. CROSS-PLATFORM CAVEAT (CLAUDE.md
// memory): the `tailscale` CLI path differs Linux vs macOS, and Tailscale may
// be absent entirely. We use plain `tailscale` on PATH plus the two
// well-known absolute paths, run with a tight timeout, and FAIL SOFT — a
// missing/erroring Tailscale must NEVER break normal operation. POSIX-only;
// bash 3.2 isn't even involved (we use execFile, no shell). Returns the
// resolved IP or null.
const TAILSCALE_CANDIDATES = [
  'tailscale', // on PATH (Linux package, macOS Homebrew)
  '/usr/bin/tailscale', // Linux distro package
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale', // macOS app bundle
];

interface TailscaleStatus {
  Peer?: Record<string, { HostName?: string; DNSName?: string; TailscaleIPs?: string[] }>;
  Self?: { HostName?: string; DNSName?: string; TailscaleIPs?: string[] };
}

function runTailscaleStatus(): Promise<TailscaleStatus | null> {
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = (): void => {
      if (i >= TAILSCALE_CANDIDATES.length) return resolve(null);
      const bin = TAILSCALE_CANDIDATES[i++];
      execFile(bin, ['status', '--json'], { timeout: 2500, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err || !stdout) return tryNext(); // try the next candidate path
        try {
          resolve(JSON.parse(stdout) as TailscaleStatus);
        } catch {
          resolve(null);
        }
      });
    };
    tryNext();
  });
}

// Match `wanted` (the configured hostname or explicit tailscaleHost) against a
// peer's HostName / DNSName (case-insensitive, prefix-on-dot for the magic-DNS
// FQDN form like host.tailnet.ts.net) and return its first TailscaleIP.
function matchPeerIp(status: TailscaleStatus, wanted: string): string | null {
  const target = wanted.toLowerCase();
  const nodes = [status.Self, ...Object.values(status.Peer ?? {})].filter(
    (n): n is NonNullable<typeof n> => !!n,
  );
  for (const n of nodes) {
    const host = (n.HostName ?? '').toLowerCase();
    const dns = (n.DNSName ?? '').toLowerCase().replace(/\.$/, '');
    const dnsHead = dns.split('.')[0];
    if (host === target || dns === target || dnsHead === target) {
      const ip = (n.TailscaleIPs ?? []).find((x) => typeof x === 'string' && x.length > 0);
      if (ip) return ip;
    }
  }
  return null;
}

// Resolve `backend`'s host via Tailscale. Returns a NEW base URL pointing at
// the resolved IP (preserving scheme/port/path), or null if Tailscale is
// absent / the host isn't a tailnet peer. Never throws.
export async function resolveViaTailscale(backend: ResolvedBackend): Promise<string | null> {
  if (backend.isLocal) return null; // never tailscale-resolve a loopback host
  let parsed: URL;
  try {
    parsed = new URL(backend.baseUrl);
  } catch {
    return null;
  }
  const wanted = backend.tailscaleHost ?? parsed.hostname;
  if (!wanted) return null;
  const status = await runTailscaleStatus();
  if (!status) return null;
  const ip = matchPeerIp(status, wanted);
  if (!ip) return null;
  // IPv6 literals must be bracketed in a URL authority.
  const hostForUrl = ip.includes(':') ? `[${ip}]` : ip;
  parsed.hostname = hostForUrl;
  return parsed.toString().replace(/\/+$/, '');
}

// ── Backend resolution from settings ──────────────────────────────────────
//
// Back-compat (degenerate one-backend case): when `backends` is empty/unset,
// the caller synthesizes a single ResolvedBackend from the legacy
// baseUrl→env→localhost cascade. This function normalizes a list of operator
// descriptors into ResolvedBackends, de-duping by baseUrl and dropping
// disabled / malformed entries. Kept here (not in settings.ts) so the local-
// host detection + label defaulting live next to their consumers.
const LOCAL_HOST_RE = /^(localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\]|::1)$/i;

function isLocalHost(hostname: string): boolean {
  return LOCAL_HOST_RE.test(hostname);
}

export function resolveBackends(
  raw: Array<{ baseUrl?: unknown; weight?: unknown; enable?: unknown; label?: unknown; tailscaleHost?: unknown }>,
): ResolvedBackend[] {
  const out: ResolvedBackend[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (r.enable === false) continue; // soft off-switch
    if (typeof r.baseUrl !== 'string') continue;
    const baseUrl = r.baseUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/\s]+(?::\d+)?$/.test(baseUrl)) continue;
    if (seen.has(baseUrl)) continue;
    seen.add(baseUrl);
    let hostname = '';
    try { hostname = new URL(baseUrl).host; } catch { hostname = baseUrl; }
    const label = typeof r.label === 'string' && r.label.trim().length > 0
      ? r.label.trim().slice(0, 48)
      : hostname;
    const weightRaw = typeof r.weight === 'number' && Number.isFinite(r.weight) ? r.weight : 1;
    const weight = weightRaw > 0 ? weightRaw : 1; // non-positive weight → 1
    const tailscaleHost = typeof r.tailscaleHost === 'string' && r.tailscaleHost.trim().length > 0
      ? r.tailscaleHost.trim()
      : undefined;
    let hostOnly = '';
    try { hostOnly = new URL(baseUrl).hostname; } catch { /* leave empty */ }
    out.push({ baseUrl, weight, label, isLocal: isLocalHost(hostOnly), ...(tailscaleHost ? { tailscaleHost } : {}) });
  }
  return out;
}

// Synthesize the single-backend degenerate case from a resolved base URL (the
// legacy cascade output). Used when settings.ollama.backends is empty/unset so
// pre-M4 operators see no behavior change.
export function singleBackend(baseUrl: string): ResolvedBackend {
  const clean = baseUrl.replace(/\/+$/, '');
  let hostname = '';
  let host = clean;
  try { const u = new URL(clean); hostname = u.hostname; host = u.host; } catch { /* leave */ }
  return { baseUrl: clean, weight: 1, label: host, isLocal: isLocalHost(hostname) };
}
