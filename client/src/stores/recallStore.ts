import { create } from 'zustand';
import type {
  RecallEntry, RecallIndexResponse, ProviderName,
  RecallSearchHit, RecallSearchResponse,
  RecallLink, RecallEntryResponse,
} from '@arco/shared';

// Workbench Expansion §F1 + §F3 — Recall client store.
//
// Kept OUT of appStore (mirrors terminalStore): the Recall index is a global,
// cross-workflow projection fetched on demand — not per-tab session state and
// not persisted. F1 added the index list + fetch; F3 adds the search slice
// (hits + filters + a debounced-by-the-view runSearch) backing the top-level
// Recall view.

export interface RecallSearchFilters {
  q: string;
  project: string;
  provider: ProviderName | '';
  // Inclusive date bounds as yyyy-mm-dd strings (the <input type=date> shape);
  // the view converts to epoch-ms before hitting the endpoint.
  from: string;
  to: string;
  includeTranscripts: boolean;
}

export const EMPTY_FILTERS: RecallSearchFilters = {
  q: '', project: '', provider: '', from: '', to: '', includeTranscripts: false,
};

interface RecallState {
  // F1 — index list.
  entries: RecallEntry[];
  loading: boolean;
  error: string | null;
  fetchIndex: (filter?: { project?: string; provider?: ProviderName }) => Promise<void>;

  // F3 — search.
  hits: RecallSearchHit[];
  searching: boolean;
  searchError: string | null;
  transcriptsAvailable: boolean;
  runSearch: (filters: RecallSearchFilters) => Promise<void>;

  // F2 — conversation summaries. `summaryBodies` caches fetched summary.md
  // text by wfid (so re-opening is instant); `summarizing` is the per-wfid
  // in-flight set (drives the row's button label). `summaryError` is a
  // transient per-wfid message surfaced inline.
  summaryBodies: Record<string, string>;
  summarizing: Record<string, boolean>;
  summaryError: Record<string, string | undefined>;
  // §F2 step 3 — operator-armed "summarize on tab close" toggle. DEFAULT OFF
  // (mirrors the cluster idle-nudger precedent). When armed, closing a tab
  // OFFERS to summarize (operator confirms) → fires recall_summary_request. It
  // NEVER auto-summarizes without the operator's explicit arm + confirm.
  // Persisted to localStorage so the arm survives reloads. The close-hook
  // consumer is a documented TODO (see SUMMARIZE_ON_CLOSE_KEY below).
  summarizeOnClose: boolean;
  setSummarizeOnClose: (on: boolean) => void;
  // Fetch a saved summary body over HTTP. Returns the text or null (404 / no
  // summary yet). Caches on success.
  fetchSummary: (wfid: string) => Promise<string | null>;
  // Mark a wfid as summary-generation-in-flight (the view calls requestSummary
  // over WS, then this so the row shows "Summarizing…").
  setSummarizing: (wfid: string, on: boolean) => void;
  // Handle the server's recall_summary_ready: clear the in-flight flag, refresh
  // the index entry's summaryRef in `hits`, and (on success) pre-fetch the body.
  onSummaryReady: (wfid: string, summaryRef: string | null, ok: boolean, error?: string) => Promise<void>;

  // ── F4 — tags + pin-as-memory + links (operator CRUD over HTTP) ──
  // Each mutation POSTs/DELETEs to the F4 route, then folds the server's
  // returned RecallEntry back onto the matching hit (the server is the source of
  // truth). No new WS surface. All operator-initiated and reversible — pin is
  // NOT the fenced self-writing memory (no LLM, manual mark of the operator's
  // OWN conversation). Returns the updated entry or null on failure.
  setTags: (wfid: string, tags: string[]) => Promise<RecallEntry | null>;
  setPinned: (wfid: string, pinned: boolean) => Promise<RecallEntry | null>;
  addLink: (wfid: string, link: RecallLink) => Promise<RecallEntry | null>;
  removeLink: (wfid: string, link: RecallLink) => Promise<RecallEntry | null>;
}

// §F2 step 3 — localStorage key for the operator-armed on-close toggle.
const SUMMARIZE_ON_CLOSE_KEY = 'arco.recall.summarizeOnClose';

function readSummarizeOnClose(): boolean {
  try {
    return localStorage.getItem(SUMMARIZE_ON_CLOSE_KEY) === '1';
  } catch {
    return false; // default OFF
  }
}

function epochOf(dateStr: string, endOfDay: boolean): number | undefined {
  if (!dateStr) return undefined;
  const d = new Date(dateStr + (endOfDay ? 'T23:59:59.999' : 'T00:00:00.000'));
  const t = d.getTime();
  return Number.isFinite(t) ? t : undefined;
}

export const useRecallStore = create<RecallState>((set) => ({
  entries: [],
  loading: false,
  error: null,
  fetchIndex: async (filter) => {
    set({ loading: true, error: null });
    try {
      const params = new URLSearchParams();
      if (filter?.project) params.set('project', filter.project);
      if (filter?.provider) params.set('provider', filter.provider);
      const qs = params.toString();
      const res = await fetch(`/api/recall/index${qs ? `?${qs}` : ''}`);
      const body = (await res.json()) as RecallIndexResponse;
      set({ entries: body.entries ?? [], loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },

  hits: [],
  searching: false,
  searchError: null,
  transcriptsAvailable: true,
  runSearch: async (filters) => {
    set({ searching: true, searchError: null });
    try {
      const params = new URLSearchParams();
      if (filters.q.trim()) params.set('q', filters.q.trim());
      if (filters.project) params.set('project', filters.project);
      if (filters.provider) params.set('provider', filters.provider);
      const from = epochOf(filters.from, false);
      const to = epochOf(filters.to, true);
      if (from !== undefined) params.set('from', String(from));
      if (to !== undefined) params.set('to', String(to));
      if (filters.includeTranscripts) params.set('transcripts', '1');
      const qs = params.toString();
      const res = await fetch(`/api/recall/search${qs ? `?${qs}` : ''}`);
      const body = (await res.json()) as RecallSearchResponse;
      set({
        hits: body.hits ?? [],
        transcriptsAvailable: body.transcriptsAvailable !== false,
        searching: false,
      });
    } catch (err) {
      set({ searchError: err instanceof Error ? err.message : String(err), searching: false });
    }
  },

  // ── F2 — summaries ──
  summaryBodies: {},
  summarizing: {},
  summaryError: {},
  summarizeOnClose: readSummarizeOnClose(),
  setSummarizeOnClose: (on) => {
    try { localStorage.setItem(SUMMARIZE_ON_CLOSE_KEY, on ? '1' : '0'); } catch { /* ignore */ }
    set({ summarizeOnClose: on });
  },
  fetchSummary: async (wfid) => {
    try {
      const res = await fetch(`/api/recall/summary?wfid=${encodeURIComponent(wfid)}`);
      if (!res.ok) return null;
      const body = (await res.json()) as { summary?: string };
      const text = typeof body.summary === 'string' ? body.summary : null;
      if (text != null) set((s) => ({ summaryBodies: { ...s.summaryBodies, [wfid]: text } }));
      return text;
    } catch {
      return null;
    }
  },
  setSummarizing: (wfid, on) =>
    set((s) => ({ summarizing: { ...s.summarizing, [wfid]: on } })),
  onSummaryReady: async (wfid, summaryRef, ok, error) => {
    set((s) => ({
      summarizing: { ...s.summarizing, [wfid]: false },
      summaryError: { ...s.summaryError, [wfid]: ok ? undefined : (error || undefined) },
      // Reflect the new ref on any matching hit so the row flips from
      // Summarize → Open summary without a full re-search.
      hits: summaryRef
        ? s.hits.map((h) => (h.wfid === wfid ? { ...h, summaryRef } : h))
        : s.hits,
    }));
    // Pre-fetch the body so the first "open" is instant (covers both the LLM
    // and deterministic-fallback paths — both wrote summary.md).
    if (summaryRef) await useRecallStore.getState().fetchSummary(wfid);
  },

  // ── F4 mutations ──
  setTags: async (wfid, tags) => mutate('/api/recall/tags', 'POST', { wfid, tags }, set),
  setPinned: async (wfid, pinned) => mutate('/api/recall/pin', 'POST', { wfid, pinned }, set),
  addLink: async (wfid, link) => mutate('/api/recall/link', 'POST', { wfid, link }, set),
  removeLink: async (wfid, link) => mutate('/api/recall/link', 'DELETE', { wfid, link }, set),
}));

// §F4 — POST/DELETE an F4 mutation route and fold the returned entry onto the
// matching hit (re-sorting pinned-first so a freshly pinned row jumps to top).
// Returns the updated entry or null on any failure (the caller surfaces a toast).
async function mutate(
  url: string,
  method: 'POST' | 'DELETE',
  payload: Record<string, unknown>,
  set: (fn: (s: RecallState) => Partial<RecallState>) => void,
): Promise<RecallEntry | null> {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as RecallEntryResponse;
    const entry = body.entry;
    if (!entry) return null;
    set((s) => ({ hits: foldEntryIntoHits(s.hits, entry) }));
    return entry;
  } catch {
    return null;
  }
}

// Replace the matching hit's F4 fields with the server's truth, then re-sort
// pinned-first (matching the server's ORDER BY pinned DESC, lastActiveAt DESC).
function foldEntryIntoHits(hits: RecallSearchHit[], entry: RecallEntry): RecallSearchHit[] {
  const next = hits.map((h) =>
    h.wfid === entry.wfid
      ? { ...h, tags: entry.tags, pinned: entry.pinned, links: entry.links }
      : h,
  );
  return [...next].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastActiveAt - a.lastActiveAt;
  });
}
