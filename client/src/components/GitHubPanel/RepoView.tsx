import { useEffect, useState } from 'react';
import type { View, RepoTab, GhRepo, GhCommitShort } from './types';
import { Loading, ErrorBox, EmptyBox, fmtDate, selectChip, badgeStyle, rowStyle } from './shared';
import { CodeView } from './CodeView';
import { BranchesList } from './BranchesList';
import { PullsList } from './PullView';
import { IssuesList } from './IssueView';
import { RunsList } from './RunView';

export function RepoView({ view, onNavigate }: { view: Extract<View, { kind: 'repo' }>; onNavigate: (v: View) => void }) {
  const [tab, setTab] = useState<RepoTab>(view.tab ?? 'code');
  const [repo, setRepo] = useState<GhRepo | null>(null);
  // Auto-scope seeds ref with the local working branch; if the branch doesn't
  // exist on GitHub yet, CodeView will surface the 404 and the operator can
  // swap via the BRANCHES tab. Fall back to default_branch once the repo
  // loads if no initialRef was provided.
  const [ref, setRef] = useState<string | null>(view.initialRef ?? null);

  useEffect(() => {
    fetch(`/api/github/repos/${view.owner}/${view.name}`)
      .then((r) => r.ok ? r.json() : Promise.reject(r.statusText))
      .then((r: GhRepo) => {
        setRepo(r);
        if (!ref) setRef(r.default_branch);
      })
      .catch(() => { /* let sub-views surface the error */ });
  }, [view.owner, view.name]);

  const tabs: RepoTab[] = ['code', 'pulls', 'issues', 'runs', 'branches', 'commits'];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Repo summary strip */}
      {repo && (
        <div style={{ padding: '8px 20px', borderBottom: '1px solid var(--color-border-hairline)', display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0, flexWrap: 'wrap' }}>
          <img src={repo.owner.avatar_url} alt={repo.owner.login} style={{ width: '22px', height: '22px', borderRadius: '3px' }} />
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '14px', letterSpacing: '2px', color: 'var(--color-accent-secondary)' }}>{repo.full_name}</span>
          {repo.private && <span style={badgeStyle('amber')}>PRIVATE</span>}
          {repo.fork && <span style={badgeStyle('dim')}>FORK</span>}
          {repo.archived && <span style={badgeStyle('red')}>ARCHIVED</span>}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)' }}>★ {repo.stargazers_count}</span>
          <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)' }}>⑂ {repo.forks_count}</span>
          <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)' }}>⚑ {repo.open_issues_count}</span>
          {repo.language && <span style={{ fontSize: '10px', color: 'var(--color-accent-primary-dim)' }}>{repo.language}</span>}
          <a href={repo.html_url} target="_blank" rel="noreferrer" style={{ fontSize: '10px', color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-display)', letterSpacing: '1px', textDecoration: 'none', padding: '3px 8px', border: '1px solid var(--color-accent-secondary-dim)', borderRadius: '3px' }}>OPEN ON GH ↗</a>
        </div>
      )}
      {/* Tab strip */}
      <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--color-border-hairline)', display: 'flex', gap: '4px', flexShrink: 0, flexWrap: 'wrap' }}>
        {tabs.map((t) => (
          <button key={t} onClick={() => setTab(t)} data-help={`github.tab.${t}`} style={selectChip(tab === t, true)}>{t.toUpperCase()}</button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {tab === 'code' && repo && ref && (
          <CodeView owner={view.owner} name={view.name} repo={repo} ref={ref} onRefChange={setRef} />
        )}
        {tab === 'pulls' && (
          <div style={{ height: '100%', overflowY: 'auto', padding: '12px 20px' }}>
            <PullsPane
              owner={view.owner}
              name={view.name}
              defaultBase={repo?.default_branch}
              headRef={ref}
              onOpen={(n) => onNavigate({ kind: 'pull', owner: view.owner, name: view.name, number: n })}
            />
          </div>
        )}
        {tab === 'issues' && (
          <div style={{ height: '100%', overflowY: 'auto', padding: '12px 20px' }}>
            <IssuesList owner={view.owner} name={view.name} onOpen={(n) => onNavigate({ kind: 'issue', owner: view.owner, name: view.name, number: n })} />
          </div>
        )}
        {tab === 'runs' && (
          <div style={{ height: '100%', overflowY: 'auto', padding: '12px 20px' }}>
            <RunsList owner={view.owner} name={view.name} onOpen={(id) => onNavigate({ kind: 'run', owner: view.owner, name: view.name, id })} />
          </div>
        )}
        {tab === 'branches' && repo && (
          <div style={{ height: '100%', overflowY: 'auto', padding: '12px 20px' }}>
            <BranchesList owner={view.owner} name={view.name} defaultBranch={repo.default_branch} onPick={(b) => { setRef(b); setTab('code'); }} />
          </div>
        )}
        {tab === 'commits' && ref && (
          <div style={{ height: '100%', overflowY: 'auto', padding: '12px 20px' }}>
            <CommitsList
              owner={view.owner}
              name={view.name}
              refName={ref}
              onOpen={(c) => onNavigate({
                kind: 'commit', owner: view.owner, name: view.name, sha: c.sha, refName: ref,
                message: c.commit.message, authorName: c.author?.login || c.commit.author.name,
                date: c.commit.author.date, htmlUrl: c.html_url,
              })}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// PR tab: the existing list plus an in-app "New PR" form (I4). Creating a PR is
// an operator-initiated outward action — the explicit CREATE PR submit is the
// confirmation. On success we navigate straight to the new PR.
function PullsPane({ owner, name, defaultBase, headRef, onOpen }: {
  owner: string; name: string; defaultBase?: string; headRef?: string | null; onOpen: (n: number) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
        <button
          onClick={() => setShowForm((s) => !s)}
          data-help="github.pr-create"
          style={{ background: 'transparent', border: '1px solid var(--color-accent-secondary-dim)', color: 'var(--color-accent-secondary)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: '10px', letterSpacing: '1px', padding: '4px 10px', borderRadius: '3px' }}
        >
          {showForm ? '× CANCEL' : '+ NEW PR'}
        </button>
      </div>
      {showForm && (
        <NewPrForm
          owner={owner}
          name={name}
          defaultBase={defaultBase}
          defaultHead={headRef ?? undefined}
          onClose={() => setShowForm(false)}
          onCreated={(n) => { setShowForm(false); onOpen(n); }}
        />
      )}
      <PullsList owner={owner} name={name} onOpen={onOpen} />
    </div>
  );
}

function NewPrForm({ owner, name, defaultBase, defaultHead, onClose, onCreated }: {
  owner: string; name: string; defaultBase?: string; defaultHead?: string; onClose: () => void; onCreated: (n: number) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState(defaultBase ?? '');
  const [head, setHead] = useState(defaultHead ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = title.trim() && base.trim() && head.trim() && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/github/repos/${owner}/${name}/pulls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, base, head }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      onCreated(data.number);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', background: 'rgba(0, 8, 4, 0.6)', border: '1px solid var(--color-border-hairline)',
    color: 'var(--color-accent-primary)', fontFamily: 'var(--font-body)', fontSize: '12px', padding: '6px 8px', borderRadius: '3px', marginBottom: '8px',
  };
  const labelStyle: React.CSSProperties = { fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', letterSpacing: '1px', display: 'block', marginBottom: '3px' };

  return (
    <div style={{ border: '1px solid var(--color-accent-secondary-dim)', borderRadius: '4px', padding: '12px', marginBottom: '12px', background: 'rgba(0, 8, 4, 0.4)' }}>
      <div style={{ fontSize: '11px', color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-display)', letterSpacing: '2px', marginBottom: '10px' }}>NEW PULL REQUEST</div>
      <label style={labelStyle}>TITLE *</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add the thing" style={inputStyle} />
      <div style={{ display: 'flex', gap: '10px' }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>BASE * (merge into)</label>
          <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="main" style={inputStyle} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>HEAD * (from)</label>
          <input value={head} onChange={(e) => setHead(e.target.value)} placeholder="feature-branch" style={inputStyle} />
        </div>
      </div>
      <label style={labelStyle}>BODY</label>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="Optional description" style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-body)' }} />
      {error && (
        <div style={{ color: 'var(--color-danger)', fontSize: '11px', fontFamily: 'var(--font-display)', marginBottom: '8px' }}>✗ {error}</div>
      )}
      <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
        <button onClick={onClose} disabled={busy} style={{ background: 'transparent', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg-muted)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: '10px', letterSpacing: '1px', padding: '5px 12px', borderRadius: '3px' }}>CANCEL</button>
        <button
          onClick={submit}
          disabled={!canSubmit}
          style={{ background: 'transparent', border: `1px solid ${canSubmit ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`, color: canSubmit ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)', cursor: canSubmit ? 'pointer' : 'default', fontFamily: 'var(--font-display)', fontSize: '10px', letterSpacing: '1px', padding: '5px 12px', borderRadius: '3px' }}
        >
          {busy ? 'CREATING…' : 'CREATE PR'}
        </button>
      </div>
    </div>
  );
}

function CommitsList({ owner, name, refName, onOpen }: { owner: string; name: string; refName: string; onOpen: (c: GhCommitShort) => void }) {
  const [commits, setCommits] = useState<GhCommitShort[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setCommits(null);
    setError(null);
    const q = new URLSearchParams();
    q.set('sha', refName);
    q.set('per_page', '50');
    fetch(`/api/github/repos/${owner}/${name}/commits?${q.toString()}`)
      .then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(j.error || r.statusText)))
      .then(setCommits)
      .catch((e) => setError(String(e)));
  }, [owner, name, refName]);
  if (error) return <ErrorBox message={error} />;
  if (commits === null) return <Loading />;
  if (commits.length === 0) return <EmptyBox label="No commits." />;
  return (
    <div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', letterSpacing: '1px', marginBottom: '8px' }}>
        COMMITS ON {refName.toUpperCase()}
      </div>
      {commits.map((c) => (
        <button key={c.sha} onClick={() => onOpen(c)} style={rowStyle} data-help="github.commit-detail">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            {c.author && <img src={c.author.avatar_url} alt={c.author.login} style={{ width: '18px', height: '18px', borderRadius: '50%' }} />}
            <span style={{ flex: 1, color: 'var(--color-accent-primary)', fontSize: '13px', fontFamily: 'var(--font-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{c.commit.message.split('\n')[0]}</span>
            <span style={{ fontSize: '10px', color: 'var(--color-accent-secondary-dim)', fontFamily: 'var(--font-display)', letterSpacing: '1px' }}>{c.sha.slice(0, 7)}</span>
          </div>
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', textAlign: 'left' }}>
            {c.author?.login || c.commit.author.name} · {fmtDate(c.commit.author.date)}
          </div>
        </button>
      ))}
    </div>
  );
}
