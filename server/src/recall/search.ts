// Workbench Expansion §F3 — Recall: global search engine.
//
// Keyword search over the F1 recall index: titles + summaries + tags via SQLite
// FTS5 (the must-have), plus an OPTIONAL full-text pass over each workflow's
// transcript (events.jsonl) via A5's ripgrep engine (operator toggle, default
// OFF — heavier scan, no extra DB bytes). Filtered by project / provider / date.
//
// FENCE-CLEARANCE (docs/RECALL.md, Part F preamble): operator-driven
// retrospective search — DETERMINISTIC (FTS5 bm25 + ripgrep), NO LLM in the
// loop, no AI ranking/summarization. This is the backward-looking archive
// search the operator asked for.
//
// Two backends, ONE shared with A5:
//   - title/summary/tags → FTS5 (RecallIndex.searchFtsRaw). bm25() ranks,
//     snippet() excerpts. Always on.
//   - transcript text → contentSearch.searchContent (the SAME ripgrep engine
//     A5's /api/search/content uses — NOT a second engine). Run once per
//     candidate workflow's events.jsonl, gated behind includeTranscripts.
//     Degrades gracefully when `rg` is absent (transcriptsAvailable:false).
//
// Why ripgrep over stuffing transcripts into FTS5: full transcripts across all
// time would bloat the machine-global recall.db and force a re-index on every
// turn. ripgrep over events.jsonl on demand keeps recall.db small and reuses an
// engine that already exists, already validated, already degrades gracefully.

import path from 'path';
import { getRecallIndex, RecallIndex, type RecallFtsRow } from './index.js';
import { searchContent, RIPGREP_BIN } from '../contentSearch.js';
import type { ProviderName, RecallEntry, RecallSearchHit, RecallSearchResponse } from '@arco/shared';

const WFID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const SNIPPET_MAX = 240;

export interface RecallSearchOpts {
  q?: string;
  project?: string;
  provider?: ProviderName;
  from?: number;
  to?: number;
  includeTranscripts?: boolean;
  // Test seam — point the transcript pass at a chosen rg binary (or null to
  // simulate a missing rg). Production leaves unset → module-detected RIPGREP_BIN.
  rgBin?: string | null;
}

// Turn an operator query into a safe FTS5 MATCH expression. FTS5 has its own
// query grammar (bare `-`, `"`, `*`, `OR`, `NEAR` are operators), so an
// unescaped operator query can throw a "fts5: syntax error". We tokenize on
// whitespace, strip FTS punctuation from each token, and AND the surviving
// tokens together as prefix terms (`foo*`) — forgiving keyword search, never a
// syntax error. Empty after sanitizing → null (caller returns recent list).
function toFtsQuery(q: string): string | null {
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/["'*^():\-+]/g, '').trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  // Quote each token (defuses any residual operator char) + prefix-match so a
  // partial keyword still surfaces ("refac" → "refactor"). AND across tokens.
  return tokens.map((t) => `"${t}"*`).join(' AND ');
}

// Pick the highest-priority non-empty FTS snippet + its field label. snippet()
// returns the column text verbatim (no brackets) when the column had no match,
// so "has brackets" ≈ "this column matched". Priority: title > summary > tags.
function pickFtsSnippet(row: RecallFtsRow): { snippet: string; matchedIn: 'title' | 'summary' | 'tags' } {
  const matched = (s: string) => s.includes('[') && s.includes(']');
  if (matched(row.snippetTitle)) return { snippet: clip(row.snippetTitle), matchedIn: 'title' };
  if (matched(row.snippetSummary)) return { snippet: clip(row.snippetSummary), matchedIn: 'summary' };
  if (matched(row.snippetTags)) return { snippet: clip(row.snippetTags), matchedIn: 'tags' };
  // No bracketed column (e.g. a prefix match FTS5 didn't bracket): fall back to
  // the title text so the row still shows something.
  return { snippet: clip(row.snippetTitle || row.entry.title), matchedIn: 'title' };
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > SNIPPET_MAX ? t.slice(0, SNIPPET_MAX - 1) + '…' : t;
}

function toHit(
  entry: RecallEntry,
  snippet: string,
  matchedIn: RecallSearchHit['matchedIn'],
): RecallSearchHit {
  return {
    wfid: entry.wfid,
    title: entry.title,
    project: entry.project,
    provider: entry.provider,
    cwd: entry.cwd,
    lastActiveAt: entry.lastActiveAt,
    summaryRef: entry.summaryRef,
    snippet,
    matchedIn,
    // §F4 — operator-curated state, surfaced on the hit for the result row.
    tags: entry.tags,
    pinned: entry.pinned,
    links: entry.links,
  };
}

// search() — the public §F3 surface backing GET /api/recall/search. Always
// returns a structured response (never throws for the empty-query / no-rg
// cases). An empty/whitespace query returns the recent list (lastActiveAt desc,
// honoring filters) so the view has something to show on open.
export async function search(opts: RecallSearchOpts, index: RecallIndex = getRecallIndex()): Promise<RecallSearchResponse> {
  const q = (opts.q ?? '').trim();
  const match = q ? toFtsQuery(q) : null;

  // Empty/blank query → recent list (deterministic, no FTS needed). The view
  // opens onto "your recent conversations"; typing narrows via FTS.
  if (!match) {
    const recent = index.query({ project: opts.project, provider: opts.provider })
      .filter((e) => withinDate(e.lastActiveAt, opts.from, opts.to))
      .slice(0, 50);
    return {
      hits: recent.map((e) => toHit(e, clip(e.title), 'title')),
      transcriptsAvailable: rgAvailable(opts),
    };
  }

  // FTS side — title/summary/tags. Always on.
  const ftsRows = index.searchFtsRaw({
    match,
    project: opts.project,
    provider: opts.provider,
    from: opts.from,
    to: opts.to,
    limit: 50,
  });
  const hits: RecallSearchHit[] = [];
  const seen = new Set<string>();
  for (const row of ftsRows) {
    const { snippet, matchedIn } = pickFtsSnippet(row);
    hits.push(toHit(row.entry, snippet, matchedIn));
    seen.add(row.entry.wfid);
  }

  // Transcript side — operator toggle, default OFF. Reuse A5's ripgrep engine
  // over each candidate workflow's events.jsonl. Scoped to the filtered index
  // entries so we never rg-walk workflows the filters exclude.
  let transcriptsAvailable = rgAvailable(opts);
  if (opts.includeTranscripts) {
    const bin = opts.rgBin === undefined ? RIPGREP_BIN : opts.rgBin;
    if (!bin) {
      transcriptsAvailable = false;
    } else {
      const candidates = index.query({ project: opts.project, provider: opts.provider })
        .filter((e) => withinDate(e.lastActiveAt, opts.from, opts.to));
      for (const entry of candidates) {
        if (seen.has(entry.wfid)) continue; // already an FTS hit — title beats transcript
        if (!WFID_PATTERN.test(entry.wfid)) continue;
        const dir = path.join(entry.cwd, '.arco', 'workflows', entry.wfid);
        const res = await searchContent({ cwd: dir, query: q, maxHits: 1, bin });
        if (!res.available) { transcriptsAvailable = false; continue; }
        const firstHit = res.hits[0];
        if (!firstHit) continue;
        seen.add(entry.wfid);
        hits.push(toHit(entry, clip(firstHit.text), 'transcript'));
      }
    }
  }

  return { hits, transcriptsAvailable };
}

function withinDate(ts: number, from?: number, to?: number): boolean {
  if (typeof from === 'number' && ts < from) return false;
  if (typeof to === 'number' && ts > to) return false;
  return true;
}

// transcriptsAvailable in the response is meaningful only when the operator
// asked for transcripts; when they didn't, report the binary's presence anyway
// so the UI can pre-disable the toggle if rg is missing.
function rgAvailable(opts: RecallSearchOpts): boolean {
  const bin = opts.rgBin === undefined ? RIPGREP_BIN : opts.rgBin;
  return !!bin;
}
