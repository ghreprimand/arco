import { create } from 'zustand';
import type {
  ProviderName,
  SessionIndexEntry,
  SessionIndexResponse,
  SessionIndexEntryResponse,
} from '@archon/shared';

// ARCHON_OPS_PLAN.md §H3 — resume-picker session-index client store.
//
// Kept OUT of appStore (mirrors recallStore / terminalStore): the session index
// is a per-cwd projection fetched on demand when the resume picker opens, not
// per-tab session state and not persisted. Holds the index entries for one cwd
// at a time plus the operator mutations (rename / pin / archive). Each mutation
// POSTs to the §H3 route and folds the server's returned entry back onto the
// matching row (the server is the source of truth) — no new WS surface.

// The entry key is (provider, sessionId); the picker merges these onto the
// discovered SessionInfo list by the same key.
export function entryKey(provider: ProviderName, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

interface SessionIndexState {
  // Keyed by `${provider}:${sessionId}` for O(1) merge against SessionInfo.
  entries: Record<string, SessionIndexEntry>;
  cwd: string;
  loading: boolean;
  error: string | null;
  // Fetch (and backfill, server-side) the index for a cwd.
  fetchIndex: (cwd: string) => Promise<void>;
  // Operator mutations — return the updated entry or null on failure (the view
  // surfaces a toast / refetch). Each folds the entry back into `entries`.
  rename: (cwd: string, provider: ProviderName, sessionId: string, title: string) => Promise<SessionIndexEntry | null>;
  setPinned: (cwd: string, provider: ProviderName, sessionId: string, pinned: boolean) => Promise<SessionIndexEntry | null>;
  setArchived: (cwd: string, provider: ProviderName, sessionId: string, archived: boolean) => Promise<SessionIndexEntry | null>;
}

function indexEntries(list: SessionIndexEntry[]): Record<string, SessionIndexEntry> {
  const out: Record<string, SessionIndexEntry> = {};
  for (const e of list) out[entryKey(e.provider, e.sessionId)] = e;
  return out;
}

export const useSessionIndexStore = create<SessionIndexState>((set) => ({
  entries: {},
  cwd: '',
  loading: false,
  error: null,

  fetchIndex: async (cwd) => {
    set({ loading: true, error: null, cwd });
    try {
      const res = await fetch(`/api/session-index?path=${encodeURIComponent(cwd)}`);
      const body = (await res.json()) as SessionIndexResponse;
      set({ entries: indexEntries(body.entries ?? []), loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },

  rename: (cwd, provider, sessionId, title) =>
    mutate(`/api/session-index/rename?path=${encodeURIComponent(cwd)}`, { provider, sessionId, title }, set),
  setPinned: (cwd, provider, sessionId, pinned) =>
    mutate(`/api/session-index/pin?path=${encodeURIComponent(cwd)}`, { provider, sessionId, pinned }, set),
  setArchived: (cwd, provider, sessionId, archived) =>
    mutate(`/api/session-index/archive?path=${encodeURIComponent(cwd)}`, { provider, sessionId, archived }, set),
}));

// POST a §H3 mutation and fold the returned entry back onto `entries`. Returns
// the entry (or null on failure / no-match).
async function mutate(
  url: string,
  payload: Record<string, unknown>,
  set: (fn: (s: SessionIndexState) => Partial<SessionIndexState>) => void,
): Promise<SessionIndexEntry | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as SessionIndexEntryResponse;
    const entry = body.entry;
    if (!entry) return null;
    set((s) => ({ entries: { ...s.entries, [entryKey(entry.provider, entry.sessionId)]: entry } }));
    return entry;
  } catch {
    return null;
  }
}
