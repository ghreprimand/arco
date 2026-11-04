// M7 (LOCAL_AI_MASTER_PLAN / Excellence LE-3) — the Ollama utility / task model.
//
// A configurable cheap/small model (e.g. a 3B) that runs DISCRETE, NAMED
// background jobs so the expensive primary stays free: the M8 compaction
// summary (the most important consumer — see runUtilitySummaryJob below), and,
// when their operator-armed triggers ship, model-titles + recall summaries.
//
// ── WHY THIS IS NOT A `distill` (CLAUDE.md hard fences) ──────────────────────
// CLAUDE.md rejects "second-LLM summarization IN THE AGENT LOOP" — the `distill`
// pattern that doubles spend, fails closed, and runs automatically every turn.
// This helper is fence-CLEAR on each of the four-question tests:
//   1. Operator-configured + opt-in — OFF by default. `settings.ollama.utility`
//      is unset until the operator names a model. When unset, callers fall back
//      to their existing behavior (no utility model = NO change). It is never
//      invoked from a per-turn path; only from discrete, named jobs.
//   2. Bounded by deterministic rules — `stream:false`, a hard `num_predict`
//      token cap, a WINDOWED prompt (last-N messages / byte cap, never an
//      unbounded context dump), optional JSON-schema `format` for structured
//      jobs. One non-streaming round-trip; no tool loop, no multi-pass refine.
//   3. Visible in events.jsonl — every invocation emits a `system_notice`
//      (job name, model, backend, input/output token counts) through the same
//      event channel M3–M6 use. The operator sees every background call.
//   4. Reversible — unset the model ⇒ the helper short-circuits and the caller
//      degrades to its deterministic fallback. Nothing persists.
//
// ── SHAPE vs the interactive streaming turn ──────────────────────────────────
// This is a DIFFERENT call shape from ollama.ts's `streamOneTurn`: non-stream,
// JSON-only, single-shot, capped. It deliberately does NOT reuse that path
// (which owns the tool-loop, thinking splitter, prefix-cache byte-stability,
// per-turn options envelope). It reuses the resilience plumbing — backend
// resolution + weighted-shuffle selection + cooldown classification + instant
// failover — because a utility job wants the same multi-backend robustness as a
// real turn, just without the streaming/agentic machinery.

import {
  getOllamaBackends,
} from './ollama.js';
import {
  selectBackend,
  reportFailure,
  classifyOllamaError,
  isBackendCooled,
  OLLAMA_CONNECT_TIMEOUT_MS,
  CONNECT_TIMEOUT_MARKER,
  type ResolvedBackend,
} from './ollamaResilience.js';

// ── Config (settings.ollama.utility) ─────────────────────────────────────────

export interface UtilityModelConfig {
  // The cheap/small model alias or colon-tag (e.g. "qwen3:3b"). When absent the
  // utility model is OFF and runUtilityJob short-circuits to `{ ok: false }`.
  model: string;
  // Optional dedicated backend base-URL. When set, the job runs ONLY against
  // this host (still through the resilience classifier, but with a one-backend
  // candidate list) — lets the operator pin the small model to a box that keeps
  // it warm. When unset the job weighted-shuffles across the configured
  // backends like a normal turn.
  baseUrl?: string;
}

// Resolve the effective utility config from settings. Returns null when the
// operator hasn't configured a model (the default-OFF state). Kept here so the
// "is it configured?" check lives next to the helper that consumes it.
export function resolveUtilityConfig(
  ollama: { utility?: { model?: string; baseUrl?: string; enabled?: boolean } } | undefined,
): UtilityModelConfig | null {
  const u = ollama?.utility;
  if (!u || typeof u.model !== 'string') return null;
  // Paused (Settings → ENABLED off): identical to unconfigured for every
  // caller, but the model/host stay saved.
  if (u.enabled === false) return null;
  const model = u.model.trim();
  if (!model) return null;
  const out: UtilityModelConfig = { model };
  if (typeof u.baseUrl === 'string' && u.baseUrl.trim().length > 0) {
    out.baseUrl = u.baseUrl.trim().replace(/\/+$/, '');
  }
  return out;
}

// ── Bounds (deterministic, operator-readable — fence-question 2) ─────────────

// Default token cap on the utility model's OUTPUT. A background job produces a
// short artifact (a title, a commit subject, a compaction summary) — never a
// long generation. Callers override per-job (M8 wants a larger summary cap than
// a title). Maps to Ollama's `num_predict` (`options.num_predict`).
export const UTILITY_DEFAULT_MAX_TOKENS = 512;
// Hard ceiling — even a caller-supplied cap can't exceed this. Stops a
// misconfigured job from turning the "cheap" model into an unbounded generation.
const UTILITY_MAX_TOKENS_CEILING = 4096;

// Default INPUT window: keep only the last N messages of a transcript-shaped
// prompt. open-webui's `{{MESSAGES:END:N}}` recipe (Excellence LE-3) — a
// utility job never needs the whole history, only the tail. Callers override
// (M8 hands a pre-sliced "older half" and sets this high enough to keep it).
export const UTILITY_DEFAULT_WINDOW_MESSAGES = 20;
// Per-job total INPUT byte cap. Independent of the message-count window: a few
// huge tool-result messages can blow a small model's context even within N
// messages, so we also clamp total serialized bytes. The newest messages are
// kept; older ones drop first (a utility job cares about recency).
export const UTILITY_DEFAULT_MAX_INPUT_BYTES = 24_000;

// Connect-timeout reuse — a dead utility-model host must fail fast, same as the
// interactive path. The decode budget below is bounded too (a utility job has
// no business taking minutes).
const UTILITY_DECODE_TIMEOUT_MS = 60_000;
// Total budget for the actual /api/chat round-trip. MUST cover a COLD model load
// PLUS full (non-streaming) generation: with stream:false Ollama sends no
// response bytes until generation completes (verified empirically — TTFB ==
// total), so the entire load+decode lives in the headers-arrival window. The
// 3s connect timeout would otherwise abort any real summary (>3s, or a cold
// load) and silently drop to the deterministic digest — defeating the point of
// a configured utility model. A cheap liveness probe (the short connect budget)
// still fast-fails a genuinely dead/hung host before we commit to this budget.
const UTILITY_TOTAL_TIMEOUT_MS = 180_000;

// ── Public API ───────────────────────────────────────────────────────────────

export interface UtilityMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface UtilityJobInput {
  // Job name for the events.jsonl visibility line ("compaction-summary",
  // "session-title", …). REQUIRED so every call is attributable in transcript
  // review.
  job: string;
  // The system prompt (job framing). Optional — some jobs put everything in the
  // user message. Sent as a role:'system' message, NOT windowed away.
  system?: string;
  // Either a single user prompt (string), OR a transcript-shaped message list
  // the window applies to. The system message (if any) is always preserved; the
  // window + byte cap apply to the user/assistant messages only.
  prompt?: string;
  messages?: UtilityMessage[];
  // Structured-output schema (or "json"). Reuses M5's Ollama `format` support:
  // the daemon grammar-constrains decoding so the result parses. Omit for free
  // text.
  format?: 'json' | Record<string, unknown>;
  // Output token cap (num_predict). Defaults to UTILITY_DEFAULT_MAX_TOKENS,
  // clamped to the ceiling.
  maxTokens?: number;
  // Input window overrides (see the DEFAULT constants above).
  windowMessages?: number;
  maxInputBytes?: number;
  // Visibility sink — the caller wires this to its event channel so the
  // invocation lands in events.jsonl. Same `system_notice` shape M3–M6 use.
  onNotice?: (line: string) => void;
  // Test seam — inject a stub fetch so request-shaping is assertable offline
  // without a live daemon. Defaults to global fetch.
  fetchImpl?: typeof fetch;
  // Test/M8 seam — inject the resolved config + backends instead of reading
  // settings. When absent, readSettings()→resolveUtilityConfig drives it.
  config?: UtilityModelConfig | null;
  backends?: ResolvedBackend[];
  // Abort signal (operator cancel / job-owner teardown). Optional.
  signal?: AbortSignal;
}

export type UtilityJobResult =
  // ok:true — the utility model produced text. `json` is set when `format` was
  // a schema (or "json") AND the body parsed; callers that asked for structure
  // read it, others read `text`.
  | { ok: true; text: string; json?: unknown; model: string; backend: string; inputTokens: number; outputTokens: number }
  // ok:false — utility model NOT configured (reason:'unconfigured'), or every
  // backend failed (reason:'error'). The CALLER decides the fallback; this
  // helper never throws and never blocks beyond the single round-trip.
  | { ok: false; reason: 'unconfigured' | 'error'; error?: string };

// The non-streaming /api/chat body. Mirrors ollama.ts's OllamaChatRequest but
// with stream:false and NO tools/think (a utility job is single-shot text).
interface UtilityChatRequest {
  model: string;
  messages: UtilityMessage[];
  stream: false;
  options: { num_predict: number; [k: string]: unknown };
  // Explicitly disable reasoning. A thinking-capable model (e.g. qwen3.5) left
  // to its default burns the whole num_predict budget on `message.thinking` and
  // returns EMPTY `message.content` — a silently empty summary. Utility jobs are
  // single-shot text, never reasoning, so force it off. Harmless no-op on models
  // without thinking support.
  think: false;
  // M5 `format` reused for structured jobs (top-level, not inside options).
  format?: 'json' | Record<string, unknown>;
  // Keep the small model warm a short while between background jobs without
  // camping VRAM — shorter than the interactive 10m default.
  keep_alive: string;
}

// Apply the input window + byte cap to the user/assistant messages (the system
// message is preserved untouched). Keeps the NEWEST messages: a utility job
// cares about recency, and the byte cap drops oldest-first. Exported for the
// offline smoke (it asserts the windowing bounds the input).
export function windowUtilityMessages(
  messages: UtilityMessage[],
  windowMessages: number,
  maxInputBytes: number,
): UtilityMessage[] {
  // Split off a leading system message (preserved verbatim, exempt from window).
  const system = messages[0]?.role === 'system' ? messages[0] : null;
  const body = system ? messages.slice(1) : messages.slice();

  // Last-N message window.
  let windowed = windowMessages > 0 && body.length > windowMessages
    ? body.slice(body.length - windowMessages)
    : body;

  // Byte cap: drop OLDEST first until total serialized content fits.
  const byteLen = (m: UtilityMessage): number => Buffer.byteLength(m.content, 'utf8');
  let total = windowed.reduce((s, m) => s + byteLen(m), 0);
  while (total > maxInputBytes && windowed.length > 1) {
    total -= byteLen(windowed[0]);
    windowed = windowed.slice(1);
  }
  // Single remaining message still over the cap → truncate its content (keep the
  // tail, which is the most recent / relevant for a recency-oriented job).
  if (windowed.length === 1 && byteLen(windowed[0]) > maxInputBytes) {
    const m = windowed[0];
    const truncated = Buffer.from(m.content, 'utf8').subarray(-maxInputBytes).toString('utf8');
    windowed = [{ role: m.role, content: truncated }];
  }

  return system ? [system, ...windowed] : windowed;
}

// Build the request body from a job input — exported so the offline smoke can
// assert on the shaping (stream:false, the num_predict cap, the window, the
// format path) WITHOUT a live daemon.
export function buildUtilityRequest(input: UtilityJobInput, model: string): UtilityChatRequest {
  const maxTokens = Math.min(
    Math.max(1, Math.trunc(input.maxTokens ?? UTILITY_DEFAULT_MAX_TOKENS)),
    UTILITY_MAX_TOKENS_CEILING,
  );
  const windowMessages = input.windowMessages ?? UTILITY_DEFAULT_WINDOW_MESSAGES;
  const maxInputBytes = input.maxInputBytes ?? UTILITY_DEFAULT_MAX_INPUT_BYTES;

  // Assemble the raw message stack: system (framing) + the prompt or transcript.
  const raw: UtilityMessage[] = [];
  if (input.system && input.system.trim()) raw.push({ role: 'system', content: input.system });
  if (input.messages && input.messages.length > 0) {
    raw.push(...input.messages);
  } else if (input.prompt) {
    raw.push({ role: 'user', content: input.prompt });
  }

  const windowed = windowUtilityMessages(raw, windowMessages, maxInputBytes);

  return {
    model,
    messages: windowed,
    stream: false,
    options: { num_predict: maxTokens },
    think: false,
    ...(input.format ? { format: input.format } : {}),
    keep_alive: '5m',
  };
}

// runUtilityJob — the bounded, fail-soft, non-streaming call. Returns
// `{ ok:false, reason:'unconfigured' }` when no utility model is set (the
// default-OFF path), `{ ok:false, reason:'error' }` when every backend failed,
// and `{ ok:true, … }` with the text (+ parsed json for structured jobs) on
// success. NEVER throws. The caller owns the fallback.
export async function runUtilityJob(input: UtilityJobInput): Promise<UtilityJobResult> {
  const doFetch = input.fetchImpl ?? fetch;

  // Resolve config — injected (M8 / tests) or read from settings. Lazy-import
  // settings so the offline smoke can drive buildUtilityRequest/windowing
  // without pulling the settings cascade.
  let config = input.config;
  let backends = input.backends;
  if (config === undefined) {
    const { readSettings } = await import('../settings.js');
    const settings = await readSettings();
    config = resolveUtilityConfig(settings.ollama);
  }
  if (!config) return { ok: false, reason: 'unconfigured' };

  // Resolve backends. A pinned utility baseUrl narrows to a single candidate;
  // otherwise reuse the operator's configured fleet (same selection the
  // interactive path uses).
  if (backends === undefined) {
    if (config.baseUrl) {
      const clean = config.baseUrl.replace(/\/+$/, '');
      let host = clean;
      try { host = new URL(clean).host; } catch { /* keep clean */ }
      backends = [{ baseUrl: clean, weight: 1, label: host, isLocal: /localhost|127\.|::1/.test(clean) }];
    } else {
      const resolved = await getOllamaBackends();
      backends = resolved.backends;
    }
  }
  if (!backends || backends.length === 0) {
    return { ok: false, reason: 'error', error: 'no Ollama backend configured' };
  }

  const body = buildUtilityRequest(input, config.model);
  const notice = input.onNotice ?? (() => {});

  // Failover loop — re-select on a retryable failure, instant zero-backoff when
  // a healthy peer exists (the resilience module owns the cooldown/never-cool-
  // last guard). Bounded at backends.length + 1.
  const attempted = new Set<string>();
  const maxAttempts = backends.length + 1;
  let lastError: unknown;

  for (let i = 0; i < maxAttempts; i++) {
    if (input.signal?.aborted) return { ok: false, reason: 'error', error: 'aborted' };

    const now = Date.now();
    const selection = selectBackend({
      backends,
      exclude: attempted,
      servesModel: () => undefined, // optimistic — the request reveals a missing model
      now,
    });
    if (!selection) {
      return { ok: false, reason: 'error', error: lastError ? String(lastError) : 'all backends failed' };
    }
    const base = selection.backend.baseUrl;

    const attempt = await oneUtilityCall(doFetch, base, body, input.signal);
    if (attempt.ok) {
      const inputTokens = attempt.inputTokens;
      const outputTokens = attempt.outputTokens;
      // VISIBILITY (fence-question 3): every invocation lands in events.jsonl.
      notice(
        `utility-model job "${input.job}": ${config.model} @ ${selection.backend.label} — ` +
        `in ${inputTokens}tok / out ${outputTokens}tok` +
        (input.format ? ' (json)' : ''),
      );
      // Structured path: try to parse when a schema/json was requested. A
      // grammar-constrained daemon returns valid JSON; if parsing still fails
      // (older daemon / model ignored format) we hand back the text and leave
      // json undefined — the caller decides.
      let json: unknown;
      if (input.format) {
        try { json = JSON.parse(attempt.text); } catch { /* leave json undefined */ }
      }
      return {
        ok: true,
        text: attempt.text,
        ...(json !== undefined ? { json } : {}),
        model: config.model,
        backend: selection.backend.label,
        inputTokens,
        outputTokens,
      };
    }
    if (attempt.aborted) return { ok: false, reason: 'error', error: 'aborted' };

    // Classify + cool (guarded) + decide failover.
    lastError = attempt.error;
    attempted.add(base);
    const decision = classifyOllamaError(attempt.error, attempt.httpStatus);
    const healthyServing = backends.filter((b) => !isBackendCooled(b.baseUrl, now)).length;
    reportFailure({
      backend: selection.backend,
      decision,
      healthyServingCount: healthyServing,
      now,
      emit: (e) => {
        if (e.kind === 'cooldown_start') notice(`utility-model backend cooled: ${e.backend} — ${e.reason}`);
        else if (e.kind === 'cooldown_skip_last') notice(`utility-model kept ${e.backend} hot (sole backend): ${e.reason}`);
      },
    });
    if (!decision.retryable) {
      notice(`utility-model job "${input.job}" failed (non-retryable): ${decision.reason}`);
      return { ok: false, reason: 'error', error: attempt.error instanceof Error ? attempt.error.message : String(attempt.error) };
    }
    // retryable → loop re-selects a peer (instant failover) or the last host.
  }

  notice(`utility-model job "${input.job}" failed: all backends exhausted`);
  return { ok: false, reason: 'error', error: lastError ? String(lastError) : 'all backends failed' };
}

// One non-streaming /api/chat round-trip against a single backend. Connect-
// timeout-guarded (fast-fail a dead host), then a bounded decode budget. Reads
// the non-stream response's single JSON object: `message.content` + the usage
// counters. Returns a discriminated result the failover loop classifies.
async function oneUtilityCall(
  doFetch: typeof fetch,
  base: string,
  body: UtilityChatRequest,
  operatorSignal: AbortSignal | undefined,
): Promise<
  | { ok: true; text: string; inputTokens: number; outputTokens: number }
  | { ok: false; aborted: true }
  | { ok: false; aborted: false; error: unknown; httpStatus?: number }
> {
  // Liveness probe: fast-fail an unreachable/hung host (the original short
  // connect budget) BEFORE committing to the long generation budget. Without
  // this, a host that accepts TCP but never answers would block for the full
  // UTILITY_TOTAL_TIMEOUT_MS. A reachable daemon then gets the generous budget
  // it needs (cold load + non-streaming generation; see the constant comment).
  try {
    const probeSignal = operatorSignal
      ? AbortSignal.any([operatorSignal, AbortSignal.timeout(OLLAMA_CONNECT_TIMEOUT_MS)])
      : AbortSignal.timeout(OLLAMA_CONNECT_TIMEOUT_MS);
    const probe = await doFetch(`${base}/api/version`, { signal: probeSignal });
    if (!probe.ok) {
      return { ok: false, aborted: false, error: new Error(`Ollama liveness HTTP ${probe.status} ${CONNECT_TIMEOUT_MARKER}`), httpStatus: probe.status };
    }
  } catch {
    if (operatorSignal?.aborted) return { ok: false, aborted: true };
    return { ok: false, aborted: false, error: new Error(`Ollama unreachable (liveness) ${CONNECT_TIMEOUT_MARKER}`) };
  }

  const controller = new AbortController();
  const onAbort = (): void => controller.abort(operatorSignal?.reason);
  if (operatorSignal) {
    if (operatorSignal.aborted) controller.abort(operatorSignal.reason);
    else operatorSignal.addEventListener('abort', onAbort, { once: true });
  }
  // Headers-arrival budget. For stream:false this must cover the WHOLE call
  // (load + generation) — Ollama sends nothing until done — so it's the generous
  // total budget, not the short connect timeout (a dead host already fast-failed
  // the liveness probe above). Once headers arrive we swap to the decode budget.
  let phase: 'connect' | 'decode' = 'connect';
  let timer = setTimeout(() => {
    controller.abort(new DOMException(`Ollama utility timeout ${CONNECT_TIMEOUT_MARKER}`, 'AbortError'));
  }, UTILITY_TOTAL_TIMEOUT_MS);

  try {
    let res: Response;
    try {
      res = await doFetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbort(err) && !(err instanceof Error && err.message.includes(CONNECT_TIMEOUT_MARKER))) {
        return { ok: false, aborted: true };
      }
      return { ok: false, aborted: false, error: err };
    }
    // Headers in hand — swap to the (bounded) decode budget.
    clearTimeout(timer);
    phase = 'decode';
    timer = setTimeout(() => controller.abort(new DOMException('Ollama decode timeout', 'AbortError')), UTILITY_DECODE_TIMEOUT_MS);

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, aborted: false, error: new Error(`Ollama HTTP ${res.status}: ${detail.slice(0, 200)}`), httpStatus: res.status };
    }

    let data: { message?: { content?: unknown }; prompt_eval_count?: unknown; eval_count?: unknown };
    try {
      data = await res.json() as typeof data;
    } catch (err) {
      return { ok: false, aborted: false, error: err };
    }
    const text = typeof data.message?.content === 'string' ? data.message.content : '';
    const inputTokens = typeof data.prompt_eval_count === 'number' ? data.prompt_eval_count : 0;
    const outputTokens = typeof data.eval_count === 'number' ? data.eval_count : 0;
    return { ok: true, text, inputTokens, outputTokens };
  } catch (err) {
    if (isAbort(err) && phase === 'connect') return { ok: false, aborted: false, error: err };
    if (isAbort(err) && !(err instanceof Error && err.message.includes('decode timeout'))) {
      return { ok: false, aborted: true };
    }
    return { ok: false, aborted: false, error: err };
  } finally {
    clearTimeout(timer);
    if (operatorSignal) operatorSignal.removeEventListener('abort', onAbort);
  }
}

function isAbort(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

// ── M8 HOST SEAM (the most important downstream consumer) ─────────────────────
//
// M8 (Ollama auto-compaction) summarizes the OLDER HALF of a transcript when
// the context window fills. That summary call runs HERE, on the utility model,
// per Excellence LE-3 ("run it here instead of on the primary") + the master
// plan ("M7 hosts M9's/M8's summary call").
//
// CONTRACT: M8 hands the messages-to-summarize (already sliced — M8 owns the
// "older half" decision + the keep-current/last-10 invariant) and a max-tokens
// cap. This returns the summary TEXT, or null when the utility model is
// unconfigured / failed. M8 owns the DETERMINISTIC FALLBACK (a structural
// digest) for the null case — this seam never invents one, so M8 keeps the
// fence-clearing "never fails closed" guarantee in one place.
//
// This is intentionally a thin wrapper over runUtilityJob with a summary-shaped
// default framing + a higher token cap; M8 can override the framing.
export interface UtilitySummaryRequest {
  // The messages to compress — M8-sliced. Windowing here is generous (M8
  // already bounded the slice), but the byte cap still guards a pathological
  // tool-result blob.
  messages: UtilityMessage[];
  // Output cap for the summary (num_predict). M8 sets this from its budget;
  // defaults to a summary-sized cap, not the tiny title-sized default.
  maxTokens?: number;
  // Optional framing override. Defaults to the compaction-summary framing below.
  framing?: string;
  // Plumbed through to runUtilityJob for visibility + cancellation + tests.
  onNotice?: (line: string) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  config?: UtilityModelConfig | null;
  backends?: ResolvedBackend[];
}

// Default compaction-summary framing. SINGLE SOURCE OF TRUTH lives in
// handoffPrompts.ts (so the operator-overridable editor registry and this
// fallback default never drift); re-exported here for existing callers + the
// runUtilitySummaryJob default below. See handoffPrompts.ts for why it lives
// there (import-cycle avoidance).
export { DEFAULT_COMPACTION_FRAMING } from '../handoffPrompts.js';
import { DEFAULT_COMPACTION_FRAMING } from '../handoffPrompts.js';

// M8's entry point. Returns the summary text, or null (M8 falls back to its
// deterministic digest). Bounded + fail-soft by construction (delegates to
// runUtilityJob).
export async function runUtilitySummaryJob(req: UtilitySummaryRequest): Promise<string | null> {
  const result = await runUtilityJob({
    job: 'compaction-summary',
    system: req.framing ?? DEFAULT_COMPACTION_FRAMING,
    messages: req.messages,
    // A compaction summary needs the whole sliced half — let M8's slice + the
    // byte cap bound it rather than dropping messages by count here.
    windowMessages: req.messages.length,
    maxTokens: req.maxTokens ?? 1024,
    onNotice: req.onNotice,
    signal: req.signal,
    fetchImpl: req.fetchImpl,
    config: req.config,
    backends: req.backends,
  });
  return result.ok && result.text.trim() ? result.text.trim() : null;
}
