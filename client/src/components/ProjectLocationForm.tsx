import { useEffect, useRef, useState } from 'react';
import type { HomeRoot } from '../utils/homeModel';
import { LocationConflict, saveProjectLocation, type LocationSaved } from '../utils/projectLocations';
import { useAppStore } from '../stores/appStore';
import { DirectoryBrowser } from './media/DirectoryPicker';

export function ProjectLocationForm({ location, initialPath = '', shortcuts = [], onSaved, onCancel, showBrowser = false, resetAfterSave = false, onBusyChange, autoFocus = true }: {
  location?: HomeRoot; initialPath?: string; shortcuts?: Array<{ name: string; path: string }>;
  autoFocus?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onSaved: (saved: LocationSaved) => void; onCancel?: () => void; showBrowser?: boolean; resetAfterSave?: boolean;
}) {
  const [name, setName] = useState(location?.name || ''), [path, setPath] = useState(location?.path || '');
  const [browser, setBrowser] = useState(showBrowser), [browserPath, setBrowserPath] = useState(location?.path || initialPath);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [conflict, setConflict] = useState<LocationConflict | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  useEffect(() => { if (autoFocus) first.current?.focus(); }, [autoFocus]);
  async function save(folder = path, renamePath?: string) {
    if (busy || !folder.trim()) return;
    setPath(folder); setBusy(true); onBusyChange?.(true); setError(''); setConflict(null);
    try {
      const saved = await saveProjectLocation({ name, path: folder }, renamePath || location?.path);
      useAppStore.getState().setSettings(saved.settings);
      if (resetAfterSave) { setName(''); setPath(''); setBrowser(false); }
      onSaved(saved);
    } catch (err) { setError(err instanceof Error ? err.message : 'The location was not saved.'); if (err instanceof LocationConflict) setConflict(err); requestAnimationFrame(() => { feedback.current?.focus(); feedback.current?.scrollIntoView({ block: 'nearest' }); }); }
    finally { setBusy(false); onBusyChange?.(false); }
  }
  return <div className="project-folders-ui location-editor">
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>Location name<input ref={first} aria-label="Location name" disabled={busy} value={name} onChange={e => setName(e.target.value)} placeholder="Work or Personal" maxLength={60} /></label>
      <label>Location folder path<input aria-label="Location folder path" disabled={busy} required value={path} onChange={e => { setPath(e.target.value); setConflict(null); setError(''); }} placeholder="Absolute folder path" /></label>
      <div className="location-actions"><button type="submit" disabled={busy || !path.trim()}>{busy ? 'Saving...' : location ? 'Save location' : 'Add location'}</button>
        <button type="button" disabled={busy} aria-expanded={browser} onClick={() => { if (path.trim()) setBrowserPath(path.trim()); setBrowser(!browser); }}>{browser ? 'Hide folder browser' : 'Browse folders'}</button>
        {onCancel && <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>}
      </div>
    </form>
    {error && <div ref={feedback} tabIndex={-1} role="alert" className="location-feedback"><p>{error}</p>{conflict && !conflict.editing && name.trim() && <button type="button" disabled={busy} onClick={() => void save(conflict.location.path, conflict.location.path)}>Rename {conflict.location.name} to {name.trim()}</button>}{conflict && !conflict.editing && !name.trim() && <button type="button" onClick={() => setName(conflict.location.name)}>Use existing name</button>}</div>}
    {browser && <DirectoryBrowser inline withFilename={false} roots={shortcuts.slice(0, 6)} initialPath={browserPath} title="Choose a project location" confirmLabel={busy ? 'Saving...' : location ? 'Save selected location' : 'Add selected location'} onDone={result => { if (result) void save(result.dir); }} />}
  </div>;
}
