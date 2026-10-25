import { useEffect, useMemo, useState } from 'react';
import type { View, GhIssue, GhIssueShort, GhComment } from './types';
import {
  Loading, ErrorBox, EmptyBox, StateTabs, Markdown, CommentsView, InlineStatus, useVisiblePolling,
  fmtDate, inputStyle, mergeBtnStyle, rowStyle, issueStateChip,
} from './shared';

function IssuesList({ owner, name, onOpen }: { owner: string; name: string; onOpen: (n: number) => void }) {
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open');
  const [issues, setIssues] = useState<GhIssueShort[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeLabels, setActiveLabels] = useState<string[]>([]);
  useEffect(() => {
    setIssues(null);
    setError(null);
    setActiveLabels([]);
    fetch(`/api/github/repos/${owner}/${name}/issues?state=${state}`)
      .then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(j.error || r.statusText)))
      .then(setIssues)
      .catch((e) => setError(String(e)));
  }, [owner, name, state]);

  // Distinct labels in the current set, sorted by frequency desc.
  const labelPalette = useMemo(() => {
    if (!issues) return [];
    const counts = new Map<string, { color: string; count: number }>();
    for (const i of issues) {
      for (const l of i.labels) {
        const cur = counts.get(l.name);
        if (cur) cur.count++;
        else counts.set(l.name, { color: l.color, count: 1 });
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, v]) => ({ name, color: v.color, count: v.count }));
  }, [issues]);

  const filtered = useMemo(() => {
    if (!issues) return null;
    if (activeLabels.length === 0) return issues;
    return issues.filter((i) => activeLabels.every((n) => i.labels.some((l) => l.name === n)));
  }, [issues, activeLabels]);

  const toggleLabel = (n: string) => {
    setActiveLabels((cur) => cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]);
  };

  return (
    <div>
      <StateTabs value={state} onChange={setState} />
      {labelPalette.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', padding: '6px 0 10px', borderBottom: '1px solid var(--color-border-hairline)', marginBottom: '8px' }}>
          <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', letterSpacing: '1px', alignSelf: 'center', marginRight: '4px' }}>LABELS:</span>
          {labelPalette.map((l) => {
            const active = activeLabels.includes(l.name);
            return (
              <button
                key={l.name}
                onClick={() => toggleLabel(l.name)}
                style={{
                  fontSize: '10px', padding: '2px 6px', borderRadius: '2px',
                  background: active ? `#${l.color}44` : `#${l.color}18`,
                  border: `1px solid #${l.color}${active ? '' : '99'}`,
                  color: `#${l.color}`, cursor: 'pointer',
                  fontFamily: 'var(--font-display)', letterSpacing: '0.5px',
                  opacity: active ? 1 : 0.85,
                }}
              >
                {l.name} <span style={{ opacity: 0.6 }}>{l.count}</span>
              </button>
            );
          })}
          {activeLabels.length > 0 && (
            <button onClick={() => setActiveLabels([])} style={{ fontSize: '10px', padding: '2px 6px', background: 'transparent', border: '1px solid var(--color-fg-muted)', color: 'var(--color-fg-muted)', cursor: 'pointer', fontFamily: 'var(--font-display)', letterSpacing: '0.5px' }}>× CLEAR</button>
          )}
        </div>
      )}
      {issues === null && !error && <Loading />}
      {error && <ErrorBox message={error} />}
      {filtered && filtered.length === 0 && <EmptyBox label={activeLabels.length > 0 ? 'No issues match these labels.' : `No ${state} issues.`} />}
      {filtered?.map((i) => (
        <button key={i.number} onClick={() => onOpen(i.number)} style={rowStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
            <span style={issueStateChip(i)}>{i.state === 'closed' ? 'CLOSED' : 'OPEN'}</span>
            <span style={{ color: 'var(--color-accent-primary)', fontSize: '13px' }}>#{i.number}</span>
            <span style={{ flex: 1, color: 'var(--color-accent-primary)', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.title}</span>
            {i.labels.slice(0, 4).map((l) => (
              <span key={l.name} style={{ fontSize: '9px', padding: '1px 5px', borderRadius: '2px', background: `#${l.color}22`, border: `1px solid #${l.color}`, color: `#${l.color}`, fontFamily: 'var(--font-display)', letterSpacing: '0.5px' }}>{l.name}</span>
            ))}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)' }}>
            {i.user.login} · {i.comments} comment(s) · updated {fmtDate(i.updated_at)}
          </div>
        </button>
      ))}
    </div>
  );
}

// ── Issue detail ────────────────────────────────────────────────────────

function IssueView({ view, onBack }: { view: Extract<View, { kind: 'issue' }>; onBack: () => void }) {
  const [issue, setIssue] = useState<GhIssue | null>(null);
  const [comments, setComments] = useState<GhComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newComment, setNewComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionStatus, setActionStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);

  const base = `/api/github/repos/${view.owner}/${view.name}/issues/${view.number}`;

  const reload = () => {
    fetch(base).then((r) => r.json()).then(setIssue).catch((e) => setError(String(e)));
    fetch(`${base}/comments`).then((r) => r.json()).then(setComments).catch(() => setComments([]));
  };
  useEffect(reload, [base]);

  // Live refresh for open issues (collaborator edits, new comments).
  useVisiblePolling(!!issue && issue.state === 'open', 30_000, () => {
    fetch(base).then((r) => r.ok ? r.json() : null).then((i) => { if (i) setIssue(i); }).catch(() => {});
    fetch(`${base}/comments`).then((r) => r.json()).then(setComments).catch(() => {});
  });

  async function postComment() {
    if (!newComment.trim() || busy) return;
    setBusy(true);
    setActionStatus(null);
    try {
      const res = await fetch(`${base}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: newComment }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      setActionStatus({ kind: 'ok', message: 'Comment posted.' });
      setNewComment('');
      reload();
    } catch (e) {
      setActionStatus({ kind: 'error', message: `Comment failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally { setBusy(false); }
  }

  async function toggleState() {
    if (!issue || busy) return;
    setBusy(true);
    setActionStatus(null);
    const next = issue.state === 'open' ? 'close' : 'reopen';
    try {
      const res = await fetch(`${base}/${next}`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      setActionStatus({ kind: 'ok', message: `Issue ${next === 'close' ? 'closed' : 'reopened'}.` });
      reload();
    } catch (e) {
      setActionStatus({ kind: 'error', message: `${next} failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally { setBusy(false); }
  }

  if (error) return <ErrorBox message={error} onDismiss={onBack} />;
  if (!issue) return <Loading />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border-hairline)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px', flexWrap: 'wrap' }}>
          <span style={issueStateChip(issue)}>{issue.state === 'closed' ? 'CLOSED' : 'OPEN'}</span>
          <span style={{ color: 'var(--color-accent-primary)', fontSize: '18px', fontFamily: 'var(--font-display)' }}>#{issue.number}</span>
          <span style={{ color: 'var(--color-accent-primary)', fontSize: '16px' }}>{issue.title}</span>
          <div style={{ flex: 1 }} />
          <button onClick={toggleState} disabled={busy} style={mergeBtnStyle}>
            {busy ? '...' : issue.state === 'open' ? 'CLOSE' : 'REOPEN'}
          </button>
          <a href={issue.html_url} target="_blank" rel="noreferrer" style={{ fontSize: '10px', color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-display)', letterSpacing: '1px', textDecoration: 'none', padding: '3px 8px', border: '1px solid var(--color-accent-secondary-dim)', borderRadius: '3px' }}>OPEN ON GH ↗</a>
        </div>
        <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)' }}>
          {issue.user.login} · {fmtDate(issue.updated_at)}
        </div>
      </div>
      <InlineStatus status={actionStatus} onDismiss={() => setActionStatus(null)} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', minHeight: 0 }}>
        <Markdown value={issue.body || '_No description._'} />
        <div style={{ marginTop: '20px', paddingTop: '12px', borderTop: '1px solid var(--color-border-hairline)' }}>
          <CommentsView comments={comments} />
        </div>
        <div style={{ marginTop: '20px' }}>
          <textarea
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            placeholder="Add a comment..."
            rows={3}
            style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'var(--font-body)' }}
          />
          <button onClick={postComment} disabled={!newComment.trim() || busy} style={{ ...mergeBtnStyle, marginTop: '6px' }}>
            {busy ? 'POSTING...' : 'POST COMMENT'}
          </button>
        </div>
      </div>
    </div>
  );
}

export { IssuesList, IssueView };
