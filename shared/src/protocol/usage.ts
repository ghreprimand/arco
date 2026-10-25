// ── Token usage + provider live-status / usage shapes ──

// Per-turn token accounting. Field semantics differ by provider — see
// docs/GOTCHAS.md "Codex" + client/src/utils/format.ts:contextTokens for the
// definitive read. Quick summary:
//   Anthropic/Claude: input, cacheRead, cacheCreate are DISJOINT and sum to
//     the total prompt size. Output is generated text only.
//   OpenAI/Codex: input IS the full prompt size. cacheRead is a SUBSET of
//     input ("of those input tokens, this many were served from cache").
//     reasoningOutput is a subset of output ("of those output tokens, this
//     many were the model's hidden reasoning trace"). total may be reported
//     directly by the provider — when present, prefer it over manual sums.
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreate?: number;
  // Codex-only today: subset of `output` representing the model's reasoning
  // trace. High-effort GPT-5.x reasoning models can put significant tokens
  // here, and they roll forward into the next turn's prompt as part of the
  // running thread. Useful for understanding why session token counts grow
  // faster than the visible chat would suggest.
  reasoningOutput?: number;
  // Provider-reported total (Codex's `total_tokens`). When absent, callers
  // can compute total = input + output (Codex) or input + output + cacheRead
  // + cacheCreate (Claude — but cacheRead/cacheCreate may be billed at
  // different rates so summing for a "billable total" is imprecise).
  total?: number;
}

// Daemon-measured generation speed for one operator turn — Ollama and Strata
// (its `done` envelope reports eval_* / prompt_eval_* counts + ns durations).
// Sums across every /api/chat call in the turn's tool loop; rates are
// tokens / ms, computed at display time so a multi-call turn weights by work
// done rather than averaging per-call rates. prefill counts are post-cache
// (only the new tokens the daemon had to process).
export interface GenerationSpeed {
  decodeTokens: number;
  decodeMs: number;
  prefillTokens: number;
  prefillMs: number;
}

export interface UsageInfo {
  session: { utilization: number; resetsAt: string | null } | null;
  weekly: { utilization: number; resetsAt: string | null } | null;
  subscriptionType: string | null;
  fetchedAt: number;
  error?: string;
}

// Live Ollama daemon snapshot. Sourced from /api/ps (currently-loaded
// models with their VRAM expiry). Polled by the client only while
// `enabledProviders.ollama` is true and the auth probe says the daemon is
// reachable — we don't burn polls on a disabled or unreachable daemon.
export interface OllamaLoadedModel {
  name: string;
  expiresAt: string | null;
  sizeVram: number | null;
}

export interface OllamaLiveStatus {
  up: boolean;
  // Daemon version reported by /api/version. Surfaced in the settings
  // panel's CLI VERSIONS block so the operator sees if their daemon has
  // drifted from the latest release. Undefined when the daemon is down or
  // the version probe failed.
  version?: string;
  loadedModels: OllamaLoadedModel[];
  fetchedAt: number;
  error?: string;
}

// M12 (LOCAL_AI_MASTER_PLAN, Excellence LE-6) — model-lifecycle console.
//
// One loaded-model row inside the multi-backend aggregation. Extends the
// single-backend OllamaLoadedModel with the idle/expiry timer the console
// renders (open-webui annotates /api/ps results with expires_at; LM Studio's
// lastUsedTime+ttlMs is the design target). `secondsUntilExpiry` is computed
// server-side from `expiresAt` at fetch time so the client doesn't have to
// re-parse the RFC3339 timestamp — it ticks down a known integer instead.
export interface OllamaPsModel {
  name: string;
  // Raw RFC3339 eviction timestamp from /api/ps (null when the daemon
  // reports keep_alive: -1 / forever, or omitted the field).
  expiresAt: string | null;
  // Seconds until the daemon evicts this model from VRAM. null = no expiry
  // (forever-loaded) or unparseable; <= 0 means it's overdue (the daemon
  // evicts lazily, so a brief negative is normal). Computed at fetchedAt.
  secondsUntilExpiry: number | null;
  // VRAM footprint in bytes (size_vram), null when the daemon omitted it.
  sizeVram: number | null;
  // Total on-disk/loaded size in bytes (size), null when omitted. size_vram
  // can be < size when part of the model is offloaded to system RAM.
  size: number | null;
}

// One backend's slice of the aggregated /api/ps fan-out. A down/unreachable
// backend shows `reachable: false` + an error string rather than crashing the
// whole aggregation (fail-soft per backend — the M4 connect-timeout pattern).
// `cooling` mirrors the M4 resilience cooldown Map so the console can grey out
// a backend the router is currently avoiding (LE-6 nice-to-have).
export interface OllamaPsBackend {
  baseUrl: string;
  label: string;
  reachable: boolean;
  // True when the M4 router has this backend in a reactive cooldown right now.
  cooling: boolean;
  loadedModels: OllamaPsModel[];
  error?: string;
}

// The full aggregated snapshot the lifecycle console polls. Backs the per-tab
// CONFIG-tab MODEL LIFECYCLE section: per-backend loaded models with size +
// idle/expiry countdown + an unload button each.
export interface OllamaPsAggregate {
  backends: OllamaPsBackend[];
  fetchedAt: number;
}

// ── VRAM budget readout (LOCAL_AI hardware-synergy) ──
//
// A live snapshot of the LOCAL serving box's GPU VRAM vs what the local Ollama
// daemon currently has resident. Powers the CONFIG-tab VRAM BUDGET readout +
// the primary/utility coexistence warning. Local-only by design: VRAM is
// per-board, so `used` reflects the single local daemon (getOllamaBase), not the
// multi-backend fleet. Fail-soft — `available:false` (+ a note) when there's no
// CUDA GPU (macOS / no nvidia-smi) or the daemon is down; the UI degrades to a
// "VRAM probe unavailable" line instead of erroring.
export interface OllamaVramReport {
  // True when a CUDA GPU was detected via nvidia-smi (totalVramBytes > 0).
  available: boolean;
  // Why the probe is degraded, when available:false (e.g. "macOS: no CUDA probe").
  note?: string;
  backend: 'cuda' | 'metal' | 'cpu';
  gpus: Array<{ name: string; vramBytes: number }>;
  totalVramBytes: number;
  // Whether the local Ollama daemon answered /api/ps.
  daemonUp: boolean;
  // Models resident in the local daemon's VRAM right now (size_vram each).
  loaded: Array<{ name: string; sizeVramBytes: number | null }>;
  // Sum of loaded size_vram (the bytes Ollama is using on this board).
  usedVramBytes: number;
  // max(0, total - used). Best-effort headroom for another model.
  availableVramBytes: number;
  fetchedAt: number;
}

// ── Fit estimate for the auto context-sizer (LOCAL_AI hardware-synergy) ──
//
// Predictive (what-if) sizing for the CONFIG-tab "set to fit" button + the
// coexistence warning. Given the workflow's primary model (and optionally the
// configured utility/summarizer model), estimate via the Cookbook fit math the
// largest num_ctx the primary can use on the local GPU — optionally reserving
// VRAM headroom for a LOCAL utility model. A utility pinned to a remote baseUrl
// costs zero local VRAM (`remote:true`), which is the whole point of the 3070-
// on-Unraid route. Estimates are coarse (KV-cache heuristics), so the UI frames
// the number as an estimate, never a guarantee.
export interface OllamaFitReport {
  ok: boolean;
  // True when a CUDA GPU was detected; false ⇒ totalVramBytes 0, no real sizing.
  available: boolean;
  note?: string;
  totalVramBytes: number;
  // VRAM held back for a local utility model before sizing the primary.
  reservedForUtilityBytes: number;
  // The local daemon's KV-cache quant (OLLAMA_KV_CACHE_TYPE), when readable —
  // e.g. "q4_0", "q8_0", "f16". Shown for transparency; the live measurement
  // already reflects it without needing this.
  kvCacheType?: string;
  primary: {
    model: string;
    // False when /api/show didn't yield enough metadata to build a spec.
    found: boolean;
    params?: number;          // billions
    quant?: string;
    contextMax?: number;      // model's trained max context (cap)
    currentNumCtx?: number;   // probed Modelfile num_ctx, when set
    // How maxNumCtx was derived — governs how much to trust it + whether to warn:
    //   'measured-live'  — DERIVED FROM ACTUAL /api/ps VRAM at the loaded
    //                      context. Captures the daemon's real KV-cache quant +
    //                      flash attention. The only value we warn on.
    //   'sliding-window' — KV is window-bounded (e.g. gemma); context isn't the
    //                      VRAM limiter, so maxNumCtx = the full trained window.
    //   'needs-load'     — model not loaded; can't measure (capacity depends on
    //                      the daemon's KV quant, which a static calc can't know
    //                      reliably). Show trained max, prompt to load. No warn.
    //   'unknown'        — KV metadata not exposed. No estimate, never warn.
    estimateMethod?: 'measured-live' | 'sliding-window' | 'needs-load' | 'unknown';
    // Largest num_ctx that fits, when known. Only 'measured-live' drives the warning.
    maxNumCtx?: number;
    estVramAtMaxBytes?: number;
    // For 'measured-live': the context + VRAM the model is CURRENTLY loaded at
    // (the measurement the estimate is derived from).
    liveLoadedCtx?: number;
    liveSizeVramBytes?: number;
  } | null;
  utility: {
    model: string;
    found: boolean;
    // Estimated local VRAM footprint (weights + overhead + a small KV slice).
    footprintBytes?: number;
    // True when the utility model targets a remote baseUrl ⇒ no local cost.
    remote: boolean;
  } | null;
  // Whether the primary (at maxNumCtx) + a local utility both fit in total VRAM.
  coexist: boolean;
  fetchedAt: number;
}

// Operator-declared llama.cpp model entry. Lives in ~/.archon/llamacpp.json.
// Unlike Ollama (which auto-discovers via /api/tags), llama-server takes one
// model per process — the operator names each loadout up front so Archon's
// lifecycle manager can spawn `llama-server` with the right -m / --mmproj /
// -ngl flags on demand. Capabilities are operator-declared since llama-server
// has no equivalent of /api/show.
export interface LlamacppModelDef {
  alias: string;
  ggufPath: string;
  // Vision projector (mmproj GGUF). Required for vision-capable loadouts;
  // absent for text-only models. The lifecycle manager passes this through
  // as `--mmproj <path>`.
  mmprojPath?: string;
  // num_ctx equivalent. Defaults to llama-server's built-in default if unset
  // (typically 4096 for older models, model-specific for newer GGUFs).
  ctxSize?: number;
  // Number of layers to offload to GPU. -1 / 999 means "all" — the typical
  // pick for VRAM-resident models on the RTX 5090.
  ngl?: number;
  // Override chat template name (rare — llama-server auto-detects from GGUF
  // metadata). Set this only when the embedded template is wrong.
  chatTemplate?: string;
  // Extra raw flags passed to llama-server. Escape-hatch for per-model
  // tuning the structured fields don't cover (e.g. `--rope-freq-base`).
  extraArgs?: string[];
  // Operator-declared capability flags. Mirrored into AuthStatus so the
  // model picker renders the same tools/vision/thinking badges Ollama
  // models get. Setting `vision: true` without `mmprojPath` is allowed but
  // silently won't produce vision output — guard at the UI layer.
  capabilities?: {
    tools?: boolean;
    vision?: boolean;
    thinking?: boolean;
  };
}

// Live llama-server snapshot. Reports the binary version (cached at server
// start since it doesn't change between Archon restarts) and the currently-
// loaded model state from the lifecycle manager. Polled on the same cadence
// as Ollama's live indicator and gated identically on enabledProviders +
// auth probe success.
export interface LlamacppLiveStatus {
  up: boolean;
  // llama-server --version output, e.g. "9037 (bbeb89d76)".
  version?: string;
  // Alias of the currently-loaded model, or null if no model is in VRAM
  // (idle eviction has run, or no turn has fired yet this session).
  loadedModel: string | null;
  // Port the lifecycle manager spawned llama-server on. Lets the UI link
  // out to llama-server's built-in /props or web UI for debugging.
  port?: number;
  // PID for log correlation when something hangs.
  pid?: number;
  fetchedAt: number;
  error?: string;
}

// Codex usage panel snapshot.
export interface CodexUsageInfo {
  available: boolean;
  fetchedAt: number;
  source: 'camoufox' | 'disabled' | 'unavailable' | 'error';
  profileDir?: string;
  analyticsUrl: string;
  summary?: string;
  rows?: Array<{ label: string; value: string }>;
  rawText?: string;
  error?: string;
}

// One month-to-date usage event from Cursor's dashboard API, flattened for the
// UI. Sourced from cursor.com's private `get-filtered-usage-events` endpoint
// with the session token `cursor-agent` already maintains (see cursorUsage.ts).
export interface CursorUsageEventRow {
  timestamp: number; // epoch-ms
  model: string;
  kind: string; // raw USAGE_EVENT_KIND_* (e.g. USAGE_EVENT_KIND_INCLUDED_IN_PRO)
  chargedCents: number;
  isTokenBasedCall: boolean;
  isHeadless: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  // ACP sessionId of the turn that produced this event — lets us attribute
  // spend to an Archon workflow. Absent for non-ACP (dashboard/IDE) turns.
  conversationId?: string;
}

// The "Included in Pro" allocation gauge, from GET /api/usage-summary — the same
// meter cursor.com's Spending page renders. `used`/`limit`/`remaining` are cents;
// the *PercentUsed values are in PERCENT units as Cursor computes them (0.28 =
// 0.28%, i.e. Cursor blends first-party vs API weighting — NOT simply used/limit).
export interface CursorIncludedUsage {
  usedCents: number;
  limitCents: number;
  remainingCents: number;
  totalPercentUsed: number;   // Cursor's blended "Total" figure — drives the bar
  autoPercentUsed: number;    // first-party (auto-selected) models
  apiPercentUsed: number;     // API (named) models
  billingCycleStart: number;  // epoch-ms
  billingCycleEnd: number;    // epoch-ms — "resets on …"
  membershipType: string;     // 'pro' | 'pro_plus' | 'free' | …
  isUnlimited: boolean;
  onDemandEnabled: boolean;   // On-Demand Spending toggle (overage past the pool)
  onDemandUsedCents: number;
}

// Cursor usage panel snapshot. Polled from the authed dashboard API (no browser
// scrape, unlike Codex): month-to-date charged $, token totals, per-kind counts,
// the on-demand hard-cap flag, and the included-in-plan allocation gauge.
export interface CursorUsageInfo {
  available: boolean;
  fetchedAt: number;
  source: 'dashboard' | 'disabled' | 'unavailable' | 'error';
  dashboardUrl: string;
  // Bounds of the month-to-date window that was polled (epoch-ms).
  periodStart?: number;
  periodEnd?: number;
  // Aggregates over the whole period (not just the returned rows).
  summary?: string;
  chargedCents?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
  eventCount?: number;
  // Raw USAGE_EVENT_KIND_* → count over the period.
  kindCounts?: Record<string, number>;
  // get-hard-limit: noUsageBasedAllowed === true ⇒ hard-capped (no overage).
  hardCapped?: boolean;
  // The "Included in Pro" allocation gauge (GET /api/usage-summary). Absent if
  // that endpoint drifted or failed — the rest of the snapshot still renders.
  included?: CursorIncludedUsage;
  // Most-recent events, bounded, newest-first — for a small table.
  rows?: CursorUsageEventRow[];
  // Set when the session token is stale/absent ⇒ surface a `cursor-agent login` nudge.
  needsLogin?: boolean;
  error?: string;
}

export interface ZaiUsageWindow {
  type: string;
  label: string;
  percentageUsed: number;
  remainingPercentage: number;
  resetAt: string | null;
  unit?: number;
  number?: number;
}

// GLM Coding Plan quota snapshot. Sourced from Z.ai's monitor endpoint with
// the same API key used for the Coding Plan chat endpoint.
export interface ZaiUsageInfo {
  available: boolean;
  fetchedAt: number;
  source: 'monitor' | 'disabled' | 'unavailable' | 'error';
  level?: string;
  windows: ZaiUsageWindow[];
  error?: string;
}
