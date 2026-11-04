import { useCallback, useEffect, useState } from 'react';

// DD7 — client side of the project-trust manager (GET/POST /api/project-trust).
//
// Backs three surfaces that all write the same user-scope ~/.arco/trust.json:
// the global PROJECT TRUST section in SettingsPanel (works with no tab open),
// the per-tab CONFIG row, and the cluster header chip. Trust is keyed by cwd,
// not by workflow, so whichever surface records the decision covers every tab
// and every cluster member pointed at that repo — the server broadcasts
// `project_trust_set` to all of them, which clears any stale composer banner.

export type TrustStatus = 'ask' | 'always' | 'never';
export type TrustDecision = 'always' | 'never';

export interface TrustEntryView {
  path: string;
  decision: TrustDecision;
  at: number;
}

export interface TrustSnapshot {
  defaultProjectTrust: TrustStatus;
  entries: TrustEntryView[];
  // Present only when the hook was given a cwd. `resources` is the list of
  // gated project-local surfaces the repo actually ships — empty means the gate
  // is a no-op there and the status is informational.
  cwd?: { path: string; status: TrustStatus; matchedPath?: string; resources: string[] };
}

export function useProjectTrust(cwd?: string) {
  const [snapshot, setSnapshot] = useState<TrustSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
      const res = await fetch(`/api/project-trust${qs}`);
      if (res.ok) setSnapshot((await res.json()) as TrustSnapshot);
    } catch {
      /* offline / server restarting — the next refresh reconciles */
    }
  }, [cwd]);

  useEffect(() => { void refresh(); }, [refresh]);

  // `clear` drops the entry, which re-arms the one-shot turn-time prompt for
  // that cwd rather than leaving it silently suppressed.
  const setTrust = useCallback(
    async (target: string, decision: TrustDecision | 'clear') => {
      if (busy) return;
      setBusy(true);
      try {
        const res = await fetch('/api/project-trust', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd: target, decision }),
        });
        if (res.ok) setSnapshot((await res.json()) as TrustSnapshot);
        else await refresh();
      } catch {
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh],
  );

  return { snapshot, busy, refresh, setTrust };
}
