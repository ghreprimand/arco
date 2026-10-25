import { useEffect, useRef, useState } from 'react';
import { ChatPanel } from './ChatPanel';
import { TerminalInput } from './TerminalInput';
import { RightPanel } from './RightPanel';
import { PlanCandidateBanner } from './PlanCandidateBanner';
import { RuntimeStateBanner } from './RuntimeStateBanner';
import { NorthStarBar } from './NorthStarBar';
import { Panel } from './primitives/Panel';
import { useAppStore } from '../stores/appStore';
import type { JobState } from '../stores/appStore';
import type { ProviderName, ModelName, EffortLevel, WorkflowConfig, ReviewContextRef, PreviewCaptureKind, PreviewViewport, ArcoSkillRef, BakeoffAttemptSpec } from '@arco/shared';
import type { McpSenders } from './RightPanel/McpRegistrySection';
import type { TaskLedgerPatch } from './RightPanel/types';

interface Props {
  job: JobState;
  onSend: (content: string, attachments?: string[], kind?: 'steer' | 'follow-up', primitive?: 'docs' | 'git', pickedSkills?: Array<{ scope: 'project' | 'global'; slug: string }>) => boolean | void;
  onCancel: () => void;
  onCompact?: () => void;
  onFold?: (engine?: 'server') => void;
  onSetToolPosture?: (posture: 'full' | 'coding' | 'chat' | 'review') => void;
  onSetProjectTrust?: (cwd: string, decision: 'always' | 'never') => void;
  onCancelQueued: (clientMessageId: string) => void;
  onUpload: (file: File) => Promise<{ fileId: string; filename: string; path: string } | null>;
  onReview?: (
    reviewer: { provider: ProviderName; model: ModelName; effort: EffortLevel },
    contextRef: ReviewContextRef,
    includeGitDiff: boolean,
  ) => void;
  onCancelReview?: (reviewId: string) => void;
  onCancelHandoff?: (handoffId: string) => void;
  onClearHandoffLock?: (cwd: string, workflowId: string, handoffId?: string) => void;
  onHandoff?: (
    mode: 'fresh-summarizer' | 'original-worker' | 'fresh-agent',
    newPrimary?: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string },
    // WP2 — summarizer that writes the handoff (fresh-summarizer mode).
    summarizer?: { provider: ProviderName; model: ModelName; effort: EffortLevel },
  ) => void;
  onSpawn?: (newConfig: WorkflowConfig, newDirection: string, includePlan: boolean) => void;
  onUpdatePrimary?: (update: { model?: ModelName; effort?: EffortLevel; autoHandoff?: { enabled: boolean; warnAt: number; autoAt: number; mode?: 'original-worker' | 'fresh-summarizer'; summarizer?: { provider: ProviderName; model?: ModelName; effort?: EffortLevel } }; autoFold?: { enabled: boolean; foldAt: number; tailBudget?: number }; codexTransport?: 'exec' | 'appserver'; codexContextPolicy?: 'max' | 'standard'; claudeTransport?: 'cli' | 'native'; ultracode?: boolean; webSearchMaxUses?: number; zaiTransport?: 'native' | 'appserver'; claudeNativeCompact?: boolean; claudeNativeForceInterleavedThinkingBeta?: boolean; claudeNativeThinkingDisplay?: 'omitted' | 'summarized' | 'updates'; nativeCompactAutoContinue?: boolean; efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive'; efficiencyFactForce?: 'on' | 'off'; efficiencyConfigProtection?: 'on' | 'off'; efficiencySandbox?: 'off' | 'on'; outputStyle?: 'normal' | 'lite' | 'terse'; goalRun?: { enabled: boolean; total?: number; tokenBudget?: number }; goal?: string; pinnedSkills?: ArcoSkillRef[]; ollamaParams?: Record<string, unknown> }) => void;
  onLoadEarlier?: () => void;
  onRecalibrate?: () => void;
  onFreshAntigravityCascade?: () => void;
  onAttachPlan?: (planId: string) => void;
  onDetachPlan?: () => void;
  // Operator-chosen shortcut from the PlanCandidateBanner: when the active
  // workflow is a cluster member, the banner offers ATTACH TO CLUSTER in
  // addition to the per-worker attach. App.tsx resolves the clusterId and
  // wires this to setClusterPlan.
  onAttachPlanToCluster?: (body: string) => void;
  // BACK TO CLUSTER button in the composer's status row, visible only when
  // the active workflow is a cluster member. Click activates the cluster
  // tab. App.tsx wires it to setActiveCluster.
  onBackToCluster?: () => void;
  // Phase 2.6 — operator clicked PROMOTE TO CLUSTER inside the per-workflow
  // PLAN tab. Only relevant when this workflow is a cluster member. The
  // caller resolves the clusterId from the store; this callback receives
  // the plan body and pipes it through cluster_plan_set.
  onPromoteToCluster?: (body: string) => void;
  onSetPreviewPort?: (port: number, framework?: string) => void;
  onClearPreviewPort?: () => void;
  onPreviewCapture?: (captures?: PreviewCaptureKind[], viewport?: PreviewViewport) => void;
  onReviewCapture?: (reportName: string) => void;
  onArmPlanMode?: () => void;
  // EFFICIENCY_PLAN.md Phase F — codebase-memory toggle. Routed App →
  // WorkflowView → RightPanel → ConfigTab → CodebaseMemorySection.
  onAttachCodebaseMemory?: (workflowId: string, indexPath?: string) => void;
  onDetachCodebaseMemory?: (workflowId: string) => void;
  onTranscriptSend?: (toWorkflowId: string, content: string) => void;
  // WORKBENCH_EXPANSION_PLAN.md §B2 — Deep Research dispatch + follow-up +
  // cancel. App wires these off requestResearch / cancelResearch / createWorkflow.
  onResearch?: (
    researcher: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string },
    topic: string,
    maxRounds: number,
    spawnConfig?: WorkflowConfig,
  ) => void;
  onCancelResearch?: (researchId: string) => void;
  onResearchFollowUp?: (seedArtifactName: string, followUp: string) => void;
  onTaskLedgerCreate?: (workflowId: string, title: string, notes?: string) => void;
  onTaskLedgerUpdate?: (
    workflowId: string,
    id: string,
    patch: TaskLedgerPatch,
  ) => void;
  onTaskLedgerDelete?: (workflowId: string, id: string) => void;
  onTaskLedgerList?: (workflowId: string) => void;
  onTaskWorktreeCreate?: (workflowId: string, id: string) => void;
  onTaskWorktreeRemove?: (workflowId: string, id: string) => void;
  onBakeoffList?: (workflowId: string) => void;
  onBakeoffStart?: (workflowId: string, prompt: string, attempts: BakeoffAttemptSpec[], name?: string) => void;
  onBakeoffPromote?: (workflowId: string, bakeoffId: string, attemptId: string) => void;
  onBakeoffCleanup?: (workflowId: string, bakeoffId: string, attemptIds: string[]) => void;
  onGenesisSeedUpdate?: (workflowId: string, seed: import('@arco/shared').GenesisSeed) => void;
  onGenesisScaffold?: (workflowId: string, root?: string, github?: import('@arco/shared').GenesisGithubParams) => void;
  onGenesisCreativeArm?: (workflowId: string, disarm?: boolean) => void;
  onGenesisAssistRequest?: (workflowId: string, requestId: string, field: import('@arco/shared').GenesisAssistField, intent: import('@arco/shared').GenesisAssistIntent, seed: import('@arco/shared').GenesisSeed, instruction?: string) => void;
  mcp?: McpSenders;
}

// Phase 4 Lite layout: resizable 2/3 (chat) + 1/3 (tabbed right pane).
// Width is stored as a 0–1 fraction of the container in localStorage so the
// splitter survives reloads. REVIEW/HANDOFFS/SPAWN buttons near the composer
// arrive in Phases 5–7.
const WIDTH_KEY = 'arco.sidePanelWidth';
const MIN_FRACTION = 0.2;
const MAX_FRACTION = 0.55;
const DEFAULT_FRACTION = 0.34;

export function WorkflowView({ job, onSend, onCancel, onCompact, onFold, onSetToolPosture, onSetProjectTrust, onCancelQueued, onUpload, onReview, onCancelReview, onCancelHandoff, onClearHandoffLock, onHandoff, onSpawn, onUpdatePrimary, onLoadEarlier, onRecalibrate, onFreshAntigravityCascade, onAttachPlan, onDetachPlan, onAttachPlanToCluster, onBackToCluster, onPromoteToCluster, onSetPreviewPort, onClearPreviewPort, onPreviewCapture, onReviewCapture, onArmPlanMode, onAttachCodebaseMemory, onDetachCodebaseMemory, onTranscriptSend, onResearch, onCancelResearch, onResearchFollowUp, onTaskLedgerCreate, onTaskLedgerUpdate, onTaskLedgerDelete, onTaskLedgerList, onTaskWorktreeCreate, onTaskWorktreeRemove, onBakeoffList, onBakeoffStart, onBakeoffPromote, onBakeoffCleanup, onGenesisSeedUpdate, onGenesisScaffold, onGenesisCreativeArm, onGenesisAssistRequest, mcp }: Props) {
  // I3 — focus mode hides the right panel (+ splitter), giving the chat the
  // full width. Reversible: toggling off restores the persisted split fraction.
  const focusMode = useAppStore((s) => s.focusMode);
  const [rightFraction, setRightFraction] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(WIDTH_KEY);
      if (raw) {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= MIN_FRACTION && n <= MAX_FRACTION) return n;
      }
    } catch { /* no-op */ }
    return DEFAULT_FRACTION;
  });
  useEffect(() => {
    try { localStorage.setItem(WIDTH_KEY, String(rightFraction)); } catch { /* no-op */ }
  }, [rightFraction]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const frac = (rect.right - e.clientX) / rect.width;
      if (!Number.isFinite(frac)) return;
      const clamped = Math.max(MIN_FRACTION, Math.min(MAX_FRACTION, frac));
      setRightFraction(clamped);
    }
    // Always restore body styles, even if our flag is somehow already cleared.
    // The previous version only reset under `if (draggingRef.current)`, which
    // failed when the drag-end was missed (mouseup outside the window, alt-tab,
    // window blur during drag) — body.style.userSelect stayed stuck on 'none'
    // and the entire chat became uncopyable until reload.
    function endDrag() {
      draggingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
    function onVisibility() {
      if (document.hidden) endDrag();
    }
    // On mount, defensively clear in case a prior instance left styles stuck
    // (e.g. Vite HMR mid-drag, or a previous broken cleanup before this fix).
    if (document.body.style.userSelect === 'none') document.body.style.userSelect = '';
    if (document.body.style.cursor === 'col-resize') document.body.style.cursor = '';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', endDrag);
    // Capture-phase pointerup catches releases other handlers might have
    // stopPropagation'd before bubble reaches us.
    window.addEventListener('pointerup', endDrag, true);
    window.addEventListener('pointercancel', endDrag, true);
    window.addEventListener('blur', endDrag);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', endDrag);
      window.removeEventListener('pointerup', endDrag, true);
      window.removeEventListener('pointercancel', endDrag, true);
      window.removeEventListener('blur', endDrag);
      document.removeEventListener('visibilitychange', onVisibility);
      endDrag();
    };
  }, []);

  const startDrag = () => {
    draggingRef.current = true;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div ref={containerRef} style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
        {/* LEFT — chat + composer. Full width in focus mode. */}
        <div
          style={{
            flex: focusMode ? '1 1 100%' : `1 1 ${(1 - rightFraction) * 100}%`,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            minHeight: 0,
          }}
        >
          {/* `no-frost`: the chat column is a transparent transcript scaffold,
              not a glass content panel. Under frosted-glass mode the generic
              `.arco-panel` backdrop-filter blur would soften the ambient
              shader (e.g. matrix rain) behind the chat — the glyphs read blurry.
              Opting out keeps the rain crisp here (matching the cluster
              transcript, which isn't a Panel at all) while real content panels
              still frost. See matrix.css § frosted opt-out. */}
          <Panel className="no-frost" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <ChatPanel job={job} onCancelQueued={onCancelQueued} onLoadEarlier={onLoadEarlier} />
          </Panel>
          <PlanCandidateBanner job={job} onAttachPlan={onAttachPlan} onAttachToCluster={onAttachPlanToCluster} />
          <RuntimeStateBanner job={job} onCancel={onCancel} />
          <NorthStarBar job={job} onUpdatePrimary={onUpdatePrimary} />
          <TerminalInput
            job={job}
            onSend={onSend}
            onCancel={onCancel}
            onCompact={onCompact}
            onFold={onFold}
            onSetToolPosture={onSetToolPosture}
            onSetProjectTrust={onSetProjectTrust}
            onCancelQueued={onCancelQueued}
            onUpload={onUpload}
            onReview={onReview}
            onHandoff={onHandoff}
            onSpawn={onSpawn}
            onRecalibrate={onRecalibrate}
            onUpdatePrimary={onUpdatePrimary}
            onArmPlanMode={onArmPlanMode}
            onBackToCluster={onBackToCluster}
            onTranscriptSend={onTranscriptSend}
            onResearch={onResearch}
          />
        </div>

        {/* SPLITTER — hidden in focus mode (no right panel to resize). */}
        {!focusMode && (
        <div
          onMouseDown={startDrag}
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize"
          style={{
            flex: '0 0 4px',
            cursor: 'col-resize',
            background: 'var(--color-border-hairline)',
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--color-accent-primary-a20, var(--color-accent-primary-dim))'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--color-border-hairline)'; }}
        />
        )}

        {/* RIGHT — tabbed side panel. Hidden in focus mode. */}
        {!focusMode && (
        <div
          style={{
            flex: `1 1 ${rightFraction * 100}%`,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            minHeight: 0,
          }}
        >
          <RightPanel
            job={job}
            onUpdatePrimary={onUpdatePrimary}
            onCancelReview={onCancelReview}
            onSend={onSend}
            onCancelHandoff={onCancelHandoff}
            onClearHandoffLock={onClearHandoffLock}
            onAttachPlan={onAttachPlan}
            onDetachPlan={onDetachPlan}
            onPromoteToCluster={onPromoteToCluster}
            onSpawn={onSpawn}
            onReview={onReview}
            onSetPreviewPort={onSetPreviewPort}
            onClearPreviewPort={onClearPreviewPort}
            onPreviewCapture={onPreviewCapture}
            onReviewCapture={onReviewCapture}
            onFreshAntigravityCascade={onFreshAntigravityCascade}
            onAttachCodebaseMemory={onAttachCodebaseMemory}
            onDetachCodebaseMemory={onDetachCodebaseMemory}
            onCancelResearch={onCancelResearch}
            onResearchFollowUp={onResearchFollowUp}
            onTaskLedgerCreate={onTaskLedgerCreate}
            onTaskLedgerUpdate={onTaskLedgerUpdate}
            onTaskLedgerDelete={onTaskLedgerDelete}
            onTaskLedgerList={onTaskLedgerList}
            onTaskWorktreeCreate={onTaskWorktreeCreate}
            onTaskWorktreeRemove={onTaskWorktreeRemove}
            onBakeoffList={onBakeoffList}
            onBakeoffStart={onBakeoffStart}
            onBakeoffPromote={onBakeoffPromote}
            onBakeoffCleanup={onBakeoffCleanup}
            onGenesisSeedUpdate={onGenesisSeedUpdate}
            onGenesisScaffold={onGenesisScaffold}
            onGenesisCreativeArm={onGenesisCreativeArm}
            onGenesisAssistRequest={onGenesisAssistRequest}
            mcp={mcp}
          />
        </div>
        )}
      </div>
    </div>
  );
}
