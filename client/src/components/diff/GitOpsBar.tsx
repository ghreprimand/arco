import { useState, useCallback } from 'react';
import type { GitOpResult, GitStashEntry } from '@archon/shared';
import { isProtectedBranch } from '@archon/shared';

// Workbench Expansion I3 — operator git-op controls for the Changes view.
//
// A compact action bar below the WorkingChangesPanel file list: stage/unstage
// all, a commit box, fetch/pull/push (with a protected-branch / force confirm),
// stash save/pop/list, and branch/tag create/delete. Every button POSTs to
// /api/git/op/<family> and, on a working-tree-changing op, calls onRefresh to
// reload the panel's file list.
//
// The push guard is enforced SERVER-SIDE (gitOps.push returns needsConfirm for a
// protected-branch / force push without confirm:true); this component ALSO
// pre-checks so the operator sees a confirm dialog before the first request,
// then re-sends with confirm:true. Never sends confirm:true silently.

export interface GitOpsBarProps {
  wfid: string;
  cwd?: string;
  // Current branch (from the panel's status), for the protected-branch precheck.
  currentBranch?: string | null;
  // Bump the panel's refreshKey after a mutating op.
  onRefresh: () => void;
}

async function postOp(family: string, body: Record<string, unknown>): Promise<GitOpResult> {
  const r = await fetch(`/api/git/op/${family}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await r.json()) as GitOpResult;
}

const BTN: React.CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  fontFamily: 'var(--font-code)',
  fontSize: '10px',
  letterSpacing: '0.5px',
  padding: '3px 8px',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-fg-secondary)',
  background: 'var(--color-bg-elevated)',
};

export function GitOpsBar({ wfid, cwd, currentBranch, onRefresh }: GitOpsBarProps) {
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [name, setName] = useState('');
  const [checkout, setCheckout] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [stashes, setStashes] = useState<GitStashEntry[] | null>(null);

  const base = useCallback(() => {
    const b: Record<string, unknown> = { wfid };
    if (cwd) b.path = cwd;
    return b;
  }, [wfid, cwd]);

  const run = useCallback(
    async (
      family: string,
      body: Record<string, unknown>,
      opts: { refresh?: boolean; okMsg?: string } = {},
    ) => {
      setBusy(true);
      setStatus(null);
      try {
        const result = await postOp(family, { ...base(), ...body });
        if (result.needsConfirm) {
          setStatus(`Confirm needed: ${result.reason ?? 'confirmation required'}`);
          return result;
        }
        if (!result.ok) {
          setStatus(`Error: ${result.stderr ?? 'failed'}`);
          return result;
        }
        if (result.stashes) setStashes(result.stashes);
        setStatus(opts.okMsg ?? `${family} ok`);
        if (opts.refresh) onRefresh();
        return result;
      } catch (err) {
        setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [base, onRefresh],
  );

  const onCommit = useCallback(async () => {
    if (!message.trim()) { setStatus('Commit message is required'); return; }
    const r = await run('commit', { message, amend }, { refresh: true });
    if (r?.ok) { setMessage(''); setAmend(false); }
  }, [message, amend, run]);

  const onPush = useCallback(
    async (force: boolean) => {
      // Pre-check the protected-branch / force confirm so the operator sees a
      // dialog before the first request. The server enforces this regardless.
      const needsConfirm = force || isProtectedBranch(currentBranch);
      if (needsConfirm) {
        const what = force
          ? 'Force-push (--force-with-lease)'
          : `Push to protected branch "${currentBranch}"`;
        if (!window.confirm(`${what}? This rewrites/updates the remote.`)) return;
        await run('push', { force, confirm: true }, { okMsg: force ? 'force-pushed' : 'pushed' });
        return;
      }
      await run('push', { force: false }, { okMsg: 'pushed' });
    },
    [currentBranch, run],
  );

  const onBranchDelete = useCallback(async () => {
    if (!name.trim()) { setStatus('Branch name is required'); return; }
    if (!window.confirm(`Delete branch "${name}"? (recoverable via reflog)`)) return;
    await run('branch', { action: 'delete', name }, { refresh: true });
  }, [name, run]);

  const onTagDelete = useCallback(async () => {
    if (!name.trim()) { setStatus('Tag name is required'); return; }
    if (!window.confirm(`Delete tag "${name}"?`)) return;
    await run('tag', { action: 'delete', name });
  }, [name, run]);

  const sectionStyle: React.CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '5px',
    padding: '5px 8px',
    borderTop: '1px solid var(--color-border-hairline)',
  };

  return (
    <div style={{ flexShrink: 0, fontFamily: 'var(--font-code)' }}>
      {/* Stage / unstage all */}
      <div style={sectionStyle}>
        <button type="button" style={BTN} disabled={busy} data-help="gitops.stage-all"
          onClick={() => run('stage', { action: 'all' }, { refresh: true, okMsg: 'staged all' })}>STAGE ALL</button>
        <button type="button" style={BTN} disabled={busy} data-help="gitops.unstage-all"
          onClick={() => run('unstage', { action: 'all' }, { refresh: true, okMsg: 'unstaged all' })}>UNSTAGE ALL</button>
      </div>

      {/* Commit */}
      <div style={sectionStyle}>
        <input
          type="text"
          value={message}
          placeholder="commit message"
          onChange={(e) => setMessage(e.target.value)}
          data-help="gitops.commit-message"
          style={{ flex: 1, minWidth: '120px', fontFamily: 'var(--font-code)', fontSize: '11px',
            padding: '3px 6px', background: 'var(--color-bg-base)', color: 'var(--color-fg-primary)',
            border: '1px solid var(--color-border-hairline)', borderRadius: '3px' }}
        />
        <label style={{ fontSize: '10px', display: 'flex', alignItems: 'center', gap: '3px' }} data-help="gitops.commit-amend">
          <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> amend
        </label>
        <button type="button" style={BTN} disabled={busy} data-help="gitops.commit" onClick={onCommit}>COMMIT</button>
      </div>

      {/* Remote */}
      <div style={sectionStyle}>
        <button type="button" style={BTN} disabled={busy} data-help="gitops.fetch"
          onClick={() => run('fetch', {}, { okMsg: 'fetched' })}>FETCH</button>
        <button type="button" style={BTN} disabled={busy} data-help="gitops.pull"
          onClick={() => run('pull', {}, { refresh: true, okMsg: 'pulled' })}>PULL</button>
        <button type="button" style={BTN} disabled={busy} data-help="gitops.push" onClick={() => onPush(false)}>PUSH</button>
        <button type="button" style={BTN} disabled={busy} data-help="gitops.push-force" onClick={() => onPush(true)}>FORCE PUSH</button>
      </div>

      {/* Stash */}
      <div style={sectionStyle}>
        <button type="button" style={BTN} disabled={busy} data-help="gitops.stash-save"
          onClick={() => run('stash', { action: 'save' }, { refresh: true, okMsg: 'stashed' })}>STASH</button>
        <button type="button" style={BTN} disabled={busy} data-help="gitops.stash-pop"
          onClick={() => run('stash', { action: 'pop' }, { refresh: true, okMsg: 'popped' })}>POP</button>
        <button type="button" style={BTN} disabled={busy} data-help="gitops.stash-list"
          onClick={() => run('stash', { action: 'list' }, { okMsg: 'listed' })}>LIST</button>
        {stashes && (
          <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>
            {stashes.length === 0 ? 'no stashes' : stashes.map((s) => s.ref).join(', ')}
          </span>
        )}
      </div>

      {/* Branch / tag */}
      <div style={sectionStyle}>
        <input
          type="text"
          value={name}
          placeholder="branch / tag name"
          onChange={(e) => setName(e.target.value)}
          data-help="gitops.branch-name"
          style={{ flex: 1, minWidth: '100px', fontFamily: 'var(--font-code)', fontSize: '11px',
            padding: '3px 6px', background: 'var(--color-bg-base)', color: 'var(--color-fg-primary)',
            border: '1px solid var(--color-border-hairline)', borderRadius: '3px' }}
        />
        <label style={{ fontSize: '10px', display: 'flex', alignItems: 'center', gap: '3px' }}>
          <input type="checkbox" checked={checkout} onChange={(e) => setCheckout(e.target.checked)} /> checkout
        </label>
        <button type="button" style={BTN} disabled={busy || !name.trim()} data-help="gitops.branch-create"
          onClick={() => run('branch', { action: 'create', name, checkout }, { refresh: true, okMsg: 'branch created' })}>+ BRANCH</button>
        <button type="button" style={BTN} disabled={busy || !name.trim()} data-help="gitops.branch-delete" onClick={onBranchDelete}>− BRANCH</button>
        <button type="button" style={BTN} disabled={busy || !name.trim()} data-help="gitops.tag-create"
          onClick={() => run('tag', { action: 'create', name }, { okMsg: 'tag created' })}>+ TAG</button>
        <button type="button" style={BTN} disabled={busy || !name.trim()} data-help="gitops.tag-delete" onClick={onTagDelete}>− TAG</button>
      </div>

      {status && (
        <div style={{ padding: '4px 8px', fontSize: '10px',
          color: status.startsWith('Error') || status.startsWith('Confirm') ? 'var(--color-danger)' : 'var(--color-fg-muted)' }}>
          {status}
        </div>
      )}
    </div>
  );
}
