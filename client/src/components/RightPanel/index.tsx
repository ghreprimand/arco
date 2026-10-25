import { useVoicePanelRequest } from '../../voice/panels';
import { useCallback, useState, useEffect, useRef } from 'react';
import type { TaskLink } from '@arco/shared';
import { GitHubPanel } from '../GitHubPanel';
import { PreviewTab } from '../PreviewTab';
import { TasksPanel } from '../TasksPanel';
import { HistoryTab } from '../HistoryTab';
import { useAppStore } from '../../stores/appStore';
import type { RightTab, Props } from './types';
import { FilesTabBody, type FilesSubTab } from './FilesTab';
import { ActivityTab } from './ActivityTab';
import { ReviewTab } from './ReviewTab';
import { ResearchTab } from './ResearchTab';
import { HandoffsTab } from './HandoffsTab';
import { ConfigTab } from './ConfigTab';
import { PlanTab } from './PlanTab';
import { UsageTab } from './UsageTab';
import { KnowledgeTab } from './KnowledgeTab';
import { LedgerTab } from './LedgerTab';
import { GenesisTab } from './GenesisTab';
import { BakeoffTab } from './BakeoffTab';

// TASKS sits between PLAN and PREVIEW. Visibility is gated below on
// `job.taskChildren` so workflows without Native Task fan-out don't see
// an empty tab — see `visibleTabs` in the component body.
// HISTORY (Phase 8) sits between TASKS and PREVIEW — it's always visible
// because every workflow has narrative events worth scrubbing.
const TABS: { id: RightTab; label: string }[] = [
  { id: 'files', label: 'FILES' },
  { id: 'genesis', label: 'GENESIS' },
  { id: 'activity', label: 'ACTIVITY' },
  { id: 'review', label: 'REVIEW' },
  { id: 'research', label: 'RESEARCH' },
  { id: 'handoffs', label: 'HANDOFFS' },
  { id: 'plan', label: 'PLAN' },
  { id: 'bakeoff', label: 'BAKE-OFF' },
  { id: 'knowledge', label: 'KNOWLEDGE' },
  { id: 'tasks', label: 'TASKS' },
  { id: 'ledger', label: 'LEDGER' },
  { id: 'history', label: 'HISTORY' },
  { id: 'usage', label: 'USAGE' },
  { id: 'preview', label: 'PREVIEW' },
  { id: 'config', label: 'CONFIG' },
  { id: 'github', label: 'GITHUB' },
];

const labelOf = (id: RightTab): string => TABS.find((t) => t.id === id)?.label ?? id.toUpperCase();

// I2 — second-level grouping. The 16-tab flat strip wrapped to 3+ rows and gave
// every surface equal weight; grouping by PURPOSE makes the panel scannable
// without hiding anything (progressive disclosure, no capability disappears).
// The active group is derived from the active tab (no separate persisted group
// state needed — the per-workflow tab persistence already pins you to a group).
// Mapping note: the plan's "Changes / Source / Remote" Workspace items aren't
// separate tabs — they're sub-tabs inside FILES — so Workspace here is FILES +
// GENESIS (the where/scaffold surfaces); TASKS rides with the Agent group;
// LEDGER (project task memory) rides with Memory.
type GroupId = 'workspace' | 'agent' | 'memory' | 'runtime';
const GROUPS: { id: GroupId; label: string; tabs: RightTab[] }[] = [
  { id: 'workspace', label: 'WORKSPACE', tabs: ['files', 'genesis'] },
  { id: 'agent', label: 'AGENT', tabs: ['activity', 'review', 'research', 'handoffs', 'plan', 'bakeoff', 'tasks'] },
  { id: 'memory', label: 'MEMORY', tabs: ['knowledge', 'ledger', 'history', 'usage'] },
  { id: 'runtime', label: 'RUNTIME', tabs: ['preview', 'config', 'github'] },
];
const groupOf = (tab: RightTab): GroupId => GROUPS.find((g) => g.tabs.includes(tab))?.id ?? 'workspace';

// Below this panel width the second-level tab row collapses into a single
// grouped <select> (optgroups preserve the families) so every tab stays
// reachable on a narrow split without a 3-row wrap.
const NARROW_PX = 360;

// Per-workflow tab persistence. Earlier this was a single global key, so
// flipping to PREVIEW on one workflow would drag every other workflow onto
// PREVIEW too (most felt wrong since PREVIEW is empty until a dev server
// binds). Map shape: { [workflowId]: RightTab }. Default for unknown
// workflowIds is 'files' — fresh workflows always land on FILES.
const STORAGE_KEY = 'arco.sidePanelTab.byWorkflow';

function loadTabsByWorkflow(): Record<string, RightTab> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, RightTab>;
  } catch { /* no-op */ }
  return {};
}

function tabForWorkflow(map: Record<string, RightTab>, workflowId: string): RightTab {
  const v = map[workflowId];
  if (v && TABS.some((t) => t.id === v)) return v;
  return 'files';
}

// Phase 4 Lite scaffolding. Content for REVIEW (Phase 5) and HANDOFFS
// (Phase 6) lands in later phases; their tabs render empty-state markers
// now so the shell is complete without shipping half-built features.
export function RightPanel({ job, onUpdatePrimary, onCancelReview, onSend, onGenesisSeedUpdate, onGenesisScaffold, onGenesisCreativeArm, onGenesisAssistRequest, onCancelHandoff, onClearHandoffLock, onAttachPlan, onDetachPlan, onPromoteToCluster, onSpawn, onReview, onSetPreviewPort, onClearPreviewPort, onPreviewCapture, onReviewCapture, onFreshAntigravityCascade, onAttachCodebaseMemory, onDetachCodebaseMemory, onCancelResearch, onResearchFollowUp, onTaskLedgerCreate, onTaskLedgerUpdate, onTaskLedgerDelete, onTaskLedgerList, onTaskWorktreeCreate, onTaskWorktreeRemove, onBakeoffList, onBakeoffStart, onBakeoffPromote, onBakeoffCleanup, mcp }: Props) {
  const cliChanges = useAppStore((s) => s.cliChanges);
  const markPreviewSeen = useAppStore((s) => s.markPreviewSeen);
  const setActiveJob = useAppStore((s) => s.setActiveJob);
  const hasCliChanges = cliChanges.length > 0;
  // I2 — measure the panel width so the second-level tab row can collapse to a
  // grouped <select> on a narrow split. Observe the panel root, not the window:
  // the splitter resizes this independently of the viewport.
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      setNarrow(w < NARROW_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [tabsByWorkflow, setTabsByWorkflow] = useState<Record<string, RightTab>>(loadTabsByWorkflow);
  const tab = tabForWorkflow(tabsByWorkflow, job.id);
  const setTab = useCallback(
    (next: RightTab) => {
      setTabsByWorkflow((prev) => {
        const updated = { ...prev, [job.id]: next };
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch { /* no-op */ }
        return updated;
      });
    },
    [job.id],
  );

  const voicePanel = useVoicePanelRequest((s) => s.request);
  useEffect(() => {
    if (voicePanel?.id === job.id && TABS.some((t) => t.id === voicePanel.panel)) setTab(voicePanel.panel as RightTab);
  }, [voicePanel, job.id, setTab]);

  // §D2 — resolve a ledger task link to a destination. plan → PLAN tab;
  // review → HISTORY tab (where past reviews live); workflow → select that
  // workflow's tab if it still exists; url → new browser tab. Unresolvable
  // targets (e.g. a workflow that's been closed) fall back to a no-op rather
  // than throwing — the chip's tooltip still shows the raw ref.
  const navigateLink = useCallback(
    (link: TaskLink) => {
      switch (link.kind) {
        case 'plan':
          setTab('plan');
          break;
        case 'review':
          setTab('history');
          break;
        case 'workflow':
          if (useAppStore.getState().jobs[link.ref]) setActiveJob(link.ref);
          break;
        case 'url':
          if (/^https?:\/\//i.test(link.ref)) window.open(link.ref, '_blank', 'noopener,noreferrer');
          break;
      }
    },
    [setTab, setActiveJob],
  );

  // H6 — "Reveal in Files" from the Media studio. The modal can't reach this
  // component's local tab state, so App dispatches a window event with the
  // target workflowId; we flip to FILES for our workflow. Bounded + operator-
  // initiated (a button click), and reversible (click another tab).
  useEffect(() => {
    const onReveal = (e: Event) => {
      const detail = (e as CustomEvent<{ workflowId?: string }>).detail;
      if (detail?.workflowId === job.id) setTab('files');
    };
    window.addEventListener('arco:reveal-in-files', onReveal as EventListener);
    return () => window.removeEventListener('arco:reveal-in-files', onReveal as EventListener);
  }, [job.id, setTab]);

  // L3 — explicit "Open in Live Preview" from the machine-wide System modal's
  // Services tab. The modal can't reach this component's local tab state, so it
  // dispatches a window event with the target workflowId; we flip to PREVIEW
  // for our workflow. Manual port binds deliberately don't auto-switch (only a
  // fresh auto-detect does, below), but this explicit operator action should.
  useEffect(() => {
    const onOpenPreview = (e: Event) => {
      const detail = (e as CustomEvent<{ workflowId?: string }>).detail;
      if (detail?.workflowId === job.id) setTab('preview');
    };
    window.addEventListener('arco:open-preview', onOpenPreview as EventListener);
    return () => window.removeEventListener('arco:open-preview', onOpenPreview as EventListener);
  }, [job.id, setTab]);

  // Auto-switch to PREVIEW when an auto-detected dev server lands. Fires
  // once per fresh bind and clears the unread flag so the operator can move
  // off without being yanked back. Manual binds never trigger this (the arm
  // happens upstream in setPreview); hydration replays don't either
  // (freshlyBound=false on the wire).
  useEffect(() => {
    if (!job.previewUnread) return;
    setTab('preview');
    markPreviewSeen(job.id);
  }, [job.id, job.previewUnread, markPreviewSeen]);

  const cwd = job.config.workingDirectory;
  // ARCO_OPS_PLAN.md §D1 — request the cwd's ledger snapshot when the LEDGER
  // tab is opened. The server also pushes one on rehydrate; this covers a
  // fresh open without a reconnect (e.g. a sibling tab created tasks).
  useEffect(() => {
    if (tab === 'ledger' && cwd) onTaskLedgerList?.(job.id);
  }, [tab, cwd, job.id, onTaskLedgerList]);

  // TASKS tab only renders when this workflow has any Task children
  // (in-flight or settled). Filtering out the tab itself rather than just
  // showing an empty body keeps the tab strip compact for the common case
  // (CLI Claude / Codex / non-fan-out Native turns have no children).
  // Phase F — Files-tab sub-tab pick (Files vs Blast Radius). Only shown
  // when codebase memory is attached. Local state, not persisted; flipping
  // back to plain FileExplorer is one click.
  const [filesSubTab, setFilesSubTab] = useState<FilesSubTab>('files');
  const hasTaskChildren = !!(job.taskChildren && Object.keys(job.taskChildren).length > 0);
  // ARCO_OPS_PLAN.md M2/M3 — GENESIS tab visibility.
  //  • M2 from-nothing: this is a genesis workflow still in its scratch ideation dir.
  //  • M3 Creative mode: any real-cwd workflow can ARM Creative mode here, and an
  //    already-armed workflow keeps the tab to edit the alternative seed + scaffold.
  const wfCwd = job.config.workingDirectory ?? '';
  const inScratch = /[\\/]\.arco[\\/]genesis[\\/]/.test(wfCwd);
  const isGenesisScratch = !!job.genesisSeed && inScratch;
  const hasRealCwd = wfCwd.trim().length > 0 && !inScratch;
  // Visible for the from-nothing flow, for any real-cwd workflow (to arm Creative
  // mode), or once Creative mode is armed.
  const isGenesisActive = isGenesisScratch || hasRealCwd || !!job.genesisCreativeArmed;
  const visibleTabs = TABS.filter((t) =>
    (t.id !== 'tasks' || hasTaskChildren) && (t.id !== 'genesis' || isGenesisActive),
  );
  // Default a fresh from-nothing genesis workflow (no explicit tab pick yet) to
  // GENESIS so the operator lands on the seed editor. A real-cwd workflow does NOT
  // auto-open GENESIS (the operator opts in by arming). If the persisted tab is one
  // that's no longer visible, fall through to FILES so the body never renders empty.
  const effectiveTab: RightTab =
    isGenesisScratch && !tabsByWorkflow[job.id] ? 'genesis'
    : tab === 'tasks' && !hasTaskChildren ? 'files'
    : tab === 'genesis' && !isGenesisActive ? 'files'
    : tab;

  // I2 — group layout. Build the visible-tab list per group, drop empty groups
  // (defensive — every group keeps at least one always-visible tab today), and
  // derive the active group from the active tab. Switching groups lands on the
  // group's first visible tab; a group carries the CONFIG alert dot so the
  // "CLI changes" signal stays visible even when CONFIG's tab row is hidden.
  const visibleIds = new Set(visibleTabs.map((t) => t.id));
  const visibleGroups = GROUPS
    .map((g) => ({ ...g, tabs: g.tabs.filter((id) => visibleIds.has(id)) }))
    .filter((g) => g.tabs.length > 0);
  const activeGroup = groupOf(effectiveTab);
  const groupHasAlert = (tabs: RightTab[]) => hasCliChanges && tabs.includes('config');
  const activeGroupTabs = visibleGroups.find((g) => g.id === activeGroup)?.tabs ?? [];

  const alertDot = (
    <span
      aria-label="CLI changes detected"
      title="CLI changes detected — open CONFIG"
      style={{
        display: 'inline-block',
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: '#ff4d4d',
        marginLeft: '6px',
        verticalAlign: 'middle',
        boxShadow: '0 0 4px #ff4d4d',
      }}
    />
  );

  return (
    <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Tab header — two levels: group selector + the active group's tabs.
          On a narrow split the second level collapses to a grouped <select>. */}
      <div className="display-font" style={{ flexShrink: 0, borderBottom: '1px solid var(--color-border-hairline)' }}>
        {/* Level 1 — group selector. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px', padding: '2px 2px 0' }}>
          {visibleGroups.map((g) => {
            const active = g.id === activeGroup;
            return (
              <button
                key={g.id}
                onClick={() => { if (!active) setTab(g.tabs[0]); }}
                data-help={`rightpanel.group.${g.id}`}
                style={{
                  flex: '0 0 auto',
                  padding: '5px 12px',
                  background: active ? 'var(--color-accent-primary-a08)' : 'transparent',
                  border: 'none',
                  borderBottom: active ? '2px solid var(--color-accent-primary)' : '2px solid transparent',
                  color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                  cursor: 'pointer',
                  fontSize: '10px',
                  letterSpacing: '2px',
                  fontFamily: 'var(--font-display)',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {g.label}
                {!active && groupHasAlert(g.tabs) && alertDot}
              </button>
            );
          })}
        </div>

        {/* Level 2 — tabs within the active group. */}
        {narrow ? (
          <div style={{ padding: '4px' }}>
            <select
              value={effectiveTab}
              onChange={(e) => setTab(e.target.value as RightTab)}
              data-help={`rightpanel.tab.${effectiveTab}`}
              style={{
                width: '100%',
                background: 'var(--color-bg-panel)',
                color: 'var(--color-accent-primary)',
                border: '1px solid var(--color-border-hairline)',
                borderRadius: '3px',
                padding: '4px 6px',
                fontSize: '10px',
                letterSpacing: '1.5px',
                fontFamily: 'var(--font-display)',
              }}
            >
              {visibleGroups.map((g) => (
                <optgroup key={g.id} label={g.label}>
                  {g.tabs.map((id) => (
                    <option key={id} value={id}>
                      {labelOf(id)}{id === 'config' && hasCliChanges ? ' ●' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px', padding: '0 2px 2px' }}>
            {activeGroupTabs.map((id) => {
              const active = effectiveTab === id;
              const showDot = id === 'config' && hasCliChanges;
              return (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  data-help={`rightpanel.tab.${id}`}
                  style={{
                    flex: '0 0 auto',
                    padding: '5px 10px',
                    background: active ? 'var(--color-accent-primary-a08)' : 'transparent',
                    border: 'none',
                    borderBottom: active ? '2px solid var(--color-accent-primary)' : '2px solid transparent',
                    color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                    cursor: 'pointer',
                    fontSize: '10px',
                    letterSpacing: '1.5px',
                    fontFamily: 'var(--font-display)',
                    position: 'relative',
                  }}
                >
                  {labelOf(id)}
                  {showDot && alertDot}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Tab body */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {effectiveTab === 'files' && (
          <FilesTabBody
            job={job}
            cwd={cwd}
            subTab={filesSubTab}
            onSubTab={setFilesSubTab}
          />
        )}
        {effectiveTab === 'activity' && <ActivityTab job={job} />}
        {effectiveTab === 'genesis' && <GenesisTab job={job} onSeedUpdate={onGenesisSeedUpdate} onScaffold={onGenesisScaffold} onCreativeArm={onGenesisCreativeArm} onAssistRequest={onGenesisAssistRequest} />}
        {effectiveTab === 'review' && <ReviewTab job={job} onCancelReview={onCancelReview} onSpawn={onSpawn} onSend={onSend} />}
        {effectiveTab === 'research' && <ResearchTab job={job} onCancelResearch={onCancelResearch} onResearchFollowUp={onResearchFollowUp} />}
        {effectiveTab === 'handoffs' && <HandoffsTab job={job} onCancelHandoff={onCancelHandoff} onClearHandoffLock={onClearHandoffLock} />}
        {effectiveTab === 'plan' && <PlanTab job={job} onAttach={onAttachPlan} onDetach={onDetachPlan} onPromoteToCluster={onPromoteToCluster} onSpawn={onSpawn} onReview={onReview} />}
        {effectiveTab === 'bakeoff' && (
          <BakeoffTab
            job={job}
            onList={onBakeoffList}
            onStart={onBakeoffStart}
            onPromote={onBakeoffPromote}
            onCleanup={onBakeoffCleanup}
          />
        )}
        {effectiveTab === 'knowledge' && <KnowledgeTab job={job} />}
        {effectiveTab === 'tasks' && hasTaskChildren && <TasksPanel job={job} />}
        {effectiveTab === 'ledger' && (
          <LedgerTab
            job={job}
            onCreate={onTaskLedgerCreate}
            onUpdate={onTaskLedgerUpdate}
            onDelete={onTaskLedgerDelete}
            onWorktreeCreate={onTaskWorktreeCreate}
            onWorktreeRemove={onTaskWorktreeRemove}
            onNavigate={navigateLink}
          />
        )}
        {effectiveTab === 'history' && <HistoryTab job={job} />}
        {effectiveTab === 'usage' && <UsageTab job={job} />}
        {/* SERVICES is MACHINE-WIDE (not workflow-scoped) — it takes no
            workflow props. Per-cwd grouping is L3. */}
        {effectiveTab === 'preview' && <PreviewTab job={job} onSetPort={onSetPreviewPort} onClear={onClearPreviewPort} onCapture={onPreviewCapture} onReviewCapture={onReviewCapture} />}
        {effectiveTab === 'config' && (
          <ConfigTab
            job={job}
            onUpdatePrimary={onUpdatePrimary}
            onFreshAntigravityCascade={onFreshAntigravityCascade}
            onAttachCodebaseMemory={onAttachCodebaseMemory}
            onDetachCodebaseMemory={onDetachCodebaseMemory}
            mcp={mcp}
          />
        )}
        {effectiveTab === 'github' && <GitHubPanel initialCwd={cwd} />}
      </div>
    </div>
  );
}
