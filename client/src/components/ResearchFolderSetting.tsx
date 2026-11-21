import { useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { DirectoryBrowser } from './media/DirectoryPicker';

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
