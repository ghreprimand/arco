import { useEffect, useMemo, useState } from 'react';
import { formatRelativeTime } from '../components/RightPanel/format';
import { mergeItems, rollupProjects, type ArtifactEntry, type DocEntry, type ProjectItem, type ProjectSummary } from './types';

// ARCHIVE (docs/CLIENT.md) - the project-artifact home. NOT a generic
// file browser: it answers "what docs + artifacts have I got across my projects,
// and where do I read them?" It merges TWO server read-models:
//
//   documents  — the .md/doc files written FOR a project, in its real tree
//                (Reports/*.md, root *.md, docs/*.md) — /api/explorer/docs
//   artifacts  — .arco workflow artifacts (Review/handoff/research outputs)
//                — /api/explorer/artifacts
//
// Two levels: HOME (recent-across-all strip + project cards) and PROJECT (drill
// into one project's merged docs+artifacts, filter box, viewer on click). Real
// project docs also get OPEN IN TREE (reveal); .arco artifacts are viewer-only.
// Pure HTTP; refetches on `focusTick` (poll-on-focus, §5).

interface Props {
  focusTick: number;
  onOpen: (path: string) => void;
  onRevealInTree: (path: string) => void;
}

const RECENT_STRIP = 10;

function subdirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '·' : rel.slice(0, i) + '/';
}
function revealable(path: string): boolean { return !path.includes('/.arco/'); }

export function ArtifactsLens({ focusTick, onOpen, onRevealInTree }: Props) {
  const [items, setItems] = useState<ProjectItem[] | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch('/api/explorer/docs').then((r) => r.json() as Promise<{ entries?: DocEntry[] }>).catch(() => ({ entries: [] })),
      fetch('/api/explorer/artifacts').then((r) => r.json() as Promise<{ entries?: ArtifactEntry[] }>).catch(() => ({ entries: [] })),
    ]).then(([docs, arts]) => {
      if (cancelled) return;
      setItems(mergeItems(arts.entries ?? [], docs.entries ?? []));
    });
    return () => { cancelled = true; };
  }, [focusTick]);

  const projects = useMemo<ProjectSummary[]>(() => rollupProjects(items ?? []), [items]);
  const recent = useMemo(() => (items ?? []).slice(0, RECENT_STRIP), [items]);
  const selected = useMemo(() => projects.find((p) => p.cwd === selectedCwd) ?? null, [projects, selectedCwd]);
  const projectItems = useMemo(() => {
    if (!selectedCwd) return [];
    const q = filter.trim().toLowerCase();
    return (items ?? [])
      .filter((it) => it.cwd === selectedCwd)
      .filter((it) => !q || it.name.toLowerCase().includes(q) || (it.rel ?? '').toLowerCase().includes(q) || (it.tabTitle ?? '').toLowerCase().includes(q));
  }, [items, selectedCwd, filter]);

  if (items === null) return <Centered text="Loading project documents…" />;

  // ── PROJECT view ──────────────────────────────────────────────────────────
  if (selected) {
    return (
      <div style={colStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
          <button onClick={() => { setSelectedCwd(null); setFilter(''); }} className="display-font" style={backBtnStyle}>← ALL PROJECTS</button>
          <div style={{ overflow: 'hidden' }}>
            <div className="display-font glow-text-cyan" style={{ fontSize: '17px', letterSpacing: '1px' }}>{selected.project}</div>
            <div style={{ fontSize: '12px', color: 'var(--color-fg-muted)' }} title={selected.cwd}>
              {countLabel(selected)} · {selected.cwd}
            </div>
          </div>
        </div>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by filename, folder, or tab title…" style={filterInputStyle} />
        <div style={{ flex: 1, overflowY: 'auto', marginTop: '10px' }}>
          {projectItems.length === 0 ? (
            <Centered text={filter ? 'Nothing matches that filter.' : 'No documents or artifacts in this project.'} />
          ) : (
            projectItems.map((it) => <ItemRow key={it.path} item={it} onOpen={onOpen} onRevealInTree={onRevealInTree} />)
          )}
        </div>
      </div>
    );
  }

  // ── HOME view ─────────────────────────────────────────────────────────────
  return (
    <div style={colStyle}>
      {recent.length > 0 && (
        <section style={{ marginBottom: '22px' }}>
          <SectionLabel>RECENT · ALL PROJECTS</SectionLabel>
          <div style={{ marginTop: '8px' }}>
            {recent.map((it) => <ItemRow key={it.path} item={it} onOpen={onOpen} onRevealInTree={onRevealInTree} showProject />)}
          </div>
        </section>
      )}

      <section style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <SectionLabel>PROJECTS ({projects.length})</SectionLabel>
        {projects.length === 0 ? (
          <Centered text="No documents or artifacts found yet. Write a doc, run a Review, or generate a file in a project — it'll appear here after a refresh." />
        ) : (
          <div style={cardGridStyle}>
            {projects.map((p) => (
              <button key={p.cwd} onClick={() => setSelectedCwd(p.cwd)} style={cardStyle} className="archive-project-card">
                <div className="display-font" style={{ fontSize: '15px', letterSpacing: '0.5px', color: 'var(--color-accent-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.project}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--color-fg-muted)', marginTop: '5px' }}>{countLabel(p)}</div>
                <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', marginTop: '3px', opacity: 0.8 }}>updated {formatRelativeTime(p.lastMtime)}</div>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function countLabel(p: ProjectSummary): string {
  const parts: string[] = [];
  if (p.docCount) parts.push(`${p.docCount} doc${p.docCount === 1 ? '' : 's'}`);
  if (p.artifactCount) parts.push(`${p.artifactCount} artifact${p.artifactCount === 1 ? '' : 's'}`);
  return parts.join(' · ') || '0 files';
}

function ItemRow({ item, onOpen, onRevealInTree, showProject }: { item: ProjectItem; onOpen: (p: string) => void; onRevealInTree: (p: string) => void; showProject?: boolean }) {
  const meta = item.kind === 'doc'
    ? `${showProject ? '' : subdirOf(item.rel ?? '') + ' · '}${formatRelativeTime(item.mtime)}`
    : `${item.tabTitle} · ${item.provider} · ${formatRelativeTime(item.mtime)}`;
  return (
    <div className="archive-row" style={rowStyle} title={item.path}>
      <button onClick={() => onOpen(item.path)} style={rowMainBtn}>
        <span style={{ width: '18px', flexShrink: 0, color: item.kind === 'doc' ? 'var(--color-accent-primary-dim)' : 'var(--color-accent-secondary-dim)', fontSize: '12px' }}>
          {item.kind === 'doc' ? '▤' : '⌸'}
        </span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-accent-secondary-dim)' }}>{item.name}</span>
        <span style={{ fontSize: '12px', color: 'var(--color-fg-muted)', flexShrink: 0, letterSpacing: '0.3px' }}>
          {showProject && <span style={{ color: 'var(--color-accent-primary-dim)' }}>{item.project} · </span>}
          {meta}
        </span>
      </button>
      {revealable(item.path) && (
        <button onClick={() => onRevealInTree(item.path)} className="display-font" title="Reveal in the file tree" style={revealBtn}>⊞</button>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="display-font" style={{ fontSize: '12px', letterSpacing: '2px', color: 'var(--color-accent-primary)' }}>{children}</div>;
}

function Centered({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-fg-muted)', fontSize: '13px', fontStyle: 'italic', padding: '24px', textAlign: 'center', lineHeight: 1.6 }}>
      {text}
    </div>
  );
}

const colStyle: React.CSSProperties = { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '18px 20px', overflow: 'hidden' };
const cardGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px', marginTop: '12px', overflowY: 'auto', paddingBottom: '8px', alignContent: 'start' };
const cardStyle: React.CSSProperties = { textAlign: 'left', background: 'var(--color-bg-panel)', border: '1px solid var(--color-border-hairline)', borderRadius: '5px', padding: '14px' , cursor: 'pointer' };
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '4px', width: '100%', borderBottom: '1px solid var(--color-border-hairline)' };
const rowMainBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', color: 'var(--color-fg)', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: '14px', padding: '9px 4px' };
const revealBtn: React.CSSProperties = { background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-accent-primary-dim)', cursor: 'pointer', fontSize: '13px', padding: '3px 8px', flexShrink: 0 };
const filterInputStyle: React.CSSProperties = { background: 'var(--color-bg-panel)', border: '1px solid var(--color-border-hairline)', borderRadius: '4px', color: 'var(--color-fg)', fontFamily: 'var(--font-body)', fontSize: '14px', padding: '8px 12px', outline: 'none' };
const backBtnStyle: React.CSSProperties = { background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-accent-primary-dim)', cursor: 'pointer', fontSize: '12px', letterSpacing: '1px', padding: '6px 11px', flexShrink: 0 };
