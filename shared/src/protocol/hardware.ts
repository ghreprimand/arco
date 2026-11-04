// Hardware probe and model-fit shapes. Types and constants only; the probe is
// server/src/hardware/probe.ts and the fit math server/src/hardware/fit.ts.

export interface GpuInfo {
  name: string;
  vramBytes: number;
}

// Detected (or simulated) serving hardware. Produced by probeHardware() /
// simulatedProfile(); consumed by scoreFit(). `totalVramBytes` is the sum of
// per-GPU VRAM (0 on a CPU/Metal-only box). `backend` drives the bytes-per-weight
// and overhead assumptions downstream.
export interface HardwareProfile {
  // Empty on a box with no CUDA GPU (macOS Metal fallback / pure CPU).
  gpus: GpuInfo[];
  totalVramBytes: number;
  systemRamBytes: number;
  // Logical core count (os.cpus().length).
  cores: number;
  backend: 'cuda' | 'metal' | 'cpu';
  // GPU core count on Apple Silicon (parsed from `system_profiler SPDisplaysDataType`).
  // Drives the metal memory-bandwidth estimate (APPLE_BANDWIDTH_BY_CORES) — an
  // 8-core base chip is ~100 GB/s, a 64-core Ultra ~800 GB/s. Absent on CUDA /
  // CPU / Intel-Mac boxes (only Apple-Silicon GPUs report a core count here).
  gpuCores?: number;
  // Set on the macOS / no-nvidia-smi fallback to explain why gpus is empty
  // (operator can set VRAM by hand in a later phase). Absent on a clean cuda probe.
  note?: string;
}

// Hardware-simulation presets — "what if I had a different rig?" previews. RAM is
// the CPU-only / system-RAM-only box; 1/2/4/8 GPU are N × a simulated 32 GB device.
// Lets the operator score a model against a hypothetical rig without owning it.
export type HardwareSimPreset = 'ram' | 'gpu1' | 'gpu2' | 'gpu4' | 'gpu8';

export const HARDWARE_SIM_PRESETS: readonly HardwareSimPreset[] = [
  'ram',
  'gpu1',
  'gpu2',
  'gpu4',
  'gpu8',
] as const;

// A model to score. `params` is the parameter count in BILLIONS (e.g. 32 for a
// 32B model). `quant` is the GGUF quant tag (Q4_K_M, Q5_K_M, Q8_0, F16, …) — the
// fit engine maps it to bytes-per-weight via QUANT_BPW. `arch` is a coarse family
// hint used for KV-cache layer/dim heuristics. Optional `sizeBytes` (the actual
// on-disk GGUF size, when known from the catalog) and `contextMax` (the model's
// trained context window) refine the estimate when present.
export interface ModelSpec {
  // Parameter count in billions.
  params: number;
  quant: string;
  // Coarse architecture family. 'moe' flags a mixture-of-experts model (only the
  // active experts sit in the hot path, but all weights must be resident for
  // llama.cpp). Unknown / unset falls back to a dense-transformer heuristic.
  arch?: 'llama' | 'qwen' | 'gemma' | 'mistral' | 'phi' | 'moe' | 'other';
  // Actual GGUF file size in bytes, when the catalog knows it. Overrides the
  // params×bpw weight estimate when present (more accurate than computing it).
  sizeBytes?: number;
  // The model's trained max context (tokens), when known. Caps maxContextThatFits.
  contextMax?: number;
}

// FIT verdict — the green/amber/red badge from the Cookbook screenshots.
//   PERFECT — fits fully on GPU with comfortable headroom at a useful context.
//   GOOD    — fits on GPU at a useful context.
//   TIGHT   — fits but with little headroom / a reduced context.
//   NO      — does not fit on GPU at any useful context (cpu-offload at best).
export type FitVerdict = 'PERFECT' | 'GOOD' | 'TIGHT' | 'NO';

// Serving mode the fit implies. 'gpu' = fully VRAM-resident; 'cpu-offload' = part
// of the weights spill to system RAM (llama.cpp -ngl < all), which is slow.
export type FitMode = 'gpu' | 'cpu-offload';

// Output of scoreFit(). `estVramBytes` is the estimated VRAM needed for weights +
// KV-cache + overhead at the chosen context. `maxContextThatFits` is the largest
// context (tokens) that still fits in available VRAM (capped at contextMax).
// `throughputTps` is a coarse tokens/sec estimate. `score` is a 0–100 number for
// sorting the catalog table (higher is better).
export interface FitResult {
  estVramBytes: number;
  maxContextThatFits: number;
  throughputTps: number;
  mode: FitMode;
  verdict: FitVerdict;
  // 0–100; sort key for the catalog. Folds verdict + headroom + throughput.
  score: number;
}

// ── G2 — Catalog search (HF Hub + Ollama library) + fit table ────────────────
//
// TYPES ONLY (the same fence as G1): the catalog fetch/normalize/score logic
// lives in server/src/cookbook/catalog.ts, the route in
// server/src/http/cookbookRoutes.ts. These shapes are the contract between that
// route and the client's CookbookModal. G2 is READ-ONLY SEARCH — no download,
// no pull, no disk write, no registration (that's G4); the modal's
// Download/Run/Configure buttons are inert placeholders.

// Where a catalog entry came from. 'hf' = a GGUF repo on the Hugging Face Hub
// (served via llama.cpp); 'ollama' = a pullable name in the Ollama library.
