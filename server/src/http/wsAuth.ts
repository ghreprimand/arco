// Session-cookie gate for the `/ws` control socket, the `/terminal` PTY
// channel, and the HTTP `/api/*` + `/upload` surface.
//
// The origin guard (originGuard.ts) stops hostile *web pages*; it lets any
// Origin-less client through by design. That left the control plane open to
// every local process — including the agents Arco itself spawns. 2026-10-10
// incident: a cluster Director grepped shared/src/protocol, then drove
// `cluster_dispatch_once` and `update_primary_config { goalRun }` from Bash
// over a hand-rolled Node `ws` client — operator-absent orchestration with AUTO-PICKUP / NUDGES / the dispatcher all OFF, because
// those toggles only fence Arco's own automation.
//
// Shape: an HMAC key lives in process memory only (never on disk, never in env,
// rotated every boot). `POST /api/session` mints a short-lived token into an
// HttpOnly SameSite=Strict cookie, and only for requests carrying the fetch
// metadata a browser attaches to a same-origin fetch from the Arco page. The
// WS upgrade then requires that cookie plus an allowed Origin. Page JS never
// sees the token; the client re-mints before every connect, so a server restart
// (new key) costs nothing.
//
// HTTP routes need the same cookie, EXCEPT the agent tool surface: cluster peer
// tools (`/api/clusters/:id/peer/*`, from the MCP children + Antigravity bridge)
// and plan tools (`/api/plans`, `/api/plans/attach`). Those are the bounded
// tools agents are meant to have; everything else is operator-only.
//
// The cookie carries no Max-Age (session cookie), so browsers keep it in memory
// rather than writing it to the on-disk cookie store another same-user process
// could read. Server-side TTL still caps it at an hour; the client re-mints
// on a timer and retries once on a 401.
//
// Limit, stated plainly: a same-user process that deliberately forges browser
// headers can still mint. This turns "read the protocol and script it" into
// explicit circumvention, and every mint / refusal is logged. It is not an OS
// sandbox.
//
// ARCO_WS_AUTH=off disables the gate for throwaway test servers (the smoke
// harness connects with a plain Node client). Never set it on arco.service.

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { IncomingMessage } from 'http';
import { PORT } from '../server/constants.js';

const KEY = randomBytes(32);
const TOKEN_TTL_MS = 60 * 60 * 1000;

// Cookies ignore the port, so a dev server and prod on one host would clobber
// each other's cookie under a shared name.
export const SESSION_COOKIE = `arco_session_${PORT}`;

export function wsAuthEnabled(): boolean {
  return (process.env.ARCO_WS_AUTH ?? '').trim().toLowerCase() !== 'off';
}

function sign(payload: string): string {
  return createHmac('sha256', KEY).update(payload).digest('base64url');
}

export function mintToken(now: number = Date.now()): string {
  const payload = `v1.${now}.${randomBytes(12).toString('base64url')}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined, now: number = Date.now()): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return false;
  const issuedAt = Number(parts[1]);
  if (!Number.isFinite(issuedAt) || issuedAt > now + 60_000 || now - issuedAt > TOKEN_TTL_MS) return false;
  const expected = Buffer.from(sign(parts.slice(0, 3).join('.')));
  const got = Buffer.from(parts[3]);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export type AuthVerdict = { ok: true } | { ok: false; reason: string };

// A same-origin `fetch()` from the Arco page. Node `ws`/`fetch`, curl, and
// cross-site pages don't produce this header set unless deliberately forged.
// Origin presence is required here; its *value* was already vetted by
// checkRequestOrigin before routing.
export function checkMintRequest(req: IncomingMessage): AuthVerdict {
  if (req.method !== 'POST') return { ok: false, reason: 'method' };
  if (typeof req.headers.origin !== 'string') return { ok: false, reason: 'no Origin header' };
  if (req.headers['sec-fetch-site'] !== 'same-origin') return { ok: false, reason: 'Sec-Fetch-Site is not same-origin' };
  const mode = req.headers['sec-fetch-mode'];
  if (mode !== 'cors' && mode !== 'same-origin') return { ok: false, reason: 'Sec-Fetch-Mode is not a page fetch' };
  if (req.headers['sec-fetch-dest'] !== 'empty') return { ok: false, reason: 'Sec-Fetch-Dest is not empty' };
  return { ok: true };
}

// No Max-Age / Expires on purpose — see header.
export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

// The agent tool surface — reachable without the cookie. Keep this list to
// endpoints an MCP child or bridge script calls by design.
const AGENT_TOOL_ROUTE = /^\/api\/clusters\/[^/]+\/peer\/[^/]+$/;
// `/api/voice/tool` is the arco-voice MCP child's relay (docs/VOICE.md);
// the route itself additionally refuses non-loopback peers.
const AGENT_TOOL_PATHS = new Set(['/api/plans', '/api/plans/attach', '/api/plans/refs', '/api/plans/refs/body', '/api/voice/tool']);

export function isAgentToolRoute(path: string): boolean {
  return AGENT_TOOL_PATHS.has(path) || AGENT_TOOL_ROUTE.test(path);
}

function needsHttpAuth(path: string): boolean {
  if (path === '/api/session') return false;
  if (path === '/upload' || path.startsWith('/upload/')) return true;
  if (path !== '/api' && !path.startsWith('/api/')) return false;
  return !isAgentToolRoute(path);
}

export function checkHttpAuth(req: IncomingMessage): AuthVerdict {
  if (!wsAuthEnabled()) return { ok: true };
  const path = (req.url ?? '/').split('?')[0];
  if (!needsHttpAuth(path)) return { ok: true };
  if (!verifyToken(readCookie(req, SESSION_COOKIE))) return { ok: false, reason: 'missing or invalid session cookie' };
  return { ok: true };
}

// Browsers always send Origin on a WebSocket handshake, so its absence alone
// marks a non-browser client.
export function checkUpgradeAuth(req: IncomingMessage): AuthVerdict {
  if (!wsAuthEnabled()) return { ok: true };
  if (typeof req.headers.origin !== 'string') return { ok: false, reason: 'no Origin header' };
  if (!verifyToken(readCookie(req, SESSION_COOKIE))) return { ok: false, reason: 'missing or invalid session cookie' };
  return { ok: true };
}

export function describePeer(req: IncomingMessage): string {
  const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 80) : '-';
  return `peer=${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? '?'} ua="${ua}"`;
}
