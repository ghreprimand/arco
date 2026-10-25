import { useEffect, useState, useCallback } from 'react';
import type {
  UpstreamComparisonResponse,
  CompareCommit,
  CompareDiffstat,
  FetchRemoteResponse,
  WorkingFileDiffResponse,
} from '@archon/shared';
import { DiffView } from './DiffView';

// Workbench Expansion I2 — the local ↔ remote comparison view.
//
// Shows how this cwd's current branch sits against its upstream: a
// "↑N to push / ↓M to pull" summary, an expandable commit list each direction,
// and the per-direction diff rendered in the A3 DiffView (its interface is
// untouched). A "Fetch" button runs POST /api/git/fetch then re-reads the
// comparison (GET /api/git/compare). Read-only except for the fetch — the
// mutating push/pull arrives in I3. Sits beside the I1 SOURCE sub-tab.

export interface CompareRemotePanelProps {
  wfid: string;
  cwd?: string;
}

type Direction = 'ahead' | 'behind';

export function CompareRemotePanel({ wfid, cwd }: CompareRemotePanelProps) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: UpstreamComparisonResponse }
  >({ kind: 'loading' });
  const [fetching, setFetching] = useState(false);
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [openDir, setOpenDir] = useState<Direction | null>(null);
  const [diffDir, setDiffDir] = useState<Direction | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    const params = new URLSearchParams({ wfid });
    if (cwd) params.set('path', cwd);
    fetch(`/api/git/compare?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
        return (await r.json()) as UpstreamComparisonResponse;
      })
      .then((data) => { if (!cancelled) setState({ kind: 'ready', data }); })
      .catch((err) => { if (!cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }); });
    return () => { cancelled = true; };
  }, [wfid, cwd, refreshKey]);

  // Reset transient selections whenever the comparison reloads.
  useEffect(() => { setOpenDir(null); setDiffDir(null); }, [wfid, cwd, refreshKey]);

  const runFetch = useCallback(async () => {
    setFetching(true);
    setFetchNote(null);
    try {
      const r = await fetch('/api/git/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wfid, ...(cwd ? { path: cwd } : {}) }),
      });
      const data = (await r.json()) as FetchRemoteResponse;
      if (data.ok) {
        setFetchNote(`Fetched ${data.remote}.`);
        setRefreshKey((k) => k + 1);
      } else {
        setFetchNote(`Fetch failed: ${data.error || 'unknown error'}`);
      }
    } catch (err) {
      setFetchNote(`Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setFetching(false);
    }
  }, [wfid, cwd]);

  const header = (
    <div
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 8px',
        borderBottom: '1px solid var(--color-border-hairline)',
      }}
    >
      <button
        type="button"
        onClick={() => void runFetch()}
        disabled={fetching}
        className="display-font"
        style={{
          all: 'unset',
          cursor: fetching ? 'default' : 'pointer',
          padding: '3px 10px',
          fontSize: '9px',
          letterSpacing: '1.5px',
          border: '1px solid var(--color-border-hairline)',
          borderRadius: '3px',
          color: fetching ? 'var(--color-fg-muted)' : 'var(--color-fg-secondary)',
          background: 'transparent',
        }}
      >
        {fetching ? 'FETCHING…' : 'FETCH'}
      </button>
      {fetchNote && (
        <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)' }}>
          {fetchNote}
        </span>
      )}
    </div>
  );

  let body: React.ReactNode;
  if (state.kind === 'loading') {
    body = <div className="archon-diff-empty display-font">Reading comparison…</div>;
  } else if (state.kind === 'error') {
    body = (
      <div className="archon-diff-empty display-font" style={{ color: 'var(--color-danger)' }}>
        Failed to read comparison: {state.message}
      </div>
    );
  } else {
    const d = state.data;
    if (!d.isRepo) {
      body = <div className="archon-diff-empty display-font">Not a git working tree — nothing to compare.</div>;
    } else if (d.detached) {
      body = <div className="archon-diff-empty display-font">Detached HEAD — no branch to compare against a remote.</div>;
    } else if (!d.hasUpstream) {
      body = (
        <div className="archon-diff-empty display-font">
          {d.branch ? `Branch "${d.branch}" has no upstream configured.` : 'No upstream configured.'} Set one with{' '}
          <code>git branch --set-upstream-to</code>, then Fetch.
        </div>
      );
    } else {
      const ahead = d.ahead ?? [];
      const behind = d.behind ?? [];
      if (ahead.length === 0 && behind.length === 0) {
        body = (
          <div className="archon-diff-empty display-font">
            In sync with {d.upstream}. Nothing to push or pull.
          </div>
        );
      } else {
        body = (
          <ComparisonBody
            wfid={wfid}
            cwd={cwd}
            upstream={d.upstream ?? ''}
            ahead={ahead}
            behind={behind}
            aheadDiffstat={d.aheadDiffstat}
            behindDiffstat={d.behindDiffstat}
            openDir={openDir}
            setOpenDir={setOpenDir}
            diffDir={diffDir}
            setDiffDir={setDiffDir}
          />
        );
      }
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {header}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{body}</div>
    </div>
  );
}

function diffstatLabel(s: CompareDiffstat | undefined): string {
  if (!s || (s.files === 0 && s.insertions === 0 && s.deletions === 0)) return '';
  const parts: string[] = [`${s.files} file${s.files === 1 ? '' : 's'}`];
  if (s.insertions) parts.push(`+${s.insertions}`);
  if (s.deletions) parts.push(`-${s.deletions}`);
  return parts.join(', ');
}

function ComparisonBody({
  wfid,
  cwd,
  upstream,
  ahead,
  behind,
  aheadDiffstat,
  behindDiffstat,
  openDir,
  setOpenDir,
  diffDir,
  setDiffDir,
}: {
  wfid: string;
  cwd?: string;
  upstream: string;
  ahead: CompareCommit[];
  behind: CompareCommit[];
  aheadDiffstat?: CompareDiffstat;
  behindDiffstat?: CompareDiffstat;
  openDir: Direction | null;
  setOpenDir: (d: Direction | null) => void;
  diffDir: Direction | null;
  setDiffDir: (d: Direction | null) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          flexShrink: 0,
          maxHeight: '45%',
          overflowY: 'auto',
          borderBottom: '1px solid var(--color-border-hairline)',
        }}
      >
        <div
          className="display-font"
          style={{ padding: '6px 8px', fontSize: '11px', letterSpacing: '0.5px', color: 'var(--color-fg-secondary)' }}
        >
          ↑{ahead.length} to push / ↓{behind.length} to pull{' '}
          <span style={{ color: 'var(--color-fg-muted)' }}>vs {upstream}</span>
        </div>
        <DirectionSection
          dir="ahead"
          label={`TO PUSH (${ahead.length})`}
          commits={ahead}
          diffstat={aheadDiffstat}
          open={openDir === 'ahead'}
          onToggleOpen={() => setOpenDir(openDir === 'ahead' ? null : 'ahead')}
          diffActive={diffDir === 'ahead'}
          onToggleDiff={() => setDiffDir(diffDir === 'ahead' ? null : 'ahead')}
        />
        <DirectionSection
          dir="behind"
          label={`TO PULL (${behind.length})`}
          commits={behind}
          diffstat={behindDiffstat}
          open={openDir === 'behind'}
          onToggleOpen={() => setOpenDir(openDir === 'behind' ? null : 'behind')}
          diffActive={diffDir === 'behind'}
          onToggleDiff={() => setDiffDir(diffDir === 'behind' ? null : 'behind')}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {diffDir ? (
          <DirectionDiffPane wfid={wfid} cwd={cwd} dir={diffDir} />
        ) : (
          <div className="archon-diff-empty display-font">Show a direction's diff to view it here.</div>
        )}
      </div>
    </div>
  );
}

function DirectionSection({
  dir,
  label,
  commits,
  diffstat,
  open,
  onToggleOpen,
  diffActive,
  onToggleDiff,
}: {
  dir: Direction;
  label: string;
  commits: CompareCommit[];
  diffstat?: CompareDiffstat;
  open: boolean;
  onToggleOpen: () => void;
  diffActive: boolean;
  onToggleDiff: () => void;
}) {
  if (commits.length === 0) return null;
  const stat = diffstatLabel(diffstat);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px 3px' }}>
        <button
          type="button"
          onClick={onToggleOpen}
          className="display-font"
          style={{
            all: 'unset',
            cursor: 'pointer',
            fontSize: '9px',
            letterSpacing: '1.5px',
            color: 'var(--color-fg-muted)',
          }}
        >
          {open ? '▾' : '▸'} {label}
        </button>
        {stat && <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-code)' }}>{stat}</span>}
        <button
          type="button"
          onClick={onToggleDiff}
          className="display-font"
          style={{
            all: 'unset',
            cursor: 'pointer',
            marginLeft: 'auto',
            fontSize: '9px',
            letterSpacing: '1px',
            color: diffActive ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
          }}
        >
          {diffActive ? 'HIDE DIFF' : 'SHOW DIFF'}
        </button>
      </div>
      {open &&
        commits.map((c) => (
          <div
            key={`${dir}:${c.hash}`}
            title={`${c.author} · ${new Date(c.ts).toLocaleString()}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '2px 8px 2px 18px',
              fontFamily: 'var(--font-code)',
              fontSize: '11px',
              color: 'var(--color-fg-secondary)',
            }}
          >
            <span style={{ color: 'var(--color-fg-muted)', flexShrink: 0 }}>{c.hash}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.subject}</span>
          </div>
        ))}
    </div>
  );
}

function DirectionDiffPane({ wfid, cwd, dir }: { wfid: string; cwd?: string; dir: Direction }) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: WorkingFileDiffResponse }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    // The per-direction diff reuses the A3 whole-tree diff endpoint with the
    // symmetric range refs git resolves from @{u}. ahead = upstream...HEAD,
    // behind = HEAD...@{u}. The server-side compare module owns range safety;
    // here we only ask for the rendered patch via the existing diff route.
    const params = new URLSearchParams({ wfid, direction: dir });
    if (cwd) params.set('path', cwd);
    fetch(`/api/git/compare/diff?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
        return (await r.json()) as WorkingFileDiffResponse;
      })
      .then((data) => { if (!cancelled) setState({ kind: 'ready', data }); })
      .catch((err) => { if (!cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }); });
    return () => { cancelled = true; };
  }, [wfid, cwd, dir]);

  if (state.kind === 'loading') {
    return <div className="archon-diff-empty display-font">Reading diff…</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="archon-diff-empty display-font" style={{ color: 'var(--color-danger)' }}>
        Failed to read diff: {state.message}
      </div>
    );
  }
  const { data } = state;
  if (!data.isRepo) {
    return <div className="archon-diff-empty display-font">Not a git working tree.</div>;
  }
  if (data.binary) {
    return <div className="archon-diff-empty display-font">Binary or oversized diff — not shown.</div>;
  }
  return <DiffView patch={data.patch} emptyText="No diff for this direction." />;
}
