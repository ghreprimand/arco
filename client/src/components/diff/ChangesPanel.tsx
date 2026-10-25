import { useEffect, useState } from 'react';
import type { DiffResponse } from '@archon/shared';
import { DiffView } from './DiffView';

// Workbench Expansion A3 — data-fetching wrapper around the source-agnostic
// DiffView. This is the layer that knows about the /api/workflows/diff
// endpoint and the from/to query semantics; DiffView itself stays unaware.
// Used by the Files "Changes" sub-tab (working tree vs HEAD) and reused by
// GitDialog's pre-commit preview. Future callers (A4 checkpoint diffs) pass
// `from`/`to` shadow refs and get the same renderer for free.

export interface ChangesPanelProps {
  wfid: string;
  cwd?: string;
  // Omit both for "working tree vs HEAD" (pre-commit). Pass two shadow refs
  // for a checkpoint-to-checkpoint diff, etc.
  from?: string;
  to?: string;
  defaultViewType?: 'unified' | 'split';
  // Bump to force a refetch (e.g. when the operator reopens the tab).
  refreshKey?: number;
}

export function ChangesPanel({ wfid, cwd, from, to, defaultViewType, refreshKey }: ChangesPanelProps) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: DiffResponse }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    const params = new URLSearchParams({ wfid });
    if (cwd) params.set('path', cwd);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    fetch(`/api/workflows/diff?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
        return (await r.json()) as DiffResponse;
      })
      .then((data) => { if (!cancelled) setState({ kind: 'ready', data }); })
      .catch((err) => { if (!cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }); });
    return () => { cancelled = true; };
  }, [wfid, cwd, from, to, refreshKey]);

  if (state.kind === 'loading') {
    return <div className="archon-diff-empty display-font">Reading diff…</div>;
  }
  if (state.kind === 'error') {
    return <div className="archon-diff-empty display-font" style={{ color: 'var(--color-danger)' }}>Failed to read diff: {state.message}</div>;
  }
  const { data } = state;
  if (!data.isRepo) {
    return <div className="archon-diff-empty display-font">Not a git working tree — no diff available.</div>;
  }
  if (data.missingRef) {
    return <div className="archon-diff-empty display-font">Revision not found: {data.missingRef}</div>;
  }
  return (
    <DiffView
      patch={data.patch}
      defaultViewType={defaultViewType}
      emptyText="No changes since HEAD."
    />
  );
}
