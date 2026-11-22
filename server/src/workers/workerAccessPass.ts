import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A turn should not start with a token that is already within the observed
// five-minute provider refresh window. The caller must renew outside the fence.
const MINIMUM_VALIDITY_MS = 5 * 60 * 1000;

/** Prepare provider-specific access-only credentials. This does not write or refresh a sign-in. */
export function workerAccessPass(provider: 'codex' | 'claude', input: unknown, now = Date.now()): string {
  const fail = (): never => { throw new Error('Provider sign-in needs renewing.'); };
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    return value as Record<string, unknown>;
  };
  const text = (value: unknown): string => {
    if (typeof value !== 'string' || !value || value.length > 32768) return fail();
    return value;
  };
  const root = record(input);
  if (provider === 'codex') {
    if (root.auth_mode !== 'chatgpt') return fail();
    const tokens = record(root.tokens);
    const token = text(tokens.access_token);
    const accountId = text(tokens.account_id);
    let expiry: unknown;
    try { expiry = record(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))).exp; } catch { return fail(); }
    if (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry * 1000 <= now + MINIMUM_VALIDITY_MS) return fail();
    const lastRefresh = text(root.last_refresh);
    if (!Number.isFinite(Date.parse(lastRefresh))) return fail();
    return JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null,
      tokens: { access_token: token, id_token: token, refresh_token: '', account_id: accountId }, last_refresh: lastRefresh });
  }
  if (provider !== 'claude') return fail();
  const oauth = record(root.claudeAiOauth);
  const accessToken = text(oauth.accessToken);
  if (typeof oauth.expiresAt !== 'number' || !Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= now + MINIMUM_VALIDITY_MS) return fail();
  if (!Array.isArray(oauth.scopes) || oauth.scopes.length > 100) return fail();
  const scopes = oauth.scopes.map(text);
  const subscriptionType = text(oauth.subscriptionType);
  const subscriptionTypeSource = text(oauth.subscriptionTypeSource);
  const rateLimitTier = text(oauth.rateLimitTier);
  return JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: '', expiresAt: oauth.expiresAt,
    scopes, subscriptionType, subscriptionTypeSource, rateLimitTier } });
}

export interface WorkerAccessPass { readonly path: string; readonly directory?: string; replace?(input: unknown): Promise<void>; close(): Promise<void> }
const preparedPasses = new WeakSet<WorkerAccessPass>();
export function isPreparedWorkerAccessPass(pass: WorkerAccessPass): boolean { return preparedPasses.has(pass); }

/** Own a private temporary file until the worker has exited. The launcher must mount it read-only. */
export async function prepareWorkerAccessPass(provider: 'codex' | 'claude', input: unknown): Promise<WorkerAccessPass> {
  const content = workerAccessPass(provider, input);
  const root = await mkdtemp(join(tmpdir(), 'arco-worker-access-'));
  try {
    const path = join(root, 'access.json');
    await writeFile(path, content, { mode: 0o400, flag: 'wx' });
    let closed = false;
    const pass: WorkerAccessPass = Object.freeze({ path, ...(provider === 'codex' ? { directory: root,
      replace: async (next: unknown) => {
        if (closed || !preparedPasses.has(pass)) throw new Error('Worker access pass is closed.');
        const replacement = workerAccessPass('codex', next);
        const temporary = join(root, `next-${randomUUID()}`);
        try {
          await writeFile(temporary, replacement, { mode: 0o400, flag: 'wx' });
          if (closed) throw new Error('Worker access pass is closed.');
          await rename(temporary, path);
        } finally { await rm(temporary, { force: true }); }
      },
    } : {}), close: async () => { closed = true; preparedPasses.delete(pass); await rm(root, { recursive: true, force: true }); } });
    preparedPasses.add(pass);
    return pass;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
