// VENDOR SHIM — replaces Odysseus `static/js/storage.js`.
//
// The upstream Storage module is a thin localStorage JSON helper used app-wide.
// In Archon the only consumer reaching this file is the vendored `dragSort.js`,
// which calls `Storage.setJSON(key, value)` to optionally persist a layer-order
// when a `storageKey` option is supplied. The editor never passes one, so this
// path is effectively dead — but we keep a faithful, dependency-free shim so the
// import resolves and the (unlikely) keyed call still works.
//
// See VENDOR.md "Local shim modules" for why this is a shim rather than a copy.

const Storage = {
  getJSON(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  setJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota / disabled storage — non-fatal for the editor */
    }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

export default Storage;
