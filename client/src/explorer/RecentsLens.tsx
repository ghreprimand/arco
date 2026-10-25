import { useEffect, useMemo, useState } from 'react';
import { formatRelativeTime } from '../components/RightPanel/format';
import { fileKind, type FileKind, type ChangedEntry, type RecentRecord } from './types';

// ARCHIVE (docs/ARCHIVE_PLAN.md §4.2) — the RECENTS lens, two sub-tabs:
//
//   AGENT WRITES     — the attributed ledger (which tab wrote what). Complete
//                      for Native writes / Review / media; best-effort for
//                      CLI/Codex/Cursor.
//   RECENTLY MODIFIED — the exhaustive, unattributed changed-within scan. The
//                      catch-all for Bash-created / generated files the ledger
//                      never saw. Either alone has a hole; together they cover.
//
// Shared filter chips (ALL/DOCS/IMAGES) + per-project dropdown. Clicking a row
// opens the viewer; real project files also expose OPEN IN TREE (reveal). Pure
// HTTP; refetches on `focusTick` (poll-on-focus, §5).

interface Props {
  focusTick: number;
  onOpen: (path: string) => void;
  onRevealInTree: (path: string) => void;
}

type SubTab = 'writes' | 'changed';
type Chip = 'all' | 'doc' | 'image';

// One normalized row shape both sub-tabs render.
interface Row {
  path: string;
  name: string;
  mtime: number;
  project?: string;
  meta: string;       // right-aligned attribution / size line
}

function basename(p: string): string { return p.split('/').filter(Boolean).pop() || p; }
// Under `.archon` (artifacts) the tree can't reveal it (dotdirs are hidden
// server-side); only real project files get OPEN IN TREE.
function revealable(path: string): boolean { return !path.includes('/.archon/'); }

export function RecentsLens({ focusTick, onOpen, onRevealInTree }: Props) {
  const [sub, setSub] = useState<SubTab>('writes');
  const [writes, setWrites] = useState<RecentRecord[] | null>(null);
  const [changed, setChanged] = useState<ChangedEntry[] | null>(null);
  const [chip, setChip] = useState<Chip>('all');
  const [project, setProject] = useState<string>('all');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/explorer/recents?limit=200')
      .then((r) => r.json() as Promise<{ records?: RecentRecord[] }>)
      .then((d) => { if (!cancelled) setWrites(d.records ?? []); })
      .catch(() => { if (!cancelled) setWrites([]); });
    return () => { cancelled = true; };
  }, [focusTick]);

  // The changed scan is heavier — fetch it lazily on first entry to that sub-tab
  // (and on focus while it's the active sub-tab).
  useEffect(() => {
    if (sub !== 'changed') return;
    let cancelled = false;
    setChanged(null);
    fetch('/api/explorer/changed?within=48h')
      .then((r) => r.json() as Promise<{ entries?: ChangedEntry[] }>)
      .then((d) => { if (!cancelled) setChanged(d.entries ?? []); })
      .catch(() => { if (!cancelled) setChanged([]); });
    return () => { cancelled = true; };
  }, [sub, focusTick]);

  const rows = useMemo<Row[] | null>(() => {
    if (sub === 'writes') {
      if (writes === null) return null;
      return writes.map((r) => ({
        path: r.path, name: basename(r.path), mtime: r.ts, project: r.project,
        meta: `${r.tabTitle} · ${r.provider} · ${r.tool} · ${formatRelativeTime(r.ts)}`,
      }));
    }
    if (changed === null) return null;
    return changed.map((e) => ({
      path: e.path, name: e.name, mtime: e.mtime, project: e.project,
      meta: `${formatSize(e.size)} · ${formatRelativeTime(e.mtime)}`,
    }));
  }, [sub, writes, changed]);

  const projects = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows ?? []) if (r.project) set.add(r.project);
    return [...set].sort();
  }, [rows]);

  const filtered = useMemo(() => {
    return (rows ?? []).filter((r) => {
      if (project !== 'all' && r.project !== project) return false;
      if (chip === 'all') return true;
      return fileKind(r.name) === (chip as FileKind);
    });
  }, [rows, chip, project]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '16px 18px', overflow: 'hidden' }}>
      {/* Sub-tab bar */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '10px' }}>
        <button onClick={() => setSub('writes')} className="display-font" style={subTabStyle(sub === 'writes')}>AGENT WRITES</button>
        <button onClick={() => setSub('changed')} className="display-font" style={subTabStyle(sub === 'changed')}>RECENTLY MODIFIED</button>
      </div>
      <div style={{ fontSize: '12px', color: 'var(--color-fg-muted)', marginBottom: '10px' }}>
        {sub === 'writes'
          ? 'Files agents wrote, attributed to the tab that wrote them — newest first.'
          : 'Every file changed in the last 48h under your projects — the complete, unattributed catch-all.'}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '4px' }}>
          {(['all', 'doc', 'image'] as Chip[]).map((c) => (
            <button key={c} onClick={() => setChip(c)} className="display-font" style={chipStyle(chip === c)}>
              {c === 'all' ? 'ALL' : c === 'doc' ? 'DOCS' : 'IMAGES'}
            </button>
          ))}
        </div>
        {projects.length > 0 && (
          <select value={project} onChange={(e) => setProject(e.target.value)} style={selectStyle}>
            <option value="all">All projects</option>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {rows === null ? (
          <Centered text={sub === 'changed' ? 'Scanning for recently modified files…' : 'Loading recent writes…'} />
        ) : filtered.length === 0 ? (
          <Centered text={emptyCopy(sub, rows.length)} />
        ) : (
          filtered.map((r) => (
            <div key={`${r.mtime}-${r.path}`} className="archive-row" style={rowStyle} title={r.path}>
              <button onClick={() => onOpen(r.path)} style={rowMainBtn}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-accent-secondary-dim)' }}>{r.name}</span>
                <span style={{ fontSize: '12px', color: 'var(--color-fg-muted)', flexShrink: 0, letterSpacing: '0.3px' }}>
                  {r.project ? <span style={{ color: 'var(--color-accent-primary-dim)' }}>{r.project} · </span> : null}
                  {r.meta}
                </span>
              </button>
              {revealable(r.path) && (
                <button onClick={() => onRevealInTree(r.path)} className="display-font" title="Reveal in the file tree" style={revealBtn}>⊞</button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function emptyCopy(sub: SubTab, total: number): string {
  if (total > 0) return 'Nothing matches this filter.';
  return sub === 'writes'
    ? 'No agent writes recorded yet. This ledger covers Claude Native Write/Edit, Review artifacts, media ops, and manual saves — CLI/Codex/Cursor tabs are best-effort, so use RECENTLY MODIFIED as the complete view.'
    : 'No files changed in the last 48h under your projects.';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Centered({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-fg-muted)', fontSize: '13px', fontStyle: 'italic', padding: '24px', textAlign: 'center', lineHeight: 1.6 }}>
      {text}
    </div>
  );
}

const subTabStyle = (active: boolean): React.CSSProperties => ({
  background: active ? 'var(--color-accent-primary-a10)' : 'transparent',
  border: `1px solid ${active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
  borderRadius: '3px', color: active ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)',
  cursor: 'pointer', fontSize: '12px', letterSpacing: '1px', padding: '6px 12px',
});
const chipStyle = (active: boolean): React.CSSProperties => ({
  background: active ? 'var(--color-accent-primary-a10)' : 'transparent',
  border: `1px solid ${active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
  borderRadius: '3px', color: active ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)',
  cursor: 'pointer', fontSize: '12px', letterSpacing: '1px', padding: '5px 11px',
});
const selectStyle: React.CSSProperties = {
  background: 'var(--color-bg-panel)', border: '1px solid var(--color-border-hairline)', borderRadius: '3px',
  color: 'var(--color-fg)', fontFamily: 'var(--font-body)', fontSize: '13px', padding: '5px 8px', outline: 'none',
};
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '4px', width: '100%', borderBottom: '1px solid var(--color-border-hairline)',
};
const rowMainBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent',
  border: 'none', color: 'var(--color-fg)', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: '14px', padding: '9px 4px',
};
const revealBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px',
  color: 'var(--color-accent-primary-dim)', cursor: 'pointer', fontSize: '13px', padding: '3px 8px', flexShrink: 0,
};
