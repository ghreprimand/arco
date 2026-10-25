// Persistence engine for the app store. Extracted verbatim from appStore.ts
// (Phase 5 file-size refactor), then reworked 2026-06-12: the original wrapped
// createJSONStorage, which JSON.stringifies the ENTIRE partialized state on
// EVERY store update — the debounce only delayed the localStorage write, not
// the serialization. With a multi-MB jobs slice that's a 10-50ms main-thread
// tax per set(), and a cluster-snapshot restore (thousands of set() calls in
// one task) compounded it into a minutes-long freeze → WS backpressure → the
// server's zombie-socket heartbeat terminated the client mid-replay. This
// storage holds the partialized state OBJECT (immutable — Zustand never
// mutates in place) and stringifies exactly once, at flush time.
import type { PersistStorage, StorageValue } from 'zustand/middleware';
import { PERSIST_DEBOUNCE_MS } from './memoryTrim';

export function debouncedJSONStorage<S>(): PersistStorage<S> {
  let pending: { key: string; value: StorageValue<S> } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (pending) {
      try {
        localStorage.setItem(pending.key, JSON.stringify(pending.value));
      } catch (err) {
        // Quota overflow keeps the PREVIOUS persisted state (the write is
        // atomic per key) — survivable, but silent loss masked the 2026-06-12
        // blank-workers debugging, so at least say it happened.
        console.warn('[archon] persist flush failed (localStorage quota?):', err);
      }
      pending = null;
    }
    timer = null;
  };
  // Flush synchronously when the tab becomes hidden (`visibilitychange` is
  // more reliable than `beforeunload` — Safari mobile in particular skips
  // beforeunload). Catches the case where the operator closes the tab or
  // the browser crashes mid-debounce-window — without this, drafts and
  // tab state queued in `pending` are lost.
  if (typeof window !== 'undefined') {
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
  }
  return {
    getItem: (key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      try { return JSON.parse(raw) as StorageValue<S>; } catch { return null; }
    },
    setItem: (key, value) => {
      pending = { key, value };
      if (!timer) timer = setTimeout(flush, PERSIST_DEBOUNCE_MS);
    },
    removeItem: (key) => {
      pending = null;
      if (timer) { clearTimeout(timer); timer = null; }
      localStorage.removeItem(key);
    },
  };
}
