// ── VRAM budget readout + auto context-sizer (LOCAL_AI hardware-synergy) ──
//
// Two read-only, fail-soft probes that give the CONFIG tab hardware awareness:
//
//   computeVramReport() — the LOCAL board's GPU VRAM (nvidia-smi via the
//   Cookbook hardware probe) vs what the local Ollama daemon currently has
//   resident (/api/ps size_vram). Powers the VRAM BUDGET readout.
//
//   computeOllamaFit() — a predictive (what-if) estimate: given the workflow's
//   primary model and the configured utility/summarizer model, use the Cookbook
//   fit math to size the largest num_ctx the primary can use on this GPU,
//   optionally reserving headroom for a LOCAL utility model. A utility pinned to
//   a remote baseUrl (the 3070-on-Unraid route) costs zero local VRAM. Powers
//   the "set to fit" button + the primary/utility coexistence warning.
//
// FAIL-SOFT throughout: no GPU (macOS / no nvidia-smi) ⇒ available:false + a
// note; a down daemon ⇒ daemonUp:false; an unprobeable model ⇒ found:false.
// Never throws — the routes wrap these but these degrade on their own. The
// Cookbook fit math is a coarse heuristic (KV-cache approximated per family),
// so every number is framed as an estimate in the UI, never a guarantee.

import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { OllamaVramReport, OllamaFitReport, ModelSpec } from '@arco/shared';
import { probeHardware } from '../cookbook/hardware.js';
import { estimateVram } from '../cookbook/fit.js';
import { getOllamaBase, probeOllamaLive } from './ollama.js';

const execFileAsync = promisify(execFile);

// Context we size the utility model's reserve footprint against. The utility job
// reads a transcript so it isn't tiny, but it runs num_predict-capped and short;
// a moderate window is a fair reserve estimate.
const UTILITY_RESERVE_CONTEXT = 8192;
// Fallback context for the coexistence check when the primary has no configured
// num_ctx (daemon default is small, but operators usually raise it — assume a
// useful working context so the warning isn't falsely reassuring).
// Q4 bits-per-weight fallback when /api/tags didn't yield the on-disk size.
const Q4_BYTES_PER_PARAM = 0.5625;

export async function computeVramReport(): Promise<OllamaVramReport> {
  const fetchedAt = Date.now();
  const [hw, live] = await Promise.all([
    probeHardware(),
    probeOllamaLive().catch(() => ({ up: false, loadedModels: [] as Array<{ name: string; sizeVram: number | null }> })),
  ]);
  const loaded = (live.loadedModels ?? []).map((m) => ({
    name: m.name,
    sizeVramBytes: typeof m.sizeVram === 'number' ? m.sizeVram : null,
  }));
  const usedVramBytes = loaded.reduce((sum, m) => sum + (m.sizeVramBytes ?? 0), 0);
  const totalVramBytes = hw.totalVramBytes;
  return {
    available: totalVramBytes > 0,
    ...(hw.note ? { note: hw.note } : {}),
    backend: hw.backend,
    gpus: hw.gpus.map((g) => ({ name: g.name, vramBytes: g.vramBytes })),
    totalVramBytes,
    daemonUp: !!live.up,
    loaded,
    usedVramBytes,
    availableVramBytes: Math.max(0, totalVramBytes - usedVramBytes),
    fetchedAt,
  };
}

// ── ModelSpec from /api/show (+ /api/tags for on-disk size) ──
//
// Ollama's /api/show returns `details.parameter_size` ("27.2B"),
// `details.quantization_level` ("Q4_K_M"), `model_info` (arch-prefixed keys incl.
// "<arch>.context_length"), and `parameters` (the Modelfile, where num_ctx may be
// pinned). /api/tags carries the real on-disk GGUF `size`, which the fit math
// prefers over the bits-per-weight estimate. We compose both. Never throws.

// Real per-model architecture, read from /api/show model_info — the EXACT
// inputs for a deterministic KV-cache calc (no param-count guessing). nKv is the
// GQA key/value head count (far smaller than head_count on modern models);
// headDim is the per-head key dimension. slidingWindow, when present, means most
// layers cap their KV at a fixed window rather than scaling with context — so
// context is NOT the VRAM bottleneck and a dense-attention calc badly
// under-reports the usable window (the gemma case).
interface ArchInfo {
  layers?: number;
  nKv?: number;
  headDim?: number;
  slidingWindow?: number;
}

interface SpecResult {
  found: boolean;
  spec?: ModelSpec;
  currentNumCtx?: number;
  arch?: ArchInfo;
}

function parseParamBillions(s: unknown): number | undefined {
  if (typeof s !== 'string') return undefined;
  const m = /([\d.]+)\s*([BM])?/i.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // "M" suffix (sub-billion models) → convert to billions.
  return /m/i.test(m[2] ?? '') ? n / 1000 : n;
}

async function fetchTagSizeBytes(model: string, base: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return undefined;
    const data = await res.json() as { models?: Array<{ name?: string; size?: number }> };
    const hit = (data.models ?? []).find((m) => m.name === model);
    return typeof hit?.size === 'number' && hit.size > 0 ? hit.size : undefined;
  } catch {
    return undefined;
  }
}

// GROUND TRUTH: a currently-loaded model's actual VRAM footprint at its actual
// context, from /api/ps. This captures the daemon's real KV-cache quant + flash
// attention WITHOUT us having to assume any of it — measuring beats guessing.
// Returns null when the model isn't loaded (then we can't measure → 'needs-load').
async function liveLoadedEntry(model: string, base: string): Promise<{ sizeVram: number; contextLength: number } | null> {
  try {
    const res = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const data = await res.json() as { models?: Array<{ name?: string; model?: string; size_vram?: number; context_length?: number }> };
    const hit = (data.models ?? []).find((m) => m.name === model || m.model === model);
    if (hit && typeof hit.size_vram === 'number' && hit.size_vram > 0
        && typeof hit.context_length === 'number' && hit.context_length > 0) {
      return { sizeVram: hit.size_vram, contextLength: hit.context_length };
    }
    return null;
  } catch {
    return null;
  }
}

// The window a loaded model is actually running at, from /api/ps. Unlike
// liveLoadedEntry this doesn't require size_vram > 0 — a CPU-offloaded load
// (tank while mining) still reports a real context_length. null when not loaded.
export async function loadedContextLength(model: string, base: string): Promise<number | null> {
  try {
    const res = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const data = await res.json() as { models?: Array<{ name?: string; model?: string; context_length?: number }> };
    const hit = (data.models ?? []).find((m) => m.name === model || m.model === model);
    return hit && typeof hit.context_length === 'number' && hit.context_length > 0 ? hit.context_length : null;
  } catch {
    return null;
  }
}

// Best-effort read of the LOCAL daemon's KV-cache quant for display/transparency
// (the math uses the live measurement, not this). Linux + systemd only; silent
// undefined everywhere else. Never throws.
async function detectKvCacheType(): Promise<string | undefined> {
  if (os.platform() !== 'linux') return undefined;
  try {
    const { stdout } = await execFileAsync('systemctl', ['show', 'ollama', '-p', 'Environment'], { timeout: 2000 });
    const m = /OLLAMA_KV_CACHE_TYPE=(\S+)/.exec(stdout);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

export async function buildModelSpec(model: string, base?: string): Promise<SpecResult> {
  const trimmed = model.trim();
  if (!trimmed) return { found: false };
  const resolvedBase = (base?.trim() || (await getOllamaBase())).replace(/\/+$/, '');
  try {
    const res = await fetch(`${resolvedBase}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return { found: false };
    const data = await res.json() as {
      details?: { parameter_size?: unknown; quantization_level?: unknown };
      model_info?: Record<string, unknown>;
      parameters?: unknown;
    };
    const params = parseParamBillions(data.details?.parameter_size);
    const quant = typeof data.details?.quantization_level === 'string'
      ? data.details.quantization_level
      : 'Q4_K_M';
    // Scan model_info for arch-prefixed numeric keys (the prefix is the arch
    // family, e.g. "qwen3", "llama", "gemma4" — match by suffix). These are the
    // EXACT KV-cache inputs; no param-count heuristic needed.
    const info = data.model_info ?? {};
    const numBySuffix = (suffix: string): number | undefined => {
      for (const [k, v] of Object.entries(info)) {
        if (k.endsWith(suffix) && typeof v === 'number' && v > 0) return v;
      }
      return undefined;
    };
    const contextMax = numBySuffix('.context_length');
    const layers = numBySuffix('.block_count');
    const nHead = numBySuffix('.attention.head_count');
    const nKv = numBySuffix('.attention.head_count_kv');
    const keyLen = numBySuffix('.attention.key_length');
    const embLen = numBySuffix('.embedding_length');
    // head_dim: prefer the explicit key_length; else hidden_size / head_count.
    const headDim = keyLen ?? (embLen && nHead ? Math.round(embLen / nHead) : undefined);
    const slidingWindow = numBySuffix('.attention.sliding_window');
    const arch: ArchInfo = {
      ...(layers ? { layers } : {}),
      ...(nKv ? { nKv } : {}),
      ...(headDim ? { headDim } : {}),
      ...(slidingWindow ? { slidingWindow } : {}),
    };
    // currentNumCtx: pinned num_ctx in the Modelfile parameters string.
    let currentNumCtx: number | undefined;
    if (typeof data.parameters === 'string') {
      const m = /^\s*num_ctx\s+(\d+)\s*$/m.exec(data.parameters);
      if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > 0) currentNumCtx = n; }
    }
    if (params === undefined) return { found: false, ...(currentNumCtx ? { currentNumCtx } : {}) };
    const sizeBytes = await fetchTagSizeBytes(trimmed, resolvedBase);
    const spec: ModelSpec = {
      params,
      quant,
      ...(sizeBytes ? { sizeBytes } : {}),
      ...(contextMax ? { contextMax } : {}),
    };
    return { found: true, spec, arch, ...(currentNumCtx ? { currentNumCtx } : {}) };
  } catch {
    return { found: false };
  }
}

export interface FitInput {
  primary: string;
  utility?: string | null;
  // When the utility model targets a remote baseUrl, it costs zero LOCAL VRAM —
  // so we don't reserve headroom for it. This is the 3070-on-Unraid payoff.
  utilityRemote?: boolean;
}

export async function computeOllamaFit(input: FitInput): Promise<OllamaFitReport> {
  const fetchedAt = Date.now();
  const hw = await probeHardware();
  const totalVramBytes = hw.totalVramBytes;
  const available = totalVramBytes > 0;

  const primaryRes = await buildModelSpec(input.primary);

  // Utility footprint: only reserve when it's a real local model.
  const utilityModel = input.utility?.trim() || '';
  const utilityRemote = !!input.utilityRemote;
  let utility: OllamaFitReport['utility'] = null;
  let reservedForUtilityBytes = 0;
  if (utilityModel) {
    if (utilityRemote) {
      utility = { model: utilityModel, found: true, remote: true };
    } else {
      const uRes = await buildModelSpec(utilityModel);
      if (uRes.found && uRes.spec) {
        const footprintBytes = Math.round(estimateVram(uRes.spec, UTILITY_RESERVE_CONTEXT));
        reservedForUtilityBytes = footprintBytes;
        utility = { model: utilityModel, found: true, footprintBytes, remote: false };
      } else {
        utility = { model: utilityModel, found: false, remote: false };
      }
    }
  }

  const localBase = (await getOllamaBase()).replace(/\/+$/, '');
  const kvCacheType = await detectKvCacheType();

  let primary: OllamaFitReport['primary'] = null;
  let coexist = true;
  if (primaryRes.found && primaryRes.spec) {
    const spec = primaryRes.spec;
    const arch = primaryRes.arch ?? {};
    const weights = spec.sizeBytes && spec.sizeBytes > 0
      ? spec.sizeBytes
      : spec.params * 1e9 * Q4_BYTES_PER_PARAM;
    // Base = on-disk weights. Everything else (compute buffers, overhead, KV)
    // falls into the measured slope below. This keeps the estimate conservative
    // and — crucially — NEVER negative: a loaded model's VRAM always exceeds its
    // weights, so we never false-negative to 'needs-load' at low loaded contexts
    // (the bug where a tiny q4_0 KV looked like "no KV at all").
    const nonKv = weights;
    const budget = Math.max(0, totalVramBytes - reservedForUtilityBytes);

    // GROUND TRUTH FIRST: if the model is loaded, back out the real KV/token from
    // its actual /api/ps VRAM at its actual context. This reflects the daemon's
    // real KV-cache quant (q4_0/q8_0/f16) + flash attention with NO assumptions —
    // the fix for "you assumed f16 but I run q4_0". Measuring beats guessing.
    const live = available ? await liveLoadedEntry(input.primary, localBase) : null;
    const liveKvPerTok = live && live.sizeVram > nonKv ? (live.sizeVram - nonKv) / live.contextLength : 0;

    let estimateMethod: 'measured-live' | 'sliding-window' | 'needs-load' | 'unknown';
    let maxNumCtx: number | undefined;
    let liveLoadedCtx: number | undefined;
    let liveSizeVramBytes: number | undefined;

    if (live && liveKvPerTok > 0) {
      estimateMethod = 'measured-live';
      liveLoadedCtx = live.contextLength;
      liveSizeVramBytes = live.sizeVram;
      maxNumCtx = Math.min(spec.contextMax ?? Number.MAX_SAFE_INTEGER, Math.floor((budget - nonKv) / liveKvPerTok));
      // Warn only on this trustworthy path: does the operator's current setting fit?
      const ctxForCheck = primaryRes.currentNumCtx ?? live.contextLength;
      coexist = nonKv + liveKvPerTok * ctxForCheck + reservedForUtilityBytes <= totalVramBytes;
    } else if (arch.slidingWindow) {
      // Sliding-window attention (gemma): KV stays small, context isn't the VRAM
      // limiter. Full trained window is usable if the weights fit.
      estimateMethod = 'sliding-window';
      maxNumCtx = available && nonKv < budget ? spec.contextMax : undefined;
    } else if (available) {
      // Dense model, not loaded → can't measure, and a static calc can't know the
      // daemon's KV-cache quant (which swings capacity ~4×). Don't fabricate.
      estimateMethod = 'needs-load';
      maxNumCtx = undefined;
    } else {
      estimateMethod = 'unknown';
      maxNumCtx = undefined;
    }

    const estVramAtMaxBytes = estimateMethod === 'measured-live' && liveKvPerTok > 0 && maxNumCtx && maxNumCtx > 0
      ? Math.round(nonKv + liveKvPerTok * maxNumCtx)
      : undefined;

    primary = {
      model: input.primary,
      found: true,
      params: spec.params,
      quant: spec.quant,
      estimateMethod,
      ...(spec.contextMax ? { contextMax: spec.contextMax } : {}),
      ...(primaryRes.currentNumCtx ? { currentNumCtx: primaryRes.currentNumCtx } : {}),
      ...(maxNumCtx !== undefined ? { maxNumCtx } : {}),
      ...(estVramAtMaxBytes ? { estVramAtMaxBytes } : {}),
      ...(liveLoadedCtx !== undefined ? { liveLoadedCtx } : {}),
      ...(liveSizeVramBytes !== undefined ? { liveSizeVramBytes } : {}),
    };
  } else {
    primary = { model: input.primary, found: false };
  }

  return {
    ok: true,
    available,
    ...(hw.note ? { note: hw.note } : {}),
    totalVramBytes,
    reservedForUtilityBytes,
    ...(kvCacheType ? { kvCacheType } : {}),
    primary,
    utility,
    coexist,
    fetchedAt,
  };
}
