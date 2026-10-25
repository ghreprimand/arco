import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createProxyMiddleware } from 'http-proxy-middleware';
import type { IncomingMessage } from 'http';

// Ports come from the launcher when present (which probes for free ports
// before invoking npm run dev). Defaults match the historical hardcoded
// values so `npm run dev` from a shell still works.
const CLIENT_PORT = Number(process.env.ARCHON_CLIENT_PORT ?? 5173);
const SERVER_PORT = Number(process.env.ARCHON_PORT ?? 3001);
const SERVER_TARGET = `http://localhost:${SERVER_PORT}`;

// True when the request looks like a sub-resource fetched from inside a
// Preview-tab iframe — the iframe URL is `/api/preview/<wfid>/`, so the
// browser's Referer header points back to that path. We forward those to
// the Archon server, which has the per-workflow port mapping in memory and
// already implements a Referer fallback (server/src/previewProxy.ts).
//
// Why this exists: the dev server's HTML uses absolute paths (Vite emits
// `/src/main.tsx`, `/@vite/client`, etc.). The browser resolves those
// against the iframe's origin = Archon's :5173, where Vite would otherwise
// try to serve them out of Archon's own source tree (wrong file, wrong
// MIME). The proxy short-circuits that for any request whose Referer
// proves it came from the iframe.
//
// The Referer chain problem: when main.ts (proxied) imports
// /src/render/terminal.ts, the browser sets Referer to main.ts's URL, NOT
// the iframe URL. Our regex would miss those, Vite would 404/SPA-fallback,
// and the iframe goes white. Fix: every URL we proxy gets "blessed" for a
// short TTL — sub-imports whose Referer is a blessed URL also match. The
// blessing spreads transitively along the import chain.
const PREVIEW_REFERER_RE = /\/api\/preview\/([a-zA-Z0-9-]{1,64})\//;
const BLESS_TTL_MS = 60_000;
// path → { wfid, expireAt }. Tracking wfid here lets us rewrite sub-import
// URLs to include the explicit `/api/preview/<wfid>/` prefix when forwarding,
// so the server's prefix matcher catches them without needing Referer.
const blessedPaths = new Map<string, { wfid: string; expireAt: number }>();

function blessPath(path: string | undefined, wfid: string): void {
  if (!path) return;
  // Normalize off the query string — Vite's pre-bundled deps include `?v=hash`
  // versions and the Referer of their sub-imports does too, but `URL(ref).pathname`
  // (the lookup key) strips it. Without this, sub-chunks of `three.js?v=...`
  // miss the bless map and leak to Archon's own Vite.
  const pathname = path.split('?')[0];
  blessedPaths.set(pathname, { wfid, expireAt: Date.now() + BLESS_TTL_MS });
}
function lookupBlessedReferer(ref: string): string | null {
  let path: string;
  try { path = new URL(ref).pathname; } catch { return null; }
  const entry = blessedPaths.get(path);
  if (!entry) return null;
  if (entry.expireAt < Date.now()) { blessedPaths.delete(path); return null; }
  return entry.wfid;
}
// Returns the preview wfid if this request originates from a preview iframe
// (directly or transitively via the import chain), or null otherwise.
function previewWfidForRequest(req: IncomingMessage): string | null {
  const ref = req.headers.referer;
  if (typeof ref !== 'string') return null;
  const m = PREVIEW_REFERER_RE.exec(ref);
  if (m) return m[1];
  return lookupBlessedReferer(ref);
}

console.log('[archon-vite-preview] plugin loaded — preview-referer proxy active');

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'archon-ws-proxy',
      configureServer(server) {
        // Create the WS proxy ONCE, at startup. The prior shape created a fresh
        // createProxyMiddleware on EVERY upgrade event and called `.upgrade()`
        // synchronously — each call spins up a new internal http-proxy whose WS
        // setup races the synchronous upgrade, intermittently corrupting the
        // handshake ("Invalid frame header" / "WebSocket is closed before the
        // connection is established"). `/ws` survived because the client's
        // useWebSocket RETRIES, so the flakiness read as harmless reconnect
        // noise; `/terminal` (XtermView, no retry) had no such cover and went
        // permanently dead. A single long-lived instance — the documented
        // http-proxy-middleware v3 pattern — is ready before any upgrade fires
        // and removes the race.
        const wsProxy = createProxyMiddleware({
          target: SERVER_TARGET,
          ws: true,
          changeOrigin: true,
        });
        // Intercept WebSocket upgrades and proxy them to the Archon server.
        // `/ws` = the main seq'd protocol; `/terminal` = the operator-PTY raw
        // stream (XtermView / K4 pop-out) — both must reach the server, else the
        // in-app terminal AND the pop-out are dead in the browser / over a 5173
        // tunnel (the terminal smokes miss this — they hit :3001 direct). Also
        // catches WS upgrades from inside a Preview iframe so HMR keeps working
        // through the proxy. Vite's own HMR handler keys off the `vite-hmr`
        // subprotocol, which a bare `new WebSocket('/terminal'|'/ws')` never
        // sends, so claiming these here can't collide with HMR.
        server.httpServer?.on('upgrade', (req, socket, head) => {
          const previewWfid = previewWfidForRequest(req);
          const wsPath = (req.url || '').split('?')[0];
          if (wsPath === '/ws' || wsPath === '/terminal' || previewWfid) {
            if (previewWfid) console.log('[archon-vite-preview] WS upgrade wfid=', previewWfid, 'ref=', req.headers.referer);
            wsProxy.upgrade!(req, socket, head);
          }
        });
      },
    },
  ],
  server: {
    port: CLIENT_PORT,
    host: true,
    // Launcher already chose a free port; if vite can't bind it, fail
    // loudly rather than silently sliding to the next port (which would
    // diverge from $URL and break the launcher's wait_ready check).
    strictPort: true,
    proxy: {
      '/upload': { target: SERVER_TARGET, changeOrigin: true },
      '/health': { target: SERVER_TARGET, changeOrigin: true },
      '/api': { target: SERVER_TARGET, changeOrigin: true },
      // Catch-all for iframe sub-resources whose absolute paths land at
      // Vite. The bypass function returns `req.url` to SKIP the proxy
      // (Vite serves the request normally) and `undefined` to PROXY. We
      // proxy whenever the Referer points to a preview iframe; everything
      // else falls through to Vite's transform pipeline. Using
      // `server.proxy` instead of `server.middlewares.use` because the
      // latter loses the race against Vite's transformMiddleware for
      // `/src/*`, `/@vite/*`, `/@fs/*` paths in Vite 6.
      '^/.*': {
        target: SERVER_TARGET,
        changeOrigin: true,
        bypass(req) {
          const wfid = previewWfidForRequest(req);
          if (!wfid) return req.url; // not a preview request — let Vite handle
          // Rewrite to the explicit-prefix URL so the server's PREFIX_RE
          // matcher catches it without needing Referer. Bless the ORIGINAL
          // path so chained sub-imports referring back to it via Referer
          // still resolve to the same wfid.
          blessPath(req.url, wfid);
          const original = req.url || '/';
          (req as { url?: string }).url = `/api/preview/${wfid}${original}`;
          console.log('[archon-vite-preview] PROXY', req.method, original, '→', req.url);
          return undefined; // proceed with proxy
        },
      },
    },
  },
});
