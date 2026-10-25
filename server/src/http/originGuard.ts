// Origin / Host guard for the unauthenticated HTTP + WS surface.
//
// Loopback bind was the only gate, and it isn't one against the operator's
// own browser: every response carried `Access-Control-Allow-Origin: *` and no
// upgrade checked Origin, so any web page open in the browser could read files
// via fetch('http://127.0.0.1:3001/api/file-content?…'), POST file writes, or
// open ws://127.0.0.1:3001/terminal — a raw shell. DNS rebinding (evil.example
// resolving to 127.0.0.1) got past a CORS-only fix, so Host is checked too.
//
// Allowed names: loopback, any IP literal (rebinding needs a DNS name the
// attacker controls), this machine's hostname, Tailscale MagicDNS (*.ts.net),
// plus ARCHON_ALLOWED_HOSTS (comma-separated hostnames, `*.suffix` wildcards)
// for a reverse proxy or custom tunnel name. Requests with no Origin (curl,
// the hub link, server-to-server) pass — browsers always send Origin on the
// cross-origin requests that matter, and Sec-Fetch-Site covers no-cors GETs.

import type { IncomingMessage } from 'http';
import { isIP } from 'net';
import { hostname as osHostname } from 'os';

function extraAllowed(): string[] {
  return (process.env.ARCHON_ALLOWED_HOSTS ?? '')
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

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  // Sandboxed iframes and file:// pages send the literal "null".
  if (origin === 'null') return false;
  try {
    return isAllowedHostname(new URL(origin).hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

export type GuardVerdict = { ok: true; origin?: string } | { ok: false; reason: string };

export function checkRequestOrigin(req: IncomingMessage): GuardVerdict {
  if (!isAllowedHostHeader(req.headers.host)) {
    return { ok: false, reason: `host ${req.headers.host} not allowed` };
  }
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (origin !== undefined) {
    return isAllowedOrigin(origin) ? { ok: true, origin } : { ok: false, reason: `origin ${origin} not allowed` };
  }
  // No Origin: a same-origin GET, a non-browser client, or a cross-site
  // no-cors subresource (<img src>, <script src>). Only the last is hostile,
  // and browsers label it.
  // A top-level navigation from elsewhere (an ntfy notification link, a
  // bookmark page) is also cross-site with no Origin, and must still load the
  // app shell — but never an /api or /upload route.
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    const path = (req.url ?? '/').split('?')[0];
    const shellNavigation = req.method === 'GET'
      && req.headers['sec-fetch-mode'] === 'navigate'
      && !path.startsWith('/api') && !path.startsWith('/upload');
    if (!shellNavigation) return { ok: false, reason: 'cross-site request without an allowed origin' };
  }
  return { ok: true };
}
