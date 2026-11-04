import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { rootsOf, type HomeRoot } from '../utils/homeModel';
import { ProjectLocationForm } from './ProjectLocationForm';

export function ProjectRootsSettings({ onChanged }: { onChanged?: () => void } = {}) {
  const feedback = useRef<HTMLParagraphElement>(null);
  const [roots, setRoots] = useState<HomeRoot[]>([]);
  const [editor, setEditor] = useState<HomeRoot | 'add' | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [note, setNote] = useState('');
  const [browserPath, setBrowserPath] = useState('');
  const load = useCallback(async () => {
    const res = await fetch('/api/projects');
    if (!res.ok) throw new Error('Project locations could not be loaded. Retry.');
    const body = await res.json(); setRoots(rootsOf(body) ?? []); setBrowserPath(body.scanFolder || body.homeFolder || '');
  }, []);
  useEffect(() => { void load().catch(err => setError(err.message)); }, [load]);
  async function remove(location: HomeRoot) {
    setBusy(true); setError(''); setNote('');
    try {
      const fresh = await fetch('/api/projects'); if (!fresh.ok) throw new Error('Locations could not be refreshed.');
      const list = rootsOf(await fresh.json()); if (!list) throw new Error('Locations could not be read. Nothing was changed.');
      const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectRoots: list.filter(root => root.path !== location.path) }) });
      if (!res.ok) throw new Error('The location was not removed. Retry.');
      useAppStore.getState().setSettings(await res.json());
      await load(); onChanged?.(); setNote(`Location "${location.name}" removed. Its folders and saved work are unchanged.`);
    } catch (err) { setError(err instanceof Error ? err.message : 'The location was not removed.'); }
    finally { setBusy(false); }
  }
  return <section className="project-folders-ui" aria-labelledby="project-roots-title">
    <div className="location-heading"><h3 id="project-roots-title">Project locations</h3>{!editor && <button type="button" disabled={busy} onClick={() => { setEditor('add'); setNote(''); }}>Add location</button>}</div>
    <p>A location contains project folders, such as Work or Personal.</p>
    {note && <p ref={feedback} tabIndex={-1} role="status" className="location-feedback">{note}</p>}
    <ul className="location-list">{roots.map(root => <li key={root.path}>
      <div><strong>{root.name}</strong><div className="location-path" title={root.path}>{root.path}</div>{!root.exists && <small>Not reachable. Reconnect the drive or edit the location.</small>}</div>
      <button type="button" disabled={busy} aria-label={`Edit location ${root.name}`} onClick={() => { setEditor(root); setNote(''); }}>Edit</button>
      <button type="button" disabled={busy} aria-label={`Remove location ${root.name}`} onClick={() => void remove(root)}>Remove</button>
    </li>)}</ul>
    {!roots.length && <p>No locations yet. Add a folder containing projects, or open a single folder from Home.</p>}
    {editor && <ProjectLocationForm onBusyChange={value => { setBusy(value); if (value) setNote(''); }} key={editor === 'add' ? 'add' : editor.path} location={editor === 'add' ? undefined : editor} initialPath={browserPath} onCancel={() => setEditor(null)} onSaved={saved => { setRoots(rootsOf(saved.list) ?? []); setNote(saved.message); setEditor(null); onChanged?.(); requestAnimationFrame(() => { feedback.current?.focus(); feedback.current?.scrollIntoView({ block: 'nearest' }); }); }} />}
{error && <p role="alert">{error}</p>}
  </section>;
}
