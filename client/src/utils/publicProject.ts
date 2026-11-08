// Explicit choices are stored by the server per project. The local value is a
// cache and migrates choices made by older versions in this browser.
import { useCallback, useEffect, useState } from 'react';

export type RemoteSuggestion = { state: 'none' } | { state: 'hosted'; host: string } | { state: 'public'; host: string };
const KEY = 'arco.publicProject.';
const suggestions = new Map<string, RemoteSuggestion>();
const suggestionLoads = new Map<string, Promise<void>>();
const choices = new Map<string, boolean | null>();
const pending = new Map<string, Promise<void>>();
const revisions = new Map<string, number>();
const loading = new Map<string, Promise<void>>();
const events = new EventTarget();

function localChoice(cwd: string): boolean | null {
  try { const v = localStorage.getItem(KEY + cwd); return v === '1' ? true : v === '0' ? false : null; } catch { return null; }
}
function notify(): void { events.dispatchEvent(new Event('change')); }
export function getPublicChoice(cwd: string): boolean | null {
  if (!cwd) return null;
  return choices.has(cwd) ? choices.get(cwd) ?? null : localChoice(cwd);
}
export function setPublicChoice(cwd: string, value: boolean): Promise<void> {
  if (!cwd) return Promise.resolve();
  revisions.set(cwd, (revisions.get(cwd) ?? 0) + 1);
  choices.set(cwd, value);
  try { localStorage.setItem(KEY + cwd, value ? '1' : '0'); } catch { /* server remains authoritative */ }
  notify();
  const prior = pending.get(cwd) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(async () => {
    const response = await fetch('/api/public-project/choice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: cwd, value }) });
    if (!response.ok) throw new Error('Could not save the public-project choice.');
  });
  pending.set(cwd, next);
  void next.then(() => { if (pending.get(cwd) === next) pending.delete(cwd); }, () => { /* Keep failed explicit choices blocking plan startup until retried. */ });
  return next;
}
async function loadChoice(cwd: string, refresh = false): Promise<void> {
  if (!refresh && choices.has(cwd)) return;
  const existing = loading.get(cwd);
  if (existing) {
    await existing;
    if (!refresh) return;
  }
  const revision = revisions.get(cwd) ?? 0;
  const initial = !choices.has(cwd);
  const task = (async () => {
    const response = await fetch(`/api/public-project/choice?path=${encodeURIComponent(cwd)}`);
    if (!response.ok) throw new Error('Could not load the public-project choice.');
    const data = await response.json() as { choice?: unknown };
    if ((revisions.get(cwd) ?? 0) !== revision) return;
    const remote = typeof data.choice === 'boolean' ? data.choice : null;
    const legacy = initial ? localChoice(cwd) : null;
    choices.set(cwd, remote ?? legacy);
    if (remote !== null) { try { localStorage.setItem(KEY + cwd, remote ? '1' : '0'); } catch { /* server remains authoritative */ } }
    notify();
    if (remote === null && legacy !== null) await setPublicChoice(cwd, legacy);
  })();
  loading.set(cwd, task);
  try { await task; } finally { if (loading.get(cwd) === task) loading.delete(cwd); }
}
async function loadSuggestion(cwd: string): Promise<void> {
  if (suggestions.has(cwd)) return;
  const existing = suggestionLoads.get(cwd);
  if (existing) return existing;
  const task = fetch(`/api/public-project/remote?path=${encodeURIComponent(cwd)}`)
    .then(async response => response.ok ? await response.json() as RemoteSuggestion : null)
    .then(value => { if (value && ['none', 'hosted', 'public'].includes(value.state)) { suggestions.set(cwd, value); notify(); } })
    .catch(() => {});
  suggestionLoads.set(cwd, task);
  try { await task; } finally { suggestionLoads.delete(cwd); }
}
/** The value a plan draft uses: the explicit choice, else a confirmed-public suggestion already shown. */
export function effectivePublic(cwd: string): boolean {
  const chosen = getPublicChoice(cwd);
  return chosen !== null ? chosen : suggestions.get(cwd)?.state === 'public';
}
async function awaitChoiceWrites(cwd: string): Promise<void> {
  while (pending.has(cwd)) await pending.get(cwd);
}
/** Refresh the saved answer without turning an old cache into a new decision. */
export async function rememberPublicChoice(cwd: string): Promise<boolean> {
  if (!cwd) return false;
  await awaitChoiceWrites(cwd);
  await loadChoice(cwd, true);
  await awaitChoiceWrites(cwd);
  if (getPublicChoice(cwd) === null) await loadSuggestion(cwd);
  return effectivePublic(cwd);
}
export function suggestionNote(s: RemoteSuggestion | null): { reason?: string; hint?: string } {
  if (!s) return {};
  if (s.state === 'public') return { reason: s.host === 'github.com' ? 'This repository is public on GitHub.' : `This repository is public on ${s.host}.` };
  if (s.state === 'hosted') return { hint: `This project has a remote on ${s.host}.` };
  return {};
}
export function usePublicProject(cwd: string) {
  const [, render] = useState(0);
  const [suggestion, setSuggestion] = useState<RemoteSuggestion | null>(() => suggestions.get(cwd) ?? null);
  const [error, setError] = useState('');
  const [failedSave, setFailedSave] = useState(false);
  useEffect(() => {
    setError(''); setFailedSave(false);
    const changed = () => render(n => n + 1);
    events.addEventListener('change', changed);
    const storageChanged = (event: StorageEvent) => {
      if (event.key !== KEY + cwd) return;
      revisions.set(cwd, (revisions.get(cwd) ?? 0) + 1);
      choices.set(cwd, event.newValue === '1' ? true : event.newValue === '0' ? false : null);
      changed();
    };
    window.addEventListener('storage', storageChanged);
    let live = true;
    if (!cwd) { setSuggestion(null); return () => { live = false; events.removeEventListener('change', changed); window.removeEventListener('storage', storageChanged); }; }
    void loadChoice(cwd).catch(() => { if (live) setError('Could not load the saved public-project choice.'); });
    setSuggestion(suggestions.get(cwd) ?? null);
    void loadSuggestion(cwd).then(() => { if (live) setSuggestion(suggestions.get(cwd) ?? null); });
    return () => { live = false; events.removeEventListener('change', changed); window.removeEventListener('storage', storageChanged); };
  }, [cwd]);
  const chosen = getPublicChoice(cwd);
  const checked = chosen ?? suggestion?.state === 'public';
  const set = useCallback((value: boolean) => {
    setError(''); setFailedSave(false);
    void setPublicChoice(cwd, value).catch(() => {
      setFailedSave(true);
      setError('Could not save the public-project choice. Select RETRY SAVE to save the displayed choice before starting a plan.');
    });
  }, [cwd]);
  const note = chosen === null ? suggestionNote(suggestion) : {};
  return { checked, set, reason: note.reason, hint: note.hint, error, retry: failedSave && chosen !== null ? () => set(chosen) : undefined };
}
