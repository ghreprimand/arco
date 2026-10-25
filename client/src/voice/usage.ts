import type { CodexUsageInfo } from '@arco/shared';
import { useAppStore } from '../stores/appStore';

export function codexQuota(snapshot: CodexUsageInfo | null) {
  if (!snapshot) return { available: false, error: 'No Codex usage snapshot yet. Open Providers → Codex usage to check its connection.' };
  return { available: snapshot.available, source: snapshot.source, fetchedAt: snapshot.fetchedAt,
    ageSeconds: Math.max(0, Math.round((Date.now() - snapshot.fetchedAt) / 1000)), error: snapshot.error,
    windows: snapshot.rows?.slice(0, 12).map(({ label, value }) => {
      const used = value.match(/\b(\d{1,3}(?:\.\d+)?)\s*%\s*(used|remaining)\b/i);
      const n = used ? Number(used[1]) : undefined;
      return { label, observed: value, ...(n !== undefined && n >= 0 && n <= 100
        ? { percentageUsed: used![2].toLowerCase() === 'remaining' ? 100 - n : n } : {}) };
    }) };
}
export async function readVoiceUsage(provider = 'all') {
  if (!['all', 'codex', 'claude', 'cursor', 'zai'].includes(provider)) throw Error('Unknown quota provider.');
  let s = useAppStore.getState();
  // Existing cached endpoint only. Never force a scrape or open a login window.
  if ((provider === 'codex' || provider === 'all') && (!s.codexUsage || Date.now() - s.codexUsage.fetchedAt > 60_000)) {
    try {
      const response = await fetch('/api/codex-usage', { signal: AbortSignal.timeout(8000) });
      if (response.ok) { const data: CodexUsageInfo = await response.json(); useAppStore.setState({ codexUsage: data }); }
    } catch { /* retain the last snapshot and its actual fetchedAt */ }
  }
  s = useAppStore.getState();
  const data = { codex: codexQuota(s.codexUsage), claude: s.usage ?? { available: false, error: 'No Claude quota snapshot.' },
    cursor: s.cursorUsage ? { available: s.cursorUsage.available, fetchedAt: s.cursorUsage.fetchedAt, included: s.cursorUsage.included,
      summary: s.cursorUsage.summary, error: s.cursorUsage.error } : { available: false },
    zai: s.zaiUsage ?? { available: false } };
  return JSON.stringify({ quota: provider === 'all' ? data : { [provider]: data[provider as keyof typeof data] },
    throttling: s.quotaState, note: 'Quota windows are subscription utilization. Throttling is separate. Never infer percentages from tokens or missing data.' });
}
