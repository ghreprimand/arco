import { useEffect, useMemo, useState } from 'react';
import type { WorkflowConfig, ProviderName, ModelName, EffortLevel } from '@arco/shared';
// Workbench Expansion I3 — the protected-branch regex moved to shared so the
// server push guard (gitOps.push) and this dialog share ONE definition.
import { PROTECTED_BRANCH_RE } from '@arco/shared';
import { RunAsPicker, spawnConfigFromRunAs, type RunAsSelection } from './RunAsPicker';
import { ChangesPanel } from './diff/ChangesPanel';

// Composer-button sibling for COMMIT / PUSH / PR / branch switching.
// Fetches live git status on open so the popup shows reality (current
// branch, ahead/behind, dirty count, GitHub-remote detection) instead
// of asking the agent to discover it. Operator picks branch + action;
// on confirm, branch switch (if any) happens server-side via the
// `/api/git/checkout` endpoint, then the structured prompt is dispatched
// to the current agent. Per-repo defaults persist to localStorage —
// after a few uses the popup reflects how each repo actually flows.

interface GitBranchSummary {
  name: string;
  hasUpstream: boolean;
  upstream: string | null;
  isCurrent: boolean;
}

interface GitRemoteSummary {
  name: string;
  url: string;
  isGitHub: boolean;
}

interface GitStatusFile {
  path: string;
  status: string;
  origPath?: string;
}

interface GitStatus {
  isRepo: boolean;
  currentBranch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirtyCount: number;
  stagedCount: number;
  toPushFiles?: GitStatusFile[];
  toPullFiles?: GitStatusFile[];
  dirtyFiles?: GitStatusFile[];
  stagedFiles?: GitStatusFile[];
  branches: GitBranchSummary[];
  remotes: GitRemoteSummary[];
  hasGitHubRemote: boolean;
  defaultBranch: string | null;
}

type Action = 'commit' | 'commit-push' | 'commit-push-pr';

interface RepoPrefs {
  action: Action;
}

interface Props {
  cwd: string;
  // Workflow id — only used to scope the pre-commit diff preview's endpoint
  // call; the GIT prompt itself is cwd-driven.
  wfid: string;
  // Parent tab's primary — RUN AS picker defaults to this.
  parentConfig: WorkflowConfig;
  // Same-tab dispatch (when RUN AS == current primary).
  onConfirm: (prompt: string) => void;
  // New-tab spawn (when RUN AS picks a different model).
  onSpawn: (newConfig: WorkflowConfig, newDirection: string, includePlan: boolean) => void;
  onCancel: () => void;
}


function prefsKey(cwd: string): string {
  return `arco.gitDialog.prefs.${cwd}`;
}
function loadPrefs(cwd: string): RepoPrefs | null {
  try {
    const raw = localStorage.getItem(prefsKey(cwd));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.action === 'commit' || parsed.action === 'commit-push' || parsed.action === 'commit-push-pr')) {
      return { action: parsed.action };
    }
  } catch { /* corrupt prefs — ignore */ }
  return null;
}
function savePrefs(cwd: string, prefs: RepoPrefs) {
  try { localStorage.setItem(prefsKey(cwd), JSON.stringify(prefs)); } catch { /* quota / disabled */ }
}

function inferDefaultAction(status: GitStatus): Action {
  // Smart default: PR if we're on a non-default branch AND there's a
  // GitHub remote (the operator's intent is almost always "ship via PR"
  // in that case). Otherwise plain push. Saved prefs override this.
  const onProtected = status.currentBranch && PROTECTED_BRANCH_RE.test(status.currentBranch);
  const onDefault = status.currentBranch && status.defaultBranch && status.currentBranch === status.defaultBranch;
  if (status.hasGitHubRemote && !onProtected && !onDefault) return 'commit-push-pr';
  return 'commit-push';
}

export function GitDialog({ cwd, wfid, parentConfig, onConfirm, onSpawn, onCancel }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<Action>('commit-push');
  const currentPrimary: RunAsSelection = useMemo(() => ({
    provider: (parentConfig.primaryProvider ?? 'claude') as ProviderName,
    model: parentConfig.primaryModel as ModelName,
    effort: parentConfig.primaryEffort as EffortLevel,
    providerAccountRef: parentConfig.providerAccountRef,
  }), [parentConfig.primaryProvider, parentConfig.primaryModel, parentConfig.primaryEffort, parentConfig.providerAccountRef]);
  const [runAs, setRunAs] = useState<RunAsSelection>(currentPrimary);
  const isCurrentPrimary = runAs.provider === currentPrimary.provider && runAs.model === currentPrimary.model && runAs.effort === currentPrimary.effort && runAs.providerAccountRef === currentPrimary.providerAccountRef;
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [commitSubject, setCommitSubject] = useState('');
  const [scopeNotes, setScopeNotes] = useState('');
  // Branch dropdown / new-branch state.
  const [pickedBranch, setPickedBranch] = useState<string>('');
  const [creatingNew, setCreatingNew] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [newBranchBase, setNewBranchBase] = useState<string>('');
  const [switchPending, setSwitchPending] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // Pre-commit working-tree diff preview. Collapsed by default so the dialog
  // opens compact; the operator expands to confirm exactly what's about to be
  // committed before dispatching the prompt.
  const [showDiff, setShowDiff] = useState(false);

  // Initial load — fetch status, prime defaults from saved prefs + smart inference.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/git/status?path=${encodeURIComponent(cwd)}`);
        if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
        const s = (await r.json()) as GitStatus;
        if (cancelled) return;
        setStatus(s);
        const saved = loadPrefs(cwd);
        setAction(saved?.action ?? inferDefaultAction(s));
        setPickedBranch(s.currentBranch ?? '');
        setNewBranchBase(s.defaultBranch ?? s.currentBranch ?? '');
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [cwd]);

  const isProtectedTarget = useMemo(() => {
    const target = creatingNew ? newBranchName : pickedBranch;
    return target ? PROTECTED_BRANCH_RE.test(target) : false;
  }, [pickedBranch, creatingNew, newBranchName]);

  const branchChanged = useMemo(() => {
    if (!status) return false;
    if (creatingNew) return newBranchName.trim().length > 0;
    return pickedBranch !== '' && pickedBranch !== status.currentBranch;
  }, [status, creatingNew, newBranchName, pickedBranch]);

  const submit = async () => {
    if (!status) return;
    setSwitchError(null);
    // Branch switch first (if requested) — fail before dispatching the
    // prompt so the operator doesn't end up committing on the wrong branch.
    if (branchChanged) {
      setSwitchPending(true);
      try {
        const body = creatingNew
          ? { path: cwd, branch: newBranchName.trim(), create: { fromBranch: newBranchBase } }
          : { path: cwd, branch: pickedBranch };
        const r = await fetch('/api/git/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = (await r.json()) as { ok: boolean; error?: string };
        if (!result.ok) {
          setSwitchError(result.error || 'Branch switch failed.');
          setSwitchPending(false);
          return;
        }
      } catch (err) {
        setSwitchError(err instanceof Error ? err.message : String(err));
        setSwitchPending(false);
        return;
      }
      setSwitchPending(false);
    }

    if (saveAsDefault) savePrefs(cwd, { action });

    // Build the prompt. Branch context reflects the FINAL branch (after
    // any switch) so the agent's first git command lands on the right
    // ref. Ahead/behind from the status snapshot may be stale post-switch
    // but the agent will re-check via `git status` anyway.
    const finalBranch = creatingNew ? newBranchName.trim() : (pickedBranch || status.currentBranch || '(unknown)');
    const prompt = buildPrompt({
      branch: finalBranch,
      branchWasSwitched: branchChanged,
      branchWasCreated: creatingNew,
      branchBase: creatingNew ? newBranchBase : null,
      action,
      ahead: status.ahead,
      behind: status.behind,
      upstream: status.upstream,
      hasGitHubRemote: status.hasGitHubRemote,
      commitSubject: commitSubject.trim(),
      scopeNotes: scopeNotes.trim(),
      isProtected: PROTECTED_BRANCH_RE.test(finalBranch),
      arcoDirtyFiles: arcoFiles([...(status.dirtyFiles ?? []), ...(status.stagedFiles ?? [])]).map((f) => displayFile(f)),
    });
    if (isCurrentPrimary) {
      // Same-tab dispatch — drops into the existing chat as a regular turn.
      onConfirm(prompt);
    } else {
      // RUN AS override — spawn a new tab so the picked model handles
      // the git work without permanently switching this tab's primary.
      const newConfig = spawnConfigFromRunAs(parentConfig, runAs, 'git');
      onSpawn(newConfig, prompt, false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-accent-primary-dim)',
          borderRadius: '6px',
          padding: '18px 22px',
          width: 'min(760px, calc(94vw / var(--ui-scale, 1)))',
          maxHeight: 'calc(90vh / var(--ui-scale, 1))',
          overflowY: 'auto',
          fontFamily: 'var(--font-body)',
        }}
      >
        <div className="display-font" style={{ fontSize: '12px', letterSpacing: '3px', color: 'var(--color-accent-primary)', marginBottom: '12px' }}>
          GIT
        </div>

        <div style={{ marginBottom: '12px' }}>
          <RunAsPicker current={currentPrimary} selection={runAs} onChange={setRunAs} />
        </div>

        {loadError && (
          <div style={{ color: 'var(--color-warning)', fontSize: '11px', marginBottom: '10px' }}>
            Failed to read git status: {loadError}
          </div>
        )}
        {!status && !loadError && (
          <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)' }}>Reading git status…</div>
        )}

        {status && !status.isRepo && (
          <div style={{ fontSize: '11px', color: 'var(--color-warning)' }}>
            This workflow's working directory isn't a git repository. Initialize one (<code>git init</code>) before using GIT.
          </div>
        )}

        {status && status.isRepo && (
          <>
            <RepoLine status={status} />
            <GitStateSummary status={status} />

            <button
              type="button"
              onClick={() => setShowDiff((s) => !s)}
              data-help="gitdialog.diff-preview"
              className="display-font"
              style={{ ...subtleBtn, marginBottom: showDiff ? '6px' : '0' }}
            >
              {showDiff ? 'HIDE FILE DIFFS' : 'EXPAND FILE DIFFS'}
            </button>
            {showDiff && (
              <div
                style={{
                  border: '1px solid var(--color-border-hairline)',
                  borderRadius: '4px',
                  maxHeight: '320px',
                  overflow: 'auto',
                  marginBottom: '6px',
                  background: 'var(--color-bg-sunken)',
                }}
              >
                <ChangesPanel wfid={wfid} cwd={cwd} />
              </div>
            )}

            <FieldLabel>BRANCH</FieldLabel>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
              {!creatingNew && (
                <select
                  value={pickedBranch}
                  onChange={(e) => setPickedBranch(e.target.value)}
                  className="display-font"
                  style={selectStyle}
                >
                  {status.branches.length === 0 && <option value="">(no branches)</option>}
                  {status.branches.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}{b.isCurrent ? ' (current)' : ''}{b.hasUpstream ? '' : ' [no upstream]'}
                    </option>
                  ))}
                </select>
              )}
              {!creatingNew && (
                <button onClick={() => { setCreatingNew(true); setNewBranchName(''); }} className="display-font" style={subtleBtn}>
                  + NEW BRANCH
                </button>
              )}
              {creatingNew && (
                <>
                  <input
                    type="text"
                    placeholder="new-branch-name"
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    className="display-font"
                    style={{ ...selectStyle, minWidth: '180px' }}
                  />
                  <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', letterSpacing: '1px' }}>FROM</span>
                  <select
                    value={newBranchBase}
                    onChange={(e) => setNewBranchBase(e.target.value)}
                    className="display-font"
                    style={selectStyle}
                  >
                    {status.branches.map((b) => (
                      <option key={b.name} value={b.name}>{b.name}</option>
                    ))}
                  </select>
                  <button onClick={() => { setCreatingNew(false); setPickedBranch(status.currentBranch ?? ''); }} className="display-font" style={subtleBtn}>
                    CANCEL
                  </button>
                </>
              )}
            </div>
            {switchError && (
              <div style={{ color: 'var(--color-warning)', fontSize: '10px', marginTop: '4px' }}>
                {switchError}
              </div>
            )}
            {branchChanged && !switchError && (
              <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', marginTop: '4px' }}>
                Branch will be switched on CONTINUE. Refuses if working tree is dirty.
              </div>
            )}

            <FieldLabel>ACTION</FieldLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <ActionRadio name="commit" current={action} onChange={setAction} label="Commit only" hint="Stage relevant changes and create commits. No push." />
              <ActionRadio name="commit-push" current={action} onChange={setAction} label="Commit + push" hint="Commit, then push to the upstream branch." />
              <ActionRadio
                name="commit-push-pr"
                current={action}
                onChange={setAction}
                label="Commit + push + open PR"
                hint={status.hasGitHubRemote
                  ? `Commit, push, and open a PR via gh pr create (target: ${status.defaultBranch ?? 'default branch'}).`
                  : 'No GitHub remote detected — PR step will likely fail.'}
                disabled={!status.hasGitHubRemote}
              />
            </div>

            {isProtectedTarget && action !== 'commit' && (
              <div style={{ color: 'var(--color-warning)', fontSize: '10px', marginTop: '6px', lineHeight: 1.5 }}>
                Target branch looks protected ({creatingNew ? newBranchName : pickedBranch}). The agent will pause and ask before pushing.
              </div>
            )}

            <label
              className="display-font"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px', fontSize: '10px', letterSpacing: '1px', color: 'var(--color-accent-primary-dim)', cursor: 'pointer' }}
            >
              <input type="checkbox" checked={saveAsDefault} onChange={(e) => setSaveAsDefault(e.target.checked)} />
              SAVE AS DEFAULT FOR THIS REPO
            </label>

            <FieldLabel>COMMIT SUBJECT (OPTIONAL)</FieldLabel>
            <input
              type="text"
              placeholder="e.g. fix categoryId race in transaction insert"
              value={commitSubject}
              onChange={(e) => setCommitSubject(e.target.value)}
              style={inputStyle}
            />

            <FieldLabel>SCOPE NOTES (OPTIONAL)</FieldLabel>
            <textarea
              placeholder="e.g. exclude lockfile changes; only commit the auth/ directory"
              value={scopeNotes}
              onChange={(e) => setScopeNotes(e.target.value)}
              rows={2}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-body)' }}
            />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
              <Btn onClick={onCancel}>CANCEL</Btn>
              <Btn primary onClick={submit} disabled={switchPending || (creatingNew && !newBranchName.trim())}>
                {switchPending ? 'SWITCHING…' : isCurrentPrimary ? 'CONTINUE' : 'CONTINUE (NEW TAB)'}
              </Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RepoLine({ status }: { status: GitStatus }) {
  const branchLabel = status.currentBranch ?? '(detached HEAD)';
  return (
    <div style={{ marginBottom: '10px', fontSize: '11px', color: 'var(--color-fg-muted)', display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
      <span>
        <span style={{ color: 'var(--color-accent-primary-dim)' }}>BRANCH</span>{' '}
        <span style={{ color: 'var(--color-accent-primary)' }}>{branchLabel}</span>
      </span>
      {status.upstream && (
        <span>
          <span style={{ color: 'var(--color-accent-primary-dim)' }}>↑</span> {status.ahead} ·{' '}
          <span style={{ color: 'var(--color-accent-primary-dim)' }}>↓</span> {status.behind}
          {' '}<span style={{ opacity: 0.6 }}>vs {status.upstream}</span>
        </span>
      )}
      {!status.upstream && status.currentBranch && (
        <span style={{ color: 'var(--color-warning)' }}>no upstream</span>
      )}
      <span>
        <span style={{ color: 'var(--color-accent-primary-dim)' }}>DIRTY</span>{' '}
        <span style={{ color: status.dirtyCount > 0 ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)' }}>{status.dirtyCount}</span>
        {status.stagedCount > 0 && <span> · {status.stagedCount} staged</span>}
      </span>
      {status.remotes.length > 0 && (
        <span>
          <span style={{ color: 'var(--color-accent-primary-dim)' }}>REMOTE</span>{' '}
          {status.remotes.map((r) => r.name).join(', ')}
          {status.hasGitHubRemote && <span style={{ marginLeft: '4px', color: 'var(--color-accent-secondary)' }}>(github)</span>}
        </span>
      )}
    </div>
  );
}

function isArcoGeneratedPath(path: string): boolean {
  return path === '.arco' || path.startsWith('.arco/');
}

function arcoFiles(files: GitStatusFile[]): GitStatusFile[] {
  return files.filter((f) => isArcoGeneratedPath(f.path) || (f.origPath ? isArcoGeneratedPath(f.origPath) : false));
}

function projectFiles(files: GitStatusFile[]): GitStatusFile[] {
  return files.filter((f) => !isArcoGeneratedPath(f.path) && !(f.origPath ? isArcoGeneratedPath(f.origPath) : false));
}

function displayFile(file: GitStatusFile): string {
  return file.origPath ? `${file.origPath} -> ${file.path}` : file.path;
}

function uniqueFiles(files: GitStatusFile[]): GitStatusFile[] {
  const out: GitStatusFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const key = `${f.origPath ?? ''}\0${f.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function GitStateSummary({ status }: { status: GitStatus }) {
  const toPush = status.toPushFiles ?? [];
  const toPull = status.toPullFiles ?? [];
  const localFiles = uniqueFiles([...(status.stagedFiles ?? []), ...(status.dirtyFiles ?? [])]);
  const localProject = projectFiles(localFiles);
  const localArco = arcoFiles(localFiles);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: '8px',
        marginBottom: '10px',
      }}
    >
      <StatusSection
        title="TO PUSH"
        tone={status.ahead > 0 ? 'accent' : 'muted'}
        summary={status.upstream
          ? status.ahead > 0
            ? `${status.ahead} local commit${status.ahead === 1 ? '' : 's'} not on ${status.upstream}`
            : `Nothing waiting to push to ${status.upstream}`
          : 'No upstream is configured for this branch'}
        files={toPush}
        empty="No committed file changes waiting to push."
      />
      <StatusSection
        title="TO PULL"
        tone={status.behind > 0 ? 'warning' : 'muted'}
        summary={status.upstream
          ? status.behind > 0
            ? `${status.behind} remote commit${status.behind === 1 ? '' : 's'} not local`
            : 'Remote has no newer commits.'
          : 'No upstream is configured for this branch'}
        files={toPull}
        empty="No remote file changes waiting to pull."
      />
      <StatusSection
        title="LOCAL UNCOMMITTED"
        tone={localProject.length > 0 ? 'accent' : localArco.length > 0 ? 'warning' : 'muted'}
        summary={localProject.length > 0
          ? `${localProject.length} project file${localProject.length === 1 ? '' : 's'} dirty`
          : localArco.length > 0
            ? 'Only Arco metadata is dirty.'
            : 'Working tree clean.'}
        files={localProject}
        empty="No project files are dirty."
      />
      {localArco.length > 0 && (
        <StatusSection
          title="ARCO METADATA"
          tone="warning"
          summary={`${localArco.length} generated file${localArco.length === 1 ? '' : 's'} under .arco/`}
          files={localArco}
          empty=""
          collapsed
        />
      )}
    </div>
  );
}

function StatusSection({
  title,
  summary,
  files,
  empty,
  tone,
  collapsed,
}: {
  title: string;
  summary: string;
  files: GitStatusFile[];
  empty: string;
  tone: 'accent' | 'warning' | 'muted';
  collapsed?: boolean;
}) {
  const color = tone === 'accent'
    ? 'var(--color-accent-primary)'
    : tone === 'warning'
      ? 'var(--color-warning)'
      : 'var(--color-fg-muted)';
  const body = (
    <FileList files={files} empty={empty} />
  );
  return (
    <div
      style={{
        border: '1px solid var(--color-border-hairline)',
        borderRadius: '4px',
        padding: '8px 9px',
        background: 'var(--color-bg-sunken)',
        minWidth: 0,
      }}
    >
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1.8px', color, marginBottom: '4px' }}>
        {title}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', lineHeight: 1.35, marginBottom: files.length > 0 ? '6px' : 0 }}>
        {summary}
      </div>
      {collapsed && files.length > 0 ? (
        <details>
          <summary className="display-font" style={{ cursor: 'pointer', fontSize: '9px', letterSpacing: '1px', color }}>
            SHOW FILES
          </summary>
          {body}
        </details>
      ) : body}
    </div>
  );
}

function FileList({ files, empty }: { files: GitStatusFile[]; empty: string }) {
  const shown = files.slice(0, 12);
  if (files.length === 0) {
    return empty ? <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>{empty}</div> : null;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
      {shown.map((f) => (
        <div
          key={`${f.status}:${f.origPath ?? ''}:${f.path}`}
          title={displayFile(f)}
          style={{
            display: 'flex',
            gap: '6px',
            minWidth: 0,
            fontFamily: 'var(--font-code)',
            fontSize: '10px',
            color: 'var(--color-fg-secondary)',
          }}
        >
          <span style={{ width: '12px', flexShrink: 0, color: 'var(--color-fg-muted)' }}>{f.status}</span>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayFile(f)}</span>
        </div>
      ))}
      {files.length > shown.length && (
        <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>
          +{files.length - shown.length} more
        </div>
      )}
    </div>
  );
}

function ActionRadio({
  name,
  current,
  onChange,
  label,
  hint,
  disabled,
}: {
  name: Action;
  current: Action;
  onChange: (a: Action) => void;
  label: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: '11px',
        color: 'var(--color-accent-primary)',
      }}
    >
      <input
        type="radio"
        name="git-action"
        checked={current === name}
        disabled={disabled}
        onChange={() => onChange(name)}
        style={{ marginTop: '2px' }}
      />
      <span style={{ flex: 1 }}>
        <div>{label}</div>
        <div style={{ fontSize: '9px', color: 'var(--color-fg-muted)', marginTop: '1px' }}>{hint}</div>
      </span>
    </label>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginTop: '12px', marginBottom: '4px' }}>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  background: 'var(--color-bg-sunken)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary)',
  fontFamily: 'var(--font-display)',
  fontSize: '11px',
};

const selectStyle: React.CSSProperties = {
  padding: '4px 8px',
  background: 'var(--color-bg-sunken)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary)',
  fontSize: '11px',
};

const subtleBtn: React.CSSProperties = {
  padding: '4px 8px',
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-fg-muted)',
  cursor: 'pointer',
  fontSize: '10px',
  letterSpacing: '1px',
};

function Btn({
  onClick,
  children,
  primary,
  disabled,
}: { onClick: () => void; children: React.ReactNode; primary?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="display-font"
      style={{
        padding: '6px 14px',
        background: primary ? 'var(--color-accent-primary-a10)' : 'transparent',
        border: `1px solid ${primary ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
        borderRadius: '3px',
        color: primary ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: '11px',
        letterSpacing: '2px',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}

// Build the structured prompt that gets dispatched as a regular turn.
// Bakes in every operator decision (branch, action, scope, subject hint)
// so the agent's only judgment calls are the contextual ones (which
// files, separating concerns, commit-message wording).
function buildPrompt(args: {
  branch: string;
  branchWasSwitched: boolean;
  branchWasCreated: boolean;
  branchBase: string | null;
  action: Action;
  ahead: number;
  behind: number;
  upstream: string | null;
  hasGitHubRemote: boolean;
  commitSubject: string;
  scopeNotes: string;
  isProtected: boolean;
  arcoDirtyFiles: string[];
}): string {
  const willPush = args.action !== 'commit';
  const willPR = args.action === 'commit-push-pr';
  const headerVerb = willPR ? 'Commit, push, and open a PR' : willPush ? 'Commit and push' : 'Commit';

  const lines: string[] = [];
  lines.push(`${headerVerb} for the work on this branch.`);
  lines.push('');
  lines.push(`**Branch:** \`${args.branch}\``);
  if (args.branchWasCreated && args.branchBase) {
    lines.push(`**Branch context:** Just created from \`${args.branchBase}\` — fresh branch, no upstream yet.`);
  } else if (args.branchWasSwitched) {
    lines.push(`**Branch context:** Just switched to this branch.`);
  } else if (args.upstream) {
    lines.push(`**Branch context:** ${args.ahead} ahead, ${args.behind} behind \`${args.upstream}\` (snapshot — re-check with \`git status\`).`);
  } else {
    lines.push(`**Branch context:** No upstream tracking branch yet.`);
  }
  lines.push(`**Action:** ${args.action.replace(/-/g, ' + ')}`);
  lines.push('');
  lines.push('**Process:**');
  lines.push('1. `git status` to confirm what\'s changed.');
  lines.push('2. Stage relevant files. Skip what\'s clearly unintentional (lockfile churn you didn\'t introduce, `.env`, debug scripts, `.arco/` runtime metadata, untracked files outside this conversation\'s scope). **Honor the SCOPE NOTES below if any.**');
  lines.push('3. If there are clearly separable concerns, group them into logical commits. Otherwise one commit is fine.');
  lines.push('4. Write commit messages **from the actual diff** — read it, don\'t rely on session memory. Use a short subject line; body if needed.');
  let stepNum = 5;
  if (willPush) {
    if (args.upstream) {
      lines.push(`${stepNum}. Push to \`${args.upstream}\`.`);
    } else if (args.branchWasCreated) {
      lines.push(`${stepNum}. Push and set upstream: \`git push -u origin ${args.branch}\`.`);
    } else {
      lines.push(`${stepNum}. Push (set upstream if not already configured).`);
    }
    stepNum++;
  }
  if (willPR) {
    lines.push(`${stepNum}. Open a PR via \`gh pr create\`. Title: short, under 70 chars. Body: bullet summary + test plan checklist.`);
    stepNum++;
  }
  lines.push('');
  lines.push('**Pause and ask before:**');
  lines.push('- Force-push, amend, or any history rewrite');
  lines.push('- Including any file you didn\'t touch in this conversation');
  if (args.arcoDirtyFiles.length > 0) {
    lines.push(`- Staging Arco runtime metadata unless the operator explicitly asks for it: ${args.arcoDirtyFiles.map((p) => `\`${p}\``).join(', ')}`);
  } else {
    lines.push('- Staging Arco runtime metadata under `.arco/` unless the operator explicitly asks for it');
  }
  if (args.isProtected) {
    lines.push(`- **This branch (\`${args.branch}\`) looks protected — confirm the push target is intentional before pushing.**`);
  } else {
    lines.push('- Pushing to a protected branch (`main`, `master`, `release/*`)');
  }
  lines.push('- Anything you\'re genuinely unsure about — better to pause than to wreck history');
  lines.push('');
  lines.push(`**Commit subject hint (operator-provided):** ${args.commitSubject || '(none — write one from the diff)'}`);
  lines.push(`**Scope notes (operator-provided):** ${args.scopeNotes || '(none)'}`);
  lines.push('');
  const wrap: string[] = ['When done, post the commit hash(es)'];
  if (willPush) wrap.push('push result');
  if (willPR) wrap.push('PR URL');
  lines.push(wrap.join(', ') + '.');
  return lines.join('\n');
}
