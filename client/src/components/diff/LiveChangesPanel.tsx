import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type {
  WorkingChangeEntry,
  WorkingChangesResponse,
  WorkingFileDiffResponse,
} from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import {
  liveChangesKey,
  requestLiveChangesSubscribe,
  requestLiveChangesUnsubscribe,
  useLiveChangesStore,
} from '../../stores/liveChangesStore';

type Group = 'staged' | 'unstaged' | 'untracked';

interface LiveRow {
  path: string;
  group: Group;
  status: string;
  origPath?: string;
}

interface FilePayloadText { type: 'text'; content: string; size: number }
interface FilePayloadImage { type: 'image'; dataUrl: string; size: number }
interface FilePayloadBinary { type: 'binary'; size: number }
interface FilePayloadTooLarge { type: 'too-large'; size: number; kind: 'text' | 'image' }
interface FilePayloadError { type: 'error'; error: string }
type FilePayload = FilePayloadText | FilePayloadImage | FilePayloadBinary | FilePayloadTooLarge | FilePayloadError;

interface HunkRange {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

const POLL_MS = 1200;

const GROUP_LABEL: Record<Group, string> = {
  staged: 'STAGED',
  unstaged: 'CHANGING',
  untracked: 'NEW FILES',
};

const GROUP_ORDER: Group[] = ['unstaged', 'untracked', 'staged'];

export function LiveChangesPanel({
  wfid,
  cwd,
  memberLabel,
}: {
  wfid: string;
  cwd: string;
  memberLabel?: string;
}) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: WorkingChangesResponse }
  >({ kind: 'loading' });
  const [selected, setSelected] = useState<LiveRow | null>(null);
  const [lastTouched, setLastTouched] = useState<Record<string, number>>({});
  const previousSigRef = useRef<Record<string, string>>({});
  const connected = useAppStore((s) => s.connected);
  const liveSnapshot = useLiveChangesStore((s) => s.snapshots[liveChangesKey(wfid, cwd)]);

  const load = useCallback(async (initial = false) => {
    const params = new URLSearchParams({ wfid, path: cwd });
    const r = await fetch(`/api/git/diff?${params.toString()}`);
    if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
    const data = (await r.json()) as WorkingChangesResponse;
    const nextSig = signatureMap(data);
    const previous = previousSigRef.current;
    const now = Date.now();
    if (!initial) {
      const touched: Record<string, number> = {};
      for (const [key, sig] of Object.entries(nextSig)) {
        if (previous[key] !== sig) touched[key] = now;
      }
      if (Object.keys(touched).length > 0) {
        setLastTouched((prev) => ({ ...prev, ...touched }));
      }
    }
    previousSigRef.current = nextSig;
    setState({ kind: 'ready', data });
  }, [cwd, wfid]);

  useEffect(() => {
    if (!connected || !wfid || !cwd) return;
    requestLiveChangesSubscribe(wfid, cwd);
    return () => {
      requestLiveChangesUnsubscribe(wfid, cwd);
    };
  }, [connected, cwd, wfid]);

  useEffect(() => {
    if (!liveSnapshot) return;
    const nextSig = signatureMap(liveSnapshot.data, liveSnapshot.fingerprints);
    const previous = previousSigRef.current;
    const now = Date.now();
    if (Object.keys(previous).length > 0) {
      const touched: Record<string, number> = {};
      for (const [key, sig] of Object.entries(nextSig)) {
        if (previous[key] !== sig) touched[key] = now;
      }
      if (Object.keys(touched).length > 0) {
        setLastTouched((prev) => ({ ...prev, ...touched }));
      }
    }
    previousSigRef.current = nextSig;
    setState({ kind: 'ready', data: liveSnapshot.data });
  }, [liveSnapshot]);

  useEffect(() => {
    if (liveSnapshot) return;
    let cancelled = false;
    const tick = (initial = false) => {
      load(initial)
        .catch((err) => {
          if (!cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        });
    };
    setState({ kind: 'loading' });
    tick(true);
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') tick(false);
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [liveSnapshot, load]);

  const rows = useMemo(() => state.kind === 'ready' ? flatten(dataOrEmpty(state.data)) : [], [state]);
  const visibleRows = useMemo(() => rows.filter((row) => !isArcoStatePath(row.path)), [rows]);
  const hiddenArcoRows = rows.length - visibleRows.length;

  useEffect(() => {
    if (visibleRows.length === 0) {
      setSelected(null);
      return;
    }
    setSelected((current) => {
      if (current && visibleRows.some((r) => rowKey(r) === rowKey(current))) return current;
      return visibleRows[0];
    });
  }, [visibleRows]);

  if (!wfid) {
    return <div className="arco-diff-empty display-font">No cluster member is available to read workspace changes.</div>;
  }
  if (state.kind === 'loading') {
    return <div className="arco-diff-empty display-font">Watching working tree...</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="arco-diff-empty display-font" style={{ color: 'var(--color-danger)' }}>
        Live changes failed: {state.message}
      </div>
    );
  }
  if (!state.data.isRepo) {
    return <div className="arco-diff-empty display-font">Not a git working tree - live changes need a repo in this version.</div>;
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div
        style={{
          width: '36%',
          minWidth: '210px',
          maxWidth: '360px',
          borderRight: '1px solid var(--color-border-hairline)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <div
          className="display-font"
          style={{
            flexShrink: 0,
            padding: '7px 9px',
            borderBottom: '1px solid var(--color-border-hairline)',
            color: 'var(--color-fg-muted)',
            fontSize: '9px',
            letterSpacing: '1.5px',
          }}
        >
          LIVE WORKTREE {memberLabel ? `- ${memberLabel}` : ''}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {visibleRows.length === 0 ? (
            <div className="arco-diff-empty display-font" style={{ padding: '10px' }}>Working tree clean.</div>
          ) : (
            GROUP_ORDER.map((group) => (
              <LiveGroup
                key={group}
                label={GROUP_LABEL[group]}
                rows={visibleRows.filter((r) => r.group === group)}
                selected={selected}
                touched={lastTouched}
                onSelect={setSelected}
              />
            ))
          )}
          {hiddenArcoRows > 0 && (
            <div
              className="display-font"
              title="Arco's own .arco runtime state is hidden from LIVE so agent edits stay visible."
              style={{ padding: '8px', color: 'var(--color-fg-muted)', fontSize: '8px', letterSpacing: '1px' }}
            >
              HIDING {hiddenArcoRows} ARCO STATE FILE{hiddenArcoRows === 1 ? '' : 'S'}
            </div>
          )}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        {selected ? (
          <LiveFileSource
            wfid={wfid}
            cwd={cwd}
            row={selected}
            refreshKey={liveSnapshot?.fingerprints?.[rowKey(selected)] ?? String(liveSnapshot?.ts ?? '')}
          />
        ) : (
          <div className="arco-diff-empty display-font">Select a changed file to inspect the edited area.</div>
        )}
      </div>
    </div>
  );
}

function LiveGroup({
  label,
  rows,
  selected,
  touched,
  onSelect,
}: {
  label: string;
  rows: LiveRow[];
  selected: LiveRow | null;
  touched: Record<string, number>;
  onSelect: (row: LiveRow) => void;
}) {
  if (rows.length === 0) return null;
  const now = Date.now();
  return (
    <div>
      <div className="display-font" style={groupHeaderStyle}>{label} ({rows.length})</div>
      {rows.map((row) => {
        const active = selected && rowKey(selected) === rowKey(row);
        const fresh = now - (touched[rowKey(row)] ?? 0) < 2500;
        return (
          <button
            key={rowKey(row)}
            type="button"
            onClick={() => onSelect(row)}
            title={row.origPath ? `${row.origPath} -> ${row.path}` : row.path}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              border: 'none',
              borderLeft: fresh ? '2px solid var(--color-warning)' : '2px solid transparent',
              background: active
                ? 'var(--color-accent-primary-a08)'
                : fresh
                  ? 'rgba(255, 205, 86, 0.08)'
                  : 'transparent',
              color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-secondary)',
              cursor: 'pointer',
              padding: '4px 8px',
              textAlign: 'left',
              fontFamily: 'var(--font-code)',
              fontSize: '11px',
            }}
          >
            <span style={{ width: '14px', flexShrink: 0, color: statusColor(row.status) }}>{row.status}</span>
            <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row.origPath ? `${row.origPath} -> ${row.path}` : row.path}
            </span>
            {fresh && <span className="display-font" style={{ color: 'var(--color-warning)', fontSize: '8px' }}>LIVE</span>}
          </button>
        );
      })}
    </div>
  );
}

function LiveFileSource({ wfid, cwd, row, refreshKey }: { wfid: string; cwd: string; row: LiveRow; refreshKey: string }) {
  const [diff, setDiff] = useState<WorkingFileDiffResponse | null>(null);
  const [payload, setPayload] = useState<FilePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const lineRefs = useRef<Record<number, HTMLDivElement | null>>({});

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setPayload(null);
    setError(null);
    setFocus(0);
    const diffParams = new URLSearchParams({ wfid, path: cwd, file: row.path });
    if (row.group === 'staged') diffParams.set('staged', '1');
    const fileParams = new URLSearchParams({ path: joinPath(cwd, row.path) });
    Promise.all([
      fetch(`/api/git/diff?${diffParams.toString()}`).then(async (r) => {
        if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
        return (await r.json()) as WorkingFileDiffResponse;
      }),
      fetch(`/api/file-content?${fileParams.toString()}`).then((r) => r.json() as Promise<FilePayload>),
    ])
      .then(([d, p]) => {
        if (cancelled) return;
        setDiff(d);
        setPayload(p);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, row.group, row.path, wfid]);

  const hunks = useMemo(() => parseHunks(diff?.patch ?? ''), [diff?.patch]);
  const changedLines = useMemo(() => changedLineSet(hunks), [hunks]);

  const scrollToHunk = useCallback((index: number) => {
    const hunk = hunks[index];
    if (!hunk) return;
    const line = Math.max(1, hunk.newStart);
    lineRefs.current[line]?.scrollIntoView({ block: 'center' });
    setFocus(index);
  }, [hunks]);

  useEffect(() => {
    if (hunks.length === 0 || !payload || payload.type !== 'text') return;
    const id = window.requestAnimationFrame(() => scrollToHunk(0));
    return () => window.cancelAnimationFrame(id);
  }, [hunks, payload, scrollToHunk]);

  if (error) {
    return <div className="arco-diff-empty display-font" style={{ color: 'var(--color-danger)' }}>Failed to inspect file: {error}</div>;
  }
  if (!diff || !payload) {
    return <div className="arco-diff-empty display-font">Opening changed area...</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={sourceToolbarStyle}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="display-font" style={{ color: 'var(--color-accent-primary)', fontSize: '10px', letterSpacing: '1px' }}>
            {row.status} {row.group.toUpperCase()}
          </div>
          <div title={row.path} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-fg-muted)', fontSize: '10px', marginTop: '2px' }}>
            {row.path}
          </div>
        </div>
        {hunks.length > 0 && payload.type === 'text' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
            <button type="button" onClick={() => scrollToHunk(Math.max(0, focus - 1))} style={tinyButtonStyle}>PREV</button>
            <span className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '9px' }}>
              {focus + 1}/{hunks.length}
            </span>
            <button type="button" onClick={() => scrollToHunk(Math.min(hunks.length - 1, focus + 1))} style={tinyButtonStyle}>NEXT</button>
          </div>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--color-bg)' }}>
        {diff.binary && <div className="arco-diff-empty display-font">Binary or oversized file - source diff is not available.</div>}
        {payload.type === 'text' && (
          <pre style={{ margin: 0, padding: '8px 0', fontFamily: 'var(--font-code)', fontSize: '11px', lineHeight: 1.55 }}>
            {payload.content.split('\n').map((line, index) => {
              const lineNo = index + 1;
              const changed = changedLines.has(lineNo);
              return (
                <div
                  key={lineNo}
                  ref={(el) => { lineRefs.current[lineNo] = el; }}
                  style={{
                    display: 'flex',
                    minWidth: 0,
                    background: changed ? 'rgba(80, 200, 120, 0.12)' : 'transparent',
                    borderLeft: changed ? '2px solid var(--color-success)' : '2px solid transparent',
                  }}
                >
                  <span style={{ width: '48px', flexShrink: 0, paddingRight: '8px', textAlign: 'right', color: changed ? 'var(--color-success)' : 'var(--color-fg-muted)', userSelect: 'none' }}>
                    {lineNo}
                  </span>
                  <code style={{ display: 'block', minWidth: 0, flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--color-fg)' }}>
                    {line || ' '}
                  </code>
                </div>
              );
            })}
          </pre>
        )}
        {payload.type === 'image' && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '14px' }}>
            <img src={payload.dataUrl} alt={row.path} style={{ maxWidth: '100%', maxHeight: '70vh' }} />
          </div>
        )}
        {payload.type === 'binary' && <InfoLine text={`Binary file (${formatSize(payload.size)}) - no preview available.`} />}
        {payload.type === 'too-large' && <InfoLine text={`${payload.kind === 'image' ? 'Image' : 'Text'} too large to preview (${formatSize(payload.size)}).`} />}
        {payload.type === 'error' && <InfoLine danger text={payload.error} />}
      </div>
    </div>
  );
}

function dataOrEmpty(data: WorkingChangesResponse): WorkingChangesResponse {
  return {
    isRepo: data.isRepo,
    staged: data.staged ?? [],
    unstaged: data.unstaged ?? [],
    untracked: data.untracked ?? [],
  };
}

function flatten(data: WorkingChangesResponse): LiveRow[] {
  const mapRows = (group: Group, entries: WorkingChangeEntry[]): LiveRow[] =>
    entries.map((e) => ({ group, path: e.path, status: e.status, ...(e.origPath ? { origPath: e.origPath } : {}) }));
  return [
    ...mapRows('unstaged', data.unstaged),
    ...mapRows('untracked', data.untracked),
    ...mapRows('staged', data.staged),
  ];
}

function signatureMap(data: WorkingChangesResponse, fingerprints: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of flatten(dataOrEmpty(data))) {
    out[rowKey(row)] = `${row.status}:${row.origPath ?? ''}:${fingerprints[rowKey(row)] ?? ''}`;
  }
  return out;
}

function rowKey(row: LiveRow): string {
  return `${row.group}:${row.path}`;
}

function isArcoStatePath(path: string): boolean {
  return path === '.arco' || path.startsWith('.arco/');
}

function joinPath(cwd: string, file: string): string {
  if (file.startsWith('/')) return file;
  return `${cwd.replace(/[\\/]+$/, '')}/${file}`;
}

function parseHunks(patch: string): HunkRange[] {
  const hunks: HunkRange[] = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(patch)) !== null) {
    hunks.push({
      oldStart: Number(match[1]),
      oldLines: Number(match[2] ?? '1'),
      newStart: Number(match[3]),
      newLines: Number(match[4] ?? '1'),
    });
  }
  return hunks;
}

function changedLineSet(hunks: HunkRange[]): Set<number> {
  const set = new Set<number>();
  for (const h of hunks) {
    const count = Math.max(1, h.newLines);
    for (let i = 0; i < count; i++) set.add(Math.max(1, h.newStart + i));
  }
  return set;
}

function statusColor(status: string): string {
  if (status === '?' || status === 'A') return 'var(--color-success)';
  if (status === 'D') return 'var(--color-danger)';
  if (status === 'R' || status === 'C') return 'var(--color-warning)';
  return 'var(--color-accent-primary-dim)';
}

function InfoLine({ text, danger = false }: { text: string; danger?: boolean }) {
  return (
    <div className="arco-diff-empty display-font" style={{ color: danger ? 'var(--color-danger)' : 'var(--color-fg-muted)' }}>
      {text}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const groupHeaderStyle: CSSProperties = {
  padding: '7px 8px 3px',
  color: 'var(--color-fg-muted)',
  fontSize: '9px',
  letterSpacing: '1.4px',
};

const sourceToolbarStyle: CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '8px 10px',
  borderBottom: '1px solid var(--color-border-hairline)',
  background: 'var(--color-bg-panel)',
};

const tinyButtonStyle: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary-dim)',
  cursor: 'pointer',
  fontFamily: 'var(--font-display)',
  fontSize: '9px',
  letterSpacing: '1px',
  padding: '3px 6px',
};
