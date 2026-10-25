// M14 (LOCAL_AI_MASTER_PLAN Stage 5 / Excellence LE-9) — RAG injection discipline.
//
// PURE, retriever-agnostic primitives for *how* retrieved chunks get folded into
// a small model's limited window without (a) blowing the window, (b) inviting
// hallucinated citations, or (c) becoming silent context manipulation. Ported in
// spirit from open-webui's RAG layer (`<source id=>` tags, RAG_TEMPLATE, top_k=3
// + relevance threshold, hybrid BM25+vector RRF).
//
// ── SCOPE (honest, per the M14 brief) ──
// There is NO live retrieval/index path in Arco today that injects ranked
// snippets into prompts (the M7 worker's note + LOCAL_AI_MASTER_PLAN §M7 confirm
// it). What exists is:
//   - recall/ — retrospective CONVERSATION search (FTS5 bm25 + ripgrep); never
//     injected into a turn. Backward-looking archive search.
//   - knowledge/store.ts buildKnowledgeBlock — folds ALL operator-curated
//     `alwaysInclude` articles into the system prompt in updatedAt order. Bounded
//     + visible, but UNRANKED: no query, no scoring, no top_k, no citation. It's
//     "pin these facts," not retrieval.
//   - Codebase memory (tree-sitter) — an EXTERNAL MCP the model queries as a
//     tool; no server-side index, no embeddings, no in-process BM25/vector that
//     yields snippets to inject. (Spawn-site wiring is itself deferred.)
//
// So this module is the DISCIPLINE LAYER, ready for the day a real retriever
// (an in-process tree-sitter+vector index, or a knowledge-base FTS5 upgrade)
// produces scored chunks. The retriever calls fuseRRF() (when it has both a BM25
// and a vector ranking), then selectTopK() (cap + relevance floor), then
// formatSources() + ragSystemTemplate() to build the injected block. The block
// it produces is bounded (top_k + threshold + byte cap), self-describing (every
// snippet carries provenance), and the selection is deterministic readable
// math — it clears CLAUDE.md's four-question test exactly like buildKnowledgeBlock
// does. Where it plugs in: the same turnEngine.ts site that calls
// buildKnowledgeBlock today (≈ line 1188), once a retriever feeds it candidates.
//
// FENCE: nothing here retrieves, scores, or persists anything. It is arithmetic
// + string formatting over inputs the caller supplies. No LLM in the loop.

// ── Tunables (LE-9 defaults) ──

// top_k ≈ 3 — context-frugality. The whole local-AI program optimizes for small
// models' limited windows (M6 accounting, M8 compaction, M10 tool-subsetting);
// dumping a dozen marginal chunks into a 4–8k window is exactly the regression
// those milestones fight. Three strong chunks beat ten weak ones.
export const RAG_DEFAULT_TOP_K = 3;

// Relevance floor — drop chunks whose score is below this even if top_k has room.
// A weak match is worse than no match: it spends scarce window budget AND tempts
// the model to "use" an irrelevant source. Score is caller-defined but MUST be
// normalized to 0..1 (see selectTopK doc). 0 disables the floor.
export const RAG_DEFAULT_MIN_SCORE = 0.0; // conservative default; retrievers tune up

// RRF constant `k` — the standard Reciprocal Rank Fusion damping term from
// Cormack et al. 2009. 60 is the canonical default (TREC); larger k flattens the
// contribution of top ranks, smaller k sharpens it. Kept configurable but
// defaulted to 60 so callers get the well-studied behavior for free.
export const RRF_DEFAULT_K = 60;

// Byte cap on the assembled injected block — a hard backstop so even N short
// chunks can't silently bloat the turn. Mirrors KNOWLEDGE_INJECT_BUDGET's
// discipline (bounded-with-notice). Defaulted small because RAG snippets feed
// small-window local models. The caller logs the post-cap bytes to events.jsonl.
export const RAG_DEFAULT_BLOCK_BUDGET = 8 * 1024; // 8 KB

// ── Types ──

// A single retrieved chunk, retriever-agnostic. `score` MUST be normalized to
// 0..1 for the relevance floor to mean anything across retrievers (a raw BM25
// score and a cosine similarity are not comparable otherwise). `source` is
// human-readable provenance (e.g. "src/foo.ts:120-140") surfaced both to the
// model (so it can cite meaningfully) and to events.jsonl (so the operator sees
// what was injected). `ref` is an optional stable id used for RRF fusion +
// content-hash dedup keying.
export interface RagChunk {
  ref: string;        // stable identity for fusion/dedup (e.g. content hash or path:line)
  text: string;       // the snippet body
  source: string;     // human-readable provenance label
  score: number;      // relevance, normalized 0..1 (caller's responsibility)
}

// A ranked list element for RRF: an item id + its 0-based rank in that list.
export interface RankedItem {
  ref: string;
  rank: number; // 0 = best
}

// One assembled, ready-to-inject source after selection — carries the 1-based
// id the model cites as [N].
export interface TaggedSource {
  id: number;         // 1-based; matches the <source id=N> tag and [N] citation
  ref: string;
  text: string;
  source: string;
  score: number;
}

export interface RagBlock {
  text: string;         // '' when no sources survive selection
  bytes: number;        // bytes of `text` (post-cap) — what the caller logs
  sources: TaggedSource[]; // the sources actually folded in (for events.jsonl provenance)
  considered: number;   // candidates seen before selection
  truncated: boolean;   // true if the byte cap dropped otherwise-selected sources
}

// ── (d) RRF — Reciprocal Rank Fusion ──
//
// Merge two (or more) ranked lists into one fused ranking via the standard
// score = Σ 1/(k + rank). A document strong in BOTH lists accumulates two
// reciprocal terms and so outranks a document strong in only one — which is the
// whole point of hybrid BM25+vector: keyword precision (BM25, excellent for code
// identifiers) AND semantic recall (vector), neither alone. Rank is 0-based, so
// the best item in a list contributes 1/(k+0) = 1/k, the second 1/(k+1), etc.
//
// Inputs are RANKINGS (ordered ref lists), not scores — RRF deliberately ignores
// the raw scores of each ranker (a BM25 score and a cosine score aren't
// comparable), using only position. Returns refs sorted by fused score desc,
// with the fused score attached. Ties broken by ref for determinism.
export function fuseRRF(
  rankings: RankedItem[][],
  k: number = RRF_DEFAULT_K,
): Array<{ ref: string; score: number }> {
  const fused = new Map<string, number>();
  for (const list of rankings) {
    for (const item of list) {
      const contribution = 1 / (k + item.rank);
      fused.set(item.ref, (fused.get(item.ref) ?? 0) + contribution);
    }
  }
  return [...fused.entries()]
    .map(([ref, score]) => ({ ref, score }))
    .sort((a, b) => (b.score - a.score) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

// Convenience: build a RankedItem[] from an already-ordered ref list (best
// first). Most retrievers return ordered results, not (ref,rank) pairs.
export function toRanking(orderedRefs: string[]): RankedItem[] {
  return orderedRefs.map((ref, rank) => ({ ref, rank }));
}

// Min-max normalize raw fused (or raw retriever) scores to 0..1 so the relevance
// floor in selectTopK is meaningful. A single-item or all-equal list maps to 1
// (no spread to normalize → treat as fully relevant). Pure helper; retrievers
// that already emit 0..1 scores skip this.
export function normalizeScores<T extends { score: number }>(items: T[]): T[] {
  if (items.length === 0) return items;
  let min = Infinity;
  let max = -Infinity;
  for (const it of items) {
    if (it.score < min) min = it.score;
    if (it.score > max) max = it.score;
  }
  const span = max - min;
  if (span <= 0) return items.map((it) => ({ ...it, score: 1 }));
  return items.map((it) => ({ ...it, score: (it.score - min) / span }));
}

// ── (c) top_k + relevance-threshold selector ──
//
// Given scored candidate chunks, return at most `topK` of them, keeping only
// those at/above `minScore`, highest score first. Also content-hash-dedups by
// `ref` (open-webui dedups retrieved chunks; the same file/identifier surfacing
// in both the BM25 and vector lists is common). The first occurrence of a ref
// wins (it's already the higher-scored one after the sort).
//
// `score` is assumed normalized 0..1 (run fuseRRF→normalizeScores, or a
// retriever that emits 0..1). The cap is the context-frugality backstop; the
// floor is the "a weak match is worse than nothing" rule. Deterministic: ties on
// score break by ref so the same inputs always yield the same selection.
export function selectTopK(
  chunks: RagChunk[],
  opts: { topK?: number; minScore?: number } = {},
): RagChunk[] {
  const topK = opts.topK ?? RAG_DEFAULT_TOP_K;
  const minScore = opts.minScore ?? RAG_DEFAULT_MIN_SCORE;
  const seen = new Set<string>();
  return [...chunks]
    .filter((c) => c.score >= minScore)
    .sort((a, b) => (b.score - a.score) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
    .filter((c) => {
      if (seen.has(c.ref)) return false;
      seen.add(c.ref);
      return true;
    })
    .slice(0, Math.max(0, topK));
}

// ── (a) <source id=N> formatter ──
//
// Wrap each selected chunk in an open-webui-style tagged block the model can
// cite by number. The `id` is 1-based and stable within this turn's block; the
// provenance label rides as an attribute so the model (and the operator reading
// events.jsonl) sees where each snippet came from. Assigns ids in selection
// order (already highest-relevance first from selectTopK).
//
//   <source id="1" from="src/foo.ts:120-140">
//   …snippet text…
//   </source>
export function tagSources(chunks: RagChunk[]): TaggedSource[] {
  return chunks.map((c, i) => ({
    id: i + 1,
    ref: c.ref,
    text: c.text,
    source: c.source,
    score: c.score,
  }));
}

function escapeAttr(s: string): string {
  // Minimal attribute hygiene so a provenance label with a quote can't break the
  // tag the model reads. Not security-critical (operator-local content) — just
  // keeps the tag well-formed.
  return s.replace(/"/g, "'").replace(/[\r\n]+/g, ' ').trim();
}

export function formatSources(sources: TaggedSource[]): string {
  return sources
    .map(
      (s) =>
        `<source id="${s.id}" from="${escapeAttr(s.source)}">\n${s.text.trim()}\n</source>`,
    )
    .join('\n\n');
}

// ── (b) citation-discipline template ──
//
// System-prompt guidance telling the model to cite by [N] and — critically — NOT
// to invent sources or facts not present in the tagged context. This is the
// anti-hallucination half of LE-9: a small local model handed loose context will
// happily fabricate; the template constrains it to grounded, attributed answers.
// Mirrors open-webui's RAG_TEMPLATE intent (cite-or-say-you-don't-know), kept
// terse for the small-window budget.
export const RAG_CITATION_TEMPLATE =
  'The context below is wrapped in <source id="N"> tags. When you use a fact ' +
  'from a source, cite it inline as [N] using that source\'s id. Do not invent ' +
  'sources or cite ids that do not appear below. If the sources do not contain ' +
  'the answer, say so plainly rather than guessing.';

// Compose the full guidance line, optionally noting how many sources are
// available so the model knows the valid id range. Pure string builder.
export function ragSystemTemplate(sourceCount: number): string {
  if (sourceCount <= 0) return RAG_CITATION_TEMPLATE;
  const range = sourceCount === 1 ? 'id [1]' : `ids [1]..[${sourceCount}]`;
  return `${RAG_CITATION_TEMPLATE} Valid source ${range}.`;
}

// ── The assembled, bounded block (the thing a retriever injects) ──
//
// End-to-end: take selected+tagged sources, render the citation template + the
// <source> blocks, and HARD-CAP the result at `budget` bytes. The byte cap is
// the final backstop (top_k already bounds count; this bounds size when chunks
// are large). When the cap drops sources, an explicit notice names how many were
// omitted — never a silent truncation (matches buildKnowledgeBlock's discipline
// and clears the visible/reversible fence). The returned `bytes` + `sources` are
// exactly what the caller logs to events.jsonl for the four-question test.
const RAG_DELIM = '--- Retrieved context ---';

export function buildRagBlock(
  selected: RagChunk[],
  opts: { budget?: number } = {},
): RagBlock {
  const budget = opts.budget ?? RAG_DEFAULT_BLOCK_BUDGET;
  const considered = selected.length;
  const empty: RagBlock = { text: '', bytes: 0, sources: [], considered, truncated: false };
  if (selected.length === 0) return empty;

  const tagged = tagSources(selected);
  const header = `${RAG_DELIM}\n${ragSystemTemplate(tagged.length)}\n`;

  // Greedily fold sources in selection order until the next would overflow.
  const kept: TaggedSource[] = [];
  let used = byteLen(header);
  for (const s of tagged) {
    // Re-id from 1 over the KEPT set so cited ids stay contiguous + valid even
    // after the byte cap drops a tail source.
    const candidate: TaggedSource = { ...s, id: kept.length + 1 };
    const block = formatSources([candidate]);
    const blockBytes = byteLen('\n' + block + '\n');
    if (kept.length > 0 && used + blockBytes > budget) break;
    kept.push(candidate);
    used += blockBytes;
  }

  const truncated = kept.length < tagged.length;
  // Rebuild header with the FINAL count so the valid-id range matches what's kept.
  const finalHeader = `${RAG_DELIM}\n${ragSystemTemplate(kept.length)}\n`;
  let text = finalHeader + '\n' + formatSources(kept) + '\n';
  if (truncated) {
    const dropped = tagged.length - kept.length;
    text += `\n[... ${dropped} more source${dropped === 1 ? '' : 's'} omitted: retrieved context exceeds the ${Math.round(budget / 1024)} KB injection budget.]\n`;
  }
  return { text, bytes: byteLen(text), sources: kept, considered, truncated };
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
