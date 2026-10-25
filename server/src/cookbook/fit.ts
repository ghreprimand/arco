// ── Cookbook fit/scoring engine (Workbench Expansion G1) ──
//
// PURE functions. Given a ModelSpec + a HardwareProfile (+ optional target
// context) compute estimated VRAM, the max context that fits, a throughput
// estimate, gpu-vs-cpu-offload mode, a FIT verdict, and a 0–100 score. Nothing
// here reads the system, the clock, or a random source — every output derives
// from the arguments, so the result is deterministic and unit-testable (the
// smoke imports these directly, no server needed).
//
// ── llmfit lineage (MIT) ──
// Adapted from the open-source `llmfit` model-fit calculator (MIT-licensed),
// which Odysseus's Cookbook is built on. The pieces we ported / adapted:
//   • VRAM = weights + KV-cache + overhead, where
//       weights   = params(B) × 1e9 × (bits-per-weight(quant) / 8)
//       KV-cache  = 2 (K and V) × layers × ctx × kvDim × kvBytes
//       overhead  = a fixed CUDA-context allotment + a fraction of weights
//   • bits-per-weight comes from the quant tag (the QUANT_BPW table below);
//     llmfit uses the same "effective bits per weight" idea (Q4_K_M ≈ 4.5 bpw,
//     etc.). The /8 converts those bits to BYTES for the weight estimate.
//   • max-context-that-fits inverts the KV-cache term against free VRAM.
//   • throughput ≈ memory-bandwidth / bytes-touched-per-token, the standard
//     memory-bound decode approximation llmfit uses for its t/s figure.
//   • verdict/score fold headroom + whether it spilled to CPU offload.
// We did NOT port llmfit's vLLM/AWQ paged-attention paths — the operator's rig serves
// GGUF via llama.cpp on one 5090, so the assumptions here are GGUF/llama.cpp
// shaped (all weights resident; -ngl all or spill to RAM). The layer/dim
// heuristics are coarse family approximations, not per-model truth — G2 can
// refine them from real GGUF metadata later.

import type {
  ModelSpec,
  HardwareProfile,
  FitResult,
  FitVerdict,
  FitMode,
} from '@archon/shared';

// ── Quant → bits-per-weight ─────────────────────────────────────────────────
// "Effective bits per weight." K-quants carry a little block-scale overhead
// above their nominal bit width, so Q4_K_M is ~4.5 bpw rather than a flat 4.0.
// The weight-byte estimate divides this by 8 (bits → bytes). Keep this table
// EXPLICIT and greppable — it's the load-bearing input to the weight estimate,
// and reviewers check it against published GGUF sizes.
export const QUANT_BPW: Record<string, number> = {
  // 2-bit family
  Q2_K: 2.6,
  // 3-bit family
  Q3_K_S: 3.4,
  Q3_K_M: 3.9,
  Q3_K_L: 4.3,
  // 4-bit family
  Q4_0: 4.5,
  Q4_K_S: 4.4,
  Q4_K_M: 4.5,
  // 5-bit family
  Q5_0: 5.5,
  Q5_K_S: 5.4,
  Q5_K_M: 5.5,
  // 6-bit family
  Q6_K: 6.6,
  // 8-bit family
  Q8_0: 8.5,
  // Full precision
  F16: 16,
  BF16: 16,
  F32: 32,
};

// Fallback when a quant tag isn't in the table: derive from a leading "Q<n>" in
// the tag (so an unlisted Q4_K_XL still lands near 4.5), else assume Q4_K_M.
// Returns BITS per weight (the table's units); weightBytes() divides by 8.
function bitsPerWeight(quant: string): number {
  const exact = QUANT_BPW[quant];
  if (exact !== undefined) return exact;
  const m = /^Q(\d+)/i.exec(quant.trim());
  if (m) {
    const bits = Number(m[1]);
    // +0.5 bit of K-quant block-scale overhead, matching the table's slope.
    if (Number.isFinite(bits) && bits > 0) return bits + 0.5;
  }
  if (/f32/i.test(quant)) return 32;
  if (/f16|bf16/i.test(quant)) return 16;
  return QUANT_BPW.Q4_K_M;
}

// ── Architecture heuristics (layers, KV dim, bandwidth) ──────────────────────
// Coarse per-family approximation of transformer depth + KV width as a function
// of parameter count. KV-cache size scales with layers × kvDim, both of which
// grow with model size; these curves are deliberately simple (G2 refines from
// GGUF metadata). kvDim already accounts for grouped-query attention (GQA),
// which most modern coders use — that's why it's far below hidden_size.
interface ArchHeuristic {
  layers: number;
  kvDim: number; // K (or V) elements cached per token per layer, post-GQA.
}

function archHeuristic(model: ModelSpec): ArchHeuristic {
  const p = model.params;
  // Layer count grows roughly with the cube-ish of param scale across the
  // common coder range (7B≈32, 14B≈48, 32B≈64, 70B≈80, 200B≈96). Clamped.
  let layers: number;
  if (p <= 4) layers = 28;
  else if (p <= 9) layers = 32;
  else if (p <= 16) layers = 48;
  else if (p <= 40) layers = 64;
  else if (p <= 90) layers = 80;
  else layers = 96;

  // Post-GQA KV dimension (K elements per token per layer). Modern GQA models
  // keep this small relative to hidden_size; scale gently with model size.
  let kvDim: number;
  if (p <= 9) kvDim = 1024;
  else if (p <= 40) kvDim = 1536;
  else kvDim = 2048;

  // MoE models have many more nominal layers but the same KV footprint pattern;
  // their weight bulk is captured by `params` already (all experts resident).
  return { layers, kvDim };
}

// KV-cache is stored at fp16 in llama.cpp by default → 2 bytes per element.
const KV_BYTES_PER_ELEM = 2;
// K and V are both cached.
const KV_KV_FACTOR = 2;

// CUDA runtime / compute-buffer overhead that doesn't scale with the model
// (context buffers, cuBLAS workspaces, the framework's own allocations). Plus a
// small fraction of the weight bytes for activation/scratch buffers.
const CUDA_FIXED_OVERHEAD_BYTES = 700 * 1024 * 1024; // ~700 MB
const WEIGHT_OVERHEAD_FRACTION = 0.06;

// Memory bandwidth (bytes/sec) by backend, for the memory-bound decode t/s
// estimate. A 5090-class card is ~1.7 TB/s; system RAM (CPU offload) is ~80 GB/s.
// Apple Metal is handled separately (metalBandwidth) — its memory bandwidth varies
// ~8× across the chip tiers, so a flat number badly mis-estimates throughput; the
// `metal` entry here is only the fallback when GPU cores are unknown.
const BANDWIDTH_BYTES_PER_SEC: Record<HardwareProfile['backend'], number> = {
  cuda: 1.7e12,
  metal: 4.0e11,
  cpu: 8.0e10,
};

// Apple Silicon memory bandwidth scales with GPU core count / chip tier (DD15).
// Ported reference points (GB/s, rounded): base 8-core M-series ≈ 100; Pro 14–16
// ≈ 200; Max 24–32 ≈ 400; Ultra 48–64 ≈ 800. Keyed by an upper-bound core count
// — the first tier whose maxCores ≥ gpuCores wins; above the top tier, the top
// tier's bandwidth applies. EXPLICIT + greppable (cf. QUANT_BPW) — reviewers check
// it against published unified-memory bandwidths.
export const APPLE_BANDWIDTH_BY_CORES: ReadonlyArray<{ maxCores: number; bytesPerSec: number }> = [
  { maxCores: 10, bytesPerSec: 1.0e11 }, // base M-series (~100 GB/s)
  { maxCores: 16, bytesPerSec: 2.0e11 }, // Pro (~200 GB/s)
  { maxCores: 40, bytesPerSec: 4.0e11 }, // Max (~400 GB/s)
  { maxCores: 80, bytesPerSec: 8.0e11 }, // Ultra (~800 GB/s)
];

// Metal memory bandwidth for the throughput estimate. Uses the cores-keyed table
// when the probe parsed a GPU core count, else the flat `metal` fallback.
function metalBandwidth(hw: HardwareProfile): number {
  if (hw.gpuCores && hw.gpuCores > 0) {
    for (const tier of APPLE_BANDWIDTH_BY_CORES) {
      if (hw.gpuCores <= tier.maxCores) return tier.bytesPerSec;
    }
    return APPLE_BANDWIDTH_BY_CORES[APPLE_BANDWIDTH_BY_CORES.length - 1].bytesPerSec;
  }
  return BANDWIDTH_BYTES_PER_SEC.metal;
}

// Resolve the GPU-resident bandwidth for a backend (metal is cores-dependent).
function backendBandwidth(hw: HardwareProfile): number {
  if (hw.backend === 'metal') return metalBandwidth(hw);
  return BANDWIDTH_BYTES_PER_SEC[hw.backend] || BANDWIDTH_BYTES_PER_SEC.cpu;
}

// Default target context when the caller doesn't pin one. A useful coding
// context; large enough that "fits at this ctx" means something.
const DEFAULT_TARGET_CONTEXT = 8192;
// The smallest context we'll still call usable when deciding a verdict.
const MIN_USEFUL_CONTEXT = 4096;

// ── Component estimates ──────────────────────────────────────────────────────

function weightBytes(model: ModelSpec): number {
  // Prefer the real on-disk size when the catalog supplied it.
  if (model.sizeBytes && model.sizeBytes > 0) return model.sizeBytes;
  // bits-per-weight / 8 → bytes-per-weight.
  return model.params * 1e9 * (bitsPerWeight(model.quant) / 8);
}

// KV-cache bytes for a given context length.
function kvCacheBytes(model: ModelSpec, context: number): number {
  const { layers, kvDim } = archHeuristic(model);
  return KV_KV_FACTOR * layers * context * kvDim * KV_BYTES_PER_ELEM;
}

function overheadBytes(weights: number): number {
  return CUDA_FIXED_OVERHEAD_BYTES + weights * WEIGHT_OVERHEAD_FRACTION;
}

// Total VRAM estimate at a context: weights + KV-cache + overhead.
export function estimateVram(model: ModelSpec, context: number): number {
  const weights = weightBytes(model);
  return weights + kvCacheBytes(model, context) + overheadBytes(weights);
}

// Largest context that still fits in `availableVram`, given weights+overhead are
// fixed. Inverts the KV-cache term. Returns 0 if weights+overhead alone overflow.
// Capped at the model's trained contextMax when known.
// Exported for the auto context-sizer (ollamaVram.ts), which sizes the primary
// model against a CUSTOM VRAM budget (total minus a reserve for a local utility
// model) rather than the whole board — so it can't go through scoreFit, which
// always sizes against hw.totalVramBytes.
export function maxContext(model: ModelSpec, availableVram: number): number {
  const weights = weightBytes(model);
  const fixed = weights + overheadBytes(weights);
  const forKv = availableVram - fixed;
  if (forKv <= 0) return 0;
  const { layers, kvDim } = archHeuristic(model);
  const bytesPerToken = KV_KV_FACTOR * layers * kvDim * KV_BYTES_PER_ELEM;
  let ctx = Math.floor(forKv / bytesPerToken);
  if (model.contextMax && model.contextMax > 0) ctx = Math.min(ctx, model.contextMax);
  return Math.max(0, ctx);
}

// Memory-bound decode throughput: bandwidth / bytes-touched-per-token. Each
// decoded token reads (roughly) the full resident weight set once. CPU-offload
// is penalised by routing the spilled fraction through the slow CPU bandwidth.
function estimateThroughput(
  model: ModelSpec,
  hw: HardwareProfile,
  mode: FitMode,
  context: number,
): number {
  const weights = weightBytes(model);
  // Bytes touched per token ≈ resident weights + the active KV-cache slice.
  const bytesPerToken = weights + kvCacheBytes(model, context);
  if (mode === 'gpu') {
    const bw = backendBandwidth(hw);
    return round1((bw / bytesPerToken));
  }
  // cpu-offload: the part that fit on GPU runs at GPU bandwidth, the spill at
  // CPU bandwidth; the slow path dominates. Estimate the resident fraction.
  const gpuBw = hw.totalVramBytes > 0 ? backendBandwidth(hw) : BANDWIDTH_BYTES_PER_SEC.cpu;
  const cpuBw = BANDWIDTH_BYTES_PER_SEC.cpu;
  const onGpu = Math.max(0, Math.min(weights, hw.totalVramBytes - overheadBytes(weights)));
  const onCpu = Math.max(0, weights - onGpu);
  // Harmonic-ish: time = onGpu/gpuBw + onCpu/cpuBw, then tokens/sec = 1/time.
  const timePerToken = onGpu / gpuBw + onCpu / cpuBw;
  if (timePerToken <= 0) return 0;
  return round1(1 / timePerToken);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ── Verdict + score ──────────────────────────────────────────────────────────

function classify(
  fits: boolean,
  headroomRatio: number, // available / needed at the target context
  ctxFits: number,
  mode: FitMode,
): FitVerdict {
  if (mode === 'cpu-offload' || !fits) return 'NO';
  if (ctxFits < MIN_USEFUL_CONTEXT) return 'NO';
  if (headroomRatio >= 1.6) return 'PERFECT';
  if (headroomRatio >= 1.15) return 'GOOD';
  return 'TIGHT';
}

// 0–100 sort score. Folds the verdict tier, VRAM headroom, available context,
// and throughput so the catalog table sorts the "best to run here" model first.
// Deterministic: pure function of the components computed above.
function computeScore(
  verdict: FitVerdict,
  headroomRatio: number,
  ctxFits: number,
  throughputTps: number,
): number {
  if (verdict === 'NO') {
    // Still rank NO rows so cpu-offload-but-usable beats truly-impossible.
    return Math.max(0, Math.min(15, Math.round(throughputTps)));
  }
  // Base tier.
  const base = verdict === 'PERFECT' ? 70 : verdict === 'GOOD' ? 55 : 40;
  // Headroom contributes up to +12 (capped so a huge GPU on a tiny model
  // doesn't dwarf throughput).
  const headroomPts = Math.min(12, Math.max(0, (headroomRatio - 1) * 12));
  // Context contributes up to +10 (32k+ context saturates).
  const ctxPts = Math.min(10, (Math.min(ctxFits, 32768) / 32768) * 10);
  // Throughput contributes up to +8 (≥80 t/s saturates).
  const tpsPts = Math.min(8, (Math.min(throughputTps, 80) / 80) * 8);
  return Math.round(Math.min(100, base + headroomPts + ctxPts + tpsPts));
}

// ── Public entry point ────────────────────────────────────────────────────────
//
// scoreFit — the one function the rest of the Cookbook calls. Deterministic:
// no Date.now / Math.random / system reads. `targetContext` defaults to
// DEFAULT_TARGET_CONTEXT; it's the context we size the verdict against (the
// "does it fit at a useful context?" question), while maxContextThatFits reports
// the ceiling.
export function scoreFit(
  model: ModelSpec,
  hw: HardwareProfile,
  targetContext: number = DEFAULT_TARGET_CONTEXT,
): FitResult {
  const target = clampContext(targetContext, model);
  // Available VRAM for this model = total board VRAM (we assume a dedicated
  // serving box; the operator isn't running a desktop on the 5090 mid-job).
  const available = hw.totalVramBytes;
  const estVramBytes = estimateVram(model, target);
  const ctxFits = maxContext(model, available);

  const fitsOnGpu = available > 0 && estVramBytes <= available;
  const mode: FitMode = fitsOnGpu ? 'gpu' : 'cpu-offload';

  // Headroom at the target context (available / needed). >1 means it fits with
  // room; <1 means it overflows (will be cpu-offload / NO).
  const headroomRatio = estVramBytes > 0 ? available / estVramBytes : 0;

  const throughputTps = estimateThroughput(model, hw, mode, target);
  const verdict = classify(fitsOnGpu, headroomRatio, ctxFits, mode);
  const score = computeScore(verdict, headroomRatio, ctxFits, throughputTps);

  return {
    estVramBytes: Math.round(estVramBytes),
    maxContextThatFits: ctxFits,
    throughputTps,
    mode,
    verdict,
    score,
  };
}

// Clamp the target context to the model's trained max (when known) and a sane
// floor, so a caller asking for 1M context on a 32k model gets sized at 32k.
function clampContext(target: number, model: ModelSpec): number {
  let t = Number.isFinite(target) && target > 0 ? Math.floor(target) : DEFAULT_TARGET_CONTEXT;
  if (model.contextMax && model.contextMax > 0) t = Math.min(t, model.contextMax);
  return Math.max(512, t);
}
