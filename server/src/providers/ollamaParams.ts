// M3 (LOCAL_AI_MASTER_PLAN) — Ollama per-model param presets: the typed
// cast/allowlist boundary. Ported from open-webui's
// `apply_model_params_to_body_ollama` (utils/payload.py): a single declarative
// table that *casts* each operator-set option to its expected type and
// *allowlists* it. Anything not in the table is silently dropped — Ollama
// otherwise logs "invalid option" warnings, and an untyped passthrough would
// be a footgun (it could smuggle `tool_choice`/`functions`, which HANG
// /api/chat — see ollama.ts).
//
// WHY a table (not ad-hoc branches): extending the allowlist (top_p,
// num_predict, repeat_penalty, …) is a one-line addition here, keeping the
// merge site in ollama.ts dumb. The minimum set required by M3 is num_ctx,
// keep_alive, num_gpu, temperature; the rest are pre-wired so power users get
// them for free.
//
// PLACEMENT (load-bearing): Ollama's /api/chat takes generation params inside
// the `options` envelope, but `keep_alive` (and `format`/`think`) live at the
// request ROOT — NOT inside options. The table marks each key's placement so
// the merge site can route it correctly. Putting keep_alive under options is
// silently ignored by the daemon.

export type OllamaParamPlacement = 'options' | 'root';

interface OllamaParamSpec {
  // Where the coerced value lands in the /api/chat body.
  placement: OllamaParamPlacement;
  // Coerce the raw operator value to the type Ollama expects. Return
  // `undefined` to drop the value (bad type / out of range) — the merge then
  // omits the key entirely rather than sending a malformed option.
  coerce: (raw: unknown) => unknown;
}

// Coercion helpers — each fails closed (returns undefined) on a value that
// can't be sensibly cast, so a malformed preset never reaches the daemon.
function toInt(raw: unknown): number | undefined {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}
function toFloat(raw: unknown): number | undefined {
  const n = typeof raw === 'string' ? parseFloat(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(n) ? n : undefined;
}
function toPositiveInt(raw: unknown): number | undefined {
  const n = toInt(raw);
  return n !== undefined && n > 0 ? n : undefined;
}
// keep_alive accepts BOTH a duration string ("10m", "1h", "0", "-1") and a
// numeric seconds value (-1 = forever, 0 = evict immediately). Pass strings
// through verbatim (the daemon parses the duration grammar); cast numbers to
// int. Anything else drops.
function toKeepAlive(raw: unknown): string | number | undefined {
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t.length > 0 ? t : undefined;
  }
  return toInt(raw);
}

// THE allowlist. Add a row to extend the surface — nothing else changes.
// The minimum M3 set is flagged; the rest are pre-wired (LM Studio's per-load
// schema is the menu of what's worth exposing — Excellence LE-2).
export const OLLAMA_PARAM_SPEC: Record<string, OllamaParamSpec> = {
  // ── M3 minimum set ──
  num_ctx: { placement: 'options', coerce: toPositiveInt }, // trusted-only — see clampNumCtx
  keep_alive: { placement: 'root', coerce: toKeepAlive },
  num_gpu: { placement: 'options', coerce: toInt }, // layers to offload to GPU; 0 = CPU-only
  temperature: { placement: 'options', coerce: toFloat },
  // ── pre-wired extensions (power users via the JSON blob) ──
  top_p: { placement: 'options', coerce: toFloat },
  top_k: { placement: 'options', coerce: toInt },
  min_p: { placement: 'options', coerce: toFloat },
  num_predict: { placement: 'options', coerce: toInt }, // -1 = unlimited
  repeat_penalty: { placement: 'options', coerce: toFloat },
  repeat_last_n: { placement: 'options', coerce: toInt },
  seed: { placement: 'options', coerce: toInt },
  num_batch: { placement: 'options', coerce: toPositiveInt },
  num_thread: { placement: 'options', coerce: toPositiveInt },
  num_keep: { placement: 'options', coerce: toInt },
};

// Operator-set keys the CONFIG-tab UI surfaces as first-class fields (the
// rest live in the raw JSON blob). Kept here so client + server agree on the
// "advanced params" menu without a second source of truth.
export const OLLAMA_PRESET_UI_KEYS = ['num_ctx', 'keep_alive', 'num_gpu', 'temperature'] as const;

export interface AppliedOllamaParams {
  // Merge straight into the /api/chat `options` envelope.
  options: Record<string, unknown>;
  // Root-level fields (keep_alive). Spread onto the request body root, NOT
  // into options. Absent keys mean "use the provider default".
  root: Record<string, unknown>;
  // Keys that were on the table and survived coercion, for the events.jsonl
  // visibility line (so transcript review shows the effective preset).
  appliedKeys: string[];
}

// trusted-only num_ctx (Hardening §3, ported from odysseus
// `_build_ollama_payload`): "only emit num_ctx when the value came from a real
// probe — never from a hardcoded fallback. Guessing high on an unknown model
// risks OOM; guessing low truncates. If the probe returned nothing, omit and
// let the daemon decide."
//
// Here the operator may type ANY num_ctx in the UI. The trusted ceiling is the
// model's Modelfile num_ctx when it has one (a deliberate per-variant choice),
// else the architecture's trained max (`<arch>.context_length` from /api/show
// model_info) — also a real probe, not a guess. The arch fallback matters for
// stock tags: before 2026-09-29 a model with no Modelfile num_ctx (stock
// qwen3.8:27b) dropped every operator value, SET TO FIT included, and ran at
// the daemon's VRAM-derived default (32768 on the 5090, not the old 2048) —
// capped at 32K on a 262K model. VRAM safety is the fit calculator's job
// (ollamaVram.ts), not this clamp's. No probe at all ⇒ omit. Returns the value
// to send, or undefined to omit.
export function clampNumCtx(requested: number, probedNumCtx: number | undefined, archCtx?: number): number | undefined {
  if (!Number.isFinite(requested) || requested <= 0) return undefined;
  const ceiling = numCtxCeiling({ numCtx: probedNumCtx, archCtx });
  if (ceiling === undefined) return undefined;
  return Math.min(requested, ceiling);
}

// The operator num_ctx ceiling for a probed model: Modelfile value, else the
// arch max. Deliberately NOT the window used for compaction / the CTX bar or
// the M9 escalation target — those need the window the daemon actually runs,
// and forcing a stock model to its arch max on recovery would be a VRAM guess.
export function numCtxCeiling(meta: { numCtx?: number; archCtx?: number }): number | undefined {
  for (const v of [meta.numCtx, meta.archCtx]) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

// `<arch>.context_length` out of /api/show `model_info` (keys are prefixed by
// the GGUF arch, e.g. `qwen35.context_length`). Ignores nested
// `*.vision.context_length`-style keys by requiring exactly `<arch>.context_length`.
export function parseArchContextLength(modelInfo: unknown): number | undefined {
  if (!modelInfo || typeof modelInfo !== 'object') return undefined;
  const info = modelInfo as Record<string, unknown>;
  const arch = typeof info['general.architecture'] === 'string' ? info['general.architecture'] : undefined;
  const keys = arch ? [`${arch}.context_length`] : Object.keys(info).filter((k) => /^[^.]+\.context_length$/.test(k));
  for (const k of keys) {
    const v = info[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.trunc(v);
  }
  return undefined;
}

// The window the daemon will actually run a turn with: the operator num_ctx
// that survives the clamp, else the Modelfile value, else the window /api/ps
// measured on a previous no-num_ctx turn (`loadedCtx` — the daemon's
// VRAM-derived default, e.g. 32768). undefined = never measured — callers
// treat that as "unknown window".
export function effectiveNumCtx(
  params: Record<string, unknown> | undefined,
  meta: { numCtx?: number; archCtx?: number; loadedCtx?: number },
): number | undefined {
  const applied = applyOllamaParams(params, meta.numCtx, meta.archCtx).options.num_ctx;
  return typeof applied === 'number' ? applied : (meta.numCtx ?? meta.loadedCtx);
}

// Apply an operator params blob through the allowlist boundary. `probedNumCtx`
// is the model's /api/show Modelfile num_ctx and `archCtx` its arch max; they
// form the trusted ceiling for num_ctx specifically (see clampNumCtx; every
// other key is type-coerced only).
export function applyOllamaParams(
  params: Record<string, unknown> | undefined,
  probedNumCtx: number | undefined,
  archCtx?: number,
): AppliedOllamaParams {
  const options: Record<string, unknown> = {};
  const root: Record<string, unknown> = {};
  const appliedKeys: string[] = [];
  if (!params || typeof params !== 'object') return { options, root, appliedKeys };

  for (const [key, rawValue] of Object.entries(params)) {
    const spec = OLLAMA_PARAM_SPEC[key];
    if (!spec) continue; // not on the allowlist → silently drop
    if (rawValue === undefined || rawValue === null || rawValue === '') continue; // operator cleared it

    let value = spec.coerce(rawValue);
    if (value === undefined) continue; // failed coercion → drop

    // num_ctx is special: trusted-only clamp against the probe.
    if (key === 'num_ctx') {
      value = clampNumCtx(value as number, probedNumCtx, archCtx);
      if (value === undefined) continue;
    }

    if (spec.placement === 'root') root[key] = value;
    else options[key] = value;
    appliedKeys.push(key);
  }

  return { options, root, appliedKeys };
}
