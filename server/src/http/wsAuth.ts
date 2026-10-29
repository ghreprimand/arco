
// Session-cookie gate for the browser control surface, including WebSocket and
// HTTP API requests. Origin checks limit hostile web pages but do not
// authenticate local non-browser clients, so protected requests also require
// a short-lived, process-signed HttpOnly cookie. Only the bounded agent-tool
// routes below are exempt; the remaining API and upload routes are operator-only.
// This is a browser-session boundary, not an operating-system sandbox: a local
// process that deliberately forges browser metadata can still imitate a page.

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
