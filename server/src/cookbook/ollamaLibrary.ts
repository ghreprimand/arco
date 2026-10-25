// ── Curated Ollama library (Workbench Expansion G2) ──
//
// A bundled, operator-readable reference list of canonical Ollama-pullable models
// for a single-GPU GGUF coding rig (the operator's 5090 / 32 GB; qwen + gemma class).
//
// WHY THIS IS STATIC (not a live fetch): Ollama has NO official keyless "list the
// library" JSON API. The only live options are scraping ollama.com/library (HTML,
// fragile) or trusting a third-party community mirror — a silent dependency on an
// unknown endpoint that could vanish or serve tampered data. Per Arco's fence
// posture (deterministic, operator-can-read-the-rules, no silent external
// dependency), the Ollama side is instead this curated manifest: every entry is a
// real `ollama pull <name>` target, the list is in the repo where the operator can
// read and extend it, and scoring it is fully deterministic. Hugging Face (the
// official, keyless Hub API) stays the live breadth source in catalog.ts.
//
// `params` is TOTAL parameters in billions — set explicitly because the size tag
// in a model name understates MoE totals (e.g. mixtral:8x7b is ~47B total, not 7B;
// qwen3-coder:30b is 30B total / 3B active). The fit engine needs the resident
// total, since llama.cpp keeps all expert weights in memory. `moe` flags those.
// Ollama serves Q4_K_M by default, so catalog.ts scores these at Q4_K_M.
//
// To extend: add an entry below. There is no other step — G4 will `ollama pull`
// whatever name appears here.

export interface OllamaLibraryEntry {
  // The pullable `ollama pull <name>` target (family:tag).
  name: string;
  // Total parameters in billions (explicit; covers MoE where the tag understates).
  params: number;
  // Coarse task facet (all of these are text-generation models).
  task?: string;
  // True for mixture-of-experts (all experts must be resident under llama.cpp).
  moe?: boolean;
}

const TG = 'text-generation';

export const OLLAMA_LIBRARY: OllamaLibraryEntry[] = [
  // ── Coding-focused ──
  { name: 'qwen2.5-coder:0.5b', params: 0.5, task: TG },
  { name: 'qwen2.5-coder:1.5b', params: 1.5, task: TG },
  { name: 'qwen2.5-coder:3b', params: 3, task: TG },
  { name: 'qwen2.5-coder:7b', params: 7, task: TG },
  { name: 'qwen2.5-coder:14b', params: 14, task: TG },
  { name: 'qwen2.5-coder:32b', params: 32, task: TG },
  { name: 'qwen3-coder:30b', params: 30, task: TG, moe: true },
  { name: 'deepseek-coder-v2:16b', params: 16, task: TG, moe: true },
  { name: 'codellama:7b', params: 7, task: TG },
  { name: 'codellama:13b', params: 13, task: TG },
  { name: 'codellama:34b', params: 34, task: TG },
  { name: 'codegemma:2b', params: 2, task: TG },
  { name: 'codegemma:7b', params: 7, task: TG },
  { name: 'starcoder2:3b', params: 3, task: TG },
  { name: 'starcoder2:7b', params: 7, task: TG },
  { name: 'starcoder2:15b', params: 15, task: TG },
  // ── Reasoning ──
  { name: 'deepseek-r1:7b', params: 7, task: TG },
  { name: 'deepseek-r1:8b', params: 8, task: TG },
  { name: 'deepseek-r1:14b', params: 14, task: TG },
  { name: 'deepseek-r1:32b', params: 32, task: TG },
  // ── General-purpose ──
  { name: 'qwen3:8b', params: 8, task: TG },
  { name: 'qwen3:14b', params: 14, task: TG },
  { name: 'qwen3:32b', params: 32, task: TG },
  { name: 'gemma2:2b', params: 2, task: TG },
  { name: 'gemma2:9b', params: 9, task: TG },
  { name: 'gemma2:27b', params: 27, task: TG },
  { name: 'gemma3:1b', params: 1, task: TG },
  { name: 'gemma3:4b', params: 4, task: TG },
  { name: 'gemma3:12b', params: 12, task: TG },
  { name: 'gemma3:27b', params: 27, task: TG },
  { name: 'llama3.1:8b', params: 8, task: TG },
  { name: 'llama3.2:1b', params: 1, task: TG },
  { name: 'llama3.2:3b', params: 3, task: TG },
  { name: 'llama3.3:70b', params: 70, task: TG },
  { name: 'mistral:7b', params: 7, task: TG },
  { name: 'mistral-nemo:12b', params: 12, task: TG },
  { name: 'mistral-small:24b', params: 24, task: TG },
  { name: 'mixtral:8x7b', params: 47, task: TG, moe: true },
  { name: 'phi4:14b', params: 14, task: TG },
  { name: 'phi3.5:3.8b', params: 3.8, task: TG },
];
