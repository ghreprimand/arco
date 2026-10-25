// Workbench Expansion G2 — Cookbook catalog normalize+score smoke.
//
// PURE-FUNCTION phase: NO network, NO server, NO WS. Feeds FIXTURE Hugging Face
// + Ollama raw payloads + the fixed RTX 5090 profile into normalizeAndScore
// (the pure half of catalog.ts) and asserts:
//   1. Rows are normalized — correct repo / name / params / quant / source.
//   2. A qwen-coder GGUF with several quant variants produces one row per
//      variant, each scored; its Q4_K_M fits the 5090 (GOOD/PERFECT).
//   3. A huge (200B+) model is flagged NO.
//   4. Rows are sorted by SCORE desc.
//   5. A quant filter narrows the result set correctly.
//   6. Determinism — identical inputs → byte-identical rows.
//
// Run: npm run smoke:cookbook-catalog  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import { normalizeAndScore } from '../../server/src/cookbook/catalog.js';
import { OLLAMA_LIBRARY } from '../../server/src/cookbook/ollamaLibrary.js';
import type { HardwareProfile } from '@arco/shared';

const GB = 1024 * 1024 * 1024;

const rig5090: HardwareProfile = {
  gpus: [{ name: 'NVIDIA GeForce RTX 5090', vramBytes: 32 * GB }],
  totalVramBytes: 32 * GB,
  systemRamBytes: 128 * GB,
  cores: 32,
  backend: 'cuda',
};

// Fixture HF payload (the bits normalizeAndScore reads): a qwen-coder GGUF repo
// with three quant variants, plus a huge 235B MoE repo that can't fit a 5090.
const hfFixture = [
  {
    id: 'Qwen/Qwen2.5-Coder-32B-Instruct-GGUF',
    pipeline_tag: 'text-generation',
    tags: ['gguf', 'text-generation'],
    downloads: 120000,
    siblings: [
      { rfilename: 'qwen2.5-coder-32b-instruct-q4_k_m.gguf', size: 19_900_000_000 },
      { rfilename: 'qwen2.5-coder-32b-instruct-q5_k_m.gguf', size: 23_300_000_000 },
      { rfilename: 'qwen2.5-coder-32b-instruct-q8_0.gguf', size: 34_800_000_000 },
      { rfilename: 'README.md' },
    ],
  },
  {
    id: 'unsloth/Qwen3-235B-A22B-GGUF',
    pipeline_tag: 'text-generation',
    tags: ['gguf', 'moe'],
    downloads: 40000,
    siblings: [{ rfilename: 'qwen3-235b-a22b-q4_k_m.gguf', size: 142_000_000_000 }],
  },
];

// Fixture Ollama payload: one small pullable coder.
const ollamaFixture = [
  { name: 'qwen2.5-coder:7b', description: 'Qwen2.5 Coder', sizes: ['7b'] },
];

async function main() {
  await step('rows are normalized (repo/name/params/quant/source)', () => {
    const rows = normalizeAndScore({ hf: hfFixture, ollama: ollamaFixture }, rig5090);
    assert(rows.length > 0, 'expected rows');
    const qwen = rows.find((r) => r.repo === 'Qwen/Qwen2.5-Coder-32B-Instruct-GGUF');
    assert(qwen !== undefined, 'qwen-coder repo must be normalized');
    assertEq(qwen!.name, 'Qwen2.5-Coder-32B-Instruct-GGUF', 'name = repo last segment');
    assertEq(qwen!.params, 32, 'params parsed from name (32B)');
    assertEq(qwen!.source, 'hf', 'source = hf');
    const ollama = rows.find((r) => r.source === 'ollama');
    assert(ollama !== undefined, 'ollama row present');
    assertEq(ollama!.params, 7, 'ollama params parsed (7b)');
    assertEq(ollama!.quant, 'Q4_K_M', 'ollama defaults to Q4_K_M');
  });

  await step('qwen-coder produces one row per quant variant, each scored', () => {
    const rows = normalizeAndScore({ hf: hfFixture, ollama: [] }, rig5090);
    const qwenRows = rows.filter((r) => r.repo === 'Qwen/Qwen2.5-Coder-32B-Instruct-GGUF');
    const quants = qwenRows.map((r) => r.quant).sort();
    assertEq(JSON.stringify(quants), JSON.stringify(['Q4_K_M', 'Q5_K_M', 'Q8_0']), 'three quant variants');
    for (const r of qwenRows) assert(r.fit.score >= 0 && r.fit.score <= 100, 'each row scored 0-100');
    const q4 = qwenRows.find((r) => r.quant === 'Q4_K_M')!;
    assert(q4.fit.verdict === 'GOOD' || q4.fit.verdict === 'PERFECT', `qwen Q4 should fit (got ${q4.fit.verdict})`);
    assertEq(q4.fit.mode, 'gpu', 'qwen Q4 runs on gpu');
  });

  await step('the 235B model is flagged NO on one 5090', () => {
    const rows = normalizeAndScore({ hf: hfFixture, ollama: [] }, rig5090);
    const big = rows.find((r) => r.repo === 'unsloth/Qwen3-235B-A22B-GGUF')!;
    assert(big !== undefined, '235B repo present');
    assertEq(big.fit.verdict, 'NO', '235B Q4 cannot fit 32 GB');
    assert(big.moe === true, '235B-A22B detected as MoE');
  });

  await step('rows are sorted by SCORE desc', () => {
    const rows = normalizeAndScore({ hf: hfFixture, ollama: ollamaFixture }, rig5090);
    for (let i = 1; i < rows.length; i++) {
      assert(rows[i - 1].fit.score >= rows[i].fit.score, `sort broken at ${i}: ${rows[i - 1].fit.score} < ${rows[i].fit.score}`);
    }
  });

  await step('quant filter narrows correctly (Q5 keeps only Q5 variants)', () => {
    const all = normalizeAndScore({ hf: hfFixture, ollama: ollamaFixture }, rig5090);
    const q5 = normalizeAndScore({ hf: hfFixture, ollama: ollamaFixture }, rig5090, { quant: 'Q5' });
    assert(q5.length < all.length, 'Q5 filter must drop non-Q5 rows');
    assert(q5.every((r) => r.quant.startsWith('Q5')), 'every filtered row is a Q5 variant');
    assert(q5.some((r) => r.quant === 'Q5_K_M'), 'Q5_K_M survives the filter');
  });

  await step('normalizeAndScore is deterministic (identical inputs → identical rows)', () => {
    const a = normalizeAndScore({ hf: hfFixture, ollama: ollamaFixture }, rig5090, { text: 'qwen' });
    const b = normalizeAndScore({ hf: hfFixture, ollama: ollamaFixture }, rig5090, { text: 'qwen' });
    assertEq(JSON.stringify(a), JSON.stringify(b), 'two identical calls must match exactly');
  });

  await step('curated Ollama manifest normalizes + scores (no live mirror)', () => {
    // The Ollama source is the bundled OLLAMA_LIBRARY (no third-party endpoint).
    // Feed it the same way fetchRawSources does and assert it scores sanely.
    const ollamaRaw = OLLAMA_LIBRARY.map((e) => ({
      name: e.name, params: e.params, task: e.task, moe: e.moe,
    }));
    const rows = normalizeAndScore({ hf: [], ollama: ollamaRaw }, rig5090);
    assert(rows.length === OLLAMA_LIBRARY.length, 'one row per curated entry (Q4_K_M each)');
    assert(rows.every((r) => r.source === 'ollama' && r.quant === 'Q4_K_M'), 'all ollama Q4_K_M');

    // Explicit total params (not the name tag) keep MoE honest: mixtral:8x7b is
    // ~47B total, so on one 5090 it's at best a marginal fit (TIGHT) and never a
    // comfortable one. A tag-derived 7B would wrongly score PERFECT/GOOD — this
    // asserts the 47B total is what's scored.
    const mixtral = rows.find((r) => r.repo === 'mixtral:8x7b')!;
    assert(mixtral !== undefined, 'mixtral present');
    assertEq(mixtral.params, 47, 'mixtral total params = 47B (explicit, not 7B from the tag)');
    assert(mixtral.moe === true, 'mixtral flagged MoE');
    assert(
      mixtral.fit.verdict === 'TIGHT' || mixtral.fit.verdict === 'NO',
      `47B on a 32 GB card must be marginal-at-best, got ${mixtral.fit.verdict}`,
    );
    assert(mixtral.fit.estVramBytes > 25 * GB, '47B Q4 weights alone are ~26 GB (proves 47B, not 7B)');

    // A small coder fits.
    const small = rows.find((r) => r.repo === 'qwen2.5-coder:7b')!;
    assert(small !== undefined && small.fit.verdict !== 'NO', 'qwen2.5-coder:7b fits the 5090');
  });

  summary('cookbook-catalog');
}

main();
