// Session cookie for the server's operator gate (server/src/http/wsAuth.ts):
// `/ws` + `/terminal` upgrades and every non-agent `/api/*` + `/upload` route
// need it. The cookie is HttpOnly (page JS never sees the token), session-only
// (no Max-Age), capped at an hour server-side, and invalidated by every server
// restart (per-boot signing key). So:
//   - sockets mint right before every connect (ensureWsSession),
//   - a timer re-mints well inside the TTL (startSessionRefresh),
//   - fetches to gated routes re-mint and retry once on a 401
//     (installSessionFetch) — covers the restart gap and boot-time races.

import { reportRecovery } from '../buildCheck';

const REFRESH_MS = 20 * 60 * 1000;
const nativeFetch: typeof fetch = window.fetch.bind(window);
let inflight: Promise<void> | null = null;

// Best-effort — a failed mint just means the next gated request 401s and the
// caller's normal error/reconnect path runs. Concurrent callers share one mint.
export function ensureWsSession(): Promise<void> {
  if (!inflight) {
    inflight = nativeFetch('/api/session', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
      .then(() => undefined, () => undefined)
      .finally(() => { inflight = null; });
  }
  return inflight;
}

function isGatedUrl(input: RequestInfo | URL): boolean {
  let url: URL;
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    url = new URL(raw, window.location.href);
  } catch {
    return false;
  }
  if (url.origin !== window.location.origin) return false;
  if (url.pathname === '/api/session') return false;
  return url.pathname.startsWith('/api/') || url.pathname === '/upload';
}

export function installSessionFetch(): void {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let replay: Request | undefined;
    if (typeof input !== 'string' && !(input instanceof URL) && !init?.body) {
      try { replay = input.clone(); } catch { /* The body is already in use. */ }
    }
    const res = await nativeFetch(input, init);
    if (res.status !== 401 || !isGatedUrl(input)) return res;
    await ensureWsSession();
    // Do not resend a Request if its body could not be copied safely.
    if (typeof input !== 'string' && !(input instanceof URL) && !replay) { reportRecovery('session'); return res; }
    const retry = await nativeFetch(replay ?? input, init);
    if (retry.status === 401) reportRecovery('session');
    return retry;
  };
}

export function startSessionRefresh(): void {
  void ensureWsSession();
  setInterval(() => { void ensureWsSession(); }, REFRESH_MS);
  // A laptop waking from sleep can be past the TTL; re-mint when the tab
  // comes back so <a href>/<img> loads (which can't retry) still carry it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void ensureWsSession();
  });
}
