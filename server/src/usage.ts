import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'node:crypto';
import type { ClaudeCredentialBinding, UsageInfo } from '@arco/shared';
import { loadTokens, nativeCredentialBinding } from './providers/claude-native/auth.js';
import { ensureLiveTokens as ensureClaudeNativeTokens, REFRESH_LEAD_MS_EXPORT } from './providers/claude-native/oauth.js';

const CREDENTIALS_PATH = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_CACHE_ENTRIES = 16;

interface CredentialsFile {
  claudeAiOauth?: { accessToken: string; refreshToken?: string; expiresAt?: number; subscriptionType?: string };
}
interface LiveTokens {
  accessToken: string;
  expiresAt: number;
  subscriptionType: string | null;
  source: 'claude-native' | 'claude-cli';
  binding: ClaudeCredentialBinding;
}
interface Candidates { tokens: LiveTokens[]; errors: string[]; key: string }
interface CacheEntry { value: UsageInfo; cachedAt: number; sequence: number }
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<UsageInfo>>();
let checkSequence = 0;

// Read current revisions before considering cached data. Native refresh stays
// with its credential owner and happens only on a cache miss before a request.
async function readNativeCredentials(): Promise<LiveTokens | null> {
  const tokens = await loadTokens();
  if (!tokens) return null;
  if (typeof tokens.accessToken !== 'string' || !tokens.accessToken || typeof tokens.refreshToken !== 'string' || !tokens.refreshToken || !Number.isFinite(tokens.expiresAt)) throw new Error('Invalid Native credentials');
  return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, subscriptionType: 'claude-native', source: 'claude-native', binding: nativeCredentialBinding(tokens) };
}

async function readCliCredentials(): Promise<LiveTokens | null> {
  let raw: string;
  try { raw = await readFile(CREDENTIALS_PATH, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const oauth = (JSON.parse(raw) as CredentialsFile).claudeAiOauth;
  if (!oauth?.accessToken || typeof oauth.accessToken !== 'string') return null;
  const revision = createHash('sha256').update(JSON.stringify([
    oauth.accessToken, oauth.refreshToken, oauth.expiresAt, oauth.subscriptionType,
  ])).digest('hex');
  return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt ?? 0, subscriptionType: oauth.subscriptionType ?? null,
    source: 'claude-cli', binding: { source: 'claude-cli', storeId: 'claude-cli-default', revision } };
}

// The CLI owns its credential file and refresh chain. The meter only reads its
// current access grant; rejection/expiry never starts an independent rotation.
async function getCliTokens(): Promise<LiveTokens | null> { return readCliCredentials(); }
export async function getCliUsageBinding(): Promise<ClaudeCredentialBinding> {
  return (await getCliTokens().catch(() => null))?.binding ?? { source: 'claude-cli', storeId: 'claude-cli-default' };
}

async function getTokenCandidates(): Promise<Candidates> {
  const tokens: LiveTokens[] = [], errors: string[] = [];
  try { const native = await readNativeCredentials(); if (native) tokens.push(native); }
  catch { errors.push('Native allowance credentials could not be read'); }
  try { const cli = await getCliTokens(); if (cli) tokens.push(cli); }
  catch { errors.push('CLI allowance credentials could not be read'); }
  return { tokens, errors, key: JSON.stringify([tokens.map(t => t.binding), errors]) };
}

function unavailable(checkedAt: number, error: string, stale = false): UsageInfo {
  return { session: null, weekly: null, subscriptionType: null, fetchedAt: Date.now(), checkedAt,
    available: false, source: 'unavailable', identity: { state: 'unknown' }, stale,
    freshness: stale ? 'stale' : 'unavailable', error };
}
function changed(checkedAt: number): UsageInfo {
  return unavailable(checkedAt, 'Credentials changed while checking allowance. Check again for the current credential source.', true);
}
function credentialContext(context: Candidates): NonNullable<UsageInfo['credentialContext']> {
  return {
    native: context.tokens.find(t => t.source === 'claude-native')?.binding ?? { source: 'claude-native', storeId: 'claude.native' },
    cli: context.tokens.find(t => t.source === 'claude-cli')?.binding ?? { source: 'claude-cli', storeId: 'claude-cli-default' },
  };
}
function fromCache(entry: CacheEntry): UsageInfo {
  return { ...entry.value, freshness: entry.value.stale ? 'stale' : entry.value.available ? 'cached' : 'unavailable' };
}
function remember(key: string, value: UsageInfo, sequence: number): UsageInfo {
  const newer = cache.get(key);
  if (newer && newer.sequence > sequence) return fromCache(newer);
  cache.delete(key); cache.set(key, { value, cachedAt: Date.now(), sequence });
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  return value;
}
function windowValue(raw: unknown): UsageInfo['session'] {
  if (raw === undefined || raw === null) return null;
  const value = raw as { utilization?: unknown; resets_at?: unknown };
  if (typeof value.utilization !== 'number' || !Number.isFinite(value.utilization)) throw new Error('Invalid allowance window');
  return { utilization: value.utilization, resetsAt: typeof value.resets_at === 'string' ? value.resets_at : null };
}

async function checkUsage(initial: Candidates, sequence: number): Promise<UsageInfo> {
  let context = initial;
  const checkedAt = Date.now(), errors = [...initial.errors];
  for (let index = 0; index < initial.tokens.length; index++) {
    let tokens = initial.tokens[index];
    if (index && (await getTokenCandidates()).key !== context.key) return changed(checkedAt);
    try {
      if (tokens.source === 'claude-native' && tokens.expiresAt <= Date.now() + REFRESH_LEAD_MS_EXPORT) {
        // Preserve the Native owner's existing locking and expiry refresh.
        // No allowance failure marks execution auth or invokes forced refresh.
        const refreshed = await ensureClaudeNativeTokens();
        const binding = nativeCredentialBinding(refreshed);
        const next = await getTokenCandidates();
        if (next.tokens.find(t => t.source === 'claude-native')?.binding.revision !== binding.revision
          || next.tokens.find(t => t.source === 'claude-cli')?.binding.revision !== context.tokens.find(t => t.source === 'claude-cli')?.binding.revision) return changed(checkedAt);
        context = next;
        tokens = { ...tokens, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt, binding };
      }
      const response = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${tokens.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' } });
      if (!response.ok) {
        errors.push(`Allowance API returned ${response.status} (${tokens.source})${tokens.source === 'claude-cli' && response.status === 401 ? '; refresh or sign in through Claude CLI, then check again' : ''}`);
        continue;
      }
      const data = await response.json() as { five_hour?: unknown; seven_day?: unknown };
      const session = windowValue(data.five_hour), weekly = windowValue(data.seven_day);
      if (!session && !weekly) { errors.push(`No allowance windows returned (${tokens.source})`); continue; }
      // Reading the revisions AFTER parsing also fences delayed response bodies.
      if ((await getTokenCandidates()).key !== context.key) return changed(checkedAt);
      const info: UsageInfo = { session, weekly, subscriptionType: tokens.subscriptionType, fetchedAt: Date.now(), checkedAt,
        source: tokens.source, binding: tokens.binding, identity: { state: 'unknown' }, available: true, stale: false,
        credentialContext: credentialContext(context),
        freshness: 'fresh', fallback: tokens.source === 'claude-cli' && (index > 0 || initial.errors.length > 0) };
      return remember(context.key, info, sequence);
    } catch {
      errors.push(`Allowance request failed (${tokens.source}); execution authentication is unchanged`);
    }
  }
  if ((await getTokenCandidates()).key !== context.key) return changed(checkedAt);
  const error = `${errors.join('; ') || 'No suitable Claude OAuth allowance credentials found'}. Allowance availability is separate from execution authentication.`;
  const previous = cache.get(context.key)?.value;
  const info = previous?.binding && (previous.session || previous.weekly)
    ? { ...previous, available: false, stale: true, freshness: 'stale' as const, checkedAt, error }
    : { ...unavailable(checkedAt, error), credentialContext: credentialContext(context) };
  return remember(context.key, info, sequence);
}

export async function getUsage(force = false): Promise<UsageInfo> {
  const candidates = await getTokenCandidates();
  const pending = inFlight.get(candidates.key);
  if (pending) return pending;
  const cached = cache.get(candidates.key);
  if (!force && cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return fromCache(cached);
  const sequence = ++checkSequence;
  const promise = Promise.resolve().then(() => checkUsage(candidates, sequence)).finally(() => {
    if (inFlight.get(candidates.key) === promise) inFlight.delete(candidates.key);
  });
  inFlight.set(candidates.key, promise);
  return promise;
}
