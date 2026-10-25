// Prod serves client/dist from disk, so a rebuild swaps the bundle under an
// open tab without telling it. 2026-10-17: Computer answered "Unknown tool."
// for arco_screen because the tab was on a bundle from before the tool
// existed, and nothing on screen said so. After every WebSocket open (the
// server just restarted, or the tab just loaded) compare the bundle that
// index.html now references with the one this tab is running; when they
// differ, raise the RELOAD banner (StaleBuildBanner). Dev (Vite) has no
// hashed bundle and is skipped.
import { create } from 'zustand';

export const useBuildStore = create<{ stale: boolean; setStale: (stale: boolean) => void }>((set) => ({ stale: false, setStale: (stale) => set({ stale }) }));

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
    useBuildStore.getState().setStale(stale);
    return stale;
  } catch { return false; }
}
