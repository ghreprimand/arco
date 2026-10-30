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

import type { ClaudeCredentialBinding, ClaudeNativeAuthFlow } from '@arco/shared';
import { createServer, type Server } from 'node:http';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import {
  loadTokens,
  nativeCredentialBinding,
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

const FLOW_TTL_MS = 10 * 60_000;
interface PendingFlow {
  state: string;
  codeVerifier: string;
  server: Server | null;
  timer?: ReturnType<typeof setTimeout>;
  result: ClaudeNativeAuthFlow;
  completion?: Promise<{ ok: true; flow: ClaudeNativeAuthFlow }>;
}
let pendingFlow: PendingFlow | null = null;
const flows = new Map<string, PendingFlow>();

function finishFlow(flow: PendingFlow, status: ClaudeNativeAuthFlow['status'], error?: string): void {
  flow.result = { ...flow.result, status, ...(error ? { error } : {}) };
  if (flow.timer) clearTimeout(flow.timer);
  if (flow.server) { try { flow.server.close(); } catch { /* already closed */ } }
  if (pendingFlow === flow) pendingFlow = null;
}
function currentFlow(flow: PendingFlow): boolean {
  return pendingFlow === flow && ['pending', 'exchanging'].includes(flow.result.status) && Date.now() < flow.result.expiresAt;
}
function sameBinding(a: ClaudeCredentialBinding, b: ClaudeCredentialBinding): boolean {
  return a.source === b.source && a.storeId === b.storeId && a.revision === b.revision;
}

export interface BootstrapStartResult {
  authorizationUrl: string;
  state: string;
  manualFallback: boolean;
  manualReason?: string;
  flow: ClaudeNativeAuthFlow;
}

// One credential owner and one callback listener. Flow ids are independent of
// the provider's state/verifier and contain no authorization material.
export async function startBootstrap(expectedBinding?: ClaudeCredentialBinding, workflowId?: string): Promise<BootstrapStartResult> {
  return withAuthLock(async () => {
    const binding = nativeCredentialBinding(await readTokensUnlocked());
    if (expectedBinding && !sameBinding(expectedBinding, binding)) throw new Error('Native credentials changed. Review sign-in status before starting again.');
    if (pendingFlow) finishFlow(pendingFlow, 'superseded');
    const verifier = randomBytes(32).toString('base64url');
    const flow: PendingFlow = { state: verifier, codeVerifier: verifier, server: null, result: {
      id: randomUUID(), status: 'pending', startedAt: Date.now(), expiresAt: Date.now() + FLOW_TTL_MS,
      bindingBefore: binding, ...(workflowId ? { workflowId } : {}),
    } };
    pendingFlow = flow;
    flows.set(flow.result.id, flow);
    while (flows.size > 32) flows.delete(flows.keys().next().value!);
    let manualReason: string | undefined;
    try {
      flow.server = await new Promise<Server>((resolve, reject) => {
        const server = createServer((req, res) => {
          let url: URL;
          try { url = new URL(req.url || '/', REDIRECT_URI); }
          catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Invalid callback request.'); return; }
          if (url.pathname !== CALLBACK_PATH) { res.writeHead(404); res.end('not found'); return; }
          void completeFlow(flow, url).then(() => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end('<!doctype html><meta charset="utf-8"><title>Arco Native sign-in</title><h1>Native sign-in completed.</h1><p>Return to Arco and review the originating workflow. No work was replayed.</p>');
          }, () => { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Sign-in did not complete. Return to Arco to review this flow.'); });
        });
        server.once('error', reject);
        server.listen(CALLBACK_PORT, CALLBACK_HOST, () => resolve(server));
      });
    } catch {
      manualReason = 'Local callback unavailable. Approve in the browser, then paste the redirected localhost URL.';
    }
    flow.timer = setTimeout(() => { void cancelBootstrap(flow.result.id, 'expired'); }, FLOW_TTL_MS);
    flow.timer.unref?.();
    const params = new URLSearchParams({ code: 'true', client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT_URI,
      scope: SCOPES, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: verifier });
    return { authorizationUrl: `${AUTHORIZE_URL}?${params}`, state: verifier, manualFallback: !flow.server, manualReason, flow: { ...flow.result } };
  });
}

export async function getBootstrapFlow(id: string): Promise<ClaudeNativeAuthFlow | null> {
  const flow = flows.get(id);
  if (!flow) return null;
  if (['pending', 'exchanging'].includes(flow.result.status) && Date.now() >= flow.result.expiresAt) await cancelBootstrap(id, 'expired');
  return { ...flow.result };
}

export async function cancelBootstrap(id: string, reason: 'cancelled' | 'expired' = 'cancelled'): Promise<ClaudeNativeAuthFlow | null> {
  return withAuthLock(async () => {
    const flow = flows.get(id);
    if (!flow) return null;
    if (['pending', 'exchanging'].includes(flow.result.status)) finishFlow(flow, reason);
    return { ...flow.result };
  });
}

export async function cancelActiveBootstrap(): Promise<void> {
  await withAuthLock(async () => { if (pendingFlow) finishFlow(pendingFlow, 'cancelled'); });
}

// Local callback and remote manual paste share the same validation, single
// exchange and guarded commit. A superseded response cannot replace tokens.
function completeFlow(flow: PendingFlow, url: URL): Promise<{ ok: true; flow: ClaudeNativeAuthFlow }> {
  if (url.searchParams.get('state') !== flow.state) return Promise.reject(new Error('state mismatch'));
  if (!currentFlow(flow)) return Promise.reject(new Error('Sign-in flow is no longer pending. Start again.'));
  if (url.searchParams.has('error')) {
    return cancelBootstrap(flow.result.id).then(() => { throw new Error('Sign-in was declined. Start again when ready.'); });
  }
  const code = url.searchParams.get('code');
  if (!code) return Promise.reject(new Error('no `code` in URL'));
  if (flow.completion) return flow.completion;
  flow.result = { ...flow.result, status: 'exchanging' };
  flow.completion = (async () => {
    try {
      const tokens = await exchangeCode(code, flow.codeVerifier);
      await withAuthLock(async () => {
        if (!currentFlow(flow)) throw new Error('Sign-in flow is no longer pending. Start again.');
        if (!sameBinding(flow.result.bindingBefore, nativeCredentialBinding(await readTokensUnlocked()))) {
          finishFlow(flow, 'superseded');
          throw new Error('Native credentials changed during sign-in. Review the current credentials.');
        }
        await writeTokensUnlocked(tokens);
        flow.result = { ...flow.result, binding: nativeCredentialBinding(tokens) };
        clearClaudeAuthProblem();
        finishFlow(flow, 'complete');
      });
      return { ok: true as const, flow: { ...flow.result } };
    } catch (err) {
      if (currentFlow(flow)) finishFlow(flow, 'failed', 'Native sign-in failed. Start a new flow to try again.');
      throw err;
    }
  })();
  return flow.completion;
}

export async function completeBootstrap(rawUrl: string, flowId?: string): Promise<{ ok: true; flow: ClaudeNativeAuthFlow }> {
  const url = new URL(rawUrl);
  const flow = flowId ? flows.get(flowId) : pendingFlow;
  if (!flow) throw new Error('no pending OAuth flow - start one first');
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== String(CALLBACK_PORT) || url.pathname !== CALLBACK_PATH) throw new Error('Expected the redirected localhost callback URL.');
  return completeFlow(flow, url);
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
  if (typeof data.access_token !== 'string' || !data.access_token || typeof data.refresh_token !== 'string' || !data.refresh_token
    || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('Invalid Native token exchange response.');
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
// Native and CLI credential status are separate in /api/auth-status. This
// signal also tells the phone console when Native reports an auth problem.
// Set when a worker hits a fatal auth failure (401 after the
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
