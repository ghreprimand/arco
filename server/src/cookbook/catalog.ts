// ── Cookbook catalog search (Workbench Expansion G2) ──
//
// Browse a fit-scored catalog of local-LLM candidates from two sources and cross
// every quant variant with G1's scoreFit:
//   • Hugging Face Hub API — GGUF repos (served via llama.cpp). LIVE, keyless,
//     official Hub API.
//   • Ollama library       — pullable model names (served via Ollama). A CURATED,
//     BUNDLED manifest (server/src/cookbook/ollamaLibrary.ts), NOT a live fetch:
//     Ollama has no official keyless catalog API, and depending on a third-party
//     community mirror would be a silent external dependency the operator can't
//     audit. The manifest is in-repo, operator-readable/-extensible, and scoring
//     it is fully deterministic. See that file's header for the rationale.
//
// G2 is READ-ONLY SEARCH. Nothing here downloads, pulls, writes disk, or
// registers a model — that is G4. This file is HTTP-fetch only: NO execFile, NO
// child_process, NO path use. The only system read is G1's cached hardware probe
// (nvidia-smi), reached through scoreFit's HardwareProfile argument, not here.
//
// ── Determinism split (load-bearing for the smoke) ──
// The fetch is separated from the normalize+score so the smoke can feed fixtures
// and assert deterministically with NO network:
//   • fetchRawSources()        — the ONLY non-deterministic part (live HTTP).
//   • normalizeAndScore(...)   — PURE: (raw HF + raw Ollama + HardwareProfile +
//                                query) → sorted CatalogRow[]. No clock, no
//                                random, no I/O. Identical inputs → identical
//                                rows. The smoke imports THIS directly.
//   • searchCatalog(...)       — wraps fetchRawSources + normalizeAndScore +
//                                the TTL cache. The route calls this.
//
// ── Graceful failure ──
// A down/slow HF or Ollama must NEVER crash the server or throw an unhandled
// rejection. Each source fetch is independently try/caught with a timeout; a
// failure degrades to "that source returned nothing" (sources.<src> = false) +
// a note. The worst case is an empty row list with both flags false.

import type {
  CatalogModel,
  CatalogQuery,
  CatalogResponse,
  CatalogRow,
  HardwareProfile,
  ModelSpec,
} from '@arco/shared';
import { scoreFit } from './fit.js';
import { OLLAMA_LIBRARY } from './ollamaLibrary.js';

// ── HF live source endpoint (public, keyless GET) ────────────────────────────
// HF Hub: filter to GGUF libraries, expand the fields we normalize from. `sort`
// + `limit` keep the payload bounded; `full=true` pulls the sibling file list
// (the GGUF quant variants) and tags. (The Ollama side is the bundled
// OLLAMA_LIBRARY manifest, not a live endpoint — see the header.)
const HF_API = 'https://huggingface.co/api/models';

// Per-source fetch timeout. A slow source must not stall the whole request.
const FETCH_TIMEOUT_MS = 8000;
// How many HF repos to pull per query (bounded payload + bounded scoring work).
const HF_LIMIT = 40;

// ── Cache (short TTL, keyed by the normalized query) ─────────────────────────
// Caches the RAW source payloads (not the scored rows) keyed by the query text/
// facets, so re-scoring against a different sim preset is cheap and the cache
// survives a hardware rescan. TTL is short — the catalog is a live view.
const CACHE_TTL_MS = 5 * 60 * 1000;

interface RawSources {
  hf: HfModel[];
  ollama: OllamaModel[];
  hfOk: boolean;
  ollamaOk: boolean;
}

interface CacheEntry {
  raw: RawSources;
  at: number;
}

const rawCache = new Map<string, CacheEntry>();

function cacheKey(q: CatalogQuery): string {
  // The raw fetch only depends on the text + task (the quant/sim filters are
  // applied purely in normalizeAndScore), so key on those.
  return `${(q.text || '').trim().toLowerCase()}|${(q.task || '').trim().toLowerCase()}`;
}

// ── Raw source shapes (the bits of each API we actually read) ────────────────
// HF /api/models entry (with full=true). We read id, tags, the sibling file
// list (GGUF quant variants), pipeline_tag (task), and downloads (for the
// trending sort). Everything is optional/defensive — the API shape drifts.
interface HfSibling {
  rfilename?: string;
  size?: number;
}
interface HfModel {
  id?: string;
  modelId?: string;
  pipeline_tag?: string;
  tags?: string[];
  downloads?: number;
  siblings?: HfSibling[];
}

// Ollama library entry (from the bundled OLLAMA_LIBRARY manifest). `params` is the
// explicit TOTAL parameter count (covers MoE, where the name tag understates it);
// `moe` and `task` carry the manifest's hints. `sizes`/`description` are accepted
// defensively in case the shape is ever fed from another source.
interface OllamaModel {
  name?: string;
  params?: number;
  task?: string;
  moe?: boolean;
  description?: string;
  sizes?: string[];
}

// ── Live fetch (the ONLY non-deterministic part) ─────────────────────────────

// fetch with an abort timeout. Uses the global fetch (Node 18+; the codebase
// uses global fetch elsewhere — see usage.ts / check-updates). Never throws to
// the caller of the source fetchers; callers wrap it.
async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHf(query: CatalogQuery): Promise<HfModel[]> {
  const params = new URLSearchParams();
  params.set('library', 'gguf');
  params.set('limit', String(HF_LIMIT));
  params.set('full', 'true');
  params.set('config', 'false');
  // Empty text → trending feed (sort by downloads). Text → search.
  if (query.text && query.text.trim()) {
    params.set('search', query.text.trim());
  } else {
    params.set('sort', 'downloads');
    params.set('direction', '-1');
  }
  if (query.task && query.task.trim()) params.set('pipeline_tag', query.task.trim());
  const data = await fetchJson(`${HF_API}?${params.toString()}`);
  return Array.isArray(data) ? (data as HfModel[]) : [];
}

// Read the bundled Ollama manifest, text-filtered to the operator's query. NO
// network — the list is in-repo (OLLAMA_LIBRARY). Deterministic; runs pre-normalize
// so it doesn't affect normalize+score determinism. Cannot fail.
function selectOllama(query: CatalogQuery): OllamaModel[] {
  const text = (query.text || '').trim().toLowerCase();
  const list: OllamaModel[] = OLLAMA_LIBRARY.map((e) => ({
    name: e.name,
    params: e.params,
    task: e.task,
    moe: e.moe,
  }));
  if (!text) return list;
  return list.filter((m) => (m.name || '').toLowerCase().includes(text));
}

// Assemble both sources. HF is the only fallible (live) one — a failure degrades
// to [] + hfOk=false; never throws. Ollama comes from the bundled manifest, so it
// is always available (ollamaOk=true).
async function fetchRawSources(query: CatalogQuery): Promise<RawSources> {
  const [hfRes] = await Promise.allSettled([fetchHf(query)]);
  const hf = hfRes.status === 'fulfilled' ? hfRes.value : [];
  if (hfRes.status === 'rejected') {
    console.error('[arco] cookbook HF fetch failed:', hfRes.reason);
  }
  return {
    hf,
    ollama: selectOllama(query),
    hfOk: hfRes.status === 'fulfilled',
    ollamaOk: true,
  };
}

// ── Normalization (pure) ─────────────────────────────────────────────────────

// Parse a parameter count in billions from a model id/name. Matches "32b",
// "7B", "1.5b", "235B" (case-insensitive). Returns 0 when unknown (the fit
// engine still scores it, just from sizeBytes when present).
export function parseParams(name: string): number {
  const m = /(\d+(?:\.\d+)?)\s*[bB]\b/.exec(name);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : 0;
}

// Pull the GGUF quant tag out of a filename: "...-Q4_K_M.gguf" → "Q4_K_M",
// "...f16.gguf" → "F16". Returns null when no recognizable quant token.
function quantFromFilename(file: string): string | null {
  const base = file.replace(/\.gguf$/i, '');
  const q = /\b(Q\d+(?:_[A-Z0-9]+)*|IQ\d+(?:_[A-Z0-9]+)*|F16|BF16|F32)\b/i.exec(base);
  if (!q) return null;
  // Normalize case: quant tags are upper, the K/M suffixes upper too.
  return q[1].toUpperCase();
}

// Coarse arch family from the model name (feeds G1's KV-cache heuristics).
function archFromName(name: string): ModelSpec['arch'] {
  const n = name.toLowerCase();
  if (/qwen/.test(n)) return 'qwen';
  if (/gemma/.test(n)) return 'gemma';
  if (/mistral|mixtral/.test(n)) return 'mistral';
  if (/phi/.test(n)) return 'phi';
  if (/llama/.test(n)) return 'llama';
  return 'other';
}

// MoE heuristic: a name carrying "moe", a NxM expert pattern (e.g. 8x7b), the
// "A<n>B" active-experts naming (e.g. Qwen3-235B-A22B = 235B total / 22B
// active), or the mixtral family.
function detectMoe(name: string): boolean {
  const n = name.toLowerCase();
  return (
    /\bmoe\b/.test(n) ||
    /\d+x\d+\s*b\b/.test(n) ||
    /\d+\s*b[-_]a\d+(?:\.\d+)?\s*b/.test(n) ||
    /mixtral/.test(n)
  );
}

function lastSegment(id: string): string {
  const parts = id.split('/');
  return parts[parts.length - 1] || id;
}

// Normalize one HF repo into a CatalogModel (or null if it carries no GGUF
// variants we can score). Pure.
function normalizeHf(m: HfModel): CatalogModel | null {
  const repo = m.id || m.modelId || '';
  if (!repo) return null;
  const name = lastSegment(repo);
  const siblings = Array.isArray(m.siblings) ? m.siblings : [];
  const variants = new Set<string>();
  const sizeByQuant: Record<string, number> = {};
  for (const s of siblings) {
    const file = s.rfilename || '';
    if (!/\.gguf$/i.test(file)) continue;
    const q = quantFromFilename(file);
    if (!q) continue;
    variants.add(q);
    // PER-VARIANT size: keep the largest file for this quant (multi-part GGUFs
    // split across files, but the catalog only needs a representative size; the
    // params×bpw fallback covers the missing-size case). Keying by quant avoids
    // scoring a Q4 row with the Q8 file's bytes.
    if (typeof s.size === 'number' && s.size > (sizeByQuant[q] || 0)) sizeByQuant[q] = s.size;
  }
  // GGUF library repo with no parseable quant file — fall back to a single
  // Q4_K_M variant so the repo still appears with a sensible default.
  const quantVariants = variants.size > 0 ? [...variants] : ['Q4_K_M'];
  return {
    repo,
    name,
    params: parseParams(repo),
    quantVariants: quantVariants.sort(),
    sizeByQuant: Object.keys(sizeByQuant).length ? sizeByQuant : undefined,
    source: 'hf',
    task: m.pipeline_tag || undefined,
    moe: detectMoe(repo),
  };
}

// Normalize one Ollama library entry. Ollama serves Q4_K_M by default, so we
// surface a single Q4_K_M variant. `params` is the manifest's EXPLICIT total
// (preferred — it's correct for MoE, where the name tag understates the total);
// it falls back to parsing the name / size tags only if absent. `moe`/`task` come
// from the manifest, falling back to the name heuristic. Pure.
function normalizeOllama(m: OllamaModel): CatalogModel | null {
  const name = (m.name || '').trim();
  if (!name) return null;
  let params = typeof m.params === 'number' && m.params > 0 ? m.params : parseParams(name);
  if (!params && Array.isArray(m.sizes)) {
    for (const s of m.sizes) {
      const p = parseParams(s);
      if (p && (!params || p < params)) params = p;
    }
  }
  return {
    repo: name,
    name,
    params,
    quantVariants: ['Q4_K_M'],
    source: 'ollama',
    task: m.task,
    moe: typeof m.moe === 'boolean' ? m.moe : detectMoe(name),
  };
}

// ── Scoring + filtering (pure) ───────────────────────────────────────────────

function normalizeQuant(q: string): string {
  return q.trim().toUpperCase();
}

// True when a row's quant matches the operator's quant filter. Matches by
// family prefix so "Q4" keeps Q4_0 / Q4_K_S / Q4_K_M.
function quantMatches(rowQuant: string, filter: string): boolean {
  const f = normalizeQuant(filter);
  if (!f) return true;
  const r = normalizeQuant(rowQuant);
  return r === f || r.startsWith(f);
}

// Cross one normalized model's quant variants with scoreFit → rows. Pure.
function rowsForModel(model: CatalogModel, hw: HardwareProfile, quantFilter?: string): CatalogRow[] {
  const rows: CatalogRow[] = [];
  for (const variant of model.quantVariants) {
    const quant = normalizeQuant(variant);
    if (quantFilter && !quantMatches(quant, quantFilter)) continue;
    const sizeBytes = model.sizeByQuant?.[quant];
    const spec: ModelSpec = {
      params: model.params,
      quant,
      arch: model.moe ? 'moe' : archFromName(model.name),
      ...(sizeBytes ? { sizeBytes } : {}),
    };
    const fit = scoreFit(spec, hw);
    rows.push({
      repo: model.repo,
      name: model.name,
      params: model.params,
      quant,
      sizeBytes,
      source: model.source,
      task: model.task,
      moe: model.moe,
      spec,
      fit,
    });
  }
  return rows;
}

// Stable sort key: score desc, then params desc, then repo/quant asc — so
// identical inputs always yield byte-identical row order (determinism).
function sortRows(rows: CatalogRow[]): CatalogRow[] {
  return rows.slice().sort((a, b) => {
    if (b.fit.score !== a.fit.score) return b.fit.score - a.fit.score;
    if (b.params !== a.params) return b.params - a.params;
    if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
    return a.quant < b.quant ? -1 : a.quant > b.quant ? 1 : 0;
  });
}

// THE PURE FUNCTION the smoke calls. Given already-fetched raw source payloads +
// a HardwareProfile + the query, normalize both sources, cross every quant
// variant with scoreFit, apply the quant/task filters, and return rows sorted by
// SCORE desc. Deterministic: no clock, no random, no I/O — identical args yield
// identical output.
export function normalizeAndScore(
  raw: { hf: HfModel[]; ollama: OllamaModel[] },
  hw: HardwareProfile,
  query: CatalogQuery = {},
): CatalogRow[] {
  const models: CatalogModel[] = [];
  for (const m of raw.hf) {
    const n = normalizeHf(m);
    if (n) models.push(n);
  }
  for (const m of raw.ollama) {
    const n = normalizeOllama(m);
    if (n) models.push(n);
  }
  const taskFilter = (query.task || '').trim().toLowerCase();
  const rows: CatalogRow[] = [];
  for (const model of models) {
    if (taskFilter && (model.task || '').toLowerCase() !== taskFilter) continue;
    rows.push(...rowsForModel(model, hw, query.quant));
  }
  return sortRows(rows);
}

// ── Public search (wraps fetch + cache + the pure scorer) ────────────────────
//
// Called by the route. Fetches (or reuses cached) raw sources, scores them
// against the supplied profile, and assembles the CatalogResponse. The
// "trending that fits" feed is the same scored rows filtered to a fitting
// verdict — present only when no text query narrowed the search (so an empty
// search box still shows "what can I run?"). Never throws.
export async function searchCatalog(
  query: CatalogQuery,
  hw: HardwareProfile,
): Promise<CatalogResponse> {
  const key = cacheKey(query);
  const now = Date.now();
  let raw: RawSources;
  const cached = rawCache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) {
    raw = cached.raw;
  } else {
    raw = await fetchRawSources(query);
    // Cache only when the live HF fetch succeeded. The cache exists solely to
    // avoid re-hitting HF (Ollama is the bundled manifest — free to re-evaluate),
    // so a transient HF failure must NOT be pinned: skipping the cache lets the
    // next request retry HF instead of serving an HF-less catalog for the TTL.
    if (raw.hfOk) rawCache.set(key, { raw, at: now });
  }

  const rows = normalizeAndScore(raw, hw, query);

  // Ollama is the bundled manifest (always available); only HF (live) can fail.
  const sources = { hf: raw.hfOk, ollama: raw.ollamaOk };
  const note = raw.hfOk
    ? undefined
    : 'Hugging Face Hub is unreachable; showing the curated Ollama library only.';

  // Trending-that-fits: only when the operator hasn't typed a text query (the
  // "what can I even run?" default feed). It's the fitting rows from the same
  // scored set, capped.
  let trending: CatalogRow[] | undefined;
  if (!query.text || !query.text.trim()) {
    trending = rows.filter((r) => r.fit.verdict !== 'NO').slice(0, 12);
  }

  return { rows, hardware: hw, trending, sources, note };
}

// Test seam: clear the raw-source cache (used by smokes / a future rescan).
export function clearCatalogCache(): void {
  rawCache.clear();
}
