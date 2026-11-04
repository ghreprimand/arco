// Per-workflow dev-server proxy. The Preview tab loads
// `/api/preview/<workflowId>/` in an iframe; the operator binds a port for
// each workflow (set_preview_port WS message) and this module forwards every
// request scoped to that workflow's wfid to 127.0.0.1:<port>.
//
// Why a proxy instead of direct iframe-to-localhost: Arco is commonly
// accessed remotely with only port 5173 forwarded. A naked iframe to
// `http://localhost:5173` would hit the OPERATOR's localhost (Arco's own
// client), not the dev server on the SERVER's box. Same-origin proxy means
// the iframe always works regardless of forwarding setup.
//
// Two entry paths handle the same target:
//   1. Explicit prefix:  /api/preview/<wfid>/<rest>  → backend /<rest>
//   2. Referer fallback: any unmatched request whose Referer points back to
//      a /api/preview/<wfid>/ page → forward as-is to that wfid's backend.
// The fallback is what makes Vite's absolute paths (`/@vite/client`,
// `/src/main.tsx`) work without per-project base-url config — the browser
// requests them from Arco's origin with the iframe's URL as Referer, and
// we route them back through the right backend.

import http, { IncomingMessage, ServerResponse } from 'http';
import type { Duplex } from 'stream';

const WFID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const PREFIX_RE = /^\/api\/preview\/([a-zA-Z0-9-]{1,64})(\/.*)?$/;
const REFERER_RE = /\/api\/preview\/([a-zA-Z0-9-]{1,64})\//;

// RFC 7230 §6.1 — connection-specific headers MUST NOT be forwarded by proxies.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export type PortLookup = (wfid: string) => number | undefined;

// Match the request to a (wfid, backendPath) pair. `allowReferer` controls
// whether the Referer-based fallback is considered: it's safe at the 404
// fallback point (the request would have died anyway) but dangerous at the
// top of the route table (a stale iframe's Referer would hijack legitimate
// Arco API requests originating from another tab).
function resolveTarget(
  req: IncomingMessage,
  allowReferer: boolean,
): { wfid: string; backendPath: string } | null {
  const url = req.url || '/';
  const m = PREFIX_RE.exec(url);
  if (m) {
    return { wfid: m[1], backendPath: m[2] || '/' };
  }
  if (!allowReferer) return null;
  const ref = req.headers.referer;
  if (typeof ref === 'string') {
    const rm = REFERER_RE.exec(ref);
    if (rm && WFID_PATTERN.test(rm[1])) {
      return { wfid: rm[1], backendPath: url };
    }
  }
  return null;
}

// Forward an HTTP request to the workflow's dev server. Returns true when
// handled (responded to or errored), false when the request didn't match a
// preview route (so the caller can fall through to other routes).
export function tryHandlePreviewRequest(
  req: IncomingMessage,
  res: ServerResponse,
  lookupPort: PortLookup,
  opts: { allowReferer?: boolean } = {},
): boolean {
  const target = resolveTarget(req, opts.allowReferer === true);
  if (!target) return false;
  const port = lookupPort(target.wfid);
  console.log(`[arco-preview-proxy] ${req.method} ${req.url} → wfid=${target.wfid.slice(0, 8)} port=${port ?? 'UNBOUND'} backend=${target.backendPath}`);
  if (!port) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Preview backend not configured for this workflow.');
    return true;
  }

  // Strip hop-by-hop and framework-confusing headers before forwarding. We
  // pass Referer through untouched — Vite's HMR client uses it to authenticate
  // WS upgrades.
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'content-length') continue;
    if (HOP_BY_HOP.has(lk)) continue;
    headers[k] = v as string | string[];
  }
  headers['host'] = `127.0.0.1:${port}`;

  const upstream = http.request(
    {
      host: '127.0.0.1',
      port,
      method: req.method,
      path: target.backendPath,
      headers,
    },
    (proxyRes) => {
      const out: Record<string, string | string[] | number> = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (v === undefined) continue;
        const lk = k.toLowerCase();
        // Strip hop-by-hop headers (RFC 7230 §6.1). Forwarding upstream's
        // `connection`/`keep-alive` across the 5181→3001→5173→browser chain
        // confused Firefox's HTTP parser on parallel module fetches and
        // produced NS_ERROR_CORRUPTED_CONTENT for everything after main.ts.
        if (HOP_BY_HOP.has(lk)) continue;
        out[k] = v as string | string[];
      }
      // Force no-store so Firefox can't poison itself with a stale text/html
      // response (Vite's SPA fallback) cached against a JS module URL — once
      // that happens, hard-reload only revalidates and the bad MIME sticks.
      out['cache-control'] = 'no-store, must-revalidate';
      delete out['etag'];
      // One connection per request. Eliminates any chance of the double-proxy
      // chain misaligning response boundaries on a reused keep-alive socket.
      out['connection'] = 'close';
      res.writeHead(proxyRes.statusCode || 502, out);
      proxyRes.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (res.headersSent) {
      try { res.end(); } catch { /* ignore */ }
      return;
    }
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Preview backend unreachable: ${(err as Error).message}`);
  });
  req.pipe(upstream);
  return true;
}

// Forward a WS upgrade to the workflow's dev server. Vite's HMR talks WS
// over the same origin as the page; this is what keeps hot reload working
// without the operator wiring it up. Returns true when handled.
export function tryHandlePreviewUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  lookupPort: PortLookup,
  opts: { allowReferer?: boolean } = {},
): boolean {
  const target = resolveTarget(req, opts.allowReferer === true);
  if (!target) return false;
  const port = lookupPort(target.wfid);
  if (!port) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return true;
  }

  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'content-length') continue;
    headers[k] = v as string | string[];
  }
  headers['host'] = `127.0.0.1:${port}`;

  const upstream = http.request({
    host: '127.0.0.1',
    port,
    method: 'GET',
    path: target.backendPath,
    headers,
  });
  upstream.on('error', () => {
    try { socket.destroy(); } catch { /* ignore */ }
  });
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    const lines = [
      `HTTP/1.1 ${upRes.statusCode || 101} ${upRes.statusMessage || 'Switching Protocols'}`,
    ];
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) lines.push(`${k}: ${item}`);
      } else {
        lines.push(`${k}: ${v}`);
      }
    }
    lines.push('', '');
    socket.write(lines.join('\r\n'));
    if (upHead && upHead.length > 0) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    upSocket.on('error', () => { try { socket.destroy(); } catch { /* ignore */ } });
    socket.on('error', () => { try { upSocket.destroy(); } catch { /* ignore */ } });
  });
  upstream.end(head);
  return true;
}
