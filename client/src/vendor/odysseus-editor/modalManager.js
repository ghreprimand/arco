// VENDOR SHIM — replaces Odysseus `static/js/modalManager.js`.
//
// The upstream modalManager (1507 lines) is the whole Odysseus app's
// floating-window / tile-dock / minimise-to-chip system, and it transitively
// imports tileManager + modalSnap. The vendored editor uses it ONLY to let two
// detachable popups (the History panel and the per-adjustment FX popup) minimise
// into a dock chip and restore later — a pure nicety. The methods touched are:
//   register(id, { restoreFn, closeFn, ... })
//   unregister(id)
//   minimize(id)
//   restore(id)
// We provide a no-op-ish shim: register/unregister track nothing meaningful,
// minimize hides the popup's element (best-effort, via the restoreFn contract),
// and restore re-shows it. The dock-chip UI is dropped — minimising simply hides
// the popup and restore brings it back if the caller wired a restoreFn. This is
// a deliberate alpha simplification (the editor's core never depends on docking).
//
// See VENDOR.md "Local shim modules".

const _entries = new Map();

export function register(id, opts = {}) {
  _entries.set(id, {
    restoreFn: opts.restoreFn || (() => {}),
    closeFn: opts.closeFn || (() => {}),
    isMinimized: false,
  });
}

export function unregister(id) {
  _entries.delete(id);
}

export function minimize(id) {
  const e = _entries.get(id);
  if (!e) return;
  e.isMinimized = true;
  // No dock chip in Arco — the popup's own minimise button already hides its
  // element before calling us in the upstream flow; nothing more to do here.
}

export function restore(id) {
  const e = _entries.get(id);
  if (!e) return;
  e.isMinimized = false;
  try { e.restoreFn(); } catch { /* best-effort */ }
}

const modalManager = { register, unregister, minimize, restore };
export default modalManager;
