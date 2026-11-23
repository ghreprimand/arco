import { useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { DirectoryBrowser } from './media/DirectoryPicker';
import { RESEARCH_ROUND_TIMEOUT_MAX_MINUTES, RESEARCH_ROUND_TIMEOUT_MIN_MINUTES, researchTimeLimitMinutes } from '@arco/shared';

// Settings > Projects > Research folder (docs/RESEARCH.md): the folder that
// holds every research project. Changing it affects only new projects.
export function ResearchFolderSetting() {
  const settings = useAppStore(s => s.settings);
  const [draft, setDraft] = useState(settings?.researchFolder ?? '');
  const [browser, setBrowser] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => setDraft(settings?.researchFolder ?? ''), [settings?.researchFolder]);
  async function save() {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ researchFolder: draft.trim() }) });
      if (!res.ok) throw new Error('The research folder was not saved.');
      useAppStore.getState().setSettings(await res.json());
    } catch (err) { setError(err instanceof Error ? err.message : 'The research folder was not saved.'); }
    finally { setBusy(false); }
  }
  return <section className="project-folders-ui" data-help="settings.research-folder">
    <h3>Research folder</h3>
    <p>Each research project gets its own subfolder here. Changing it affects only new projects; existing ones stay where they are.</p>
    <form onSubmit={e => { e.preventDefault(); void save(); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <label style={{ flex: 1 }}>Research folder path<input aria-label="Research folder path" value={draft} onChange={e => setDraft(e.target.value)} placeholder="Not set; asked when research starts" style={{ width: '100%' }} /></label>
      <button type="submit" disabled={busy}>Save research folder</button><button type="button" onClick={() => setBrowser(!browser)}>Browse research folder</button>
    </form>
    {browser && <DirectoryBrowser inline withFilename={false} initialPath={draft} roots={settings?.projectRoots} title="Choose research folder" confirmLabel="Choose research folder" onDone={r => { if (r) { setDraft(r.dir); setBrowser(false); } }} />}
    {error && <p role="alert">{error}</p>}
  </section>;
}

// Settings > Projects > Research time limit (docs/RESEARCH.md): minutes before
// a researcher that has not replied to a round or catch-up is timed out.
export function ResearchTimeLimitSetting() {
  const saved = useAppStore(s => researchTimeLimitMinutes(s.settings?.researchTimeLimitMinutes));
  const [draft, setDraft] = useState(String(saved));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => setDraft(String(saved)), [saved]);
  const value = Number(draft);
  const valid = Number.isInteger(value) && value >= RESEARCH_ROUND_TIMEOUT_MIN_MINUTES && value <= RESEARCH_ROUND_TIMEOUT_MAX_MINUTES;
  async function save() {
    if (!valid) return;
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ researchTimeLimitMinutes: value }) });
      if (!res.ok) throw new Error('The research time limit was not saved.');
      useAppStore.getState().setSettings(await res.json());
    } catch (err) { setError(err instanceof Error ? err.message : 'The research time limit was not saved.'); }
    finally { setBusy(false); }
  }
  return <section className="project-folders-ui" data-help="settings.research-time-limit">
    <h3>Research time limit</h3>
    <p>A researcher that has not replied to a round within this time is timed out. Applies to rounds and catch-ups started after saving.</p>
    <form onSubmit={e => { e.preventDefault(); void save(); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <label>Minutes ({RESEARCH_ROUND_TIMEOUT_MIN_MINUTES} to {RESEARCH_ROUND_TIMEOUT_MAX_MINUTES})<input type="number" inputMode="numeric" aria-label="Research time limit in minutes" min={RESEARCH_ROUND_TIMEOUT_MIN_MINUTES} max={RESEARCH_ROUND_TIMEOUT_MAX_MINUTES} step={1} value={draft} onChange={e => setDraft(e.target.value)} style={{ width: '8em', display: 'block' }} /></label>
      <button type="submit" disabled={busy || !valid || value === saved}>Save research time limit</button>
    </form>
    {!valid && <p role="alert">Enter a whole number from {RESEARCH_ROUND_TIMEOUT_MIN_MINUTES} to {RESEARCH_ROUND_TIMEOUT_MAX_MINUTES}.</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
