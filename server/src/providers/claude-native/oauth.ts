// Phase 7a — PKCE OAuth bootstrap + refresh for Claude Native transport.
//
// Constants are lifted verbatim from Pi
// (`earendil-works/pi` `packages/ai/src/utils/oauth/anthropic.ts`).
// Pi has been running this exact set successfully for ~6 months.
//
// CLIENT_ID is stored as base64 → atob() at module load time. Mirrors
// Pi's pattern as deliberate minor protection against repo scrapes;
// it's not a security boundary (PKCE flows don't treat client_id as a
// secret).
//
// Manual-paste fallback: if the local callback server can't bind (port
// in use, sandbox refusal, headless / SSH session), we surface the
// authorize URL and accept a `{ url }` paste body to extract `code` +
// `state`. The operator's remote-access setup only forwards port 5173 so this
// path is the common case for him.

import { createServer, type Server } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import {
  loadTokens,
  saveTokens,
  withAuthLock,
  writeTokensUnlocked,
  readTokensUnlocked,
  type ClaudeNativeTokens,
} from './auth.js';

// `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (Pi-derived) — base64-encoded.
const CLIENT_ID_B64 = 'OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl';
const CLIENT_ID = Buffer.from(CLIENT_ID_B64, 'base64').toString('utf8');

const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CALLBACK_HOST = process.env.ARCO_OAUTH_CALLBACK_HOST || '127.0.0.1';
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = '/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
].join(' ');

// Refresh ahead of expiry so a turn that's mid-flight doesn't trip the
// boundary. 30s mirrors the plan-doc value.
const REFRESH_LEAD_MS = 30_000;

interface PendingFlow {
  state: string;
  codeVerifier: string;
  server: Server | null;
  resolveCode: (params: { code: string; state: string }) => void;
  rejectCode: (err: Error) => void;
  startedAt: number;
}

// At most one bootstrap can be pending at a time on a single machine —
// the callback port is hardcoded.
let pendingFlow: PendingFlow | null = null;

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function genVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

function challengeOf(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest());
}

export interface BootstrapStartResult {
  authorizationUrl: string;
  state: string;
  manualFallback: boolean;
  manualReason?: string;
}

// Begin a PKCE bootstrap. Returns the URL the operator opens in a
// browser. Tries to spawn a local callback server; on EADDRINUSE (or
// any bind failure) falls back to manual-paste mode.
export async function startBootstrap(): Promise<BootstrapStartResult> {
  if (pendingFlow) {
    cancelPendingFlow('superseded');
  }
  const codeVerifier = genVerifier();
  const codeChallenge = challengeOf(codeVerifier);
  // Pi-parity: state IS the verifier. The challenge round-trips on the
  // callback; the verifier round-trips on the token exchange. Anthropic
  // validates the PKCE pair, and Pi has confirmed state-as-verifier is
  // the supported shape.
  const state = codeVerifier;

  let server: Server | null = null;
  let manualReason: string | undefined;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const s = createServer((req, res) => {
        const url = req.url || '';
        if (!url.startsWith(CALLBACK_PATH)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
          return;
        }
        try {
          const u = new URL(url, `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
          const code = u.searchParams.get('code') || '';
          const recvState = u.searchParams.get('state') || '';
          const error = u.searchParams.get('error');
          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end(`OAuth error: ${error}`);
            if (pendingFlow) pendingFlow.rejectCode(new Error(`OAuth: ${error}`));
            return;
          }
          if (!code || !recvState) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('missing code/state');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><meta charset="utf-8"><title>Arco — Claude Native auth</title>
<style>body{font-family:ui-monospace,Menlo,monospace;background:#0b0b0b;color:#cfcfcf;padding:2rem}</style>
<h1>Arco: Claude Native auth complete.</h1>
<p>You can close this tab and return to Arco.</p>`);
          if (pendingFlow) pendingFlow.resolveCode({ code, state: recvState });
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`callback error: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
      s.once('error', (err) => reject(err));
      s.listen(CALLBACK_PORT, CALLBACK_HOST, () => resolve(s));
    });
  } catch (err) {
    server = null;
    const msg = err instanceof Error ? err.message : String(err);
    manualReason = msg.includes('EADDRINUSE')
      ? `port ${CALLBACK_PORT} in use — falling back to manual-paste`
      : `local callback unavailable (${msg}) — falling back to manual-paste`;
    console.warn(`[claude-native] OAuth bootstrap: ${manualReason}`);
  }

  pendingFlow = {
    state,
    codeVerifier,
    server,
    startedAt: Date.now(),
    // Set when settleBootstrap or completeBootstrap fires. Rejected on
    // cancelPendingFlow.
    resolveCode: () => { /* replaced below */ },
    rejectCode: () => { /* replaced below */ },
  };

  // Wire the resolve/reject *after* construction so the callback server's
  // closure (created above) can see the slot.
  const codePromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    if (!pendingFlow) { reject(new Error('flow lost')); return; }
    pendingFlow.resolveCode = resolve;
    pendingFlow.rejectCode = reject;
  });

  // Background — when a code arrives, exchange it. Errors land in the
  // pending-flow store.
  void codePromise.then(async ({ code, state: recvState }) => {
    if (recvState !== state) {
      console.error('[claude-native] OAuth state mismatch — dropping callback');
      return;
    }
    try {
      const tokens = await exchangeCode(code, codeVerifier);
      await saveTokens(tokens);
      clearClaudeAuthProblem();
      console.log('[claude-native] OAuth bootstrap complete');
    } catch (err) {
      console.error('[claude-native] OAuth code exchange failed:', err);
    } finally {
      cancelPendingFlow('completed');
    }
  }).catch((err) => {
    console.error('[claude-native] OAuth flow rejected:', err);
    cancelPendingFlow('rejected');
  });

  // `code: 'true'` is required by Anthropic — Pi sends it; without it
  // claude.ai/oauth/authorize returns "Invalid request format" before
  // rendering consent.
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  return {
    authorizationUrl: `${AUTHORIZE_URL}?${params.toString()}`,
    state,
    manualFallback: !server,
    manualReason,
  };
}

// Manual-paste path. Operator pastes the localhost:53692/callback?code=…
// URL into the UI; we extract code + state and exchange synchronously.
export async function completeBootstrap(rawUrl: string): Promise<{ ok: true }> {
  if (!pendingFlow) throw new Error('no pending OAuth flow — start one first');
  const u = new URL(rawUrl);
  const code = u.searchParams.get('code') || '';
  const recvState = u.searchParams.get('state') || '';
  if (!code) throw new Error('no `code` in URL');
  if (recvState !== pendingFlow.state) throw new Error('state mismatch');
  const tokens = await exchangeCode(code, pendingFlow.codeVerifier);
  await saveTokens(tokens);
  clearClaudeAuthProblem();
  cancelPendingFlow('completed');
  return { ok: true };
}

function cancelPendingFlow(reason: string): void {
  if (!pendingFlow) return;
  const { server } = pendingFlow;
  pendingFlow = null;
  if (server) {
    try { server.close(); } catch { /* already closing */ }
  }
  void reason; // for grep
}

async function exchangeCode(code: string, codeVerifier: string): Promise<ClaudeNativeTokens> {
  // Pi-parity: JSON body, not form-encoded; include `state` (= verifier)
  // alongside `code_verifier` (= verifier).
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      state: codeVerifier,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`token exchange failed (${res.status}): ${txt.slice(0, 200)}`);
  }
  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type?: string;
    scope?: string;
  };
  const now = Date.now();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: now + (data.expires_in * 1000),
    tokenType: data.token_type ?? 'Bearer',
    scope: data.scope ?? SCOPES,
    obtainedAt: now,
  };
}

// Refresh under the auth-file lock so two workers refreshing the same
// token don't race. Returns the (possibly-new) tokens.
export async function refreshTokens(current: ClaudeNativeTokens): Promise<ClaudeNativeTokens> {
  return withAuthLock(async () => {
    // Re-read inside the lock — another worker may have already refreshed.
    const fresh = await readTokensUnlocked();
    if (fresh && fresh.expiresAt > Date.now() + REFRESH_LEAD_MS) return fresh;
    return refreshUnlocked(fresh ?? current);
  });
}

// A1 (docs/REMOTE_MANAGEMENT.md) - refresh IGNORING the local
// expiry check. The worker calls this when an API request 401s on a token
// whose expiresAt is still in the future: Anthropic revokes access tokens
// server-side ahead of local expiry (observed near-daily in prod — repeated
// `claude auth failed (401)` with zero refresh attempts in the journal), and
// ensureLiveTokens() never tries the refresh token in that state.
// `staleObtainedAt` guards the concurrent case: if another worker already
// rotated the on-disk tokens since the 401'ing client was built, return those
// instead of burning a second refresh against a just-rotated chain.
export async function forceRefreshTokens(staleObtainedAt: number): Promise<ClaudeNativeTokens> {
  return withAuthLock(async () => {
    const fresh = await readTokensUnlocked();
    if (!fresh) throw new ClaudeNativeNoAuthError();
    if (fresh.obtainedAt > staleObtainedAt) return fresh;
    return refreshUnlocked(fresh);
  });
}

// The actual refresh POST + persist. Caller MUST hold the auth-file lock.
// A rejected refresh logs its own distinct line — this is the journal signal
// that separates "access token revoked early, chain still good" (no line ever
// appears; forced refresh recovers silently) from "refresh chain dead, re-auth
// genuinely required" (§10.2 diagnostics).
async function refreshUnlocked(seed: ClaudeNativeTokens): Promise<ClaudeNativeTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: seed.refreshToken,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.error(`[claude-native] refresh rejected (${res.status}): ${txt.slice(0, 200)}`);
    const err = new Error(`refresh failed (${res.status}): ${txt.slice(0, 200)}`);
    (err as Error & { httpStatus?: number }).httpStatus = res.status;
    throw err;
  }
  const data = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type?: string;
    scope?: string;
  };
  const now = Date.now();
  const next: ClaudeNativeTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? seed.refreshToken,
    expiresAt: now + (data.expires_in * 1000),
    tokenType: data.token_type ?? seed.tokenType,
    scope: data.scope ?? seed.scope,
    obtainedAt: now,
  };
  await writeTokensUnlocked(next);
  clearClaudeAuthProblem(); // a fresh grant is proof the chain works again
  return next;
}

// -- A2 (docs/REMOTE_MANAGEMENT.md) - live auth-problem state -----
// The /api/auth-status probe checks the CLAUDE CLI, not these native tokens,
// so the phone console needs its own signal for "the native transport can't
// authenticate". Set when a worker hits a fatal auth failure (401 after the
// A1 forced refresh, or NO_AUTH); cleared when tokens are provably good again
// (successful refresh or a completed bootstrap). In-memory only — a restart
// clears it until the next failed turn re-reports, which is the honest state.
// The transition into "problem" emits ONE auth-expired workbench notice (J1 →
// ntfy), so the phone learns without polling.
let claudeAuthProblem: { since: number; detail: string } | null = null;
let authProblemNotify: ((detail: string) => void) | null = null;

// Wired by the server bootstrap (initHubLink) to the J1 emit() — injected so
// this module stays free of a notifications import (and smoke-testable).
export function setClaudeAuthProblemNotifier(fn: (detail: string) => void): void {
  authProblemNotify = fn;
}

export function markClaudeAuthProblem(detail: string): void {
  if (claudeAuthProblem) return; // already alerted — don't re-notify per turn
  claudeAuthProblem = { since: Date.now(), detail };
  try {
    authProblemNotify?.(detail);
  } catch {
    /* notifier must never break the auth path */
  }
}

export function clearClaudeAuthProblem(): void {
  claudeAuthProblem = null;
}

export function getClaudeAuthProblem(): { since: number; detail: string } | null {
  return claudeAuthProblem;
}

// Thrown when ~/.arco/auth.json has no claude.native key. The worker
// catches `code === 'NO_AUTH'` and surfaces the [AUTH:claude] system_notice
// that the chat renderer turns into a RE-LOGIN button.
export class ClaudeNativeNoAuthError extends Error {
  readonly code = 'NO_AUTH' as const;
  constructor() {
    super('Claude Native is not authenticated');
    this.name = 'ClaudeNativeNoAuthError';
  }
}

// Public wrapper — load tokens, refresh if expired, return the live set.
// Throws ClaudeNativeNoAuthError on no-auth or a generic Error on refresh
// failure (caller surfaces [AUTH:claude]).
export async function ensureLiveTokens(): Promise<ClaudeNativeTokens> {
  const tokens = await loadTokens();
  if (!tokens) throw new ClaudeNativeNoAuthError();
  if (tokens.expiresAt > Date.now() + REFRESH_LEAD_MS) return tokens;
  return refreshTokens(tokens);
}

export const REFRESH_LEAD_MS_EXPORT = REFRESH_LEAD_MS;
