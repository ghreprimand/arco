import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { rootsOf, type HomeRoot } from '../utils/homeModel';
import { DirectoryBrowser } from './media/DirectoryPicker';

export function ProjectRootsSettings() {
  const [roots, setRoots] = useState<HomeRoot[]>([]);
  const [name, setName] = useState(''), [path, setPath] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [browser, setBrowser] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    const res = await fetch('/api/projects');
    if (!res.ok) throw new Error('Roots could not be loaded. Retry.');
    setRoots(rootsOf(await res.json()) ?? []); setLoaded(true);
  }, []);
  useEffect(() => { void load().catch(err => setError(err.message)); }, [load]);
  async function save(next: Array<{ name: string; path: string }>) {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectRoots: next }) });
      if (!res.ok) throw new Error('Roots were not saved. Retry.');
      useAppStore.getState().setSettings(await res.json());
      await load(); setName(''); setPath(''); setEditing(null); setBrowser(false);
    } catch (err) { setError(err instanceof Error ? err.message : 'Roots were not saved.'); }
    finally { setBusy(false); }
  }
  return <section className="project-folders-ui" aria-labelledby="project-roots-title">
    <h3 id="project-roots-title">Project roots</h3>
    <p>A root is a named folder containing projects, such as Work or Personal. A project is one working folder. Adding a root discovers immediate child folders without saving or trusting them.</p>
    <ul style={{ listStyle: 'none', padding: 0 }}>{roots.map(root => <li key={root.path} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--color-border-hairline)' }}>
      <div style={{ flex: 1, minWidth: 0 }}><strong>{root.name}</strong><div style={{ overflowWrap: 'anywhere' }}>{root.path}</div><small>{root.exists ? 'Available' : 'Not reachable - reconnect the drive or edit the path'}</small></div>
      <button type="button" disabled={busy} aria-label={`Edit root ${root.name}`} onClick={() => { setEditing(root.path); setName(root.name); setPath(root.path); }}>Edit</button>
      <button type="button" disabled={busy} aria-label={`Remove root ${root.name}`} onClick={() => void save(roots.filter(r => r.path !== root.path))}>Remove</button>
    </li>)}</ul>
    {!roots.length && <p>No discovery roots. Individual projects remain available below.</p>}
    <form onSubmit={e => { e.preventDefault(); const next = { name: name.trim(), path: path.trim() }; void save(editing ? roots.map(root => root.path === editing ? next : root) : [...roots, next]); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
      <label>Root name<input aria-label="Root name" value={name} onChange={e => setName(e.target.value)} placeholder="Work" maxLength={60} /></label>
      <label style={{ flex: 1, minWidth: 120 }}>Root folder path<input aria-label="Root folder path" required value={path} onChange={e => setPath(e.target.value)} placeholder="Absolute folder path" style={{ width: '100%' }} /></label>
      <button type="submit" disabled={busy || !loaded || !path.trim()}>{editing ? 'Save root' : 'Add root'}</button>
      <button type="button" onClick={() => setBrowser(!browser)}>Browse root folder</button>
      {editing && <button type="button" onClick={() => { setEditing(null); setName(''); setPath(''); }}>Cancel edit</button>}
    </form>
    {browser && <DirectoryBrowser inline withFilename={false} initialPath={path} roots={roots} title="Choose a project root" confirmLabel="Choose root folder" onDone={r => { if (r) { setPath(r.dir); setBrowser(false); } }} />}
    <p>Removing a root removes discovery and grouping only. Registered projects, folders and saved sessions stay intact.</p>
    {error && <p role="alert">{error}</p>}
  </section>;
}
