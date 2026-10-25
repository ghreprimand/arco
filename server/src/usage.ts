import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { UsageInfo } from '@archon/shared';
import { ClaudeNativeNoAuthError, ensureLiveTokens as ensureClaudeNativeTokens } from './providers/claude-native/oauth.js';

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CACHE_TTL_MS = 2 * 60 * 1000;

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    subscriptionType?: string;
  };
}

interface LiveTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  subscriptionType: string | null;
  source: 'claude-native' | 'claude-cli';
}

// In-memory token cache. We never write back to credentials.json — that's
// Claude CLI's file to manage. If our refreshed access token expires and we
// restart, we re-read credentials.json and refresh again.
let cliLiveTokens: LiveTokens | null = null;
let cachedUsage: UsageInfo | null = null;

function isFresh(tokens: LiveTokens): boolean {
  return tokens.expiresAt - Date.now() > 60_000;
}

async function readNativeCredentials(): Promise<LiveTokens | null> {
  try {
    const tokens = await ensureClaudeNativeTokens();
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      subscriptionType: 'claude-native',
      source: 'claude-native',
    };
  } catch (err) {
    if (err instanceof ClaudeNativeNoAuthError) return null;
    throw err;
  }
}

async function readCliCredentials(): Promise<LiveTokens | null> {
  try {
    const raw = await readFile(CREDENTIALS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as CredentialsFile;
    const oauth = parsed.claudeAiOauth;
    if (!oauth?.accessToken || !oauth.refreshToken) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt ?? 0,
      subscriptionType: oauth.subscriptionType ?? null,
      source: 'claude-cli',
    };
  } catch {
    return null;
  }
}

async function refreshAccessToken(refreshToken: string): Promise<LiveTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!res.ok) {
    throw new Error(`Claude usage token refresh failed (${res.status})`);
  }

  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    subscriptionType: cliLiveTokens?.subscriptionType ?? null,
    source: 'claude-cli',
  };
}

async function fetchUsageJson(accessToken: string): Promise<Response> {
  return fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
    },
  });
}

async function getCliTokens(): Promise<LiveTokens | null> {
  // Use live (possibly refreshed) CLI tokens if still valid.
  if (cliLiveTokens && isFresh(cliLiveTokens)) {
    return cliLiveTokens;
  }
  // Otherwise read from disk (Claude CLI may have refreshed its own copy).
  const fromDisk = await readCliCredentials();
  if (!fromDisk) return null;

  // If disk tokens look valid, use them.
  if (isFresh(fromDisk)) {
    cliLiveTokens = fromDisk;
    return cliLiveTokens;
  }

  // Disk tokens near/past expiry — refresh in-memory.
  try {
    const refreshed = await refreshAccessToken(fromDisk.refreshToken);
    refreshed.subscriptionType = fromDisk.subscriptionType;
    cliLiveTokens = refreshed;
    return cliLiveTokens;
  } catch {
    // Last resort: try the expired token anyway — API may still accept briefly.
    cliLiveTokens = fromDisk;
    return cliLiveTokens;
  }
}

async function getTokenCandidates(): Promise<{ tokens: LiveTokens[]; errors: string[] }> {
  const tokens: LiveTokens[] = [];
  const errors: string[] = [];

  try {
    const native = await readNativeCredentials();
    if (native) tokens.push(native);
  } catch (err) {
    errors.push(`Claude Native credentials failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const cli = await getCliTokens();
    if (cli) tokens.push(cli);
  } catch (err) {
    errors.push(`Claude CLI credentials failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { tokens, errors };
}

export async function getUsage(force = false): Promise<UsageInfo> {
  if (!force && cachedUsage && Date.now() - cachedUsage.fetchedAt < CACHE_TTL_MS) {
    return cachedUsage;
  }

  const candidates = await getTokenCandidates();
  if (candidates.tokens.length === 0) {
    const info: UsageInfo = {
      session: null,
      weekly: null,
      subscriptionType: null,
      fetchedAt: Date.now(),
      error: candidates.errors.length > 0
        ? candidates.errors.join('; ')
        : 'No Claude credentials found (~/.archon/auth.json native token or ~/.claude/.credentials.json CLI token)',
    };
    cachedUsage = info;
    return info;
  }

  const errors = [...candidates.errors];
  for (const tokens of candidates.tokens) {
    // `fetch` rejects (not just non-2xx) on network-level failures — DNS, an
    // IPv6 route that's ENETUNREACH, a TLS reset. That rejection used to escape
    // getUsage entirely and, with no global unhandledRejection handler, took the
    // whole server down: one unreachable usage meter → process.exit(1) →
    // systemd crash-loop → start-limit-hit → permanent "SERVER DOWN". Treat a
    // transport failure like any other failed candidate: record it and move on.
    let res: Response;
    try {
      res = await fetchUsageJson(tokens.accessToken);
    } catch (err) {
      errors.push(`Usage API unreachable: ${err instanceof Error ? err.message : String(err)} (${tokens.source})`);
      continue;
    }
    if (res.status === 401 && tokens.source === 'claude-cli') {
      try {
        const refreshed = await refreshAccessToken(tokens.refreshToken);
        refreshed.subscriptionType = tokens.subscriptionType;
        cliLiveTokens = refreshed;
        res = await fetchUsageJson(refreshed.accessToken);
      } catch (err) {
        errors.push(`${err instanceof Error ? err.message : 'Claude usage token refresh failed'} (${tokens.source})`);
        continue;
      }
    }

    if (!res.ok) {
      errors.push(`Usage API returned ${res.status} (${tokens.source})`);
      continue;
    }

    const data = (await res.json()) as {
      five_hour?: { utilization: number; resets_at?: string };
      seven_day?: { utilization: number; resets_at?: string };
    };

    const info: UsageInfo = {
      session: data.five_hour
        ? { utilization: data.five_hour.utilization, resetsAt: data.five_hour.resets_at ?? null }
        : null,
      weekly: data.seven_day
        ? { utilization: data.seven_day.utilization, resetsAt: data.seven_day.resets_at ?? null }
        : null,
      subscriptionType: tokens.subscriptionType,
      fetchedAt: Date.now(),
    };
    cachedUsage = info;
    return info;
  }

  const info: UsageInfo = {
    session: null,
    weekly: null,
    subscriptionType: candidates.tokens[0]?.subscriptionType ?? null,
    fetchedAt: Date.now(),
    error: `${errors.join('; ') || 'Claude usage unavailable'}; Claude turns can still work through their configured transport, but Arco cannot read the subscription meter.`,
  };
  cachedUsage = info;
  return info;
}
