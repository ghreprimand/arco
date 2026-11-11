import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProviderName, CodexUsageInfo, UsageInfo } from '@arco/shared';
import { getState, markAvailable, wireSnapshot } from '../quota.js';

interface MeterReaders { codex: () => Promise<unknown>; claude: () => Promise<unknown> }
const meters: MeterReaders = {
  codex: async () => (await import('../codexUsage.js')).getCodexUsage(true),
  claude: async () => (await import('../usage.js')).getUsage(true),
};
const providers: ProviderName[] = ['claude','codex','cursor','ollama','llamacpp','lmstudio','strata','deepseek'];
const HEADROOM_CLEARED = 'Usage shows headroom. Notice cleared. If the provider is still limiting requests, the next turn will show it again.';
function usageResult(provider: 'codex' | 'claude', raw: unknown) {
  const data = raw as { available?: boolean; stale?: boolean; fetchedAt: number };
  const codex = raw as CodexUsageInfo;
  const claude = raw as UsageInfo;
  const fresh = data?.available === true && !data.stale && Number.isFinite(data.fetchedAt)
    && Date.now() - data.fetchedAt < 60_000 && data.fetchedAt <= Date.now() + 5_000;
  let values: number[] = [];
  if (fresh && provider === 'codex' && codex.source === 'appserver' && Array.isArray(codex.rows)) {
    values = codex.rows!.map(row => Number(row.value.match(/^(\d+(?:\.\d+)?)% used(?:\s|$)/)?.[1] ?? NaN));
  } else if (fresh && provider === 'claude' && claude.freshness === 'fresh') {
    values = [claude.session, claude.weekly].filter(window => window !== null && window !== undefined).map(window => window.utilization);
  }
  if (!values.length || !values.every(value => Number.isFinite(value) && value >= 0 && value <= 100)) {
    return { status: 'unavailable' as const, message: 'Fresh usage is unavailable. The remembered limit is unchanged.' };
  }
  const exhausted = values.some(value => value >= 100);
  return exhausted
    ? { status: 'exhausted' as const, message: 'A reported usage window is exhausted. The remembered limit is unchanged.' }
    : { status: 'headroom' as const, message: HEADROOM_CLEARED };
}
async function recheck(provider: 'codex' | 'claude', readers: MeterReaders) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([readers[provider](), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('usage timeout')), 15_000); timer.unref();
    })]);
    return usageResult(provider, raw);
  } catch { return { status: 'unavailable' as const, message: 'Could not recheck usage. The remembered limit is unchanged.' }; }
  finally { if (timer) clearTimeout(timer); }
}
/** Called only after the router's origin and session-cookie checks. */
export async function tryHandleProviderThrottleRoutes(req: IncomingMessage, res: ServerResponse, readers: MeterReaders = meters): Promise<boolean> {
  if (req.url !== '/api/provider-throttle') return false;
  const reply = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); return true; };
  if (req.method !== 'POST') return reply(405, { error: 'POST required.' });
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      const data = Buffer.from(chunk); size += data.length;
      if (size > 4096) return reply(413, { error: 'Request is too large.' });
      chunks.push(data);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    if (!body || Array.isArray(body) || !providers.includes(body.provider as ProviderName)
      || !['clear','recheck'].includes(body.action as string) || Object.keys(body).some(key => key !== 'provider' && key !== 'action')) return reply(400, { error: 'Invalid provider or action.' });
    const provider = body.provider as ProviderName;
    if (body.action === 'clear') {
      markAvailable(provider, 'manual-clear');
      return reply(200, { ok: true, providers: wireSnapshot() });
    }
    if (provider !== 'codex' && provider !== 'claude') return reply(400, { error: 'Usage recheck is available for Codex and Claude only. Clear is available for every provider.' });
    // Only the limit seen before the meter read may be cleared: a newer
    // error recorded during the read replaces the state object and survives.
    const before = getState(provider);
    const usage = await recheck(provider, readers);
    const current = getState(provider);
    let cleared = false;
    if (usage.status === 'headroom') {
      if (current === before && before.throttled) { markAvailable(provider, 'manual-probe'); cleared = true; }
      else if (current.throttled) usage.message = 'Usage shows headroom, but a newer limit arrived during the recheck. The notice is unchanged.';
      else usage.message = 'Usage shows headroom. No limit is remembered.';
    }
    return reply(200, { ok: true, usage: { ...usage, cleared }, providers: wireSnapshot() });
  } catch { return reply(400, { error: 'Invalid request.' }); }
}
