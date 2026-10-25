// ── Cookbook agent-driven recommendation (Workbench Expansion G3) ──
//
// "The layer beyond Odysseus": a top-tier agent (Claude / Codex, via RUN AS)
// reasons over the G1 hardware profile + the G2 fit-filtered candidate set + the
// operator's chosen task profile, and recommends a SPECIFIC model + quant +
// context allocation, with a rationale grounded in the provided fit numbers and a
// ready-to-apply Archon config block.
//
// ── REUSE B2, do NOT fork it ──
// The recommendation is ONE bounded research-style turn. We do NOT spawn a worker
// here, do NOT touch runResearch.ts, and add NO new bounded-turn machinery: we
// build a rich grounding TOPIC string (buildRecommendationTopic, PURE) and hand it
// to the existing runResearch() bounded turn (which enforces the round ceiling,
// writes a `research-<ts>.md` artifact, broadcasts research_started/_progress/
// _complete, and is cancellable via the existing research-cancel path). The
// recommendation artifact IS a research report — it flows through the exact same
// surface. Only the prompt differs.
//
// ── Fence note (CLAUDE.md "hard fences") ──
// G3 is operator-armed, NOT an orchestrator. The agent RECOMMENDS; it does not
// route, does not decide "is this done?", does not select-and-apply autonomously,
// and does not auto-download. The operator picks the task profile + the agent,
// clicks RECOMMEND, reviews the artifact, and applies the config themselves (G4).
// One BOUNDED turn (the B2 ceiling) — NOT a multi-step agent loop, NOT a second
// LLM in the loop, NOT a quality-verdict / done-judge. Reusing B2's bounded turn
// is precisely what keeps it on the right side of the fence; there is no "keep
// researching until satisfied" loop anywhere in this file.

import type {
  CatalogRow,
  HardwareProfile,
} from '@archon/shared';
import {
  COOKBOOK_TASK_PROFILES,
  type CookbookTaskProfile,
} from '@archon/shared';

// How many top fit-filtered candidates to embed in the grounding prompt. Bounds
// the prompt size; the agent recommends FROM these (grounded, not from memory).
const MAX_CANDIDATES = 14;

function gb(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function ctxLabel(tokens: number): string {
  if (!tokens || tokens <= 0) return '—';
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}k`;
  return String(tokens);
}

// Human-readable label + the prompt-bias sentence for each task profile. Kept
// here (not in the protocol) because it is prompt-shaping text, not a contract.
const PROFILE_GUIDANCE: Record<CookbookTaskProfile, { label: string; bias: string }> = {
  coding: {
    label: 'Coding assistant',
    bias: 'Favour coder-tuned models (Qwen-Coder, DeepSeek-Coder, CodeLlama, etc.) at a quant that keeps quality high while fitting comfortably. Prefer GOOD/PERFECT fit with enough headroom for a useful working context.',
  },
  'fast-autocomplete': {
    label: 'Fast autocomplete',
    bias: 'Favour SMALL, HIGH-throughput models — latency dominates. Pick the smallest capable model and the quant with the best tokens/sec, even if a larger model would score marginally higher on the catalog SCORE. A modest context is acceptable.',
  },
  'long-context': {
    label: 'Long-context analysis',
    bias: 'Maximise the context window that still FITS on the rig (maxContextThatFits) while keeping a GOOD/PERFECT verdict. Trade some throughput for the largest usable context; a smaller quant that buys more KV-cache headroom is acceptable.',
  },
  vision: {
    label: 'Vision (multimodal)',
    bias: 'Recommend ONLY vision-capable / multimodal models (the candidate set is pre-filtered to vision tasks). Note that llama.cpp needs an mmproj projector for vision; flag it in the config block.',
  },
  general: {
    label: 'General-purpose',
    bias: 'Recommend a well-rounded instruct model with the best overall balance of capability, fit headroom, and throughput on this rig.',
  },
};

// ── Task-profile fit-filter (PURE) ────────────────────────────────────────────
//
// Narrows the G2 candidate rows per task profile BEFORE they are embedded in the
// prompt, so the agent reasons over a profile-appropriate shortlist. Deterministic
// (no clock, no random). Always drops NO-verdict rows (the rig can't run them).
// Re-sorts where the profile's priority differs from the catalog's score sort
// (e.g. fast-autocomplete sorts by throughput). Falls back to the unfiltered
// fitting rows when a strict filter would empty the list, so the agent always has
// something to reason over.
export function filterCandidatesForProfile(
  rows: CatalogRow[],
  profile: CookbookTaskProfile,
): CatalogRow[] {
  const fitting = rows.filter((r) => r.fit.verdict !== 'NO');
  const base = fitting.length ? fitting : rows.slice();

  const codingNameRe = /(cod(?:e|er|ing)|deepseek|qwen.*coder|starcoder|codestral)/i;

  let picked: CatalogRow[];
  switch (profile) {
    case 'coding':
      picked = base.filter((r) => codingNameRe.test(`${r.repo} ${r.name}`));
      break;
    case 'fast-autocomplete':
      // Small + fast: drop the big/slow rows, then sort by throughput desc. "Small"
      // is params <= 14B when params are known; rows with unknown params (0) are
      // kept (size unknown ≠ disqualified). The throughput re-sort is the bias.
      picked = base
        .filter((r) => r.params === 0 || r.params <= 14)
        .slice()
        .sort((a, b) => b.fit.throughputTps - a.fit.throughputTps);
      break;
    case 'long-context':
      // Largest usable context first; the agent picks from the top of this list.
      picked = base
        .slice()
        .sort((a, b) => b.fit.maxContextThatFits - a.fit.maxContextThatFits);
      break;
    case 'vision':
      // Vision rows surface via the task facet (pipeline_tag) or a vision-y name.
      picked = base.filter(
        (r) =>
          /vision|image|multimodal|vl\b|-vl|llava|moondream|minicpm-v/i.test(`${r.repo} ${r.name}`) ||
          /image|vision|visual|multimodal/i.test(r.task || ''),
      );
      break;
    case 'general':
    default:
      picked = base;
      break;
  }

  // If a strict filter emptied the shortlist, fall back to the fitting rows so the
  // agent still has grounded candidates (it can then say "nothing ideal fits").
  const result = picked.length ? picked : base;
  return result.slice(0, MAX_CANDIDATES);
}

function hardwareLine(hw: HardwareProfile): string {
  if (hw.gpus.length) {
    const cards = hw.gpus.map((g) => `${g.name} (${gb(g.vramBytes)})`).join(', ');
    return `${cards} — total VRAM ${gb(hw.totalVramBytes)}; system RAM ${gb(hw.systemRamBytes)}; ${hw.cores} cores; backend ${hw.backend}.`;
  }
  return `No CUDA GPU detected — backend ${hw.backend}; system RAM ${gb(hw.systemRamBytes)}; ${hw.cores} cores.${hw.note ? ` (${hw.note})` : ''}`;
}

function candidateTable(rows: CatalogRow[]): string {
  if (!rows.length) return '(no candidates fit this rig for this task profile)';
  const header = '| # | MODEL | SOURCE | PARAM | QUANT | EST VRAM | MAX CTX | t/s | MODE | FIT | SCORE |';
  const sep = '|---|-------|--------|-------|-------|----------|--------|-----|------|-----|-------|';
  const lines = rows.map((r, i) => {
    const param = r.params > 0 ? `${r.params}B${r.moe ? ' MoE' : ''}` : '?';
    return `| ${i + 1} | ${r.repo} | ${r.source} | ${param} | ${r.quant} | ${gb(r.fit.estVramBytes)} | ${ctxLabel(r.fit.maxContextThatFits)} | ${r.fit.throughputTps.toFixed(1)} | ${r.fit.mode} | ${r.fit.verdict} | ${r.fit.score} |`;
  });
  return [header, sep, ...lines].join('\n');
}

// ── The PURE topic builder ────────────────────────────────────────────────────
//
// Given the hardware profile + the (already fit-filtered) candidate rows + the
// task profile, produce the full grounding+instruction text handed to the B2
// bounded turn. DETERMINISTIC: identical inputs → byte-identical output. No clock,
// no random, no I/O. This is the unit-tested core (scripts/smoke/cookbook-recommend.ts).
//
// The output instructs the agent to return a STRUCTURED recommendation: the single
// best model + quant, the recommended context, expected t/s + mode, a rationale
// grounded in the PROVIDED fit numbers, and a ready-to-apply Archon config block
// (a llama.cpp catalog entry for HF/GGUF picks, an `ollama pull` line for Ollama
// picks). Web search is allowed ONLY to confirm current facts; the recommendation
// must come from the PROVIDED candidates. The operator applies the result.
export function buildRecommendationTopic(
  hw: HardwareProfile,
  candidates: CatalogRow[],
  taskProfile: CookbookTaskProfile,
  maxRounds: number,
): string {
  const guidance = PROFILE_GUIDANCE[taskProfile] ?? PROFILE_GUIDANCE.general;
  return `You are a LOCAL-MODEL SELECTION agent for Arco's Cookbook. In ONE bounded turn, recommend the single best local LLM for the operator's task on THEIR hardware, choosing from the pre-scored candidate set below.

TASK PROFILE: ${guidance.label} (${taskProfile})
${guidance.bias}

DETECTED SERVING HARDWARE (the rig you must fit the model on):
${hardwareLine(hw)}

FIT-FILTERED CANDIDATES (already scored against the rig above by Arco's fit engine — recommend FROM THESE, do not invent models that aren't listed):

${candidateTable(candidates)}

Column meanings: EST VRAM = estimated VRAM at the listed context; MAX CTX = the largest context that still fits in VRAM; t/s = a coarse throughput estimate; MODE = gpu (fully VRAM-resident) or cpu-offload (slow); FIT = PERFECT/GOOD/TIGHT/NO verdict; SCORE = 0–100 sort key. These numbers are your PRIMARY grounding — base your rationale on them.

WEB SEARCH: optional, and ONLY to confirm current facts about a candidate you are already considering (e.g. "is this model still recommended for coding in 2026?", a known benchmark, a quant-quality caveat). Do NOT use it to discover models outside the candidate set. HARD STOP: at most ${maxRounds} web-search/fetch rounds (the server enforces this ceiling mechanically where it can; your own "sufficient" signal is advisory — you may stop earlier, never go past the cap).

YOU ARE RECOMMENDING ONLY. You are NOT downloading, installing, configuring, or selecting-and-applying anything. The operator reviews your recommendation and applies it themselves (Arco's Cookbook G4 step). Do NOT claim to have downloaded or configured a model.

Return your answer as markdown with EXACTLY these sections:

## Recommendation
The single best pick as **<model repo or ollama name> @ <QUANT>** on one line, then a one-sentence why.

## Configuration
- **Recommended context:** <N tokens> (must be ≤ the candidate's MAX CTX above).
- **Expected throughput:** <t/s> running in <gpu | cpu-offload> mode.
- **Serving backend:** llama.cpp (for a Hugging Face GGUF pick) or Ollama (for an Ollama-library pick).

## Rationale
Why this pick beats the runners-up FOR THIS TASK PROFILE, grounded explicitly in the fit numbers above (VRAM headroom, MAX CTX, t/s, verdict, score). Name at least one runner-up and say why it lost.

## Apply (ready-to-paste Archon config)
A fenced code block the operator can apply directly:
- For a Hugging Face GGUF pick, a llama.cpp catalog entry (this is the shape Arco's ~/.archon/llamacpp.json "models" array takes — the operator pastes it there, then fills in the real downloaded ggufPath in G4):
\`\`\`json
{
  "alias": "<short-alias>",
  "ggufPath": "/path/to/<file>.gguf",
  "ctxSize": <recommended context>,
  "ngl": 999,
  "capabilities": { "tools": true, "vision": <true|false>, "thinking": <true|false> }
}
\`\`\`
  (Add "mmprojPath" for a vision pick.)
- For an Ollama-library pick, the pull command instead:
\`\`\`bash
ollama pull <model:tag>
\`\`\`

End with a one-line note reminding the operator that Arco's Cookbook download/configure step (G4) performs the actual fetch + registration once they confirm — nothing has been changed on disk by this recommendation.`;
}
