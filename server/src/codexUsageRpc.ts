import { spawn, execFile } from 'node:child_process';
import { JsonRpcClient, JsonRpcRequestError } from './providers/codex-appserver/jsonRpc.js';
import { commandArgs } from './windowsCommand.js';
import type { GetAccountResponse } from './providers/codex-appserver/bindings/v2/GetAccountResponse.js';
import type { RateLimitSnapshot } from './providers/codex-appserver/bindings/v2/RateLimitSnapshot.js';
import type { GetAccountRateLimitsResponse } from './providers/codex-appserver/bindings/v2/GetAccountRateLimitsResponse.js';
import type { CodexUsageInfo } from '@arco/shared';

export class CodexQuotaError extends Error {
  constructor(message: string, readonly identity = '') { super(message); }
}

const ANALYTICS_URL = 'https://chatgpt.com/settings/usage?tab=overview';

// A fresh child uses the same account home as the corresponding Codex worker.
// It never starts a thread and does not log account details or RPC payloads.
export async function readCodexQuota(codexHome?: string, timeoutMs = 12_000): Promise<{ usage: CodexUsageInfo; identity: string }> {
  const proc = spawn(...commandArgs('codex', ['app-server']), {
    env: { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      proc.once('spawn', resolve);
      proc.once('error', () => reject(new CodexQuotaError('Could not start Codex CLI. Install or update the Codex CLI in Connections.')));
    });
  } catch (err) {
    try { proc.kill(); } catch { /* already exited */ }
    throw err;
  }
  proc.stderr.resume();
  const rpc = new JsonRpcClient(proc.stdin, proc.stdout);
  proc.on('error', () => rpc.close('Could not start Codex CLI. Install or update the Codex CLI in Connections.'));
  proc.on('exit', () => rpc.close('Codex app-server exited before returning quota data. Update the Codex CLI and try again.'));
  const timer = setTimeout(() => rpc.close('Codex quota check timed out. Try again.'), timeoutMs);
  let identity = '';
  try {
    await rpc.request('initialize', { clientInfo: { name: 'arco', title: 'Arco', version: '0.1.0' }, capabilities: { experimentalApi: false } });
    rpc.notify('initialized');
    const account = await rpc.request<GetAccountResponse>('account/read', { refreshToken: false });
    if (!account.account) throw new Error('Codex is signed out. Connect a ChatGPT account in Connections.');
    if (account.account.type !== 'chatgpt') throw new Error('ChatGPT subscription quota is unavailable for an API key or other non-ChatGPT account.');
    identity = JSON.stringify([account.account.email, account.account.planType]);
    const updates = new Map<string, RateLimitSnapshot>();
    let acceptUpdates = false;
    rpc.on('notification', (event: { method: string; params: unknown }) => {
      if (!acceptUpdates || event.method !== 'account/rateLimits/updated') return;
      const update = (event.params as { rateLimits?: RateLimitSnapshot } | null)?.rateLimits;
      if (update) updates.set(update.limitId ?? 'codex', update);
    });
    const result = await rpc.request<GetAccountRateLimitsResponse>('account/rateLimits/read');
    acceptUpdates = true;
    await new Promise(resolve => setTimeout(resolve, 30));
    const byId = new Map(Object.entries(result.rateLimitsByLimitId ?? {}));
    if (byId.size === 0 && result.rateLimits) byId.set(result.rateLimits.limitId ?? 'codex', result.rateLimits);
    for (const [id, update] of updates) byId.set(id, { ...byId.get(id), ...update });
    const buckets = [...byId.entries()];
    const rows: NonNullable<CodexUsageInfo['rows']> = [];
    for (const [id, bucket] of buckets) {
      if (!bucket) continue;
      for (const [kind, window] of [['Primary', bucket.primary], ['Secondary', bucket.secondary]] as const) {
        if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) continue;
        const duration = window.windowDurationMins == null ? kind : `${window.windowDurationMins} min`;
        const reset = typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) ? new Date(window.resetsAt * 1000) : null;
        const validReset = reset && !Number.isNaN(reset.valueOf()) ? ` · Resets ${reset.toISOString()}` : '';
        rows.push({ label: `${bucket.limitName || bucket.limitId || id} · ${duration}`, value: `${window.usedPercent}% used${validReset}` });
      }
    }
    if (!rows.length) throw new Error('Codex returned no quota windows for this account. Open the usage dashboard or try again later.');
    return { identity, usage: { available: true, fetchedAt: Date.now(), source: 'appserver', analyticsUrl: ANALYTICS_URL, rows } };
  } catch (err) {
    if (err instanceof JsonRpcRequestError && err.rpcError.code === -32601) throw new CodexQuotaError('Installed Codex CLI does not support quota reads. Update the Codex CLI in Connections.', identity);
    if (err instanceof JsonRpcRequestError) throw new CodexQuotaError('Codex quota request failed. Check the account connection and retry.', identity);
    throw new CodexQuotaError(err instanceof Error ? err.message : 'Codex quota check failed.', identity);
  } finally {
    clearTimeout(timer);
    rpc.close('quota check finished');
    if (process.platform === 'win32') {
      if (proc.pid) execFile('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true }, () => {});
      try { proc.kill(); } catch { /* already exited */ }
    } else if (proc.pid) {
      const pid = proc.pid;
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already exited */ }
      const killTimer = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ } }, 2000);
      killTimer.unref();
    }
  }
}
