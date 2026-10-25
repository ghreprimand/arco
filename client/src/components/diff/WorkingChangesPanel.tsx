import { useEffect, useState, useCallback } from 'react';
import type {
  WorkingChangesResponse,
  WorkingChangeEntry,
  WorkingFileDiffResponse,
  GitOpResult,
} from '@archon/shared';
import { DiffView } from './DiffView';
import { GitOpsBar } from './GitOpsBar';

// Workbench Expansion I1 — the "Source Control" working-tree changes view.
//
// Lists the working tree's changed files grouped staged / unstaged /
// untracked (GET /api/git/diff?wfid). Clicking a file fetches its per-file
// unified diff (GET /api/git/diff?wfid&file&staged) and renders it in the
// source-agnostic A3 DiffView — DiffView's interface is untouched; this layer
// owns all the I1 endpoint knowledge. Sits beside the A3 whole-tree CHANGES
// sub-tab in the Files panel.

export interface WorkingChangesPanelProps {
  wfid: string;
  cwd?: string;
  // Bump to force a refetch of the status list.
  refreshKey?: number;
}

type Group = 'staged' | 'unstaged' | 'untracked';

interface Selected {
  path: string;
  group: Group;
}

const GROUP_LABEL: Record<Group, string> = {
  staged: 'STAGED',
  unstaged: 'CHANGES',
  untracked: 'UNTRACKED',
};

// POST a single-file stage/unstage op. Returns the structured result so the
// caller can surface an error. (I3 — argv-only, server-validated path.)
async function postFileOp(
  family: 'stage' | 'unstage',
  wfid: string,
  cwd: string | undefined,
  path: string,
): Promise<GitOpResult> {
  const body: Record<string, unknown> = { wfid, action: 'files', paths: [path] };
  if (cwd) body.path = cwd;
  const r = await fetch(`/api/git/op/${family}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await r.json()) as GitOpResult;
}

export function WorkingChangesPanel({ wfid, cwd, refreshKey }: WorkingChangesPanelProps) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: WorkingChangesResponse }
  >({ kind: 'loading' });
  const [selected, setSelected] = useState<Selected | null>(null);
  // I3 — internal refresh counter bumped after any op, combined with the prop.
  const [internalRefresh, setInternalRefresh] = useState(0);
  const [branch, setBranch] = useState<string | null>(null);
  const bump = useCallback(() => setInternalRefresh((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    const params = new URLSearchParams({ wfid });
    if (cwd) params.set('path', cwd);
    fetch(`/api/git/diff?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
        return (await r.json()) as WorkingChangesResponse;
      })
      .then((data) => { if (!cancelled) setState({ kind: 'ready', data }); })
      .catch((err) => { if (!cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }); });
    return () => { cancelled = true; };
  }, [wfid, cwd, refreshKey, internalRefresh]);

  // Current branch for the GitOpsBar protected-branch precheck. Read from the
  // I2 compare endpoint (it already reports branch). Best-effort.
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ wfid });
    if (cwd) params.set('path', cwd);
    fetch(`/api/git/compare?${params.toString()}`)
      .then((r) => r.json())
      .then((d: { branch?: string }) => { if (!cancelled) setBranch(d.branch ?? null); })
      .catch(() => { if (!cancelled) setBranch(null); });
    return () => { cancelled = true; };
  }, [wfid, cwd, refreshKey, internalRefresh]);

  const onFileOp = useCallback(
    async (family: 'stage' | 'unstage', path: string) => {
      await postFileOp(family, wfid, cwd, path);
      bump();
    },
    [wfid, cwd, bump],
  );

  // Clear the selected file whenever the list reloads — a stale selection
  // could point at a file no longer changed.
  useEffect(() => { setSelected(null); }, [wfid, cwd, refreshKey, internalRefresh]);

  if (state.kind === 'loading') {
    return <div className="archon-diff-empty display-font">Reading changes…</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="archon-diff-empty display-font" style={{ color: 'var(--color-danger)' }}>
        Failed to read changes: {state.message}
      </div>
    );
  }
  const { data } = state;
  if (!data.isRepo) {
    return <div className="archon-diff-empty display-font">Not a git working tree — no changes to show.</div>;
  }
  const total = data.staged.length + data.unstaged.length + data.untracked.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          flexShrink: 0,
          maxHeight: '40%',
          overflowY: 'auto',
          borderBottom: '1px solid var(--color-border-hairline)',
        }}
      >
        {total === 0 ? (
          <div className="archon-diff-empty display-font" style={{ padding: '8px' }}>Working tree clean.</div>
        ) : (
          <>
            <FileGroup label={GROUP_LABEL.staged} group="staged" files={data.staged} selected={selected} onSelect={setSelected} onFileOp={onFileOp} />
            <FileGroup label={GROUP_LABEL.unstaged} group="unstaged" files={data.unstaged} selected={selected} onSelect={setSelected} onFileOp={onFileOp} />
            <FileGroup label={GROUP_LABEL.untracked} group="untracked" files={data.untracked} selected={selected} onSelect={setSelected} onFileOp={onFileOp} />
          </>
        )}
      </div>
      <GitOpsBar wfid={wfid} cwd={cwd} currentBranch={branch} onRefresh={bump} />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {selected ? (
          <FileDiffPane wfid={wfid} cwd={cwd} path={selected.path} group={selected.group} />
        ) : (
          <div className="archon-diff-empty display-font">Select a file to view its diff.</div>
        )}
      </div>
    </div>
  );
}

function FileGroup({
  label,
  group,
  files,
  selected,
  onSelect,
  onFileOp,
}: {
  label: string;
  group: Group;
  files: WorkingChangeEntry[];
  selected: Selected | null;
  onSelect: (s: Selected) => void;
  onFileOp: (family: 'stage' | 'unstage', path: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div>
      <div
        className="display-font"
        style={{
          padding: '5px 8px 3px',
          fontSize: '9px',
          letterSpacing: '1.5px',
          color: 'var(--color-fg-muted)',
        }}
      >
        {label} ({files.length})
      </div>
      {files.map((f) => {
        const active = selected?.group === group && selected.path === f.path;
        // Staged rows unstage; unstaged/untracked rows stage. The action button
        // sits beside the file name (the row is a div so it can hold both).
        const staged = group === 'staged';
        return (
          <div
            key={`${group}:${f.path}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              width: '100%',
              boxSizing: 'border-box',
              padding: '3px 8px 3px 14px',
              fontFamily: 'var(--font-code)',
              fontSize: '11px',
              background: active ? 'var(--color-accent-primary-a08)' : 'transparent',
            }}
          >
            <button
              type="button"
              onClick={() => onSelect({ path: f.path, group })}
              title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
              style={{
                all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
                flex: 1, minWidth: 0,
                color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-secondary)',
              }}
            >
              <span style={{ width: '12px', flexShrink: 0, color: 'var(--color-fg-muted)' }}>{f.status}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f.origPath ? `${f.origPath} → ${f.path}` : f.path}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onFileOp(staged ? 'unstage' : 'stage', f.path)}
              data-help={staged ? 'gitops.unstage-file' : 'gitops.stage-file'}
              title={staged ? 'Unstage' : 'Stage'}
              style={{
                all: 'unset', cursor: 'pointer', flexShrink: 0, padding: '0 5px',
                fontSize: '12px', lineHeight: 1, color: 'var(--color-fg-muted)',
              }}
            >
              {staged ? '−' : '+'}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function FileDiffPane({
  wfid,
  cwd,
  path,
  group,
}: {
  wfid: string;
  cwd?: string;
  path: string;
  group: Group;
}) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: WorkingFileDiffResponse }
  >({ kind: 'loading' });

  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    const params = new URLSearchParams({ wfid, file: path });
    if (cwd) params.set('path', cwd);
    if (group === 'staged') params.set('staged', '1');
    fetch(`/api/git/diff?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
        return (await r.json()) as WorkingFileDiffResponse;
      })
      .then((data) => { if (!cancelled) setState({ kind: 'ready', data }); })
      .catch((err) => { if (!cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }); });
    return () => { cancelled = true; };
  }, [wfid, cwd, path, group]);

  useEffect(() => load(), [load]);

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
    return <div className="archon-diff-empty display-font">Binary or oversized file — diff not shown.</div>;
  }
  return <DiffView patch={data.patch} emptyText="No diff for this file." />;
}
