// Local running tally of which models the operator picks in SECOND OPINION.
// Stored in this browser only; nothing is sent anywhere.
const KEY = 'arco.secondOpinion.picks';

export type Tally = Record<string, number>;

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function tallyKey(leg: { provider: string; model: string }): string {
  return `${leg.provider}/${leg.model}`;
}

export function readTally(store = storage()): Tally {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Tally = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'number' && v > 0 && Number.isFinite(v)) out[k] = Math.floor(v);
    return out;
  } catch { return {}; }
}

export function recordPick(leg: { provider: string; model: string }, store = storage()): Tally {
  const next = readTally(store);
  const k = tallyKey(leg);
  next[k] = (next[k] ?? 0) + 1;
  try { store?.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable: the tally just isn't kept */ }
  return next;
}

export function resetTally(store = storage()): void {
  try { store?.removeItem(KEY); } catch { /* ignore */ }
}

export function sortedTally(t: Tally): Array<[string, number]> {
  return Object.entries(t).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
