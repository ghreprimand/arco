// Workbench Expansion G3 — Cookbook agent-driven recommendation smoke.
//
// CENTERED ON THE DETERMINISTIC CORE. Stubbing a live LLM turn is impractical in
// a unit smoke (and the bounded research turn is exercised by smoke:research), so
// this asserts the PURE pieces G3 adds — buildRecommendationTopic +
// filterCandidatesForProfile — which are what keep the recommendation grounded and
// on the right side of the fence. NO network, NO server, NO WS.
//
// Asserts:
//   1. The topic embeds the detected hardware, the candidate rows, and the task profile.
//   2. The required output STRUCTURE is requested (model+quant, context, t/s+mode,
//      rationale, a ready-to-apply config block).
//   3. The bounded-rounds + operator-applies (recommend-only, no download) framing is present.
//   4. Determinism — identical inputs → byte-identical topic.
//   5. The fit-filter narrows per task profile (fast-autocomplete drops the big/slow
//      rows; vision keeps only vision rows; coding keeps coder models; NO-verdict
//      rows are always dropped).
//
// Run: npm run smoke:cookbook-recommend  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import {
  buildRecommendationTopic,
  filterCandidatesForProfile,
} from '../../server/src/cookbook/recommend.js';
import type { CatalogRow, HardwareProfile, FitResult } from '@archon/shared';

const GB = 1024 * 1024 * 1024;

const rig5090: HardwareProfile = {
  gpus: [{ name: 'NVIDIA GeForce RTX 5090', vramBytes: 32 * GB }],
  totalVramBytes: 32 * GB,
  systemRamBytes: 128 * GB,
  cores: 32,
  backend: 'cuda',
};

function fit(p: Partial<FitResult>): FitResult {
  return {
    estVramBytes: 18 * GB,
    maxContextThatFits: 32768,
    throughputTps: 40,
    mode: 'gpu',
    verdict: 'GOOD',
    score: 70,
    ...p,
  };
}

function row(r: Partial<CatalogRow> & { repo: string; quant: string }): CatalogRow {
  return {
    name: r.repo.split('/').pop() || r.repo,
    params: r.params ?? 7,
    source: r.source ?? 'hf',
    spec: { params: r.params ?? 7, quant: r.quant },
    fit: r.fit ?? fit({}),
    ...r,
  } as CatalogRow;
}

// A fixed, fit-scored candidate set spanning the profiles: a fast small coder, a
// big slow coder, a long-context general model, a vision model, and a NO row that
// must always be dropped.
const candidates: CatalogRow[] = [
  row({ repo: 'Qwen/Qwen2.5-Coder-7B-GGUF', params: 7, quant: 'Q4_K_M', fit: fit({ throughputTps: 90, maxContextThatFits: 16384, verdict: 'PERFECT', score: 88 }) }),
  row({ repo: 'Qwen/Qwen2.5-Coder-32B-GGUF', params: 32, quant: 'Q4_K_M', fit: fit({ throughputTps: 22, maxContextThatFits: 24576, verdict: 'GOOD', score: 75 }) }),
  row({ repo: 'meta/Llama-3.1-8B-GGUF', params: 8, quant: 'Q5_K_M', task: 'text-generation', fit: fit({ throughputTps: 60, maxContextThatFits: 131072, verdict: 'GOOD', score: 72 }) }),
  row({ repo: 'Qwen/Qwen2-VL-7B-GGUF', params: 7, quant: 'Q4_K_M', task: 'image-text-to-text', fit: fit({ throughputTps: 35, maxContextThatFits: 8192, verdict: 'GOOD', score: 65 }) }),
  row({ repo: 'unsloth/Qwen3-235B-GGUF', params: 235, quant: 'Q4_K_M', moe: true, fit: fit({ throughputTps: 3, maxContextThatFits: 0, verdict: 'NO', mode: 'cpu-offload', score: 8 }) }),
];

async function main() {
  await step('topic embeds hardware + candidates + task profile', () => {
    const topic = buildRecommendationTopic(rig5090, candidates.slice(0, 3), 'coding', 4);
    assert(topic.includes('RTX 5090'), 'hardware (GPU name) embedded');
    assert(topic.includes('32.0 GB'), 'total VRAM embedded');
    assert(topic.includes('Qwen/Qwen2.5-Coder-7B-GGUF'), 'candidate repo embedded');
    assert(topic.includes('Q4_K_M'), 'candidate quant embedded');
    assert(/coding/i.test(topic) && /Coding assistant/.test(topic), 'task profile embedded');
  });

  await step('topic requests the required output structure', () => {
    const topic = buildRecommendationTopic(rig5090, candidates, 'coding', 4);
    assert(/## Recommendation/.test(topic), 'asks for a Recommendation section (model+quant)');
    assert(/Recommended context/i.test(topic), 'asks for recommended context');
    assert(/throughput/i.test(topic) && /gpu|cpu-offload/i.test(topic), 'asks for expected t/s + mode');
    assert(/## Rationale/.test(topic), 'asks for a grounded rationale');
    assert(/## Apply/.test(topic) && /ggufPath/.test(topic) && /ollama pull/.test(topic), 'asks for a ready-to-apply config block (both backends)');
  });

  await step('topic carries the bounded + recommend-only framing (fence)', () => {
    const topic = buildRecommendationTopic(rig5090, candidates, 'coding', 3);
    assert(/at most 3 web-search/.test(topic), 'bounded-rounds cap stated with the passed value');
    assert(/HARD STOP/.test(topic), 'hard-stop framing present');
    assert(/RECOMMENDING ONLY/.test(topic), 'recommend-only framing present');
    assert(/NOT downloading|not.*configuring|do not claim to have downloaded/i.test(topic), 'no-download / operator-applies framing present');
    assert(/recommend FROM THESE|do not invent/i.test(topic), 'grounded-to-candidates framing present');
  });

  await step('topic is deterministic (identical inputs → identical text)', () => {
    const a = buildRecommendationTopic(rig5090, candidates, 'long-context', 5);
    const b = buildRecommendationTopic(rig5090, candidates, 'long-context', 5);
    assertEq(a, b, 'two identical calls must match exactly');
  });

  await step('fit-filter always drops NO-verdict rows', () => {
    for (const p of ['coding', 'fast-autocomplete', 'long-context', 'vision', 'general'] as const) {
      const filtered = filterCandidatesForProfile(candidates, p);
      assert(!filtered.some((r) => r.fit.verdict === 'NO'), `${p}: NO rows must be dropped`);
    }
  });

  await step('fast-autocomplete drops the big/slow row + sorts by throughput', () => {
    const filtered = filterCandidatesForProfile(candidates, 'fast-autocomplete');
    assert(!filtered.some((r) => r.params > 14), 'big (>14B) models dropped');
    // Sorted by throughput desc — the 7B coder (90 t/s) leads.
    assert(filtered[0].fit.throughputTps >= filtered[filtered.length - 1].fit.throughputTps, 'sorted by throughput desc');
    assertEq(filtered[0].repo, 'Qwen/Qwen2.5-Coder-7B-GGUF', 'highest-t/s row leads');
  });

  await step('coding keeps only coder models', () => {
    const filtered = filterCandidatesForProfile(candidates, 'coding');
    assert(filtered.length > 0, 'has coder candidates');
    assert(filtered.every((r) => /cod/i.test(`${r.repo} ${r.name}`)), 'every row is a coder model');
  });

  await step('vision keeps only vision rows', () => {
    const filtered = filterCandidatesForProfile(candidates, 'vision');
    assert(filtered.length > 0, 'has vision candidates');
    assert(filtered.some((r) => r.repo.includes('VL')), 'the VL model survives');
    assert(filtered.every((r) => /vision|vl\b|-vl|image|multimodal/i.test(`${r.repo} ${r.name}`) || /image|vision|multimodal/i.test(r.task || '')), 'every row is vision-capable');
  });

  await step('long-context surfaces the largest-context row first', () => {
    const filtered = filterCandidatesForProfile(candidates, 'long-context');
    assertEq(filtered[0].repo, 'meta/Llama-3.1-8B-GGUF', '131k-context model leads');
  });

  summary('cookbook-recommend');
}

main();
