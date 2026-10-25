import { useEffect, useState } from 'react';
import type { View, GhPull, GhPullShort, GhPullFile, GhComment, GhCheckRun } from './types';
import {
  Loading, ErrorBox, EmptyBox, StateTabs, Markdown, CommentsView, useVisiblePolling,
  fmtDate, selectChip, mergeBtnStyle, rowStyle, prStateChip, checkStateChip,
} from './shared';
import { GhFilesDiff } from './GhFilesDiff';

function PullsList({ owner, name, onOpen }: { owner: string; name: string; onOpen: (n: number) => void }) {
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open');
  const [pulls, setPulls] = useState<GhPullShort[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPulls(null);
    setError(null);
    fetch(`/api/github/repos/${owner}/${name}/pulls?state=${state}`)
      .then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(j.error || r.statusText)))
      .then(setPulls)
      .catch((e) => setError(String(e)));
  }, [owner, name, state]);

  return (
    <div>
      <StateTabs value={state} onChange={setState} />
      {pulls === null && !error && <Loading />}
      {error && <ErrorBox message={error} />}
      {pulls && pulls.length === 0 && <EmptyBox label={`No ${state} pull requests.`} />}
      {pulls?.map((p) => (
        <button key={p.number} onClick={() => onOpen(p.number)} style={rowStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span style={prStateChip(p)}>
              {p.merged_at ? 'MERGED' : p.state === 'closed' ? 'CLOSED' : p.draft ? 'DRAFT' : 'OPEN'}
            </span>
            <span style={{ color: 'var(--color-accent-primary)', fontSize: '13px', fontFamily: 'var(--font-body)' }}>#{p.number}</span>
            <span style={{ flex: 1, color: 'var(--color-accent-primary)', fontSize: '13px', fontFamily: 'var(--font-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
          </div>
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)' }}>
            {p.user.login} · {p.head.ref} → {p.base.ref} · updated {fmtDate(p.updated_at)}
          </div>
        </button>
      ))}
    </div>
  );
}

// ── Pull detail ─────────────────────────────────────────────────────────

function PullView({ view, onBack }: { view: Extract<View, { kind: 'pull' }>; onBack: () => void }) {
  const [pull, setPull] = useState<GhPull | null>(null);
  const [files, setFiles] = useState<GhPullFile[] | null>(null);
  const [comments, setComments] = useState<GhComment[] | null>(null);
  const [checks, setChecks] = useState<GhCheckRun[] | null>(null);
  const [tab, setTab] = useState<'overview' | 'files' | 'comments' | 'checks'>('overview');
  const [error, setError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [actionStatus, setActionStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  const [confirmMerge, setConfirmMerge] = useState<'merge' | 'squash' | 'rebase' | null>(null);

  const base = `/api/github/repos/${view.owner}/${view.name}/pulls/${view.number}`;

  // Drop any stale action status + confirmation when we navigate PRs
  useEffect(() => {
    setActionStatus(null);
    setConfirmMerge(null);
    setPull(null);
    setError(null);
    fetch(base)
      .then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(j.error || r.statusText)))
      .then(setPull)
      .catch((e) => setError(String(e)));
  }, [base]);

  // Always try to load checks up front — the readiness box on the Conversation
  // tab wants them, and it's cheap.
  useEffect(() => {
    if (!pull) return;
    if (checks !== null) return;
    fetch(`${base}/checks?ref=${pull.head.sha}`)
      .then((r) => r.ok ? r.json() : { check_runs: [] })
      .then((d) => setChecks(d.check_runs ?? []))
      .catch(() => setChecks([]));
  }, [pull, base, checks]);

  useEffect(() => {
    if (tab === 'files' && files === null) fetch(`${base}/files`).then((r) => r.json()).then(setFiles).catch(() => setFiles([]));
    if (tab === 'comments' && comments === null) fetch(`${base}/comments`).then((r) => r.json()).then(setComments).catch(() => setComments([]));
  }, [tab, base, files, comments]);

  // Live refresh open PRs: refetch pull + head-sha checks, plus comments if
  // currently viewed. Skip closed/merged PRs and pause on hidden tabs.
  const pollEnabled = !!pull && pull.state === 'open' && !pull.merged;
  useVisiblePolling(pollEnabled, 20_000, () => {
    fetch(base).then((r) => r.ok ? r.json() : null).then((p) => { if (p) setPull(p); }).catch(() => {});
    if (pull) {
      fetch(`${base}/checks?ref=${pull.head.sha}`)
        .then((r) => r.ok ? r.json() : { check_runs: [] })
        .then((d) => setChecks(d.check_runs ?? []))
        .catch(() => {});
    }
    if (tab === 'comments') {
      fetch(`${base}/comments`).then((r) => r.json()).then(setComments).catch(() => {});
    }
  });

  async function doMerge(method: 'merge' | 'squash' | 'rebase') {
    if (!pull || merging) return;
    setMerging(true);
    setActionStatus(null);
    try {
      const res = await fetch(`${base}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || res.statusText);
      setActionStatus({ kind: 'ok', message: `Merged PR #${pull.number} (${method}${body.sha ? ` → ${String(body.sha).slice(0, 7)}` : ''}).` });
      const p = await fetch(base).then((r) => r.json());
      setPull(p);
    } catch (e) {
      setActionStatus({ kind: 'error', message: `Merge failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setMerging(false);
      setConfirmMerge(null);
    }
  }

  if (error) return <ErrorBox message={error} onDismiss={onBack} />;
  if (!pull) return <Loading />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border-hairline)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px', flexWrap: 'wrap' }}>
          <span style={prStateChip(pull)}>
            {pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : pull.draft ? 'DRAFT' : 'OPEN'}
          </span>
          <span style={{ color: 'var(--color-accent-primary)', fontSize: '18px', fontFamily: 'var(--font-display)' }}>#{pull.number}</span>
          <span style={{ color: 'var(--color-accent-primary)', fontSize: '16px', fontFamily: 'var(--font-body)' }}>{pull.title}</span>
          <div style={{ flex: 1 }} />
          <a href={pull.html_url} target="_blank" rel="noreferrer" style={{ fontSize: '10px', color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-display)', letterSpacing: '1px', textDecoration: 'none', padding: '3px 8px', border: '1px solid var(--color-accent-secondary-dim)', borderRadius: '3px' }}>OPEN ON GH ↗</a>
        </div>
        <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', marginBottom: '8px' }}>
          {pull.user.login} · {pull.head.ref} → {pull.base.ref} · {pull.commits} commit(s) · {pull.changed_files} file(s) · +{pull.additions} -{pull.deletions}
        </div>
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          {(['overview', 'files', 'comments', 'checks'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={selectChip(tab === t, true)}>{t.toUpperCase()}</button>
          ))}
        </div>
      </div>

      {/* Inline action status — replaces alert() for merge / comment / close */}
      {actionStatus && (
        <div style={{
          padding: '8px 20px', borderBottom: '1px solid var(--color-border-hairline)', flexShrink: 0,
          background: actionStatus.kind === 'ok' ? 'var(--color-accent-primary-a06)' : 'rgba(255, 80, 80, 0.06)',
          color: actionStatus.kind === 'ok' ? 'var(--color-accent-primary)' : 'var(--color-danger)',
          fontSize: '11px', fontFamily: 'var(--font-display)', letterSpacing: '0.5px',
          display: 'flex', alignItems: 'center', gap: '8px',
        }}>
          <span>{actionStatus.kind === 'ok' ? '✓' : '✗'}</span>
          <span style={{ flex: 1 }}>{actionStatus.message}</span>
          <button onClick={() => setActionStatus(null)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', opacity: 0.6, fontSize: '12px' }}>×</button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', minHeight: 0 }}>
        {tab === 'overview' && (
          <>
            <Markdown value={pull.body || '_No description._'} />
            <div style={{ marginTop: '20px' }}>
              <MergeReadinessBox
                pull={pull}
                checks={checks}
                merging={merging}
                confirmMerge={confirmMerge}
                onRequestMerge={(m) => setConfirmMerge(m)}
                onCancelConfirm={() => setConfirmMerge(null)}
                onConfirmMerge={() => confirmMerge && doMerge(confirmMerge)}
              />
            </div>
          </>
        )}
        {tab === 'files' && <FilesView files={files} />}
        {tab === 'comments' && <CommentsView comments={comments} />}
        {tab === 'checks' && <ChecksView checks={checks} />}
      </div>
    </div>
  );
}

// Merge readiness summary — mirrors GitHub's green-box UI. Aggregates
// check-run conclusions and the PR's mergeable / mergeable_state fields so
// the operator can see exactly why a merge would or wouldn't proceed.
function MergeReadinessBox({
  pull, checks, merging, confirmMerge, onRequestMerge, onCancelConfirm, onConfirmMerge,
}: {
  pull: GhPull;
  checks: GhCheckRun[] | null;
  merging: boolean;
  confirmMerge: 'merge' | 'squash' | 'rebase' | null;
  onRequestMerge: (m: 'merge' | 'squash' | 'rebase') => void;
  onCancelConfirm: () => void;
  onConfirmMerge: () => void;
}) {
  if (pull.merged) {
    return (
      <div style={{ ...readinessBoxStyle('ok'), padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <StatusGlyph kind="merged" />
          <div style={{ flex: 1 }}>
            <div style={{ color: '#a080ff', fontFamily: 'var(--font-display)', fontSize: '13px', letterSpacing: '1px' }}>Pull request merged</div>
            <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', marginTop: '2px' }}>
              {pull.head.ref} → {pull.base.ref}
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (pull.state === 'closed') {
    return (
      <div style={{ ...readinessBoxStyle('dim'), padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <StatusGlyph kind="closed" />
          <div style={{ flex: 1 }}>
            <div style={{ color: 'var(--color-danger)', fontFamily: 'var(--font-display)', fontSize: '13px', letterSpacing: '1px' }}>Pull request closed without merging</div>
          </div>
        </div>
      </div>
    );
  }

  // Aggregate checks
  let checkTone: 'ok' | 'fail' | 'pending' | 'none' = 'none';
  let checkLabel = '';
  let checkDetail = '';
  if (checks === null) {
    checkTone = 'pending';
    checkLabel = 'Loading checks…';
  } else if (checks.length === 0) {
    checkTone = 'none';
    checkLabel = 'No checks reported';
    checkDetail = 'This PR has no configured status checks on its head commit.';
  } else {
    const failed = checks.filter((c) => c.conclusion === 'failure' || c.conclusion === 'cancelled' || c.conclusion === 'timed_out');
    const pending = checks.filter((c) => c.status !== 'completed');
    const passed = checks.filter((c) => c.conclusion === 'success');
    const skipped = checks.filter((c) => c.conclusion === 'skipped' || c.conclusion === 'neutral');
    if (failed.length > 0) {
      checkTone = 'fail';
      checkLabel = `Some checks failing`;
      checkDetail = `${failed.length} failing · ${passed.length} passing · ${pending.length} pending`;
    } else if (pending.length > 0) {
      checkTone = 'pending';
      checkLabel = 'Checks in progress';
      checkDetail = `${passed.length} passing · ${pending.length} pending`;
    } else {
      checkTone = 'ok';
      checkLabel = 'All checks have passed';
      checkDetail = `${passed.length} successful${skipped.length ? ` · ${skipped.length} skipped` : ''}`;
    }
  }

  // Aggregate mergeability
  let mergeTone: 'ok' | 'fail' | 'pending' = 'pending';
  let mergeLabel = 'Checking mergeability…';
  let mergeDetail = '';
  if (pull.mergeable === true) {
    mergeTone = 'ok';
    mergeLabel = 'No conflicts with base branch';
    mergeDetail = 'Merging can be performed automatically.';
  } else if (pull.mergeable === false) {
    mergeTone = 'fail';
    mergeLabel = 'Conflicts with base branch';
    mergeDetail = `Resolve conflicts locally and push to ${pull.head.ref}.`;
  } else if (pull.mergeable_state === 'unknown') {
    mergeTone = 'pending';
    mergeLabel = 'GitHub is computing merge state…';
    mergeDetail = 'Give it a moment and refresh.';
  }

  // Mergeable_state can add more context (e.g. 'blocked' for required reviews)
  if (pull.mergeable_state === 'blocked') {
    mergeTone = 'fail';
    mergeLabel = 'Merging is blocked';
    mergeDetail = 'Branch protection rules require reviews or additional checks.';
  } else if (pull.mergeable_state === 'behind') {
    mergeTone = 'fail';
    mergeLabel = 'Branch is out of date with base';
    mergeDetail = `Sync ${pull.head.ref} with ${pull.base.ref} before merging.`;
  } else if (pull.mergeable_state === 'draft') {
    mergeTone = 'pending';
    mergeLabel = 'Pull request is in draft';
    mergeDetail = 'Mark ready for review to enable merging.';
  } else if (pull.mergeable_state === 'unstable') {
    // unstable = mergeable but with failing / pending non-required checks
    // — leave the check tone as-is but note it in the merge detail.
    if (mergeTone === 'ok') mergeDetail += ' Non-required checks are unstable.';
  }

  const canMergeOverall = mergeTone === 'ok' && checkTone !== 'fail' && !pull.draft;

  return (
    <div style={readinessBoxStyle(canMergeOverall ? 'ok' : mergeTone === 'fail' || checkTone === 'fail' ? 'fail' : 'pending')}>
      <ReadinessLine
        tone={checkTone === 'none' ? 'dim' : checkTone}
        label={checkLabel}
        detail={checkDetail}
      />
      <ReadinessLine
        tone={mergeTone}
        label={mergeLabel}
        detail={mergeDetail}
      />
      {pull.draft && (
        <ReadinessLine
          tone="dim"
          label="This is a draft pull request"
          detail="Mark ready for review to allow merging."
        />
      )}

      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--color-border-hairline)' }}>
        {confirmMerge ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--color-warning)', fontSize: '11px', fontFamily: 'var(--font-display)', letterSpacing: '1px' }}>
              Confirm {confirmMerge.toUpperCase()} of #{pull.number}?
            </span>
            <div style={{ flex: 1 }} />
            <button onClick={onCancelConfirm} disabled={merging} style={{ ...mergeBtnStyle, border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg-muted)', background: 'transparent' }}>CANCEL</button>
            <button onClick={onConfirmMerge} disabled={merging} style={{ ...mergeBtnStyle, color: 'var(--color-accent-primary)', borderColor: 'var(--color-accent-primary)' }}>
              {merging ? 'MERGING…' : `CONFIRM ${confirmMerge.toUpperCase()}`}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '10px', fontFamily: 'var(--font-display)', color: 'var(--color-fg-muted)', letterSpacing: '1px' }}>
              {canMergeOverall ? 'READY TO MERGE' : 'MERGE AT YOUR RISK'}
            </span>
            <div style={{ flex: 1 }} />
            <button onClick={() => onRequestMerge('squash')} disabled={merging} style={mergeBtnStyle} title="Squash commits into one and merge">SQUASH</button>
            <button onClick={() => onRequestMerge('merge')} disabled={merging} style={mergeBtnStyle} title="Create a merge commit">MERGE</button>
            <button onClick={() => onRequestMerge('rebase')} disabled={merging} style={mergeBtnStyle} title="Rebase and merge">REBASE</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ReadinessLine({ tone, label, detail }: { tone: 'ok' | 'fail' | 'pending' | 'dim'; label: string; detail?: string }) {
  const color = tone === 'ok' ? 'var(--color-accent-primary)' : tone === 'fail' ? 'var(--color-danger)' : tone === 'pending' ? 'var(--color-warning)' : 'var(--color-fg-muted)';
  const glyph = tone === 'ok' ? '✓' : tone === 'fail' ? '✗' : tone === 'pending' ? '◐' : '◦';
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '12px 16px', borderBottom: '1px solid var(--color-accent-primary-a06)' }}>
      <span style={{ color, fontSize: '18px', lineHeight: 1, flexShrink: 0, marginTop: '2px' }}>{glyph}</span>
      <div style={{ flex: 1 }}>
        <div style={{ color, fontFamily: 'var(--font-display)', fontSize: '12px', letterSpacing: '1px' }}>{label}</div>
        {detail && <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', marginTop: '2px' }}>{detail}</div>}
      </div>
    </div>
  );
}

function StatusGlyph({ kind }: { kind: 'merged' | 'closed' }) {
  const color = kind === 'merged' ? '#a080ff' : 'var(--color-danger)';
  return <span style={{ color, fontSize: '20px' }}>{kind === 'merged' ? '◆' : '✗'}</span>;
}

function readinessBoxStyle(tone: 'ok' | 'fail' | 'pending' | 'dim'): React.CSSProperties {
  const accent = tone === 'ok' ? 'var(--color-accent-primary)' : tone === 'fail' ? 'var(--color-danger)' : tone === 'pending' ? 'var(--color-warning)' : 'var(--color-border-hairline)';
  return {
    border: `1px solid ${accent}`,
    borderRadius: '5px',
    background: 'rgba(0, 8, 4, 0.5)',
    overflow: 'hidden',
    boxShadow: `0 0 12px ${accent}22`,
  };
}

// I4: PR file diffs render through the shared A3 DiffView via GhFilesDiff,
// replacing the old plain-<pre> per-line coloring. GitHub's bare-hunk patches
// are reconstructed into real unified diffs in ghDiff.ts.
function FilesView({ files }: { files: GhPullFile[] | null }) {
  if (files === null) return <Loading />;
  if (files.length === 0) return <EmptyBox label="No files changed." />;
  return <GhFilesDiff files={files} helpKey="github.pr-files-diff" />;
}

function ChecksView({ checks }: { checks: GhCheckRun[] | null }) {
  if (checks === null) return <Loading />;
  if (checks.length === 0) return <EmptyBox label="No checks reported." />;
  return (
    <div>
      {checks.map((c) => (
        <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid var(--color-border-hairline)' }}>
          <span style={checkStateChip(c)}>{(c.conclusion || c.status).toUpperCase()}</span>
          <span style={{ flex: 1, color: 'var(--color-accent-primary-dim)', fontSize: '12px' }}>{c.name}</span>
          <a href={c.html_url} target="_blank" rel="noreferrer" style={{ color: 'var(--color-accent-secondary)', fontSize: '10px', fontFamily: 'var(--font-display)', letterSpacing: '1px', textDecoration: 'none' }}>VIEW ↗</a>
        </div>
      ))}
    </div>
  );
}

export { PullsList, PullView };
