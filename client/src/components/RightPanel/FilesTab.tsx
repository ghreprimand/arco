import { useState, useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { FileExplorer } from '../FileExplorer';
import { BlastRadiusTab } from './BlastRadiusTab';
import { ChangesPanel } from '../diff/ChangesPanel';
import { WorkingChangesPanel } from '../diff/WorkingChangesPanel';
import { CompareRemotePanel } from '../diff/CompareRemotePanel';
import { LiveChangesPanel } from '../diff/LiveChangesPanel';
import { useAppStore } from '../../stores/appStore';
import type { JobState } from '../../stores/appStore';
import type { ClusterStatePayload, WorktreeInfo, WorktreeListResponse } from '@archon/shared';

export type FilesSubTab = 'files' | 'live' | 'changes' | 'source' | 'remote' | 'blast-radius' | 'sandbox';
export type ClusterFilesSubTab = 'files' | 'live' | 'changes' | 'source' | 'remote';

// Phase F + Workbench A3/I1/I2 — Files-tab body. FILES (the explorer), CHANGES
// (whole working-tree-vs-HEAD diff, A3), SOURCE (per-file changes grouped
// staged/unstaged/untracked, I1) and REMOTE (local↔upstream ahead/behind +
// fetch, I2) are always available; BLAST RADIUS shows when codebase memory is
// attached, SANDBOX when the efficiency sandbox is on.
// Empty-state when no cwd is bound (cluster member without a workflow path,
// fresh tab before workflow_created, etc.).
export function FilesTabBody({
  job,
  cwd,
  subTab,
  onSubTab,
}: {
  job: JobState;
  cwd: string | undefined;
  subTab: FilesSubTab;
  onSubTab: (t: FilesSubTab) => void;
}) {
  // Hook runs unconditionally (before the !cwd guard) to keep hook order stable.
  const isGitSub = subTab === 'live' || subTab === 'changes' || subTab === 'source' || subTab === 'remote';
  const {
    effectiveCwd, watchingBranch, showPicker, autoLabel, worktrees,
    selectedWorktree, setSelectedWorktree,
  } = useWorktreeSelection({
    wfid: job.id,
    baseCwd: cwd ?? '',
    active: isGitSub && !!cwd,
    rootLabel: 'tab root',
  });

  if (!cwd) {
    return <EmptyState text="No working directory bound to this tab." />;
  }
  const memoryAttached = job.config.codebaseMemory?.attached === true;
  const sandboxOn = (job.config.efficiencySandbox ?? 'off') === 'on';
  const tabs: Array<{ id: FilesSubTab; label: string; show: boolean; help?: string }> = [
    { id: 'files', label: 'FILES', show: true },
    { id: 'live', label: 'LIVE', show: true, help: 'rightpanel.files.live' },
    { id: 'changes', label: 'CHANGES', show: true, help: 'rightpanel.files.changes' },
    { id: 'source', label: 'SOURCE', show: true, help: 'rightpanel.files.source' },
    { id: 'remote', label: 'REMOTE', show: true, help: 'rightpanel.files.remote' },
    { id: 'blast-radius', label: 'BLAST RADIUS', show: memoryAttached },
    { id: 'sandbox', label: 'SANDBOX', show: sandboxOn },
  ];
  const visible = tabs.filter((t) => t.show);
  const effectiveSub = visible.some((t) => t.id === subTab) ? subTab : 'files';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        className="display-font"
        style={{
          display: 'flex',
          gap: '2px',
          borderBottom: '1px solid var(--color-border-hairline)',
          padding: '4px 6px 0',
          flexShrink: 0,
        }}
      >
        {visible.map(({ id, label, help }) => {
          const active = effectiveSub === id;
          return (
            <button
              key={id}
              onClick={() => onSubTab(id)}
              data-help={help}
              style={{
                flex: '0 0 auto',
                padding: '4px 8px',
                background: active ? 'var(--color-accent-primary-a08)' : 'transparent',
                border: 'none',
                borderBottom: active ? '2px solid var(--color-accent-primary)' : '2px solid transparent',
                color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                cursor: 'pointer',
                fontSize: '9px',
                letterSpacing: '1.5px',
                fontFamily: 'var(--font-display)',
              }}
            >
              {label}
            </button>
          );
        })}
        {showPicker && (
          <div style={{ marginLeft: 'auto', marginBottom: '3px', display: 'flex' }}>
            <WorktreePicker
              worktrees={worktrees}
              selectedWorktree={selectedWorktree}
              setSelectedWorktree={setSelectedWorktree}
              autoLabel={autoLabel}
              rootLabel="tab root"
            />
          </div>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {effectiveSub === 'files' && <FileExplorer cwd={cwd} workflowId={job.id} />}
        {effectiveSub === 'live' && (
          <LiveChangesPanel
            wfid={job.id}
            cwd={effectiveCwd}
            memberLabel={watchingBranch && effectiveCwd !== cwd ? watchingBranch : undefined}
          />
        )}
        {effectiveSub === 'changes' && <ChangesPanel wfid={job.id} cwd={effectiveCwd} />}
        {effectiveSub === 'source' && <WorkingChangesPanel wfid={job.id} cwd={effectiveCwd} />}
        {effectiveSub === 'remote' && <CompareRemotePanel wfid={job.id} cwd={effectiveCwd} />}
        {effectiveSub === 'blast-radius' && memoryAttached && <BlastRadiusTab job={job} />}
        {effectiveSub === 'sandbox' && sandboxOn && <SandboxFilesSection job={job} />}
      </div>
    </div>
  );
}

export function ClusterFilesTabBody({
  cluster,
  subTab,
  onSubTab,
}: {
  cluster: ClusterStatePayload;
  subTab: ClusterFilesSubTab;
  onSubTab: (t: ClusterFilesSubTab) => void;
}) {
  const [selectedWfid, setSelectedWfid] = useState('');
  const members = cluster.members;
  const effectiveWfid = members.some((m) => m.workflowId === selectedWfid)
    ? selectedWfid
    : members[0]?.workflowId ?? '';
  const selectedMember = members.find((m) => m.workflowId === effectiveWfid);
  const tabs: Array<{ id: ClusterFilesSubTab; label: string; help?: string }> = [
    { id: 'files', label: 'FILES' },
    { id: 'live', label: 'LIVE', help: 'rightpanel.files.live' },
    { id: 'changes', label: 'CHANGES', help: 'rightpanel.files.changes' },
    { id: 'source', label: 'SOURCE', help: 'rightpanel.files.source' },
    { id: 'remote', label: 'REMOTE', help: 'rightpanel.files.remote' },
  ];
  const effectiveSub = tabs.some((t) => t.id === subTab) ? subTab : 'files';
  const needsMember = effectiveSub !== 'files';

  const {
    effectiveCwd, watchingBranch, showPicker: showWorktreePicker, autoLabel, worktrees,
    selectedWorktree, setSelectedWorktree,
  } = useWorktreeSelection({
    wfid: effectiveWfid,
    baseCwd: cluster.cwd,
    active: needsMember && !!effectiveWfid,
    rootLabel: 'cluster root',
    boardKey: cluster.taskBoardKey,
  });
  const memberBase = selectedMember?.displayName || effectiveWfid.slice(0, 8);
  const memberLabel = watchingBranch && effectiveCwd !== cluster.cwd
    ? `${memberBase} @ ${watchingBranch}`
    : memberBase;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        className="display-font"
        style={{
          display: 'flex',
          gap: '2px',
          borderBottom: '1px solid var(--color-border-hairline)',
          padding: '4px 6px 0',
          flexShrink: 0,
          alignItems: 'flex-end',
        }}
      >
        {tabs.map(({ id, label, help }) => {
          const active = effectiveSub === id;
          return (
            <button
              key={id}
              onClick={() => onSubTab(id)}
              data-help={help}
              style={{
                flex: '0 0 auto',
                padding: '4px 8px',
                background: active ? 'var(--color-accent-primary-a08)' : 'transparent',
                border: 'none',
                borderBottom: active ? '2px solid var(--color-accent-primary)' : '2px solid transparent',
                color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                cursor: 'pointer',
                fontSize: '9px',
                letterSpacing: '1.5px',
                fontFamily: 'var(--font-display)',
              }}
            >
              {label}
            </button>
          );
        })}
        {needsMember && (members.length > 1 || showWorktreePicker) && (
          <div style={{ marginLeft: 'auto', marginBottom: '3px', display: 'flex', gap: '4px' }}>
            {members.length > 1 && (
              <select
                value={effectiveWfid}
                onChange={(e) => setSelectedWfid(e.target.value)}
                title="Member used for workspace-scoped git reads"
                style={pickerStyle}
              >
                {members.map((m) => (
                  <option key={m.workflowId} value={m.workflowId}>
                    {m.displayName || m.workflowId.slice(0, 8)}
                  </option>
                ))}
              </select>
            )}
            {showWorktreePicker && (
              <WorktreePicker
                worktrees={worktrees}
                selectedWorktree={selectedWorktree}
                setSelectedWorktree={setSelectedWorktree}
                autoLabel={autoLabel}
                rootLabel="cluster root"
              />
            )}
          </div>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {effectiveSub === 'files' && <FileExplorer cwd={cluster.cwd} />}
        {needsMember && !effectiveWfid && <EmptyState text="No cluster member is available for workspace git views." />}
        {effectiveSub === 'live' && effectiveWfid && (
          <LiveChangesPanel
            wfid={effectiveWfid}
            cwd={effectiveCwd}
            memberLabel={memberLabel}
          />
        )}
        {effectiveSub === 'changes' && effectiveWfid && <ChangesPanel wfid={effectiveWfid} cwd={effectiveCwd} />}
        {effectiveSub === 'source' && effectiveWfid && <WorkingChangesPanel wfid={effectiveWfid} cwd={effectiveCwd} />}
        {effectiveSub === 'remote' && effectiveWfid && <CompareRemotePanel wfid={effectiveWfid} cwd={effectiveCwd} />}
      </div>
    </div>
  );
}

// EFFICIENCY_PLAN.md Phase E §9 — Files-tab sub-section listing the most
// recent sandbox chunks. Pulls /api/workflows/:wfId/sandbox/stats which
// includes a `recent[]` preview (id + language + bytes + preview). The
// chunk count chip on the section also lives in JobState.sandboxChunkCount,
// pushed by sandbox_chunk_added events; this body refetches on mount
// and whenever that counter changes so a freshly stored chunk shows up
// without an explicit refresh click.
function SandboxFilesSection({ job }: { job: JobState }) {
  type Row = { chunkId: number; language: string; byteLen: number; createdAt: number; preview: string };
  const [recent, setRecent] = useState<Row[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [fullById, setFullById] = useState<Record<number, string>>({});
  const counterPing = job.sandboxChunkCount ?? 0;

  useEffect(() => {
    fetch(`/api/workflows/${encodeURIComponent(job.id)}/sandbox/stats`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.recent)) setRecent(data.recent as Row[]);
      })
      .catch(() => { /* ignore */ });
  }, [job.id, counterPing]);

  const togglePreview = (chunkId: number) => {
    if (open === chunkId) { setOpen(null); return; }
    setOpen(chunkId);
    if (fullById[chunkId] === undefined) {
      // Fetch full chunk content. The endpoint we'd want would be
      // /api/workflows/:wfId/sandbox/chunk/:id — not shipped in v1 to
      // keep the surface compact. Fall back to the preview snippet.
      setFullById((p) => ({ ...p, [chunkId]: '' }));
    }
  };

  if (recent.length === 0) {
    return (
      <EmptyState text="No sandbox chunks yet. Have the model call ctx_execute and print `[chunk] …` lines to stash content for later retrieval." />
    );
  }
  return (
    <div style={{ overflowY: 'auto', padding: '8px 10px' }}>
      {recent.map((r) => (
        <div
          key={r.chunkId}
          style={{
            borderBottom: '1px solid var(--color-border-hairline)',
            padding: '6px 0',
            fontFamily: 'var(--font-body)',
            fontSize: '11px',
          }}
        >
          <button
            type="button"
            onClick={() => togglePreview(r.chunkId)}
            style={{
              all: 'unset',
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              gap: '8px',
              width: '100%',
              color: 'var(--color-fg-secondary)',
            }}
          >
            <span style={{ fontFamily: 'var(--font-code)' }}>#{r.chunkId} [{r.language}]</span>
            <span style={{ color: 'var(--color-fg-muted)' }}>{r.byteLen}B</span>
          </button>
          {open === r.chunkId && (
            <pre
              style={{
                margin: '6px 0 0',
                padding: '6px 8px',
                background: 'var(--color-bg-secondary)',
                color: 'var(--color-fg-secondary)',
                fontSize: '10px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {fullById[r.chunkId] || r.preview}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

// Shared style for the FilesTab header member / worktree pickers.
const pickerStyle: CSSProperties = {
  maxWidth: '150px',
  background: 'var(--color-bg-input, var(--color-bg))',
  color: 'var(--color-fg-secondary)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  fontSize: '10px',
  fontFamily: 'var(--font-body)',
};

// Human label for a worktree option. `rootLabel` names the primary checkout
// ("cluster root" / "tab root"); linked worktrees show their branch, falling
// back to the checkout's basename (covers detached-HEAD worktrees).
function worktreeLabel(w: WorktreeInfo | undefined, path: string, rootLabel: string): string {
  if (w?.isMain) return rootLabel;
  if (w?.branch) return w.branch;
  return path.split('/').filter(Boolean).pop() || path;
}

// Worktree-aware git views. A worker (cluster member or solo) often edits inside
// a git worktree — an Archon task worktree under ~/.archon/worktrees, or one it
// ran `git worktree add` for itself. Those edits never touch the shared checkout,
// so watching `baseCwd` reads "clean" mid-work. This resolves the tree the worker
// is actually editing (AUTO = its active-task worktree from the ledger) and lets
// the operator pick any linked worktree — including off-ledger ones AUTO can't see.
function useWorktreeSelection(opts: {
  wfid: string;
  baseCwd: string;
  active: boolean;
  rootLabel: string;
  boardKey?: string;
}): {
  effectiveCwd: string;
  watchingBranch: string | null | undefined;
  showPicker: boolean;
  autoLabel: string;
  worktrees: WorktreeInfo[];
  selectedWorktree: string;
  setSelectedWorktree: (v: string) => void;
} {
  const { wfid, baseCwd, active, rootLabel, boardKey } = opts;
  const [selectedWorktree, setSelectedWorktree] = useState<string>(''); // '' = auto
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const taskLedger = useAppStore((s) => s.taskLedger);

  // A manual pick shouldn't leak onto a different worker's view.
  useEffect(() => { setSelectedWorktree(''); }, [wfid]);

  // AUTO target: the worker's assigned task that carries a worktree, preferring
  // in_progress, else most recently updated. Pulled from the ledger in the store.
  const autoWorktreePath = useMemo(() => {
    const ledgerKey = boardKey ? `${baseCwd}::${boardKey}` : baseCwd;
    const tasksForBoard = taskLedger[ledgerKey] ?? [];
    const mine = tasksForBoard.filter((t) => t.assignee === wfid && t.worktree?.path);
    if (mine.length === 0) return '';
    const inProgress = mine.find((t) => t.status === 'in_progress');
    const pick = inProgress ?? [...mine].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return pick?.worktree?.path ?? '';
  }, [taskLedger, baseCwd, boardKey, wfid]);

  // Enumerate the repo's linked worktrees (catches worker-made ones the ledger
  // doesn't know about). Slow poll so a freshly-added worktree appears on its own.
  useEffect(() => {
    if (!active || !wfid) { setWorktrees([]); return; }
    let cancelled = false;
    const fetchWorktrees = () => {
      const params = new URLSearchParams({ wfid, path: baseCwd });
      fetch(`/api/git/worktrees?${params.toString()}`)
        .then((r) => (r.ok ? r.json() : { worktrees: [] }) as Promise<WorktreeListResponse>)
        .then((d) => { if (!cancelled) setWorktrees(d.worktrees ?? []); })
        .catch(() => { if (!cancelled) setWorktrees([]); });
    };
    fetchWorktrees();
    const id = window.setInterval(fetchWorktrees, 4000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [active, wfid, baseCwd]);

  const effectiveCwd = selectedWorktree || autoWorktreePath || baseCwd;
  const showPicker = active && (worktrees.length > 1 || !!autoWorktreePath);
  const autoLabel = autoWorktreePath
    ? `AUTO — ${worktreeLabel(worktrees.find((w) => w.path === autoWorktreePath), autoWorktreePath, rootLabel)}`
    : `AUTO — ${rootLabel}`;
  const watchingBranch = worktrees.find((w) => w.path === effectiveCwd)?.branch;

  return { effectiveCwd, watchingBranch, showPicker, autoLabel, worktrees, selectedWorktree, setSelectedWorktree };
}

// The header worktree dropdown. Shared by the solo and cluster FilesTab bodies.
function WorktreePicker({
  worktrees,
  selectedWorktree,
  setSelectedWorktree,
  autoLabel,
  rootLabel,
}: {
  worktrees: WorktreeInfo[];
  selectedWorktree: string;
  setSelectedWorktree: (v: string) => void;
  autoLabel: string;
  rootLabel: string;
}) {
  return (
    <select
      value={selectedWorktree}
      onChange={(e) => setSelectedWorktree(e.target.value)}
      title="Git working tree watched by the LIVE / CHANGES / SOURCE / REMOTE views. AUTO follows the worker's active task worktree."
      style={{ ...pickerStyle, maxWidth: '170px' }}
    >
      <option value="">{autoLabel}</option>
      {worktrees.map((w) => (
        <option key={w.path} value={w.path}>
          {worktreeLabel(w, w.path, rootLabel)}
        </option>
      ))}
    </select>
  );
}

export function EmptyState({ text }: { text: string }) {
  return (
    <div
      className="display-font"
      style={{
        padding: '24px 18px',
        color: 'var(--color-fg-muted)',
        fontSize: '11px',
        letterSpacing: '0.5px',
        lineHeight: 1.6,
      }}
    >
      {text}
    </div>
  );
}
