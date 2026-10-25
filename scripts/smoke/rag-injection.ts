// M14 (LOCAL_AI_MASTER_PLAN Stage 5 / Excellence LE-9) — RAG injection
// discipline unit smoke.
//
// PURE unit test — NO WebSocket, NO server boot, NO live retriever (there is no
// live retrieval/RAG path in Arco today; see ragInjection.ts SCOPE comment).
// Drives the discipline primitives in server/src/providers/ragInjection.ts
// directly and asserts:
//   - the <source id=N> formatter output shape,
//   - the citation template content (anti-hallucination guidance + valid id range),
//   - top_k cap + relevance-floor filtering (marginal chunks dropped) + dedup,
//   - RRF fusion correctness (a doc strong in BOTH lists beats one strong in
//     only one; the exact 1/(k+rank) math),
//   - the assembled bounded block + byte-cap truncation notice.
//
// Run: npm run smoke:rag-injection   (no dev server needed)

import {
  fuseRRF,
  toRanking,
  normalizeScores,
  selectTopK,
  tagSources,
  formatSources,
  ragSystemTemplate,
  buildRagBlock,
  RAG_CITATION_TEMPLATE,
  RAG_DEFAULT_TOP_K,
  RRF_DEFAULT_K,
  type RagChunk,
} from '../../server/src/providers/ragInjection.js';

let passes = 0;
let fails = 0;
const failures: string[] = [];

function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passes++;
  } else {
    console.log(`  FAIL  ${label}`);
    failures.push(label);
    fails++;
  }
}

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

// ── RRF: the 1/(k+rank) math ─────────────────────────────────────────────────

{
  // Single list, k=60: best item (rank 0) → 1/60, second (rank 1) → 1/61.
  const fused = fuseRRF([toRanking(['a', 'b'])], 60);
  const a = fused.find((x) => x.ref === 'a')!;
  const b = fused.find((x) => x.ref === 'b')!;
  check('RRF rank-0 contributes 1/(k+0)', approx(a.score, 1 / 60));
  check('RRF rank-1 contributes 1/(k+1)', approx(b.score, 1 / 61));
  check('RRF uses default k=60', RRF_DEFAULT_K === 60);
}

{
  // The load-bearing hybrid property: a doc strong in BOTH lists beats a doc
  // strong in only ONE.
  //   bm25:   [shared, onlyBm25]
  //   vector: [shared, onlyVec]
  // shared accumulates 1/60 + 1/60; onlyBm25 = 1/61, onlyVec = 1/61.
  const bm25 = toRanking(['shared', 'onlyBm25']);
  const vector = toRanking(['shared', 'onlyVec']);
  const fused = fuseRRF([bm25, vector], 60);
  check('RRF fuses two lists into one ranking', fused.length === 3);
  check('RRF: doc in BOTH lists ranks first', fused[0].ref === 'shared');
  check(
    'RRF: shared score = sum of both reciprocal terms',
    approx(fused.find((x) => x.ref === 'shared')!.score, 1 / 60 + 1 / 60),
  );
  check(
    'RRF: single-list docs score below the shared doc',
    fused[0].score > fused[1].score && fused[0].score > fused[2].score,
  );
}

{
  // A doc that is RANK-1 in both can still beat a doc that is RANK-0 in one:
  //   both:   1/61 + 1/61 = 0.03278...
  //   single: 1/60        = 0.01666...
  const fused = fuseRRF(
    [toRanking(['top', 'both']), toRanking(['x', 'both'])],
    60,
  );
  const both = fused.find((f) => f.ref === 'both')!;
  const top = fused.find((f) => f.ref === 'top')!;
  check('RRF: consistent-across-lists beats best-in-one-list', both.score > top.score);
}

{
  // Determinism: tie scores break by ref.
  const fused = fuseRRF([toRanking(['z', 'a'])], 60);
  // z=1/60, a=1/61 — z first by score; but two items with equal rank in
  // separate single-item lists tie and must break by ref.
  const tie = fuseRRF([toRanking(['z']), toRanking(['a'])], 60);
  check('RRF score sort: higher reciprocal first', fused[0].ref === 'z');
  check('RRF tie-break is deterministic by ref', tie[0].ref === 'a' && tie[1].ref === 'z');
}

// ── normalizeScores ──────────────────────────────────────────────────────────

{
  const norm = normalizeScores([{ score: 10 }, { score: 5 }, { score: 0 }]);
  check('normalize: max → 1', approx(norm[0].score, 1));
  check('normalize: mid → 0.5', approx(norm[1].score, 0.5));
  check('normalize: min → 0', approx(norm[2].score, 0));
  const flat = normalizeScores([{ score: 7 }, { score: 7 }]);
  check('normalize: all-equal → 1 (no spread)', flat.every((x) => x.score === 1));
  check('normalize: empty → empty', normalizeScores([]).length === 0);
}

// ── selectTopK: cap + relevance floor + dedup ────────────────────────────────

const chunks: RagChunk[] = [
  { ref: 'r1', text: 'strong A', source: 'a.ts:1', score: 0.95 },
  { ref: 'r2', text: 'strong B', source: 'b.ts:1', score: 0.80 },
  { ref: 'r3', text: 'mid C', source: 'c.ts:1', score: 0.55 },
  { ref: 'r4', text: 'weak D', source: 'd.ts:1', score: 0.10 },
  { ref: 'r2', text: 'dup B', source: 'b.ts:1', score: 0.70 }, // duplicate ref
];

{
  const sel = selectTopK(chunks, { topK: 3, minScore: 0.0 });
  check('top_k caps at 3', sel.length === 3);
  check('top_k keeps highest scores first', sel[0].ref === 'r1' && sel[1].ref === 'r2');
  check('top_k dedups by ref (first/higher wins)', sel.filter((c) => c.ref === 'r2').length === 1);
  check('default top_k constant is ~3', RAG_DEFAULT_TOP_K === 3);
}

{
  // Relevance floor drops the weak chunk even though top_k has room.
  const sel = selectTopK(chunks, { topK: 10, minScore: 0.5 });
  check('relevance floor drops sub-threshold chunks', !sel.some((c) => c.ref === 'r4'));
  check('relevance floor keeps at-or-above-threshold chunks', sel.some((c) => c.ref === 'r3'));
}

{
  // Floor can drop everything → empty (a weak match is worse than none).
  const sel = selectTopK(chunks, { topK: 3, minScore: 0.99 });
  check('relevance floor can select nothing', sel.length === 0);
}

// ── tagSources + formatSources: <source id=N> shape ──────────────────────────

{
  const sel = selectTopK(chunks, { topK: 2 });
  const tagged = tagSources(sel);
  check('tagged ids are 1-based contiguous', tagged[0].id === 1 && tagged[1].id === 2);
  const out = formatSources(tagged);
  check('formatter emits <source id="1" ...>', out.includes('<source id="1"'));
  check('formatter carries provenance via from=', out.includes('from="a.ts:1"'));
  check('formatter closes the tag', out.includes('</source>'));
  check('formatter includes the snippet text', out.includes('strong A'));
  // Attribute hygiene: a quote in provenance must not break the tag.
  const dirty = formatSources([
    { id: 1, ref: 'x', text: 'body', source: 'weird"label\nhere', score: 1 },
  ]);
  check('formatter sanitizes quotes/newlines in from=', !dirty.includes('"label') && dirty.includes('<source id="1"'));
}

// ── citation template: anti-hallucination guidance ───────────────────────────

{
  check('template tells model to cite [N]', /\[N\]/.test(RAG_CITATION_TEMPLATE));
  check('template forbids inventing sources', /not invent sources/i.test(RAG_CITATION_TEMPLATE));
  check('template says to admit when answer is absent', /say so/i.test(RAG_CITATION_TEMPLATE));
  check('template names valid id range (plural)', ragSystemTemplate(3).includes('[1]..[3]'));
  check('template names valid id (singular)', ragSystemTemplate(1).includes('id [1]'));
  check('template with 0 sources = bare guidance', ragSystemTemplate(0) === RAG_CITATION_TEMPLATE);
}

// ── buildRagBlock: assembled bounded block + visibility ──────────────────────

{
  const sel = selectTopK(chunks, { topK: 3, minScore: 0.5 });
  const block = buildRagBlock(sel, { budget: 8 * 1024 });
  check('block non-empty when sources selected', block.text.length > 0 && block.bytes > 0);
  check('block reports the sources it injected (events.jsonl provenance)', block.sources.length === sel.length);
  check('block ids stay contiguous from 1', block.sources[0].id === 1);
  check('block contains the citation template', block.text.includes('cite it inline as [N]'));
  check('block contains <source> tags', block.text.includes('<source id="1"'));
  check('block bytes match rendered text', block.bytes === Buffer.byteLength(block.text, 'utf8'));
  check('block not truncated under generous budget', block.truncated === false);
}

{
  // Byte-cap truncation: tiny budget forces a drop + an explicit notice (never
  // a silent truncation — the visible/reversible fence).
  const big: RagChunk[] = [
    { ref: 'b1', text: 'X'.repeat(400), source: 's1', score: 0.9 },
    { ref: 'b2', text: 'Y'.repeat(400), source: 's2', score: 0.8 },
    { ref: 'b3', text: 'Z'.repeat(400), source: 's3', score: 0.7 },
  ];
  const block = buildRagBlock(big, { budget: 600 });
  check('byte cap drops over-budget sources', block.truncated === true);
  check('byte cap keeps at least one source', block.sources.length >= 1 && block.sources.length < 3);
  check('truncation notice names omitted count', /more source.*omitted/.test(block.text));
  check('kept ids re-numbered contiguously after cap', block.sources.every((s, i) => s.id === i + 1));
  check('post-cap bytes within budget tolerance', block.bytes <= 600 + Buffer.byteLength(block.text.split('[...')[1] ?? '', 'utf8') + 400);
}

{
  // Empty selection → empty block (no header, no template spam).
  const block = buildRagBlock([]);
  check('empty selection → empty block', block.text === '' && block.bytes === 0 && block.sources.length === 0);
}

// ── end-to-end: retriever pipeline (RRF → normalize → select → block) ─────────

{
  // Simulate what a future retriever does: two rankings (BM25 + vector) over the
  // same corpus, fuse, normalize, attach text, select top_k, build the block.
  const corpus: Record<string, { text: string; source: string }> = {
    f1: { text: 'def parseConfig()', source: 'config.ts:10' },
    f2: { text: 'class Router {}', source: 'router.ts:1' },
    f3: { text: 'const DEFAULT = 3', source: 'const.ts:1' },
    f4: { text: 'unrelated noise', source: 'noise.ts:1' },
  };
  const bm25 = toRanking(['f1', 'f3', 'f4']);     // keyword strong on f1
  const vector = toRanking(['f1', 'f2', 'f4']);   // semantic also strong on f1
  const fused = normalizeScores(fuseRRF([bm25, vector]));
  const candidates: RagChunk[] = fused
    .filter((f) => corpus[f.ref])
    .map((f) => ({ ref: f.ref, score: f.score, text: corpus[f.ref].text, source: corpus[f.ref].source }));
  const sel = selectTopK(candidates, { topK: 3 });
  const block = buildRagBlock(sel);
  check('e2e: f1 (top in both lists) is source id 1', block.sources[0].ref === 'f1');
  check('e2e: top_k capped the pipeline output at 3', block.sources.length === 3);
  check('e2e: block cites f1 provenance', block.text.includes('config.ts:10'));
}

// ── summary ──────────────────────────────────────────────────────────────────

console.log('');
console.log(`rag-injection: ${passes}/${passes + fails} checks passed`);
if (fails > 0) {
  console.log('');
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
