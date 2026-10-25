// ── llama.cpp serve-failure diagnosis (DD13) ──
//
// PURE function. Given the tail of llama-server's stderr (and, optionally, the
// failed loadout's current ctxSize / ngl so a fix can suggest a concrete lower
// value), classify the failure against an ORDERED registry of known causes and
// return a structured diagnosis: cause + human message + plain-text suggestions +
// one-click fixes that map onto the catalog editor's fields.
//
// Nothing here reads the system, the clock, or a model — it's a deterministic
// regex pass, so it's unit-testable and faithful to review (the fence: a readable
// rule set, not a model verdict). See shared/protocol/llamacppDiagnose.ts for the
// shapes + the fence rationale.
//
// Scope: the llama.cpp subset ONLY (port-in-use, gguf-missing, ctx-too-large, oom,
// binary-missing, unsupported-arch) + a Traceback fallback. The upstream reference
// also carried vLLM/SGLang entries — DROPPED; Arco serves GGUF via llama.cpp.

import type {
  LlamacppServeDiagnosis,
  LlamacppServeFix,
  LlamacppFailureCause,
} from '@arco/shared';

export interface DiagnoseOpts {
  // The failed loadout's configured context window, when known — lets the
  // ctx-too-large / OOM fix suggest a concrete halved value rather than a guess.
  currentCtxSize?: number;
  // The failed loadout's configured GPU layer count (ngl), when known — lets the
  // OOM fix suggest offloading fewer layers.
  currentNgl?: number;
}

// Floor we won't suggest dropping context below — smaller than this isn't useful
// for a coding turn, so we'd rather the operator pick a smaller model.
const MIN_SUGGESTED_CTX = 2048;
// Default context to suggest when we don't know the current one.
const DEFAULT_SUGGESTED_CTX = 4096;

// Suggest a context size strictly below the current one (halved, floored). When
// the current size is unknown or already tiny, fall back to a fixed conservative
// value.
function halveCtx(current?: number): number {
  if (current && current > MIN_SUGGESTED_CTX * 2) {
    return Math.max(MIN_SUGGESTED_CTX, Math.floor(current / 2 / 1024) * 1024 || Math.floor(current / 2));
  }
  return DEFAULT_SUGGESTED_CTX;
}

// One ordered rule. `build` produces the cause-specific message/suggestions/fixes
// (it gets the opts so a fix can reference the current ctx/ngl). First match wins.
interface Rule {
  cause: LlamacppFailureCause;
  re: RegExp;
  build: (opts: DiagnoseOpts) => Omit<LlamacppServeDiagnosis, 'matched' | 'cause'>;
}

// ORDER MATTERS: more specific causes first. OOM is checked before ctx-too-large
// because an OOM message often also mentions the KV cache / context; we want the
// OOM remediation (lower ngl + ctx) to win over the ctx-only one.
const RULES: Rule[] = [
  {
    cause: 'binary-missing',
    // ENOENT spawning llama-server, or a shell "command not found".
    re: /\b(?:ENOENT|command not found|no such file or directory)\b[^\n]*llama-server|llama-server[^\n]*\b(?:ENOENT|not found)\b/i,
    build: () => ({
      message: 'llama-server could not be launched — the binary is missing or not on PATH.',
      suggestions: [
        'Install llama.cpp (it provides the `llama-server` binary).',
        'Ensure `llama-server` is on the PATH the Arco service runs with.',
      ],
      fixes: [],
    }),
  },
  {
    cause: 'port-in-use',
    re: /\b(?:address already in use|bind\s*(?:\(\))?\s*[:=].*in use|EADDRINUSE|failed to bind)\b/i,
    build: () => ({
      message: 'The serve port is already taken by another process.',
      suggestions: [
        'Stop whatever is already listening on that port (an orphaned llama-server, or another service).',
        'Or pin a different port via the loadout\'s extra args (e.g. `--port 8081`).',
      ],
      // --port lives in extraArgs; offer it as a one-click escape hatch.
      fixes: [{ kind: 'add-extra-arg', arg: '--port 8081', label: 'Serve on port 8081 instead' }],
    }),
  },
  {
    cause: 'oom',
    // CUDA/Metal/host OOM. Catch the common llama.cpp / CUDA phrasings.
    re: /\b(?:out of memory|cudaMalloc|cuda error[^\n]*out of memory|failed to allocate[^\n]*(?:VRAM|device|buffer)|ggml_backend[^\n]*alloc[^\n]*fail|insufficient memory)\b/i,
    build: (opts) => ({
      message: 'The model ran out of GPU/host memory while loading.',
      suggestions: [
        'Lower the context size — the KV-cache grows linearly with context.',
        'Offload fewer layers to the GPU (reduce ngl) so more weight sits in system RAM.',
        'Or pick a smaller quant / model that fits this hardware (see the fit warnings above).',
      ],
      fixes: [
        { kind: 'set-ctx-size', ctxSize: halveCtx(opts.currentCtxSize), label: `Reduce context to ${halveCtx(opts.currentCtxSize)}` },
        ...(typeof opts.currentNgl === 'number' && opts.currentNgl > 0
          ? [{ kind: 'set-ngl', ngl: Math.max(0, Math.floor(opts.currentNgl * 0.75)), label: `Offload fewer layers (ngl ${Math.max(0, Math.floor(opts.currentNgl * 0.75))})` } as LlamacppServeFix]
          : []),
      ],
    }),
  },
  {
    cause: 'ctx-too-large',
    // KV-cache / context allocation failures that aren't a general OOM.
    re: /\b(?:failed to allocate[^\n]*(?:KV|kv cache|context)|n_ctx[^\n]*(?:too large|exceeds)|kv (?:self )?cache[^\n]*(?:alloc|too large)|context (?:size )?too large)\b/i,
    build: (opts) => ({
      message: 'The requested context window was too large to allocate.',
      suggestions: ['Lower the context size to one that fits this hardware.'],
      fixes: [{ kind: 'set-ctx-size', ctxSize: halveCtx(opts.currentCtxSize), label: `Reduce context to ${halveCtx(opts.currentCtxSize)}` }],
    }),
  },
  {
    cause: 'unsupported-arch',
    re: /\b(?:unknown (?:model )?architecture|unsupported (?:model )?architecture|unknown model arch|architecture not supported|unknown architecture)\b/i,
    build: () => ({
      message: 'This GGUF\'s model architecture is not supported by the installed llama.cpp.',
      suggestions: [
        'Update llama.cpp to a build new enough to support this architecture.',
        'Or use a GGUF of an architecture the current build supports.',
      ],
      fixes: [],
    }),
  },
  {
    cause: 'gguf-missing',
    // Model file not found / load failure. Checked AFTER binary-missing so a
    // missing llama-server doesn't get misread as a missing GGUF.
    re: /\b(?:failed to load model|error loading model|unable to load model|cannot open|gguf[^\n]*(?:not found|no such file)|llama_(?:model_)?load[^\n]*(?:fail|error))\b/i,
    build: () => ({
      message: 'llama-server could not load the GGUF file.',
      suggestions: [
        'Verify the GGUF path in the loadout is correct and the file exists.',
        'If the download was interrupted, re-download the model (a truncated GGUF fails to load).',
      ],
      fixes: [],
    }),
  },
];

// Classify a serve-failure tail. Returns the first matching rule's diagnosis, or
// an `unknown` fallback (matched:false) that still surfaces the failure so the
// operator reads the raw tail. Empty/whitespace input → unknown with no message.
export function diagnoseLlamacppServeFailure(tail: string, opts: DiagnoseOpts = {}): LlamacppServeDiagnosis {
  const text = (tail ?? '').trim();
  if (!text) {
    return { matched: false, cause: 'unknown', message: 'No serve log available to diagnose.', suggestions: [], fixes: [] };
  }
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      const built = rule.build(opts);
      return { matched: true, cause: rule.cause, ...built };
    }
  }
  return {
    matched: false,
    cause: 'unknown',
    message: 'The launch failed but the cause was not recognised — review the stderr tail below.',
    suggestions: ['Check the last-stderr tail for the underlying error.'],
    fixes: [],
  };
}
