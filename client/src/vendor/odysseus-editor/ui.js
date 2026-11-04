// VENDOR SHIM — replaces Odysseus `static/js/ui.js`.
//
// The upstream ui.js (1255 lines) is the whole Odysseus app's UI helper layer
// (toasts, modal-aware confirm/prompt, history autoscroll, clipboard, theme
// hooks) and it transitively imports the app's theme + modalManager. The
// vendored editor only ever touches THREE of its methods —
//   uiModule.showToast(msg, durationOrOpts)
//   uiModule.showError(msg)
//   uiModule.styledConfirm(message, opts) -> Promise<boolean>
// — so rather than drag in the entire windowing tree we provide a small,
// self-contained, Arco-themed shim. Toasts render as a transient bottom-centre
// pill using Arco's CSS vars; styledConfirm falls back to the native
// window.confirm (the only consumer is the "flatten the base layer?" guard in
// layer-panel.js, where a plain confirm is perfectly adequate for the alpha).
//
// See VENDOR.md "Local shim modules".

function ensureToastHost() {
  let host = document.getElementById('ge-vendor-toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ge-vendor-toast-host';
    host.style.cssText =
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
      'z-index:2147483000;display:flex;flex-direction:column;gap:8px;' +
      'align-items:center;pointer-events:none;';
    document.body.appendChild(host);
  }
  return host;
}

function toast(msg, { error = false, duration = 2600 } = {}) {
  if (typeof document === 'undefined' || !msg) return;
  const host = ensureToastHost();
  const pill = document.createElement('div');
  pill.textContent = String(msg);
  pill.style.cssText =
    'pointer-events:auto;max-width:480px;padding:8px 14px;border-radius:4px;' +
    'font-family:var(--font-body,system-ui);font-size:13px;line-height:1.4;' +
    'box-shadow:0 4px 18px rgba(0,0,0,0.45);opacity:0;transition:opacity .15s;' +
    `background:var(--color-bg-elevated,#1a1a1a);` +
    `color:${error ? 'var(--color-danger,#e06c75)' : 'var(--color-fg,#9cdef2)'};` +
    `border:1px solid ${error ? 'var(--color-danger,#e06c75)' : 'var(--color-border-bright,#355a66)'};`;
  host.appendChild(pill);
  requestAnimationFrame(() => { pill.style.opacity = '1'; });
  const dur = typeof duration === 'number' ? duration : 2600;
  setTimeout(() => {
    pill.style.opacity = '0';
    setTimeout(() => pill.remove(), 200);
  }, dur);
}

export function showToast(msg, durationOrOpts) {
  const opts =
    typeof durationOrOpts === 'number' ? { duration: durationOrOpts }
    : (durationOrOpts || {});
  toast(msg, opts);
}

export function showError(msg) {
  toast(msg, { error: true, duration: 5000 });
}

// Upstream renders a themed modal and resolves a Promise<boolean>. The native
// confirm is synchronous but returns a boolean; wrapping it in Promise.resolve
// keeps the `await`-ing call site (layer-panel.js base-layer guard) correct.
export function styledConfirm(message /*, opts */) {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
    return Promise.resolve(true);
  }
  return Promise.resolve(window.confirm(String(message)));
}

// Prompt parity for the (rare) call paths that reach for it; not used by the
// vendored editor today but kept so a future un-stub doesn't surprise-break.
export function styledPrompt(message, { defaultValue = '' } = {}) {
  if (typeof window === 'undefined' || typeof window.prompt !== 'function') {
    return Promise.resolve(null);
  }
  return Promise.resolve(window.prompt(String(message), defaultValue));
}

const uiModule = { showToast, showError, styledConfirm, styledPrompt };
export default uiModule;
