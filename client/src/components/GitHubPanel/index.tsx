import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import type { View, GhUser } from './types';
import { ErrorBox, mergeBtnStyle, closeButtonStyle } from './shared';
import { Breadcrumbs } from './Breadcrumbs';
import { ReposView } from './ReposView';
import { RepoView } from './RepoView';
import { PullView } from './PullView';
import { IssueView } from './IssueView';
import { RunView } from './RunView';
import { CommitView } from './CommitView';

// Comprehensive GitHub view. Mounts as a full-screen takeover of the main
// content area when `showGithub` is true. Internally a tiny state machine
// drives navigation between repo list → single repo → PR / issue / workflow
// run details. All data flows through the server's /api/github/* passthrough
// which uses `gh auth token` transparently.

interface GitHubPanelProps {
  // When set, the panel tries to auto-scope to the GitHub repo matching the
  // cwd's `origin` remote and preselect the current local branch as the
  // ref. Fires once per distinct cwd. Empty/404 falls back to the repos list.
  initialCwd?: string;
}

export function GitHubPanel({ initialCwd }: GitHubPanelProps = {}) {
  const authStatus = useAppStore((s) => s.authStatus);
  const setShowGithub = useAppStore((s) => s.setShowGithub);
  const [view, setView] = useState<View>({ kind: 'repos' });
  const [user, setUser] = useState<GhUser | null>(null);
  const [userError, setUserError] = useState<string | null>(null);
  const embedded = Boolean(initialCwd);
  // Track which cwds we've resolved so switching between workflows re-scopes.
  const scopedCwdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!authStatus?.github.loggedIn) return;
    fetch('/api/github/user')
      .then((r) => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(setUser)
      .catch((e) => setUserError(String(e)));
  }, [authStatus]);

  // Auto-scope to the current workflow's repo + branch when embedded in the
  // right panel. On 404 we stay on the repos list (cwd isn't GitHub-backed).
  useEffect(() => {
    if (!initialCwd) return;
    if (!authStatus?.github.loggedIn) return;
    if (scopedCwdRef.current === initialCwd) return;
    scopedCwdRef.current = initialCwd;
    const q = new URLSearchParams({ path: initialCwd });
    fetch(`/api/github/context?${q.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((ctx: { owner: string; name: string; branch: string | null }) => {
        setView({
          kind: 'repo',
          owner: ctx.owner,
          name: ctx.name,
          ...(ctx.branch ? { initialRef: ctx.branch } : {}),
        });
      })
      .catch(() => { /* 404 or network — leave on repos list */ });
  }, [initialCwd, authStatus]);

  const loggedIn = Boolean(authStatus?.github.loggedIn);

  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', background: 'rgba(5, 12, 8, 0.92)', color: 'var(--color-accent-primary)' }}>
      {/* Header bar */}
      <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--color-border-hairline)', display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
        <span className="display-font glow-text-bright" style={{ fontSize: '16px', letterSpacing: '4px', color: 'var(--color-accent-secondary)' }}>
          ◆ GITHUB
        </span>
        <Breadcrumbs view={view} onNavigate={setView} />
        <div style={{ flex: 1 }} />
        {user && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <img src={user.avatar_url} alt={user.login} style={{ width: '22px', height: '22px', borderRadius: '50%', border: '1px solid var(--color-accent-secondary-dim)' }} />
            <span className="display-font" style={{ fontSize: '11px', color: 'var(--color-accent-primary-dim)', letterSpacing: '1px' }}>{user.login}</span>
          </div>
        )}
        {!embedded && (
          <button onClick={() => setShowGithub(false)} className="display-font" style={closeButtonStyle}>
            × CLOSE
          </button>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {!loggedIn ? (
          <NotLoggedIn />
        ) : userError ? (
          <ErrorBox message={`Couldn't fetch user: ${userError}`} />
        ) : view.kind === 'repos' ? (
          <ReposView onOpen={(owner, name) => setView({ kind: 'repo', owner, name })} />
        ) : view.kind === 'repo' ? (
          <RepoView view={view} onNavigate={setView} />
        ) : view.kind === 'pull' ? (
          <PullView view={view} onBack={() => setView({ kind: 'repo', owner: view.owner, name: view.name, tab: 'pulls' })} />
        ) : view.kind === 'issue' ? (
          <IssueView view={view} onBack={() => setView({ kind: 'repo', owner: view.owner, name: view.name, tab: 'issues' })} />
        ) : view.kind === 'commit' ? (
          <CommitView view={view} onBack={() => setView({ kind: 'repo', owner: view.owner, name: view.name, tab: 'commits', initialRef: view.refName })} />
        ) : (
          <RunView view={view} onBack={() => setView({ kind: 'repo', owner: view.owner, name: view.name, tab: 'runs' })} />
        )}
      </div>
    </div>
  );
}

// ── Shared bits ─────────────────────────────────────────────────────────

function NotLoggedIn() {
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setShowGithub = useAppStore((s) => s.setShowGithub);
  return (
    <div style={{ padding: '40px 60px', textAlign: 'center', color: 'var(--color-accent-primary-dim)', fontFamily: 'var(--font-body)' }}>
      <div style={{ fontSize: '14px', marginBottom: '14px' }}>GitHub CLI is not authenticated.</div>
      <button onClick={() => { setShowGithub(false); setShowSettings(true); }} style={mergeBtnStyle}>OPEN SETTINGS TO LOG IN</button>
    </div>
  );
}
