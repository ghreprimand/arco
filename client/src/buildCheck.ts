// Prod serves client/dist from disk, so a rebuild swaps the bundle under an
// open tab without telling it.: Computer answered "Unknown tool."
// for arco_screen because the tab was on a bundle from before the tool
// existed, and nothing on screen said so. After every WebSocket open (the
// server just restarted, or the tab just loaded) compare the bundle that
// index.html now references with the one this tab is running; when they
// differ, raise the RELOAD banner (StaleBuildBanner). Dev (Vite) has no
// hashed bundle and is skipped.
import { create } from 'zustand';
import { useAppStore } from './stores/appStore';
import { useDraftStore } from './stores/draftStore';

type RecoveryReason = 'build' | 'session';
export const useBuildStore = create<{ stale: boolean; reason: RecoveryReason | null; setStale: (stale: boolean) => void }>((set) => ({ stale: false, reason: null, setStale: (stale) => set({ stale, reason: stale ? 'build' : null }) }));
const editedFields = new Set<Element>();
let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
const RELOAD_KEY = 'arco.recovery.reload';

// A changed field may belong to an unsaved form, editor or plan. Be
// conservative: keep the reload prompt while an edited field remains mounted.
export function startRecoveryGuard(): void {
  const mark = (event: Event) => {
    if (event.target instanceof Element && !event.target.hasAttribute('data-recovery-composer')) editedFields.add(event.target);
  };
  document.addEventListener('input', mark, true);
  document.addEventListener('change', mark, true);
}

export function hasUnsavedWork(): boolean {
  const app = useAppStore.getState();
  for (const field of editedFields) if (!field.isConnected) editedFields.delete(field);
  return editedFields.size > 0 || Object.values(useDraftStore.getState().drafts).some((draft) => draft.length > 0)
    || Object.values(app.attachments).some((attachments) => attachments.length > 0)
    || Object.values(app.jobs).some((job) => job.config.incognito)
    || Boolean(document.querySelector('[role="dialog"], [data-dialog-shell], dialog[open], [contenteditable="true"]:focus'));
}

export function reportRecovery(reason: RecoveryReason): void {
  useBuildStore.setState({ stale: true, reason });
  if (recoveryTimer) return;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = undefined;
    if (hasUnsavedWork()) return;
    try {
      const previous = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
      if (Date.now() - previous < 60_000) return;
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      window.location.reload();
    } catch { /* If storage is unavailable, keep the visible reload action. */ }
  }, 1000);
}

export const bundleOf = (html: string): string | null => html.match(/<script[^>]+src="([^"]*\/assets\/index-[^"]+\.js)"/)?.[1] ?? null;

export function runningBundle(doc: Document = document): string | null {
  for (const s of Array.from(doc.querySelectorAll('script[type="module"][src]'))) {
    const src = s.getAttribute('src') ?? '';
    if (/\/assets\/index-[^/]+\.js$/.test(src)) return src;
  }
  return null;
}

export async function checkBuild(): Promise<boolean> {
  const running = runningBundle();
  if (!running) return false;
  try {
    const res = await fetch(`/index.html?build=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return false;
    const served = bundleOf(await res.text());
    const stale = !!served && served !== running;
    if (stale) reportRecovery('build');
    return stale;
  } catch { return false; }
}
