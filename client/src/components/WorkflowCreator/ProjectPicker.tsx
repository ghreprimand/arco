import { useCallback, useEffect, useState } from 'react';

// Flat project list for the creator's WORKING DIRECTORY cell: registered
// folders, children of the optional scan folder, and folders a workflow ran
// in before. One click sets the cwd; the folder tree below stays available
// for anything not listed. Lives in its own file for the size budget.
export interface ProjectEntry {
  path: string;
  name: string;
  source: 'registered' | 'scanned' | 'recent';
  exists: boolean;
}

interface Props {
  workDir: string;
  onPick: (path: string) => void;
  // Pre-select the first existing project when nothing is chosen yet.
  autoPick?: boolean;
}

const SOURCE_LABEL: Record<ProjectEntry['source'], string> = { registered: 'PROJECT', scanned: 'SCANNED', recent: 'RECENT' };

export function ProjectPicker({ workDir, onPick, autoPick }: Props) {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      const data = (await res.json()) as { projects?: ProjectEntry[] };
      const list = Array.isArray(data.projects) ? data.projects : [];
      setProjects(list);
      return list;
    } catch { return null; /* keep the previous list */ }
  }, []);

  useEffect(() => {
    void load().then((list) => {
      const first = list?.find((p) => p.exists);
      if (autoPick && !workDir.trim() && first) onPick(first.path);
    });
    // Mount-time only: a later empty field is the operator clearing it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const current = workDir.trim().replace(/\/+$/, '');
  const registered = projects.some((p) => p.path === current && p.source === 'registered');

  async function register() {
    if (!current || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: current }) });
      const data = (await res.json()) as { projects?: ProjectEntry[]; error?: string };
      if (!res.ok) { setError(data.error || 'Could not add project'); return; }
      setProjects(Array.isArray(data.projects) ? data.projects : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-help="creator.projects" style={{ gridColumn: '1 / -1', border: '1px solid var(--color-border-hairline)', borderRadius: '4px', background: 'var(--color-bg-sunken)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px', borderBottom: '1px solid var(--color-border-hairline)' }}>
        <span className="display-font" style={{ flex: 1, fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>
          PROJECTS ({projects.length})
        </span>
        {current && !registered && (
          <button
            onClick={register}
            disabled={busy}
            className="display-font"
            title="Keep this folder in the project list"
            style={{ background: 'transparent', border: '1px solid var(--color-accent-secondary-dim)', borderRadius: '3px', color: 'var(--color-accent-secondary)', cursor: busy ? 'wait' : 'pointer', fontSize: '9px', letterSpacing: '1px', padding: '2px 8px' }}
          >
            {busy ? '...' : '+ ADD CURRENT FOLDER'}
          </button>
        )}
      </div>
      {error && (
        <div style={{ padding: '3px 8px', color: 'var(--color-warning)', fontSize: '10px', fontFamily: 'var(--font-display)', borderBottom: '1px solid var(--color-border-hairline)' }}>{error}</div>
      )}
      <div style={{ maxHeight: '160px', overflowY: 'auto' }}>
        {projects.length === 0 && (
          <div style={{ padding: '6px 12px', fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', fontStyle: 'italic' }}>
            No projects yet. Browse to a folder below, then ADD CURRENT FOLDER, or set a scan folder in Settings.
          </div>
        )}
        {projects.map((p) => (
          <button
            key={p.path}
            onClick={() => onPick(p.path)}
            disabled={!p.exists}
            title={p.exists ? p.path : `${p.path} (missing)`}
            style={{
              display: 'flex', alignItems: 'center', gap: '10px', width: '100%', padding: '4px 12px',
              background: current === p.path ? 'var(--color-accent-primary-a08)' : 'transparent',
              border: 'none', borderBottom: '1px solid var(--color-accent-primary-a05)',
              color: !p.exists ? 'var(--color-fg-muted)' : current === p.path ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)',
              cursor: p.exists ? 'pointer' : 'not-allowed', fontFamily: 'var(--font-body)', fontSize: '12px', textAlign: 'left',
            }}
          >
            <span style={{ minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '10px', color: 'var(--color-fg-muted)' }}>{p.path}</span>
            <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>{p.exists ? SOURCE_LABEL[p.source] : 'MISSING'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
