// ARCHIVE (docs/ARCHIVE_PLAN.md §3) — open the standalone explorer window.
//
// PRIMARY: `window.open` popup. It opens in the SAME browser instance that
// already renders the workspace, so it inherits that window's per-monitor DPI /
// display scaling automatically. A server-spawned `brave --app=` window is a
// fresh process that latches onto ONE scale factor and never re-scales per
// monitor — so it renders huge on a 1080p/1200p display and tiny on a 4K one.
// The popup also opens on the OPERATOR's machine (correct for remote/tunnelled
// use), whereas the workstation-side spawn would open on the workstation.
//
// The popup is chromeless-ish (no tabs/toolbar) in Chromium-family + Firefox and
// is not blocker-affected when triggered from a click (this always is).
//
// FALLBACK: only if the popup is refused (returns null) do we ask the server to
// spawn a chromeless `--app=` window; last resort is a plain new tab.

const EXPLORER_URL = '/?app=explorer';

// `lens` picks the landing lens (`&lens=plans` → the PLANS library). An
// already-open explorer window is re-navigated to it, not duplicated.
export async function openArchive(lens?: 'plans'): Promise<void> {
  const url = lens ? `${EXPLORER_URL}&lens=${lens}` : EXPLORER_URL;
  // Same-browser popup — inherits correct per-monitor DPI. Named so a second
  // click focuses the existing window instead of stacking duplicates.
  const win = window.open(url, 'arco-explorer', 'popup,width=1400,height=900');
  if (win) { win.focus(); return; }

  // Popup refused (rare for a user gesture) → server-spawned chromeless window.
  try {
    const res = await fetch('/api/explorer/open', { method: 'POST' });
    const body = (await res.json()) as { ok?: boolean };
    if (body.ok) return;
  } catch {
    /* fall through to a plain tab */
  }
  window.open(url, '_blank');
}
