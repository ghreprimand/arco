// Origin / Host guard for the unauthenticated HTTP + WS surface.
//
// Loopback bind was the only gate, and it isn't one against the operator's
// own browser: every response carried `Access-Control-Allow-Origin: *` and no
// upgrade checked Origin, so any web page open in the browser could read files
// via fetch('http://127.0.0.1:3001/api/file-content?…'), POST file writes, or
// open ws://127.0.0.1:3001/terminal — a raw shell. DNS rebinding (evil.example
// resolving to 127.0.0.1) got past a CORS-only fix, so Host is checked too.
//
// Host validation accepts local/IP/tailnet names and ARCO_ALLOWED_HOSTS.
// Browser origins use an independent exact scheme/host/port list: served
// local origins, the enabled development frontend, explicitly named remote
// hosts and ARCO_ALLOWED_ORIGINS. Requests from the served authority remain
// valid after Host validation. Host rules do not approve other browser
// authorities. Requests with no Origin (curl,
// the hub link, server-to-server) pass — browsers always send Origin on the
// cross-origin requests that matter, and Sec-Fetch-Site covers no-cors GETs.

import type { IncomingMessage } from 'http';
import { isIP } from 'net';
import { hostname as osHostname, networkInterfaces } from 'os';
import { PORT } from '../server/constants.js';

function extraAllowed(): string[] {
  return (process.env.ARCO_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function stripPort(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : h;
  }
  // Bare IPv6 without brackets has multiple colons — no port to strip.
  if (h.split(':').length > 2) return h;
  return h.replace(/:\d+$/, '');
}

export function isAllowedHostname(name: string): boolean {
  const h = name.replace(/\.$/, '').toLowerCase();
  if (!h) return false;
  if (isIP(h)) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const self = osHostname().toLowerCase();
  if (h === self || h === self.split('.')[0]) return true;
  if (h.endsWith('.ts.net')) return true;
  if (configuredOrigins().some(origin => new URL(origin).hostname.replace(/^\[|\]$/g, '') === h)) return true;
  for (const pat of extraAllowed()) {
    if (pat.startsWith('*.') ? h.endsWith(pat.slice(1)) : h === pat) return true;
  }
  return false;
}

export function isAllowedHostHeader(host: string | undefined): boolean {
  // HTTP/1.1 requires Host; a missing one is a hand-rolled client, not a
  // browser — let it through like any other Origin-less caller.
  if (!host) return true;
  return isAllowedHostname(stripPort(host));
}

// Browser authorities are full HTTP(S) origins. Host wildcards never expand
// this list: a reverse proxy using another port supplies its exact origin.
function configuredOrigins(): string[] {
  return (process.env.ARCO_ALLOWED_ORIGINS ?? '').split(',').flatMap(value => {
    try {
      const url = new URL(value.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return [];
      return [url.origin];
    } catch { return []; }
  });
}

function originFor(host: string, port: number, scheme = 'http:'): string | undefined {
  try { return new URL(`${scheme}//${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`).origin; }
  catch { return undefined; }
}

// A validated Host identifies the address presented to the browser. A proxy
// preserves that Host and overwrites X-Forwarded-Proto with its public scheme.
// This only constructs the CORS authority; it is not a TLS trust assertion.
function servedOrigin(req: IncomingMessage): string | undefined {
  if (!req.headers.host || !isAllowedHostHeader(req.headers.host)) return undefined;
  const scheme = (req.socket as { encrypted?: boolean } | undefined)?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
  try { return new URL(`${scheme}//${req.headers.host}`).origin; } catch { return undefined; }
}

function allowedOrigins(req?: IncomingMessage): Set<string> {
  const origins = new Set(configuredOrigins());
  const current = req && servedOrigin(req); if (current) origins.add(current);
  const self = osHostname().toLowerCase();
  const local = new Set(['localhost', '127.0.0.1', '::1', self, self.split('.')[0]]);
  for (const interfaces of Object.values(networkInterfaces())) for (const entry of interfaces ?? []) local.add(entry.address);
  const bind = process.env.ARCO_HOST;
  if (bind && bind !== '0.0.0.0' && bind !== '::') local.add(bind);
  const port = req?.socket?.localPort || PORT;
  const scheme = (req?.socket as { encrypted?: boolean } | undefined)?.encrypted ? 'https:' : 'http:';
  const dev = process.env.ARCO_SERVE_CLIENT !== '1';
  const frontendPort = Number(process.env.ARCO_CLIENT_PORT ?? 5173);
  for (const host of local) {
    const origin = originFor(host, port, scheme); if (origin) origins.add(origin);
    if (dev) { const frontend = originFor(host, frontendPort); if (frontend) origins.add(frontend); }
  }
  // Preserve explicitly named remote hosts at the server/dev port and the
  // conventional HTTPS proxy origin. Non-default proxy ports are explicit
  // ARCO_ALLOWED_ORIGINS entries. A *.suffix Host rule is not an origin rule.
  for (const host of extraAllowed().filter(host => !host.includes('*'))) {
    for (const origin of [originFor(host, port), originFor(host, 443, 'https:'), ...(dev ? [originFor(host, frontendPort)] : [])]) {
      if (origin) origins.add(origin);
    }
  }
  return origins;
}

export function isAllowedOrigin(origin: string | undefined, req?: IncomingMessage): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || origin !== url.origin) return false;
    return allowedOrigins(req).has(url.origin);
  } catch { return false; }
}

export type GuardVerdict = { ok: true; origin?: string } | { ok: false; reason: string };

export function checkRequestOrigin(req: IncomingMessage): GuardVerdict {
  if (!isAllowedHostHeader(req.headers.host)) {
    return { ok: false, reason: `host ${req.headers.host} not allowed` };
  }
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (origin !== undefined) {
    return isAllowedOrigin(origin, req) ? { ok: true, origin } : { ok: false, reason: `origin ${origin} not allowed` };
  }
  // No Origin: a same-origin GET, a non-browser client, or a cross-site
  // no-cors subresource (<img src>, <script src>). Only the last is hostile,
  // and browsers label it.
  // A top-level navigation from elsewhere (an ntfy notification link, a
  // bookmark page) is also cross-site with no Origin, and must still load the
  // app shell — but never an /api or /upload route.
  if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers['sec-fetch-site'] === 'same-site') {
    const path = (req.url ?? '/').split('?')[0];
    const shellNavigation = req.method === 'GET'
      && req.headers['sec-fetch-mode'] === 'navigate'
      && !path.startsWith('/api') && !path.startsWith('/upload');
    if (!shellNavigation) return { ok: false, reason: 'cross-site request without an allowed origin' };
  }
  return { ok: true };
}
