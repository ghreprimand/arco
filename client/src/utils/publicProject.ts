// Public-project choice per project folder (this browser) and the remote
// suggestion from the server. An explicit choice always wins over a suggestion.
import { useCallback, useEffect, useState } from 'react';

export type RemoteSuggestion = { state: 'none' } | { state: 'hosted'; host: string } | { state: 'public'; host: string };

const KEY = 'arco.publicProject.';
const suggestions = new Map<string, RemoteSuggestion>();

export function getPublicChoice(cwd: string): boolean | null {
  if (!cwd) return null;
  try {
    const v = localStorage.getItem(KEY + cwd);
    return v === '1' ? true : v === '0' ? false : null;
  } catch { return null; }
}

export function setPublicChoice(cwd: string, value: boolean): void {
  if (!cwd) return;
  try { localStorage.setItem(KEY + cwd, value ? '1' : '0'); } catch { /* no-op */ }
}

/** The value a plan draft uses: the explicit choice, else a confirmed-public suggestion already shown. */
export function effectivePublic(cwd: string): boolean {
  const chosen = getPublicChoice(cwd);
  if (chosen !== null) return chosen;
  return suggestions.get(cwd)?.state === 'public';
}

export function suggestionNote(s: RemoteSuggestion | null): { reason?: string; hint?: string } {
  if (!s) return {};
  if (s.state === 'public') return { reason: s.host === 'github.com' ? 'This repository is public on GitHub.' : `This repository is public on ${s.host}.` };
  if (s.state === 'hosted') return { hint: `This project has a remote on ${s.host}.` };
  return {};
}

export function usePublicProject(cwd: string) {
  const [chosen, setChosen] = useState<boolean | null>(() => getPublicChoice(cwd));
  const [suggestion, setSuggestion] = useState<RemoteSuggestion | null>(() => suggestions.get(cwd) ?? null);
  useEffect(() => {
    setChosen(getPublicChoice(cwd));
    if (!cwd) { setSuggestion(null); return; }
    const known = suggestions.get(cwd);
    if (known) { setSuggestion(known); return; }
    let live = true;
    void fetch(`/api/public-project/remote?path=${encodeURIComponent(cwd)}`)
      .then((r) => (r.ok ? r.json() as Promise<RemoteSuggestion> : null))
      .then((s) => { if (s && live) { suggestions.set(cwd, s); setSuggestion(s); } })
      .catch(() => { /* no suggestion */ });
    return () => { live = false; };
  }, [cwd]);
  const checked = chosen ?? suggestion?.state === 'public';
  const set = useCallback((value: boolean) => { setPublicChoice(cwd, value); setChosen(value); }, [cwd]);
  const note = chosen === null ? suggestionNote(suggestion) : {};
  return { checked, set, reason: note.reason, hint: note.hint };
}
