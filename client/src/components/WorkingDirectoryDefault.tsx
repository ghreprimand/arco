import { useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { DirectoryBrowser } from './media/DirectoryPicker';

export function WorkingDirectoryDefault() {
  const settings = useAppStore(s => s.settings);
  const [draft, setDraft] = useState(settings?.defaultWorkingDirectory ?? '');
  const [browser, setBrowser] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => setDraft(settings?.defaultWorkingDirectory ?? ''), [settings?.defaultWorkingDirectory]);
  async function save() {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultWorkingDirectory: draft.trim() }) });
      if (!res.ok) throw new Error('Browsing default was not saved.');
      useAppStore.getState().setSettings(await res.json());
    } catch (err) { setError(err instanceof Error ? err.message : 'Browsing default was not saved.'); }
    finally { setBusy(false); }
  }
  return <section className="project-folders-ui" data-help="settings.default-working-dir">
    <h3>Default browsing location</h3>
    <p>Where the folder browser starts. Changing this does not add a project root or register folders. Leave blank to use the server default.</p>
    <form onSubmit={e => { e.preventDefault(); void save(); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <label style={{ flex: 1 }}>Browsing folder path<input aria-label="Browsing folder path" value={draft} onChange={e => setDraft(e.target.value)} placeholder="Server default" style={{ width: '100%' }} /></label>
      <button type="submit" disabled={busy}>Save browsing location</button><button type="button" onClick={() => setBrowser(!browser)}>Browse location</button>
    </form>
    {browser && <DirectoryBrowser inline withFilename={false} initialPath={draft} roots={settings?.projectRoots} title="Choose browsing location" confirmLabel="Choose browsing location" onDone={r => { if (r) { setDraft(r.dir); setBrowser(false); } }} />}
    {error && <p role="alert">{error}</p>}
  </section>;
}
