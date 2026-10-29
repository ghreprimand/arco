import { useEffect, useState } from 'react';
import { parseProjects, rootsOf, type HomeProject, type HomeRoot } from '../../utils/homeModel';

export type ProjectEntry = HomeProject;
export function ProjectPicker({ workDir, onPick, onBrowseRoot }: {
  workDir: string; onPick: (path: string) => void; onBrowseRoot?: (path: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [roots, setRoots] = useState<HomeRoot[]>([]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void fetch('/api/projects').then(async res => {
      if (!res.ok) throw new Error();
      const body = await res.json();
      if (active) { setProjects(parseProjects(body) ?? []); setRoots(rootsOf(body) ?? []); }
    }).catch(() => { if (active) setError('Project choices could not be loaded. Type or browse a folder.'); });
    return () => { active = false; };
  }, []);
  // Loading/filtering never chooses a working directory or overwrites typing.
  const current = workDir.trim();
  const registered = projects.some(p => p.path === current && p.source === 'registered');
  const shown = projects.filter(p => !p.archived && (filter === 'all' || filter === 'shortcuts' ? filter !== 'shortcuts' || p.pinned || p.source === 'recent' : p.rootPath === filter))
    .filter(p => `${p.name} ${p.path}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  async function keep() {
    if (!current || busy) return;
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: current }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not keep project');
      setProjects(parseProjects(body) ?? []);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not keep project'); }
    finally { setBusy(false); }
  }
  return <div className="project-folders-ui" data-help="creator.projects" style={{ gridColumn: '1 / -1', border: '1px solid var(--color-border-hairline)', borderRadius: 4, padding: 10 }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <label>Project location <select aria-label="Project location" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All folders</option><option value="shortcuts">Pinned and recent</option>{roots.map(root => <option key={root.path} value={root.path}>{root.name}{root.exists ? '' : ' (not reachable)'}</option>)}</select></label>
      <label style={{ flex: 1 }}>Search folders <input type="search" aria-label="Search folder choices" value={query} onChange={e => setQuery(e.target.value)} placeholder="Name or folder" style={{ width: '100%' }} /></label>
      {current && !registered && <button type="button" onClick={() => void keep()} disabled={busy}>Keep current folder</button>}
    </div>
    {filter !== 'all' && filter !== 'shortcuts' && <button type="button" onClick={() => onBrowseRoot?.(filter)}>Browse this location</button>}
    <div role="list" aria-label="Project choices" style={{ maxHeight: 170, overflowY: 'auto', marginTop: 8 }}>
      {shown.map(p => <div role="listitem" key={p.path}><button type="button" onClick={() => onPick(p.path)} disabled={!p.exists} title={p.path} aria-pressed={p.path === current} style={{ display: 'flex', gap: 8, width: '100%', textAlign: 'left', alignItems: 'center', padding: 6 }}>
        <strong>{p.name}</strong><small style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.path}</small><small>{!p.exists ? 'Missing' : p.pinned ? 'Pinned' : p.source === 'scanned' ? 'Folder' : p.source === 'recent' ? 'Recent' : 'Saved'}</small>
      </button></div>)}
      {!shown.length && <p>No matching folders. Type a path or browse another folder. A project location contains folders such as those kept under Work or Personal.</p>}
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
