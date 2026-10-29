import { useCallback, useEffect, useState } from 'react';
import { ProjectRootsSettings } from './ProjectRootsSettings';
import { WorkingDirectoryDefault } from './WorkingDirectoryDefault';
import type { ProjectEntry } from './WorkflowCreator/ProjectPicker';

// Settings -> PROJECTS. The registered project folders (absolute paths that can
// live anywhere), plus the optional scan folder below. Own file to keep
// SettingsPanel under the size budget.
export function ProjectsSettings() {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      const data = (await res.json()) as { projects?: ProjectEntry[] };
      setProjects(Array.isArray(data.projects) ? data.projects : []);
    } catch { /* keep the previous list */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function mutate(method: 'POST' | 'DELETE', path: string) {
    if (!path || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/projects', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
      const data = (await res.json()) as { projects?: ProjectEntry[]; error?: string };
      if (!res.ok) { setError(data.error || 'Request failed'); return; }
      setProjects(Array.isArray(data.projects) ? data.projects : []);
      if (method === 'POST') setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const registered = projects.filter((p) => p.source === 'registered');
  const others = projects.filter((p) => p.source !== 'registered');
  const row = (p: ProjectEntry, removable: boolean) => (
    <div key={p.path} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 10px', borderBottom: '1px solid var(--color-accent-primary-a05)', fontSize: '11px', fontFamily: 'var(--font-code)', color: p.exists ? 'var(--color-accent-primary-dim)' : 'var(--color-fg-muted)' }}>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.path}>{p.path}</span>
      <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>{p.exists ? (p.source === 'scanned' ? 'FOLDER' : p.source === 'recent' ? 'USED' : '') : 'MISSING'}</span>
      {removable ? (
        <button onClick={() => { void mutate('DELETE', p.path); }} disabled={busy} title="Remove from the project list" style={{ background: 'none', border: 'none', color: 'var(--color-accent-secondary-dim)', cursor: 'pointer', fontSize: '11px' }}>Remove</button>
      ) : (
        <button onClick={() => { void mutate('POST', p.path); }} disabled={busy || !p.exists} title="Keep this folder in the project list" className="display-font" style={{ background: 'none', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-accent-secondary-dim)', cursor: 'pointer', fontSize: '9px', letterSpacing: '1px', padding: '1px 6px' }}>KEEP</button>
      )}
    </div>
  );

  return (
    <div data-help="settings.projects">
      <ProjectRootsSettings onChanged={() => void load()} />
      <details className="saved-project-management"><summary>Manage saved project folders ({registered.length})</summary>
      <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' }}>
        SAVED PROJECT FOLDERS
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void mutate('POST', draft.trim()); } }}
          placeholder="Absolute path to a project folder"
          spellCheck={false}
          style={{ flex: 1, minWidth: 0, padding: '6px 10px', background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-accent-primary)', fontSize: '11px', fontFamily: 'var(--font-code)' }}
        />
        <button
          onClick={() => { void mutate('POST', draft.trim()); }}
          disabled={busy || !draft.trim()}
          className="display-font"
          style={{ background: 'none', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: draft.trim() ? 'var(--color-accent-secondary)' : 'var(--color-fg-muted)', cursor: draft.trim() ? 'pointer' : 'not-allowed', fontSize: '10px', letterSpacing: '1px', padding: '5px 10px', whiteSpace: 'nowrap' }}
        >
          {busy ? '...' : '+ ADD'}
        </button>
      </div>
      {error && <div style={{ color: 'var(--color-warning)', fontSize: '10px', fontFamily: 'var(--font-display)', marginBottom: '6px' }}>{error}</div>}
      <div style={{ border: '1px solid var(--color-border-hairline)', borderRadius: '4px', background: 'var(--color-bg-sunken)', marginBottom: '8px', maxHeight: '220px', overflowY: 'auto' }}>
        {registered.map((p) => row(p, true))}
        {registered.length === 0 && (
          <div style={{ padding: '6px 10px', fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', fontStyle: 'italic' }}>No saved project folders. Add a path above, or keep a folder below.</div>
        )}
        <details><summary>Other available folders ({others.length})</summary>{others.map((p) => row(p, false))}</details>
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', marginBottom: '14px', lineHeight: 1.5 }}>
        Saved folders stay available even when their location is removed. Removing a saved folder never deletes its files or sessions.
      </div>
      </details>
      <details className="advanced-folder-options"><summary>Advanced folder options</summary><WorkingDirectoryDefault /></details>
    </div>
  );
}
