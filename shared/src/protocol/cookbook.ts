// ── Cookbook — intelligent local-LLM management (Workbench Expansion Part G) ──
//
// G1 surface: TYPES + CONSTS ONLY. No logic lives here (the fit/scoring math is
// in server/src/cookbook/fit.ts; the hardware probe in hardware.ts). These shapes
// are the contract the later phases build on: G2 (catalog search) crosses each
// model variant with a HardwareProfile to produce FitResults; G3 (agent rec)
// grounds on the same profile + scored candidates; G4 (download/register) adds a
// download-progress protocol to this same file.
//
// Grounding (don't lose it): the serving box is ONE NVIDIA 5090 (32 GB VRAM)
// served via llama.cpp (GGUF) + Ollama — not vLLM/AWQ. The fit engine sizes
// everything off the *detected* hardware (probeHardware) automatically; the
// simulation presets below let the operator preview a hypothetical rig.

// One GPU as reported by the hardware probe (nvidia-smi on Linux, operator-set /
// empty on macOS-Metal / CPU). `vramBytes` is total board VRAM, not free.
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
// the CPU-only / system-RAM-only box; 1/2/4/8 GPU are N × a 5090-class 32 GB card.
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
export type CatalogSource = 'hf' | 'ollama';

// A normalized model from either source, BEFORE per-variant fit scoring. One
// entry can carry several quant variants (e.g. a GGUF repo with Q4_K_M / Q5_K_M
// / Q8_0 files) — the catalog crosses each variant with scoreFit into a row.
//   • repo  — the source identifier (HF "owner/name", or the Ollama model name).
//   • name  — a short display name (the repo's last path segment / model name).
//   • params — parameter count in BILLIONS (best-effort parse from the name).
//   • quantVariants — the GGUF quant tags offered (Q4_K_M, Q5_K_M, …). For
//     Ollama (which abstracts quant behind a tag) this is the tag's effective
//     quant or a default.
//   • sizeByQuant — PER-VARIANT on-disk GGUF size (bytes) keyed by quant tag,
//     when the HF sibling list reported it. The fit engine prefers this exact
//     size over the params×bpw estimate. Per-variant (not a single repo size)
//     so a Q4 row isn't mis-scored with the Q8 file's bytes.
//   • source / task — provenance + a coarse task facet (text-generation, etc.).
//   • moe — mixture-of-experts flag (drives the +MoE badge in the table).
export interface CatalogModel {
  repo: string;
  name: string;
  params: number;
  quantVariants: string[];
  sizeByQuant?: Record<string, number>;
  source: CatalogSource;
  task?: string;
  moe?: boolean;
}

// One scored row in the fit table — a (model, quant) pair crossed with the
// detected/simulated hardware. `model` carries the display fields; `quant` is
// the specific variant this row scores; `fit` is G1's FitResult. The client
// renders the screenshot columns from these: FIT · MODEL (+MoE) · PARAM · QUANT
// · VRAM · CTX · SPEED · SCORE · MODE.
export interface CatalogRow {
  repo: string;
  name: string;
  params: number;
  quant: string;
  sizeBytes?: number;
  source: CatalogSource;
  task?: string;
  moe?: boolean;
  // The G1 ModelSpec this row was scored from (so the client can show the exact
  // inputs / G4 can reuse it). Mirrors `params`/`quant`/`sizeBytes` above.
  spec: ModelSpec;
  fit: FitResult;
}

// The operator's search/filter inputs. All optional — an empty query lists the
// trending-that-fits feed. `quant` narrows to a single quant family (rows whose
// quant tag matches are kept). `task` narrows by the coarse task facet. `sim`
// scores against a simulated rig instead of the detected one.
export interface CatalogQuery {
  text?: string;
  quant?: string;
  task?: string;
  sim?: HardwareSimPreset;
}

// The catalog endpoint's response. `rows` are sorted by score desc. `hardware`
// is the profile the rows were scored against (detected or simulated). `trending`
// is the "models that fit your hardware" feed (HF trending filtered to fitting
// rows), present when no text query narrowed the search. `sources` reports which
// upstream sources answered (a down source is false, not an error). `note`
// carries a human-readable degradation reason when a source failed.
export interface CatalogResponse {
  rows: CatalogRow[];
  hardware: HardwareProfile;
  trending?: CatalogRow[];
  sources: { hf: boolean; ollama: boolean };
  note?: string;
}

// ── G3 — Agent-driven recommendation (the layer beyond Odysseus) ─────────────
//
// TYPES ONLY (same fence as G1/G2). The recommendation REUSES the B2 Deep-Research
// bounded turn end-to-end: the request below grounds a research turn on the G1
// profile + the G2 fit-filtered candidates + a task profile, and the lifecycle
// flows through the EXISTING research_started / research_progress /
// research_complete events + the `research-<ts>.md` artifact. There is no
// separate recommendation-result message — the artifact IS the recommendation.
// The topic-builder (server/src/cookbook/recommend.ts) is PURE; only the bounded
// LLM turn is non-deterministic (and capped).
//
// Fence: operator-armed, NOT an orchestrator. The agent RECOMMENDS; it does not
// route, decide "done?", select-and-apply, or auto-download. ONE bounded turn —
// not an agent loop, not a second-LLM judge. The operator reviews the artifact
// and applies the config themselves (G4).

// The five task profiles the operator picks from. Each biases the fit-filter that
// narrows the candidate set + the grounding prompt:
//   • coding            — coder-tuned models, GOOD/PERFECT fit with working headroom.
//   • fast-autocomplete — small + highest throughput; latency dominates.
//   • long-context      — maximise the context that still fits.
//   • vision            — vision-capable / multimodal models only.
//   • general           — best overall balance.
export type CookbookTaskProfile =
  | 'coding'
  | 'fast-autocomplete'
  | 'long-context'
  | 'vision'
  | 'general';

export const COOKBOOK_TASK_PROFILES: readonly CookbookTaskProfile[] = [
  'coding',
  'fast-autocomplete',
  'long-context',
  'vision',
  'general',
] as const;

// Dispatch a Cookbook recommendation. The server fit-filters the G2 candidates for
// the task profile, builds the grounding topic (recommend.ts), and runs it through
// the B2 bounded turn — so the response arrives via the research_* events, NOT a
// dedicated reply. Cancellable via the existing cancel_research path (the
// underlying run is an ordinary research run with a research-style researchId).
export interface CookbookRecommendRequestMessage {
  type: 'cookbook_recommend_request';
  workflowId: string;
  // Which agent runs the bounded turn (the RUN AS picker fills this — Claude or
  // Codex on the operator's subscription, exactly like the reviewer / researcher).
  researcher: {
    provider: import('./providers.js').ProviderName;
    model: import('./providers.js').ModelName;
    effort: import('./providers.js').EffortLevel;
    providerAccountRef?: string;
  };
  // The task profile that biases the fit-filter + the prompt.
  taskProfile: CookbookTaskProfile;
  // Hard round ceiling for confirm-the-facts web search. Clamped server-side to
  // [1, RESEARCH_MAX_ROUNDS_CEILING] (same ceiling as Deep Research).
  maxRounds: number;
  // Optional free-text narrowing for the catalog search the server runs to build
  // the candidate set (e.g. "qwen coder"). Empty → the trending-that-fits feed.
  query?: string;
  // Score against a simulated rig instead of the detected one (mirrors G2).
  sim?: HardwareSimPreset;
}

// ── G4 — Download + run + auto-register ──────────────────────────────────────
//
// TYPES ONLY (same fence as G1–G3). The download/register LOGIC lives in
// server/src/cookbook/install.ts; the WS handlers in ws/workflowHandlers.ts.
// These shapes are the contract for the operator-initiated download lifecycle.
//
// FENCE (four-question test): every download is operator-initiated (a DOWNLOAD
// click, or a G3 recommendation the operator confirms) — NOTHING here auto-pulls.
// The lifecycle is bounded (one fetch), visible (start/progress/done/refused/
// cancelled persist to events.jsonl via the workflowId), and reversible (the
// operator deletes the file + removes the catalog entry). HF weights land ONLY
// in ~/.archon/models/ (path-confined, sanitized basename); a disk pre-flight
// REFUSES an oversized pull before a byte downloads; a cancel/error deletes the
// partial file and writes NO catalog entry.

// Where the model comes from. 'hf' = a Hugging Face GGUF repo (downloaded into
// the models dir + auto-registered as a llama.cpp catalog entry); 'ollama' = an
// Ollama library tag (pulled via /api/pull; Ollama auto-discovers it — no
// catalog write).
export type CookbookDownloadSource = 'hf' | 'ollama';

// Dispatch a download. Operator-initiated only. For an HF pick, `repo` + `quant`
// name the GGUF (the server re-queries the repo for the exact filename); `alias`
// / `ctxSize` / `capabilities` seed the auto-registered catalog entry. For an
// Ollama pick, `name` is the pullable tag. `confirm` is set when the operator
// has acknowledged a disk pre-flight warning shown client-side (the server still
// runs its own authoritative pre-flight and refuses an oversized pull).
export interface CookbookDownloadRequestMessage {
  type: 'cookbook_download_request';
  workflowId: string;
  source: CookbookDownloadSource;
  // HF pick.
  repo?: string;
  quant?: string;
  alias?: string;
  ctxSize?: number;
  capabilities?: { tools?: boolean; vision?: boolean; thinking?: boolean };
  // Ollama pick.
  name?: string;
  // Operator acknowledged the client-side pre-flight (advisory; the server's
  // own pre-flight is authoritative).
  confirm?: boolean;
}

// Cancel an in-flight download by its downloadId (mirrors cancel_research). The
// server aborts the fetch and deletes the partial file.
export interface CookbookCancelDownloadMessage {
  type: 'cookbook_cancel_download';
  workflowId: string;
  downloadId: string;
}

// The download lifecycle phase.
//   • preflight   — running the size-vs-free-disk check (size + free surfaced).
//   • downloading — bytes flowing (receivedBytes / totalBytes).
//   • registering — writing the llama.cpp catalog entry (HF only).
//   • done        — fully downloaded + registered (HF) / pulled (Ollama).
//   • error       — failed (message carries the reason; a disk refusal is an
//                   error with freeBytes/totalBytes populated).
//   • cancelled   — operator cancelled; the partial file was deleted.
export type CookbookDownloadPhase =
  | 'preflight'
  | 'downloading'
  | 'registering'
  | 'done'
  | 'error'
  | 'cancelled';

// Progress / lifecycle broadcast for a download. `downloadId` correlates the
// stream + the cancel. Persisted to events.jsonl (the workflowId is the key).
// `alias` is the registered catalog alias on a successful HF download (so the
// client can point the operator at CONFIG).
export interface CookbookDownloadProgressMessage {
  type: 'cookbook_download_progress';
  workflowId: string;
  downloadId: string;
  phase: CookbookDownloadPhase;
  source: CookbookDownloadSource;
  receivedBytes?: number;
  totalBytes?: number;
  freeBytes?: number;
  message?: string;
  // Set on phase 'done' for an HF pick — the alias the model registered under.
  alias?: string;
}
