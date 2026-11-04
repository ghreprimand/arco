import { useEffect, useMemo, useState } from 'react';
import type { OtherWorkResponse, OtherWorkRow } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { requestWorktreeView } from '../utils/worktreeNavigation';

// Read-only "Other work" section of the GIT dialog: the repository's other
// worktrees and local branches. No merge, delete or switch actions live here;
// VIEW CHANGES only points the FILES tab at a worktree.

const small: React.CSSProperties = { fontSize: '10px', color: 'var(--color-fg-muted)' };

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

/** Names of the tabs working in a worktree: by working directory or by an assigned task's worktree. */
export function tabsAt(path: string, jobs: Record<string, { config: { name: string; workingDirectory?: string } }>, ledger: Record<string, Array<{ assignee?: string; worktree?: { path?: string } | null }>>): string[] {
  const names = new Set<string>();
  for (const job of Object.values(jobs)) if (job.config.workingDirectory && samePath(job.config.workingDirectory, path)) names.add(job.config.name);
  for (const tasks of Object.values(ledger)) for (const t of tasks) {
    if (t.worktree?.path && samePath(t.worktree.path, path) && t.assignee && jobs[t.assignee]) names.add(jobs[t.assignee].config.name);
  }
  return [...names];
}

export function GitOtherWork({ cwd, wfid, onViewed }: { cwd: string; wfid: string; onViewed: () => void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<OtherWorkResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const jobs = useAppStore((s) => s.jobs);
  const ledger = useAppStore((s) => s.taskLedger);

  useEffect(() => {
    if (!open || data || failed) return;
    const ac = new AbortController();
    fetch(`/api/git/other-work?${new URLSearchParams({ wfid, path: cwd })}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: OtherWorkResponse) => setData(body))
      .catch(() => { if (!ac.signal.aborted) setFailed(true); });
    return () => ac.abort();
  }, [open, data, failed, cwd, wfid]);

  const rows = data?.rows ?? [];
  const tabsFor = useMemo(() => (path: string | null) => (path ? tabsAt(path, jobs as never, ledger as never) : []), [jobs, ledger]);

  return (
    <div data-help="gitdialog.other-work" data-testid="git-other-work" style={{ marginTop: '10px' }}>
      <button type="button" className="display-font" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        style={{ padding: '3px 8px', background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px' }}>
        {open ? 'HIDE OTHER WORK' : 'SHOW OTHER WORK'}
      </button>
      {open && (
        <div style={{ marginTop: '6px', border: '1px solid var(--color-border-hairline)', borderRadius: '4px', padding: '6px 8px', background: 'var(--color-bg-sunken)' }}>
          {!data && !failed && <div style={small}>Reading worktrees and branches...</div>}
          {failed && <div style={small}>Other work could not be read.</div>}
          {data && !data.isRepo && <div style={small}>Not a git repository.</div>}
          {data && data.isRepo && rows.length === 0 && <div style={small}>No other worktrees or local branches.</div>}
          {data && rows.map((row) => (
            <Row key={`${row.worktreePath ?? ''}|${row.branch ?? ''}`} row={row} base={data.defaultBranch} tabs={tabsFor(row.worktreePath)}
              onView={row.worktreePath ? () => { requestWorktreeView(wfid, row.worktreePath as string); onViewed(); } : undefined} />
          ))}
          {data?.truncated && <div style={small}>More branches exist than are listed.</div>}
          {data && data.isRepo && data.prStatus === 'unavailable' && <div style={{ ...small, marginTop: '4px' }}>Open pull requests are not shown (the GitHub CLI is not available here).</div>}
        </div>
      )}
    </div>
  );
}

function Row({ row, base, tabs, onView }: { row: OtherWorkRow; base: string | null; tabs: string[]; onView?: () => void }) {
  const counts = row.ahead !== null && row.behind !== null && base ? `${row.ahead} ahead, ${row.behind} behind ${base}` : '';
  return (
    <div data-testid="git-other-work-row" style={{ display: 'flex', alignItems: 'baseline', gap: '10px', padding: '4px 0', borderTop: '1px solid var(--color-border-hairline)', fontSize: '11px', flexWrap: 'wrap' }}>
      <span style={{ color: 'var(--color-fg)', fontWeight: 600 }}>{row.branch ?? '(detached)'}</span>
      <span style={small}>{row.worktreePath ? (row.isMain ? 'main checkout' : 'worktree') : 'branch only'}</span>
      {tabs.length > 0 && <span style={{ ...small, color: 'var(--color-accent-primary)' }}>tab: {tabs.join(', ')}</span>}
      {counts && <span style={small}>{counts}</span>}
      {row.dirtyCount !== null && <span style={small}>{row.dirtyCount === 0 ? 'clean' : `${row.dirtyCount} uncommitted`}</span>}
      {row.pr && <a href={row.pr.url} target="_blank" rel="noreferrer" title={row.pr.title} style={{ ...small, color: 'var(--color-accent-secondary-dim)' }}>PR #{row.pr.number}</a>}
      {onView && <button type="button" className="display-font" onClick={onView} style={{ marginLeft: 'auto', padding: '2px 8px', background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-accent-secondary-dim)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px' }}>VIEW CHANGES</button>}
    </div>
  );
}
