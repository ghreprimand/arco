// docs/PROTOCOL_CLUSTER.md + docs/CLIENT.md - cluster tab.
//
// Body layout: compact MemberCard grid (left) + 4px col-resize splitter +
// single focused MemberPane detail (right) + ClusterRightPanel (Members /
// Mailbox / Activity etc.). The tab has one typing surface: the focused
// member's own composer (the director on open). The composer's TO chip picks
// one or several recipients; several go out as one cluster_broadcast (idle
// members start a fresh turn, busy members enqueue as follow-up, and a toast
// reports the split). NUDGE and the BRIEF choice live in the same composer.
//
// The cluster routing branch in App.tsx is mutually exclusive with the
// per-workflow active job — selecting a workflow tab clears
// activeClusterId. Closing the cluster tab keeps the cluster alive (members
// keep working as plain workflows, peer tools stay registered) until the
// operator clicks × on the tab and confirms tear-down (DELETE
// /api/clusters/:id parity).

import type { SpawnMemberIdentity } from '@arco/shared';
import { useEffect, useRef, useState } from 'react';

const NUDGED_MS = 120_000;
import { buildClusterNudge } from '../utils/clusterNudge';
import { onVoiceDialog } from '../voice/dialogs';
import { useAppStore, type ClusterCardLayout } from '../stores/appStore';
import { MemberPane } from './MemberPane';
import { MemberCard } from './MemberCard';
import { useMessageBoxSize, messageBoxMinHeight } from '../utils/messageBoxSize';
import { findDirector, hasNewReply, initialFocus, latestReplyId, orderMembers } from './clusterSurface.helpers';
import { NeedsYouBadge } from './NeedsYouBadge';
import { ClusterRightPanel } from './ClusterRightPanel';
import { clusterDisplayName } from './TabBar';
import { beginPlanReview } from './terminalInput/planDraft';
import { PublicProjectBox } from './PublicProjectBox';
import { ProjectStateNotice } from './ProjectStateNotice';
import { effectivePublic } from '../utils/publicProject';
import type { ClusterMemberProvider, ProviderName, ModelName, EffortLevel, WorkflowConfig, ReviewContextRef, MemberTier, ClusterEfficiencyLevel, ClusterProgressMode, ClusterTaskBoardMode, LedgerTaskStatus } from '@arco/shared';
import { presetForText } from '@arco/shared';
import type { ClusterDispatcherSettingsPatch, ClusterMemberPrimaryUpdate, ClusterSwarmCreateRequest } from './ClusterRightPanel/types';
import type { McpSenders } from './RightPanel/McpRegistrySection';
import type { UploadResult } from '../utils/uploadAttachment';
import { readRangeFraction, useLayout, writeRangeFraction, type LayoutRange } from '../layout/layoutRange';
import { PanelStrip, SlideOut } from '../layout/SlideOut';

// docs/CLIENT.md - splitter min widths (px). Detail favored - its
// chat surface needs reading width; the grid's cards stay legible at 240.
const MIN_GRID_PX = 240;
const MIN_DETAIL_PX = 360;

const CARD_LAYOUT_OPTIONS: Array<{ id: ClusterCardLayout; label: string; title: string }> = [
  { id: 'auto', label: 'AUTO', title: 'Balanced grid based on member count' },
  { id: 'rows', label: 'ROWS', title: 'Stack member cards top to bottom' },
  { id: 'columns', label: 'COLS', title: 'Arrange member cards side by side' },
  { id: 'grid', label: 'GRID', title: 'Force the balanced grid layout' },
];

// outer splitter between the (grid + detail) trio and the
// ClusterRightPanel. Mirrors WorkflowView.tsx's chat / right-panel splitter
// shape so cluster + workflow surfaces share the same operator gesture.
const RIGHT_PANEL_WIDTH_KEY = 'arco.clusterRightPanelWidth';
const RIGHT_PANEL_MIN_FRACTION = 0.18;
const RIGHT_PANEL_MAX_FRACTION = 0.5;
// 0.28 ≈ the ~320 px the right panel was hard-pinned to before the splitter
// existed (320 / ~1140 typical body width). Defaulting to a fraction keeps
// the first paint stable across window widths.
const RIGHT_PANEL_DEFAULT_FRACTION = 0.28;
// Window-size layout (client/src/layout/layoutRange.ts): start widths in the
// medium and wide ranges until the operator drags a splitter there. Each
// range keeps its own dragged position.
const MEDIUM_RIGHT_PANEL_PX = 320;
const GRID_SPLIT_KEY = 'arco.clusterGridSplit';
const GRID_SPLIT_STORE_DEFAULT = 0.35;
const GRID_PX: Partial<Record<LayoutRange, number>> = { medium: 250, wide: 380 };
const RIGHT_STRIP = [
  { id: 'board', label: 'BOARD' },
  { id: 'plan', label: 'PLAN' },
  { id: 'files', label: 'FILES' },
  { id: 'more', label: 'MORE' },
];

interface Props {
  clusterId: string;
  // Per-member dispatch (threaded through from App.tsx → useWebSocket).
  onSendToMember: (workflowId: string, content: string, attachments?: string[], kind?: 'steer' | 'follow-up' | 'interrupt', primitive?: 'docs' | 'git' | 'plan-review', pickedSkills?: Array<{ scope: 'project' | 'global' | 'builtin'; slug: string }>) => boolean | void;
  onCancelMember: (workflowId: string) => void;
  onCancelQueuedForMember: (workflowId: string, clientMessageId: string) => void;
  onUpload: (file: File) => Promise<UploadResult>;
  onLoadEarlier?: (workflowId: string) => void;
  // Cluster-scoped helpers.
  // recipientWorkflowIds is an optional non-empty subset of
  // current members; omitted/undefined means "all members" (preserves the
  // pre-recipient-picker behaviour).
  onBroadcast?: (
    clusterId: string,
    content: string,
    attachments?: string[],
    clientMessageId?: string,
    recipientWorkflowIds?: string[],
  ) => void;
  onSubscribe?: (clusterId: string) => void;
  // Slice 6a — operator renamed the cluster from the Members header.
  onRenameCluster?: (clusterId: string, name: string) => void;
  // Phase 2.5.1 — grow membership from inside the cluster (Members sub-tab).
  // optional `opts` triple overrides provider/model/effort on
  // freshly spawned cluster members. Undefined fields → inherit-from-template.
  onAddFreshWorkers?: (
    clusterId: string,
    count: number,
    opts?: { provider?: ClusterMemberProvider; model?: string; effort?: string; providerAccountRef?: string; accessMode?: import('@arco/shared').ClusterMemberAccessMode; name?: string; role?: string },
  ) => void;
  onAddExistingMember?: (clusterId: string, workflowId: string) => void;
  // Phase 2.6 — shared cluster plan + per-member role hint editors live in
  // ClusterRightPanel. Threaded as App-level senders so this component can
  // stay stateless.
  onSetClusterPlan?: (clusterId: string, body: string) => void;
  onAttachClusterPlan?: (clusterId: string, planId: string) => void;
  onClearClusterPlan?: (clusterId: string) => void;
  onSetMemberRole?: (clusterId: string, workflowId: string, role: string) => void;
  // operator picked a builder-tier from a member row's pill
  // row in ClusterRightPanel. Pure metadata: surfaces in peer_list so the
  // cluster director can match task complexity to builder capability.
  onSetMemberTier?: (clusterId: string, workflowId: string, tier: MemberTier | null) => void;
  // operator edited focus (sub-specialty) on a member row.
  // Empty/null clears. Pure metadata; surfaces in peer_list alongside tier.
  onSetMemberFocus?: (clusterId: string, workflowId: string, focus: string | null) => void;
  // Phase 5 — in-panel detach button on each MemberRow. Existing × on the
  // bottom-row tab does the same thing; this is the explicit affordance
  // for operators driving from the right-panel Members list.
  onDetachMember?: (clusterId: string, workflowId: string) => void;
  // Phase 5 — operator armed/disarmed the idle-nudger from the cluster
  // header chip. Default OFF.
  onToggleIdleNudger?: (clusterId: string, enabled: boolean) => void;
  // Phase 5b — auto-turn-on-mailbox toggle (sits next to the nudger chip).
  onToggleAutoTurn?: (clusterId: string, enabled: boolean) => void;
  // Explicit cluster board mode: none, shared project board, or private
  // cluster board.
  onSetTaskBoardMode?: (clusterId: string, mode: ClusterTaskBoardMode) => void;
  // Back-compat project attach/detach callback.
  onSetTaskBoardAttached?: (clusterId: string, attached: boolean) => void;
  // per-cluster efficiency level (+ optional doctrine addendum).
  onSetAutoCompaction?: (clusterId: string, policy: import('@arco/shared').AutoCompactionPolicy | null) => void;
  onSetEfficiency?: (clusterId: string, level: ClusterEfficiencyLevel, addendum?: string, messageGuard?: import('@arco/shared').ClusterMessageGuard) => void;
  onSetRemote?: (clusterId: string, enabled: boolean) => void;
  onSetGates?: (clusterId: string, enabled: boolean) => void;
  // drag-to-reorder the member grid; full permutation sent.
  onReorderMembers?: (clusterId: string, memberIds: string[]) => void;
  // per-cluster progress-tracking mode (plan / board / both).
  onSetProgress?: (clusterId: string, mode: ClusterProgressMode) => void;
  // Director/workers Stage F — one-shot task dispatcher.
  onDispatchOnce?: (clusterId: string, workflowId: string, maxTasks?: number) => void;
  // Director/workers Stage G — operator-armed cluster task dispatcher daemon.
  onToggleDispatcher?: (clusterId: string, workflowId: string, enabled: boolean) => void;
  onUpdateDispatcherSettings?: (
    clusterId: string,
    workflowId: string,
    settings: ClusterDispatcherSettingsPatch,
  ) => void;
  onUpdateTaskStatus?: (workflowId: string, taskId: string, status: LedgerTaskStatus, boardKey?: string) => void;
  // Director/workers Stage H — task run recovery controls in the BOARD drawer.
  onReassignTask?: (workflowId: string, taskId: string, assigneeWorkflowId: string | null, boardKey?: string) => void;
  onReclaimRun?: (clusterId: string, workflowId: string, taskId: string, runId: string, boardKey?: string) => void;
  onTerminateRun?: (clusterId: string, workflowId: string, taskId: string, runId: string, boardKey?: string) => void;
  // Director/workers Stage I — operator-created swarm graph.
  onCreateSwarm?: (clusterId: string, workflowId: string, request: ClusterSwarmCreateRequest) => void;
  // Slice 6a — primitive callbacks threaded App → ClusterTab → MemberPane.
  // Keyed on the per-member workflowId at the App.tsx level (same shape as
  // the standalone WorkflowView already uses).
  onReviewMember?: (
    workflowId: string,
    reviewer: { provider: ProviderName; model: ModelName; effort: EffortLevel },
    contextRef: ReviewContextRef,
    includeGitDiff: boolean,
  ) => void;
  onCancelMemberReview?: (workflowId: string, reviewId: string) => void;
  onCancelMemberHandoff?: (workflowId: string, handoffId: string) => void;
  onClearMemberHandoffLock?: (cwd: string, workflowId: string, handoffId?: string) => void;
  onHandoffMember?: (
    workflowId: string,
    mode: 'quick' | 'fresh-summarizer' | 'original-worker' | 'fresh-agent',
    newPrimary?: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string },
    // WP2 — summarizer that writes the handoff (fresh-summarizer mode).
    summarizer?: { provider: ProviderName; model: ModelName; effort: EffortLevel },
  ) => void;
  onSpawnMember?: (
    workflowId: string,
    newConfig: WorkflowConfig,
    newDirection: string,
    includePlan: boolean,
    joinClusterId?: string,
    memberIdentity?: SpawnMemberIdentity,
  ) => void;
  onCompactMember?: (workflowId: string) => void;
  onRecalibrateMember?: (workflowId: string) => void;
  onUpdateMemberPrimary?: (workflowId: string, update: ClusterMemberPrimaryUpdate) => void;
  onAttachCodebaseMemory?: (workflowId: string, indexPath?: string) => void;
  onDetachCodebaseMemory?: (workflowId: string) => void;
  mcp?: McpSenders;
  onArmPlanModeMember?: (workflowId: string) => void;
  // cluster PLAN tab pills (SPAWN PHASE + REVIEW PHASE /
  // VERIFY PHASE / REVIEW PLAN / VERIFY WORK / CUSTOM REVIEW). Reuse the
  // existing per-member primitives at App.tsx — REVIEW rides on the picked
  // member's wfid; SPAWN PHASE rides on the cluster's first member as the
  // parent (cluster's template).
  onSpawnFromCluster?: (
    sourceWorkflowId: string,
    newConfig: WorkflowConfig,
    newDirection: string,
    includePlan: boolean,
    joinClusterId: string,
    memberIdentity?: SpawnMemberIdentity,
  ) => void;
  // Operator-driven cluster-routed review — picker in ReviewDialog (cluster
  // context). Dispatches a review task as a peer message so the chosen
  // member does the work as a normal visible turn.
  onReviewViaMember?: (
    targetWorkflowId: string,
    reviewerWorkflowId: string,
    contextRef: ReviewContextRef,
    includeGitDiff: boolean,
  ) => void;
  onAttachPlanToMember?: (workflowId: string, planId: string) => void;
  // Operator-driven transcript-send, fired from the focused member's composer.
  onTranscriptSendFromMember?: (
    clusterId: string,
    fromWorkflowId: string,
    toWorkflowId: string,
    content: string,
  ) => void;
}

interface Toast {
  id: string;
  text: string;
  // Auto-dismiss timestamp (epoch ms).
  expiresAt: number;
}

export function ClusterTab({
  clusterId,
  onSendToMember,
  onCancelMember,
  onCancelQueuedForMember,
  onUpload,
  onLoadEarlier,
  onBroadcast,
  onSubscribe,
  onRenameCluster,
  onAddFreshWorkers,
  onAddExistingMember,
  onSetClusterPlan,
  onAttachClusterPlan,
  onClearClusterPlan,
  onSetMemberRole,
  onSetMemberTier,
  onSetMemberFocus,
  onDetachMember,
  onToggleIdleNudger,
  onToggleAutoTurn,
  onSetTaskBoardMode,
  onSetTaskBoardAttached,
  onSetEfficiency,
  onSetAutoCompaction,
  onSetRemote,
  onSetGates,
  onReorderMembers,
  onSetProgress,
  onDispatchOnce,
  onToggleDispatcher,
  onUpdateDispatcherSettings,
  onUpdateTaskStatus,
  onReassignTask,
  onReclaimRun,
  onTerminateRun,
  onCreateSwarm,
  onReviewMember,
  onCancelMemberReview,
  onCancelMemberHandoff,
  onClearMemberHandoffLock,
  onHandoffMember,
  onSpawnMember,
  onCompactMember,
  onRecalibrateMember,
  onUpdateMemberPrimary,
  onArmPlanModeMember,
  onSpawnFromCluster,
  onTranscriptSendFromMember,
  onReviewViaMember,
  onAttachPlanToMember,
  onAttachCodebaseMemory,
  onDetachCodebaseMemory,
  mcp,
}: Props) {
  const boxSize = useMessageBoxSize();
  const cluster = useAppStore((s) => s.clusters[clusterId]);
  const jobs = useAppStore((s) => s.jobs);
  const setActiveJob = useAppStore((s) => s.setActiveJob);
  // Slice 6a — focused-member highlight. Lifted to the store so the
  // bottom-row TabBar member tab and the MemberPane visual highlight stay
  // in sync. Default to first member when not yet set; setClusterState's
  // reducer keeps it valid across membership changes.
  const focusedMemberId = useAppStore((s) => s.clusterFocusedMember[clusterId]);
  const setClusterFocusedMember = useAppStore((s) => s.setClusterFocusedMember);
  const gridSplit = useAppStore((s) => s.clusterGridSplit);
  const setClusterGridSplit = useAppStore((s) => s.setClusterGridSplit);
  const cardLayout = useAppStore((s) => s.clusterCardLayout);
  const setClusterCardLayout = useAppStore((s) => s.setClusterCardLayout);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const { range: widthRange } = useLayout();
  const widthRangeRef = useRef(widthRange);
  widthRangeRef.current = widthRange;
  const compactLayout = widthRange !== 'standard';
  // Saved grid split per range (Standard uses the store value as before).
  const [gridByRange, setGridByRange] = useState<Partial<Record<LayoutRange, number | null>>>({});
  const gridSavedForRange = (r: LayoutRange): number | null => {
    if (r === 'standard') return gridSplit;
    if (r in gridByRange) return gridByRange[r] ?? null;
    const own = readRangeFraction(GRID_SPLIT_KEY, r, 0.05, 0.95);
    if (own !== null) return own;
    // The wide range starts from a split saved before ranges existed.
    return r === 'wide' && gridSplit !== GRID_SPLIT_STORE_DEFAULT ? gridSplit : null;
  };
  const [memberListOpen, setMemberListOpen] = useState(false);
  const [rightSlide, setRightSlide] = useState<string | null>(null);
  const [rightTabRequest, setRightTabRequest] = useState<{ tab: string; n: number } | null>(null);
  const [planHintMore, setPlanHintMore] = useState(false);
  useEffect(() => { if (widthRange !== 'narrow') { setMemberListOpen(false); setRightSlide(null); } }, [widthRange]);
  // docs/CLIENT.md - splitter drag, mirrors WorkflowView.tsx
  // pattern (mouse + capture-phase pointerup + pointercancel + blur +
  // visibilitychange cleanup; defensive body-style restore on mount).
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  // Buffer the live drag value so we don't fire setClusterGridSplit on
  // every mousemove (which would persist on every frame). Persist on drag
  // end; render uses the local value while dragging.
  const [liveSplit, setLiveSplit] = useState<number | null>(null);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!draggingRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      const rawFrac = (e.clientX - rect.left) / rect.width;
      const minFrac = MIN_GRID_PX / rect.width;
      const maxFrac = 1 - MIN_DETAIL_PX / rect.width;
      const clamped = Math.max(minFrac, Math.min(maxFrac, rawFrac));
      if (Number.isFinite(clamped)) setLiveSplit(clamped);
    }
    function endDrag() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      // Persist debounced — setLiveSplit may have buffered the latest value;
      // commit it now.
      setLiveSplit((v) => {
        if (v !== null) {
          const r = widthRangeRef.current;
          if (r === 'standard') setClusterGridSplit(v);
          else { writeRangeFraction(GRID_SPLIT_KEY, r, v); setGridByRange((m) => ({ ...m, [r]: v })); }
        }
        return null;
      });
    }
    function onVisibility() {
      if (document.hidden) endDrag();
    }
    if (document.body.style.userSelect === 'none') document.body.style.userSelect = '';
    if (document.body.style.cursor === 'col-resize') document.body.style.cursor = '';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', endDrag);
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
  }, [setClusterGridSplit]);

  const startSplitDrag = () => {
    draggingRef.current = true;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  };

  // outer splitter (trio | ClusterRightPanel). Same shape as
  // WorkflowView's chat/right splitter: persisted fraction, defensive
  // body-style restore, capture-phase pointerup, blur + visibilitychange
  // cleanup. Independent of the inner grid splitter so the operator can
  // resize either boundary without interaction.
  const outerContainerRef = useRef<HTMLDivElement | null>(null);
  const outerDraggingRef = useRef(false);
  // Right panel position per range. null: no position saved for this range;
  // Standard and wide then use the default share, medium a fixed width.
  const [rightByRange, setRightByRange] = useState<Partial<Record<LayoutRange, number | null>>>({});
  const rightSaved = widthRange in rightByRange
    ? rightByRange[widthRange] ?? null
    : readRangeFraction(RIGHT_PANEL_WIDTH_KEY, widthRange, RIGHT_PANEL_MIN_FRACTION, RIGHT_PANEL_MAX_FRACTION);
  const rightFixedPx = rightSaved === null && widthRange === 'medium' ? MEDIUM_RIGHT_PANEL_PX : null;
  const rightPanelFraction = rightSaved ?? RIGHT_PANEL_DEFAULT_FRACTION;
  // Only reads refs and stable setters, so the drag effect below may keep it.
  const setRightPanelFraction = (value: number) => {
    const r = widthRangeRef.current;
    writeRangeFraction(RIGHT_PANEL_WIDTH_KEY, r, value);
    setRightByRange((m) => ({ ...m, [r]: value }));
  };
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!outerDraggingRef.current || !outerContainerRef.current) return;
      const rect = outerContainerRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      const frac = (rect.right - e.clientX) / rect.width;
      if (!Number.isFinite(frac)) return;
      const clamped = Math.max(RIGHT_PANEL_MIN_FRACTION, Math.min(RIGHT_PANEL_MAX_FRACTION, frac));
      setRightPanelFraction(clamped);
    }
    function endDrag() {
      outerDraggingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
    function onVisibility() {
      if (document.hidden) endDrag();
    }
    // Defensive on-mount restore — see WorkflowView for the same fix
    // around HMR / blur-mid-drag races leaving body styles stuck.
    if (document.body.style.userSelect === 'none') document.body.style.userSelect = '';
    if (document.body.style.cursor === 'col-resize') document.body.style.cursor = '';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', endDrag);
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
  const startOuterSplitDrag = () => {
    outerDraggingRef.current = true;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  };
  // Map clientMessageId → "expected dispatch" so when cluster_broadcast_dispatched
  // arrives we can build a precise toast. We listen for it via the store
  // through a ref (the dispatcher in useWebSocket doesn't dispatch a store
  // action, so we set up a bus here). Simplest path: peek the WebSocket
  // by calling onBroadcast and synthesizing the toast based on cluster
  // member states at submit time — busy at submit → queued; idle → idle.
  // The server's reply is authoritative for `failed`, but for v1 we trust
  // local state; mismatches will land as system_notices on individual
  // members anyway.

  useEffect(() => {
    onSubscribe?.(clusterId);
  }, [clusterId, onSubscribe]);

  // First-render default: the director when there is one, else the first
  // member. A still-valid focus is kept, and focus is never moved after open.
  useEffect(() => {
    if (!cluster || cluster.members.length === 0) return;
    const target = initialFocus(cluster.members, focusedMemberId);
    if (target && target !== focusedMemberId) setClusterFocusedMember(clusterId, target);
  }, [cluster, clusterId, focusedMemberId, setClusterFocusedMember]);

  const [planHintHidden, setPlanHintHidden] = useState<boolean>(() => {
    try { return localStorage.getItem(`arco.clusterPlanHint.${clusterId}`) === '1'; } catch { return false; }
  });
  const [planTabRequest, setPlanTabRequest] = useState(0);
  const [membersTabRequest, setMembersTabRequest] = useState(0);

  // Director card: quiet NEW REPLY mark. `seenReply` holds the latest reply
  // id the operator has already looked at (seeded on first sight so replies
  // that predate this view do not light it); focusing the director clears it.
  const directorMember = cluster ? findDirector(cluster.members) : undefined;
  const directorLatestReply = latestReplyId(directorMember ? jobs[directorMember.workflowId]?.messages : undefined);
  const directorFocused = !!directorMember && focusedMemberId === directorMember.workflowId;
  const [seenReply, setSeenReply] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (seenReply === undefined || directorFocused) setSeenReply(directorLatestReply);
  }, [seenReply, directorFocused, directorLatestReply]);
  const directorNewReply = !!directorMember && hasNewReply(directorLatestReply, seenReply, directorFocused);

  // drag-to-reorder: dragId is the picked-up member, dragOverId
  // the current drop target (dashed outline). Drop sends the full permutation;
  // the server validates + rebroadcasts cluster_state, which re-renders the
  // grid in the new order (no optimistic reorder — the round-trip is fast and
  // a stale drag must not fake success).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // The director is listed first until the operator drags a card; the flag is
  // remembered per cluster in this browser.
  const reorderedKey = `arco.clusterReordered.${clusterId}`;
  const [operatorReordered, setOperatorReordered] = useState<boolean>(() => {
    try { return localStorage.getItem(reorderedKey) === '1'; } catch { return false; }
  });
  const dropMember = (targetId: string) => {
    if (!cluster || !onReorderMembers || !dragId || dragId === targetId) return;
    try { localStorage.setItem(reorderedKey, '1'); } catch { /* no-op */ }
    setOperatorReordered(true);
    const ids = orderMembers(cluster.members, operatorReordered).map((m) => m.workflowId);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    onReorderMembers(clusterId, ids);
  };

  // Drop expired toasts on a 500ms interval. Cheap; only runs while toasts
  // exist.
  useEffect(() => {
    if (toasts.length === 0) return;
    const t = setInterval(() => {
      const now = Date.now();
      setToasts((prev) => prev.filter((tt) => tt.expiresAt > now));
    }, 500);
    return () => clearInterval(t);
  }, [toasts.length]);

  if (!cluster) {
    return (
      <div
        className="display-font"
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-fg-muted)',
          fontSize: '12px',
          letterSpacing: '1px',
        }}
      >
        LOADING CLUSTER {clusterId.slice(0, 8)}&hellip;
      </div>
    );
  }

  const pendingByMember = cluster.members.map((member) => {
    const depth = cluster.mailboxDepth?.[member.workflowId];
    return Number.isSafeInteger(depth) && depth > 0 ? depth : 0;
  });
  const pendingTotal = pendingByMember.reduce((sum, depth) => sum + depth, 0);
  const pendingMembers = pendingByMember.filter((depth) => depth > 0).length;
  const headerPill: React.CSSProperties = {
    flex: '0 0 auto', padding: '2px 7px', background: 'transparent', color: 'var(--color-fg-muted)',
    border: '1px solid var(--color-border-hairline)', cursor: 'pointer', fontSize: '9px', letterSpacing: '1px',
  };
  const nudgeLabel = pendingTotal > 0
    ? `NUDGE: ${pendingTotal} pending ${pendingTotal === 1 ? 'message' : 'messages'} across ${pendingMembers} ${pendingMembers === 1 ? 'member' : 'members'}`
    : 'NUDGE: no pending messages';

  // Canned nudge: uses the per-member composer path so active members
  // receive steer input at their next supported delivery point.
  // Idle members start a normal turn, with the existing wake-up prompt, so
  // the operator doesn't have to type "check your mailbox" every time.
  // Recipients are picked via a dedicated modal (no recipient = no-op);
  // we deliberately don't share the BROADCAST chip-picker state here
  // because that picker defaults to all-selected, which would silently
  // nudge members that don't have pending work and waste their turns.
  //
  // NUDGE modal state. null when closed; Set of selected member wfids when
  // open. Default-empty (operator must explicitly pick) so a stray click
  // never nudges everyone.
  const [nudgeSelection, setNudgeSelection] = useState<Set<string> | null>(null);

  // Recipients chooser: the composer's TO chip. null means the member in view
  // (the default); otherwise the picked member ids. Sending to several uses
  // the unchanged cluster_broadcast path. Busy members receive the message as
  // a follow-up, exactly as before.
  const [composerRecipients, setComposerRecipients] = useState<string[] | null>(null);
  const [recipientDraft, setRecipientDraft] = useState<Set<string> | null>(null);
  useEffect(() => { setComposerRecipients(null); }, [focusedMemberId, clusterId]);
  const openRecipients = () => {
    const current = composerRecipients ?? (focusedMemberId ? [focusedMemberId] : cluster.members.slice(0, 1).map((m) => m.workflowId));
    setRecipientDraft(new Set(current));
  };
  const closeRecipients = () => setRecipientDraft(null);
  const toggleRecipient = (wfid: string) => setRecipientDraft((prev) => {
    if (!prev) return prev;
    const next = new Set(prev);
    if (next.has(wfid)) next.delete(wfid); else next.add(wfid);
    return next;
  });
  const confirmRecipients = () => {
    if (!recipientDraft || recipientDraft.size === 0) return;
    const ids = cluster.members.map((m) => m.workflowId).filter((id) => recipientDraft.has(id));
    const viewId = focusedMemberId ?? cluster.members[0]?.workflowId;
    setComposerRecipients(ids.length === 1 && ids[0] === viewId ? null : ids);
    setRecipientDraft(null);
  };
  const recipientLabel = (() => {
    if (!composerRecipients) {
      const view = cluster.members.find((m) => m.workflowId === focusedMemberId) ?? cluster.members[0];
      return (view?.displayName ?? 'MEMBER').toUpperCase();
    }
    if (composerRecipients.length === cluster.members.length && cluster.members.length > 1) return 'EVERYONE';
    if (composerRecipients.length === 1) return (cluster.members.find((m) => m.workflowId === composerRecipients[0])?.displayName ?? 'MEMBER').toUpperCase();
    return `${composerRecipients.length} MEMBERS`;
  })();
  const composerPlaceholder = (() => {
    const targetId = composerRecipients && composerRecipients.length === 1 ? composerRecipients[0] : composerRecipients ? null : (focusedMemberId ?? cluster.members[0]?.workflowId);
    if (!targetId) return `Message ${recipientLabel === 'EVERYONE' ? 'everyone' : recipientLabel.toLowerCase()}...`;
    if (directorMember && targetId === directorMember.workflowId) return 'Message the director, your main contact...';
    return `Message ${cluster.members.find((m) => m.workflowId === targetId)?.displayName ?? 'the member'}...`;
  })();
  // Operator-picked skills go with a message to one member; a message to
  // several members is sent without them.
  const sendFromComposer = (viewId: string, content: string, attachments?: string[], kind?: 'steer' | 'follow-up' | 'interrupt', primitive?: 'docs' | 'git' | 'plan-review', pickedSkills?: Array<{ scope: 'project' | 'global' | 'builtin'; slug: string }>) => {
    const allIds = cluster.members.map((m) => m.workflowId);
    const sub = composerRecipients ? allIds.filter((id) => composerRecipients.includes(id)) : [];
    if (sub.length === 0 || !onBroadcast) return onSendToMember(viewId, content, attachments, kind, primitive, pickedSkills);
    const recipientList = sub.length < allIds.length ? sub : undefined;
    const clientMessageId = `cb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const targetSet = new Set(sub);
    const targetMembers = cluster.members.filter((m) => targetSet.has(m.workflowId));
    const queued = targetMembers.filter((m) => m.status !== 'idle').length;
    onBroadcast(clusterId, content, attachments, clientMessageId, recipientList);
    const total = cluster.members.length;
    const scopeLabel = recipientList ? `${sub.length} of ${total}` : `all ${total}`;
    const toastText = queued === 0
      ? `Sent to ${scopeLabel} members`
      : `Queued for ${queued} of ${targetMembers.length}${recipientList ? ` (of ${total})` : ''} members`;
    setToasts((prev) => [...prev, { id: clientMessageId, text: toastText, expiresAt: Date.now() + 4500 }]);
    setComposerRecipients(null);
    return true;
  };

  // Click NUDGE → open modal with default-empty selection. Operator picks
  // explicitly; SEND NUDGE fires with that exact set. Cancel closes without
  // dispatching. Idle+mailbox-depth-positive members are visually flagged
  // ("has mail") so the operator can pick the ones that actually need
  // waking, but no member is auto-checked.
  // Members nudged and not yet started: their mail mark and the composer NUDGE
  // read "Nudged" until the member starts its turn (or two minutes pass).
  const [nudgedAt, setNudgedAt] = useState<Record<string, number>>({});
  const startedKey = cluster.members.map((m) => `${m.workflowId}:${m.status === 'busy' || jobs[m.workflowId]?.busy === true ? 1 : 0}`).join('|');
  useEffect(() => {
    const now = Date.now();
    setNudgedAt((prev) => {
      const next: Record<string, number> = {};
      for (const m of cluster.members) {
        const at = prev[m.workflowId];
        if (at && now - at < NUDGED_MS && !(m.status === 'busy' || jobs[m.workflowId]?.busy === true)) next[m.workflowId] = at;
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [startedKey]);
  useEffect(() => {
    const live = Object.values(nudgedAt);
    if (!live.length) return;
    const timer = setTimeout(() => setNudgedAt((prev) => Object.fromEntries(Object.entries(prev).filter(([, at]) => Date.now() - at < NUDGED_MS))), Math.max(1000, NUDGED_MS - (Date.now() - Math.min(...live)) + 50));
    return () => clearTimeout(timer);
  }, [nudgedAt]);
  const nudgedCount = Object.keys(nudgedAt).length;
  const openNudgeModal = () => {
    setNudgeSelection(new Set());
  };
  const nudgeMembers = (ids: Set<string>, toast = true): number => {
    // Read at click time: the member may have started/settled since the
    // picker opened. Match the composer's busy fallbacks during reconnect.
    const currentJobs = useAppStore.getState().jobs;
    let sent = 0;
    for (const member of cluster.members) {
      if (!ids.has(member.workflowId)) continue;
      const job = currentJobs[member.workflowId];
      const active = member.status === 'busy' || job?.busy === true
        || Object.values(job?.workers ?? {}).some((w) => w.status === 'running' || w.status === 'spawning')
        || (job?.messages.some((m) => m.isStreaming) ?? false);
      const result = onSendToMember(
        member.workflowId,
        buildClusterNudge(cluster.efficiencyLevel, active, member.role),
        undefined,
        'steer',
      );
      if (result !== false) { sent++; setNudgedAt((prev) => ({ ...prev, [member.workflowId]: Date.now() })); }
    }
    if (sent === 0 || !toast) return sent;
    setToasts((prev) => [...prev, {
      id: `nudge-${Date.now()}`,
      text: `Nudged ${sent} member${sent === 1 ? '' : 's'}`,
      expiresAt: Date.now() + 4500,
    }]);
    return sent;
  };
  const confirmNudge = () => {
    if (!nudgeSelection || nudgeSelection.size === 0) return;
    if (nudgeMembers(nudgeSelection) > 0) setNudgeSelection(null);
  };
  const cancelNudge = () => setNudgeSelection(null);
  const toggleNudgeMember = (wfid: string) => {
    setNudgeSelection((prev) => {
      if (!prev) return prev;
      const next = new Set(prev);
      if (next.has(wfid)) next.delete(wfid);
      else next.add(wfid);
      return next;
    });
  };
  // Computer (voice) asks for the nudge picker or the recipient chooser by
  // name; it opens exactly what a click would and sends nothing.
  useEffect(() => onVoiceDialog((r) => {
    if (r.clusterId !== clusterId) return false;
    if (r.name === 'nudge') { openNudgeModal(); return true; }
    if (r.name === 'broadcast') { openRecipients(); return true; }
    return false;
  }), [clusterId]);
  // Esc closes the nudge modal. Listener only attached while open.
  useEffect(() => {
    if (nudgeSelection === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setNudgeSelection(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nudgeSelection]);
  useEffect(() => {
    if (recipientDraft === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setRecipientDraft(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [recipientDraft]);

  return (
    <div
      data-help="cluster.tab"
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div ref={outerContainerRef} style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
        {/* TRIO — grid + inner splitter + detail. Wrapped here so the outer
            splitter sits between this whole block and the ClusterRightPanel
            on the right. */}
        <div
          style={{
            flex: widthRange === 'narrow' || rightFixedPx !== null ? '1 1 0%' : `1 1 ${(1 - rightPanelFraction) * 100}%`,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
          }}
        >
        {/* docs/CLIENT.md - compact MemberCards + splitter + single
            focused MemberPane (detail). The card rail now supports multiple
            orientations: balanced grid, vertical rows, and horizontal cols. */}
        <div
          ref={splitContainerRef}
          // minWidth 0 is load-bearing: without it this box's min-content
          // floor is the widest unbreakable line in the focused MemberPane
          // (e.g. a long nowrap north-star), and the whole trio overflows
          // under the ClusterRightPanel.
          style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', position: 'relative' }}
        >
          {(() => {
            const N = cluster.members.length;
            const balancedCardsPerRow = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(N || 1))));
            const memberCount = Math.max(N, 1);
            const layout = CARD_LAYOUT_OPTIONS.some((o) => o.id === cardLayout) ? cardLayout : 'auto';
            const layoutCss =
              layout === 'rows'
                ? {
                    gridTemplateColumns: 'minmax(0, 1fr)',
                    gridTemplateRows: `repeat(${memberCount}, minmax(120px, 1fr))`,
                    gridAutoRows: 'minmax(120px, 1fr)',
                  }
                : layout === 'columns'
                  ? {
                      gridTemplateColumns: `repeat(${memberCount}, minmax(160px, 1fr))`,
                      gridTemplateRows: 'minmax(120px, 1fr)',
                      gridAutoRows: 'minmax(120px, 1fr)',
                    }
                  : {
                      gridTemplateColumns: `repeat(${balancedCardsPerRow}, minmax(0, 1fr))`,
                      gridAutoRows: 'minmax(120px, 1fr)',
                    };
            // Medium and wide: cards take their own height instead of
            // stretching to fill the column.
            const cardRowsCss = compactLayout
              ? { gridTemplateRows: layout === 'columns' ? 'min-content' : 'none', gridAutoRows: 'min-content', alignContent: 'start' as const }
              : {};
            const savedGrid = gridSavedForRange(widthRange);
            const gridFixedPx = liveSplit === null && savedGrid === null ? GRID_PX[widthRange] ?? null : null;
            const fraction = liveSplit ?? savedGrid ?? GRID_SPLIT_STORE_DEFAULT;
            const cardDensity = widthRange === 'wide' ? 'wide' : compactLayout ? 'compact' : 'standard';
            const focusedMember =
              cluster.members.find((m) => m.workflowId === focusedMemberId) ?? cluster.members[0];
            const focusedJob = focusedMember ? jobs[focusedMember.workflowId] : undefined;

            return (
              <>
                {/* GRID — compact cards */}
                {(() => { const gridColumn = (
                <div
                  data-help="cluster.grid"
                  style={{
                    flex: widthRange === 'narrow' ? 1 : gridFixedPx !== null ? `0 0 ${gridFixedPx}px` : `1 1 ${fraction * 100}%`,
                    minWidth: 0,
                    minHeight: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    // Transparent so the ambient background shader shows
                    // through the gaps around the member cards (each card
                    // carries its own background).
                    background: 'transparent',
                  }}
                >
                  <div
                    className="display-font"
                    style={{
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '6px 8px 0',
                      fontSize: '9px',
                      letterSpacing: '1px',
                      color: 'var(--color-fg-muted)',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span style={{ marginRight: '3px', flexShrink: 0 }}>LAYOUT</span>
                    {CARD_LAYOUT_OPTIONS.map((opt) => {
                      const active = layout === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setClusterCardLayout(opt.id)}
                          title={opt.title}
                          className="display-font"
                          style={{
                            flex: '0 0 auto',
                            padding: '2px 7px',
                            border: active
                              ? '1px solid var(--color-accent-primary)'
                              : '1px solid var(--color-border-hairline)',
                            background: active ? 'var(--color-accent-primary-a08)' : 'transparent',
                            color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                            cursor: 'pointer',
                            fontSize: '9px',
                            letterSpacing: '1px',
                          }}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                    <NeedsYouBadge clusterId={clusterId} />
                  </div>

                  {directorMember && <ProjectStateNotice cwd={jobs[directorMember.workflowId]?.config.workingDirectory ?? ''} skip={directorMember.accessMode === 'isolated'} />}
                  {!cluster.plan && !planHintHidden && (() => {
                    // Medium and wide: one line (DRAFT A PLAN, then MORE for the rest).
                    const short = compactLayout && !planHintMore;
                    return <div data-help="cluster.no-plan-hint" style={{ display: 'flex', flexWrap: short ? 'nowrap' : 'wrap', alignItems: 'center', gap: '7px', padding: '5px 8px', color: 'var(--color-fg-muted)', fontSize: '11px', overflow: short ? 'hidden' : undefined }}>
                    <span style={short ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } : undefined} title={short ? 'A plan keeps every worker on the same list.' : undefined}>{short ? 'No plan yet.' : 'No plan yet: a plan keeps every worker on the same list.'}</span>
                    {!short && !directorMember && <span>Set a director in <button type="button" data-testid="plan-line-members" onClick={() => setMembersTabRequest((value) => value + 1)} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-accent-secondary)', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}>Members</button> to request a draft.</span>}
                    <button type="button" disabled={!directorMember} title={directorMember ? 'Ask the director for a reviewable draft' : 'Set a director in Members first'} onClick={() => {
                      if (!directorMember) return;
                      const id = directorMember.workflowId;
                      const started = beginPlanReview(id, (prompt) => onSendToMember(id, prompt, undefined, undefined, 'plan-review'), '', true, effectivePublic(jobs[id]?.config.workingDirectory ?? ''));
                      if (started) setClusterFocusedMember(clusterId, id);
                      else useAppStore.getState().pushNotification('error', 'The director must be idle and ready before drafting a plan.');
                    }}>DRAFT A PLAN</button>
                    {short && <button type="button" data-help="layout.plan-hint-more" data-testid="plan-hint-more" onClick={() => setPlanHintMore(true)} style={{ flexShrink: 0 }}>MORE ▾</button>}
                    {!short && directorMember && <PublicProjectBox cwd={jobs[directorMember.workflowId]?.config.workingDirectory ?? ''} testId="cluster-public-project" />}
                    {!short && <button type="button" disabled={!onAttachClusterPlan} onClick={() => setPlanTabRequest((value) => value + 1)}>ATTACH EXISTING</button>}
                    {!short && <button type="button" onClick={() => { setPlanHintHidden(true); try { localStorage.setItem(`arco.clusterPlanHint.${clusterId}`, '1'); } catch { /* no-op */ } }}>NOT NOW</button>}
                    {compactLayout && planHintMore && <button type="button" data-help="layout.plan-hint-more" onClick={() => setPlanHintMore(false)}>LESS ▴</button>}
                    </div>;
                  })()}
                  <div
                    style={{
                      flex: 1,
                      minHeight: 0,
                      overflowY: layout === 'columns' ? 'hidden' : 'auto',
                      overflowX: layout === 'columns' ? 'auto' : 'hidden',
                      padding: '8px',
                      display: 'grid',
                      gap: compactLayout ? '6px' : '8px',
                      ...layoutCss,
                      ...cardRowsCss,
                    }}
                  >
                    {orderMembers(cluster.members, operatorReordered).map((m) => (
                      <MemberCard
                        key={m.workflowId}
                        job={jobs[m.workflowId]}
                        displayName={m.displayName}
                        status={m.status}
                        role={m.role}
                        pendingMail={pendingByMember[cluster.members.indexOf(m)]}
                        onNudge={() => nudgeMembers(new Set([m.workflowId]), false)}
                        nudged={nudgedAt[m.workflowId] !== undefined}
                        newReply={directorNewReply && m.workflowId === directorMember?.workflowId}
                        focused={focusedMemberId === m.workflowId}
                        density={cardDensity}
                        onClick={() => { setClusterFocusedMember(clusterId, m.workflowId); setMemberListOpen(false); }}
                        dragOver={dragOverId === m.workflowId && dragId !== null && dragId !== m.workflowId}
                        dragProps={onReorderMembers ? {
                          draggable: true,
                          onDragStart: (e) => {
                            setDragId(m.workflowId);
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', m.workflowId);
                          },
                          onDragOver: (e) => {
                            if (!dragId || dragId === m.workflowId) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            setDragOverId(m.workflowId);
                          },
                          onDragLeave: () => {
                            setDragOverId((cur) => (cur === m.workflowId ? null : cur));
                          },
                          onDrop: (e) => {
                            e.preventDefault();
                            dropMember(m.workflowId);
                            setDragId(null);
                            setDragOverId(null);
                          },
                          onDragEnd: () => {
                            setDragId(null);
                            setDragOverId(null);
                          },
                        } : undefined}
                      />
                    ))}
                  </div>
                </div>
                );
                if (widthRange !== 'narrow') return gridColumn;
                // Narrow: a rail of member initials; the full list opens over the chat.
                return (
                  <>
                    <div data-help="layout.member-rail" data-testid="member-rail" style={{ flex: '0 0 46px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '8px 0', borderRight: '1px solid var(--color-border-hairline)', overflowY: 'auto' }}>
                      <button type="button" data-help="layout.member-list-open" data-testid="member-list-open" onClick={() => setMemberListOpen(true)} title="Show the member list" aria-label="Show the member list" className="display-font" style={{ padding: '2px 6px', cursor: 'pointer', fontSize: '12px' }}>☰</button>
                      {orderMembers(cluster.members, operatorReordered).map((m) => {
                        const focused = focusedMemberId === m.workflowId;
                        const mail = pendingByMember[cluster.members.indexOf(m)] ?? 0;
                        const busy = m.status === 'busy';
                        return (
                          <button
                            key={m.workflowId}
                            type="button"
                            onClick={() => setClusterFocusedMember(clusterId, m.workflowId)}
                            title={`${m.displayName}${m.role ? ` (${m.role})` : ''}: ${busy ? 'working' : 'idle'}${mail ? `, ${mail} waiting` : ''}`}
                            aria-label={`${m.displayName}${busy ? ', working' : ''}${mail ? `, ${mail} messages waiting` : ''}`}
                            aria-pressed={focused}
                            className="display-font"
                            style={{ width: '32px', height: '32px', flexShrink: 0, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', cursor: 'pointer', background: focused ? 'var(--color-accent-primary-a08)' : 'transparent', color: focused ? 'var(--color-accent-primary)' : 'var(--color-fg)', border: `1px solid ${focused ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}` }}
                          >
                            {m.displayName.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?'}
                            <span aria-hidden="true" style={{ position: 'absolute', right: '-3px', top: '-3px', width: '7px', height: '7px', borderRadius: '50%', background: mail ? 'var(--color-warning)' : busy ? 'var(--color-accent-primary)' : 'transparent', border: mail || busy ? 'none' : '1px solid var(--color-fg-muted)' }} />
                          </button>
                        );
                      })}
                    </div>
                    {memberListOpen && <SlideOut side="left" width="320px" label="MEMBERS" onClose={() => setMemberListOpen(false)} testId="member-list-slide-out">{gridColumn}</SlideOut>}
                  </>
                );
                })()}

                {/* SPLITTER */}
                {widthRange !== 'narrow' && <div
                  onMouseDown={startSplitDrag}
                  role="separator"
                  aria-orientation="vertical"
                  data-help="cluster.splitter"
                  title="Drag to resize"
                  style={{
                    flex: '0 0 4px',
                    cursor: 'col-resize',
                    background: 'var(--color-border-hairline)',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background = 'var(--color-accent-primary-a20, var(--color-accent-primary-dim))';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background = 'var(--color-border-hairline)';
                  }}
                />}

                {/* DETAIL — focused member's full MemberPane */}
                <div
                  style={{
                    flex: widthRange === 'narrow' || gridFixedPx !== null ? '1 1 0%' : `1 1 ${(1 - fraction) * 100}%`,
                    minWidth: 0,
                    minHeight: 0,
                    display: 'flex',
                  }}
                >
                  {focusedMember && focusedJob ? (
                    <MemberPane
                      key={focusedMember.workflowId}
                      job={focusedJob}
                      displayName={focusedMember.displayName}
                      status={focusedMember.status}
                      focused={true}
                      onSend={(content, attachments, kind, primitive, pickedSkills) =>
                        sendFromComposer(focusedMember.workflowId, content, attachments, kind, primitive, pickedSkills)
                      }
                      clusterControls={{ clusterId, recipientLabel, placeholder: composerPlaceholder, onChooseRecipients: openRecipients, pendingTotal, pendingMembers, nudgedCount, onNudge: openNudgeModal }}
                      onAttachPlan={onAttachPlanToMember ? (planId) => onAttachPlanToMember(focusedMember.workflowId, planId) : undefined}
                      onAttachToCluster={onSetClusterPlan ? (body) => onSetClusterPlan(clusterId, body) : undefined}
                      onCancel={() => onCancelMember(focusedMember.workflowId)}
                      onCancelQueued={(cid) => onCancelQueuedForMember(focusedMember.workflowId, cid)}
                      onUpload={onUpload}
                      onLoadEarlier={onLoadEarlier ? () => onLoadEarlier(focusedMember.workflowId) : undefined}
                      onReview={
                        onReviewMember
                          ? (reviewer, contextRef, includeGitDiff) =>
                              onReviewMember(focusedMember.workflowId, reviewer, contextRef, includeGitDiff)
                          : undefined
                      }
                      onHandoff={
                        onHandoffMember
                          ? (mode, newPrimary, summarizer) => onHandoffMember(focusedMember.workflowId, mode, newPrimary, summarizer)
                          : undefined
                      }
                      onSpawn={
                        onSpawnMember
                          ? (newConfig, newDirection, includePlan, joinClusterId, memberIdentity) =>
                              onSpawnMember(focusedMember.workflowId, newConfig, newDirection, includePlan, joinClusterId, memberIdentity)
                          : undefined
                      }
                      onCompact={
                        onCompactMember ? () => onCompactMember(focusedMember.workflowId) : undefined
                      }
                      clusterContext={{ clusterId, name: clusterDisplayName(cluster) }}
                      onRecalibrate={
                        onRecalibrateMember ? () => onRecalibrateMember(focusedMember.workflowId) : undefined
                      }
                      onUpdatePrimary={
                        onUpdateMemberPrimary
                          ? (update) => onUpdateMemberPrimary(focusedMember.workflowId, update)
                          : undefined
                      }
                      onArmPlanMode={
                        onArmPlanModeMember ? () => onArmPlanModeMember(focusedMember.workflowId) : undefined
                      }
                      onTranscriptSend={
                        onTranscriptSendFromMember
                          ? (toWorkflowId, content) =>
                              onTranscriptSendFromMember(clusterId, focusedMember.workflowId, toWorkflowId, content)
                          : undefined
                      }
                      onReviewViaMember={
                        onReviewViaMember
                          ? (reviewerWfid, contextRef, includeGitDiff) =>
                              onReviewViaMember(focusedMember.workflowId, reviewerWfid, contextRef, includeGitDiff)
                          : undefined
                      }
                    />
                  ) : (
                    <div
                      className="display-font"
                      style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--color-fg-muted)',
                        fontSize: '11px',
                        letterSpacing: '1px',
                      }}
                    >
                      {focusedMember ? 'AWAITING REHYDRATE…' : 'NO MEMBERS'}
                    </div>
                  )}
                </div>
              </>
            );
          })()}
        </div>
        </div>

        {/* OUTER SPLITTER — between the trio and the ClusterRightPanel. Same
            4 px col-resize divider as the inner grid splitter; persisted
            fraction in localStorage so the operator's preferred width
            survives reloads. */}
        {widthRange !== 'narrow' && <div
          onMouseDown={startOuterSplitDrag}
          role="separator"
          aria-orientation="vertical"
          data-help="cluster.right-panel-splitter"
          title="Drag to resize the cluster right panel"
          style={{
            flex: '0 0 4px',
            cursor: 'col-resize',
            background: 'var(--color-border-hairline)',
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLDivElement).style.background = 'var(--color-accent-primary-a20, var(--color-accent-primary-dim))';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLDivElement).style.background = 'var(--color-border-hairline)';
          }}
        />}

        {widthRange === 'narrow' && <PanelStrip items={RIGHT_STRIP} active={rightSlide} onOpen={(id) => {
          if (id !== 'more') setRightTabRequest((prev) => ({ tab: id, n: (prev?.n ?? 0) + 1 }));
          setRightSlide(id);
        }} />}
        {(() => { const rightPanel = (
        <ClusterRightPanel
          cluster={cluster}
          compactSettings={compactLayout}
          tabRequest={rightTabRequest}
          planTabRequest={planTabRequest}
          membersTabRequest={membersTabRequest}
          onFocusMember={setActiveJob}
          onRename={onRenameCluster}
          onAddFreshWorkers={onAddFreshWorkers}
          onAddExistingMember={onAddExistingMember}
          onSetPlan={onSetClusterPlan}
          onAttachPlan={onAttachClusterPlan}
          onClearPlan={onClearClusterPlan}
          onSetMemberRole={onSetMemberRole}
          onSetMemberTier={onSetMemberTier}
          onSetMemberFocus={onSetMemberFocus}
          onDetachMember={onDetachMember}
          onToggleIdleNudger={onToggleIdleNudger}
          onToggleAutoTurn={onToggleAutoTurn}
          onSetTaskBoardMode={onSetTaskBoardMode}
          onSetTaskBoardAttached={onSetTaskBoardAttached}
          onSetEfficiency={onSetEfficiency}
          onSetAutoCompaction={onSetAutoCompaction}
          onSetRemote={onSetRemote}
          onSetGates={onSetGates}
          onSetProgress={onSetProgress}
          onDispatchOnce={onDispatchOnce}
          onToggleDispatcher={onToggleDispatcher}
          onUpdateDispatcherSettings={onUpdateDispatcherSettings}
          onUpdateTaskStatus={onUpdateTaskStatus}
          onReassignTask={onReassignTask}
          onReclaimRun={onReclaimRun}
          onTerminateRun={onTerminateRun}
          onCreateSwarm={onCreateSwarm}
          onSpawnPhase={onSpawnFromCluster
            ? (newConfig, newDirection, includePlan, joinClusterId, memberIdentity) => {
                // SPAWN PHASE in cluster context — parent the new member off
                // the cluster's first member (the cluster's template).
                // joinClusterId is the cluster the new worker joins.
                const sourceWfid = cluster.members[0]?.workflowId;
                if (!sourceWfid) return;
                onSpawnFromCluster(sourceWfid, newConfig, newDirection, includePlan, joinClusterId, memberIdentity);
              }
            : undefined}
          onReviewMember={onReviewMember}
          onCancelReview={onCancelMemberReview}
          onCancelHandoff={onCancelMemberHandoff}
          onClearHandoffLock={onClearMemberHandoffLock}
          onReviewViaMember={onReviewViaMember}
          onAttachPlanToMember={onAttachPlanToMember}
          onUpdateMemberPrimary={onUpdateMemberPrimary}
          onAttachCodebaseMemory={onAttachCodebaseMemory}
          onDetachCodebaseMemory={onDetachCodebaseMemory}
          mcp={mcp}
        />
        );
        if (widthRange === 'narrow') {
          return rightSlide && <SlideOut side="right" width="380px" label="CLUSTER PANEL" onClose={() => setRightSlide(null)} testId="right-panel-slide-out">{rightPanel}</SlideOut>;
        }
        return (
        <div
          style={{
            flex: rightFixedPx !== null ? `0 0 ${rightFixedPx}px` : `1 1 ${rightPanelFraction * 100}%`,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
          }}
        >
          {rightPanel}
        </div>
        );
        })()}
      </div>

      {/* NUDGE modal — operator picks which members get the canned mailbox
          prod. Default selection is empty; SEND NUDGE disabled until at
          least one is picked. Esc + click-on-backdrop close without
          dispatching. */}
      {nudgeSelection !== null && (
        <div
          onClick={cancelNudge}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9200,
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Nudge: pick recipients"
            onClick={(e) => e.stopPropagation()}
            style={{
              minWidth: '420px',
              maxWidth: '560px',
              background: 'var(--color-bg-dialog)',
              border: '1px solid var(--color-accent-primary)',
              padding: '16px 18px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <div
              className="display-font"
              style={{
                fontSize: '11px',
                letterSpacing: '1.5px',
                color: 'var(--color-accent-primary)',
              }}
            >
              NUDGE: PICK RECIPIENTS
            </div>
            <div style={{ color: 'var(--color-fg-muted)', fontSize: '11px', lineHeight: 1.4 }}>
              Remind selected members to check their mail. Idle members start a turn.
              Active members receive a reminder to pick up mail when they reach a convenient point
              in their current work. Delivery follows the provider&apos;s steering support;
              providers without mid-turn delivery pick it up after the current turn.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {cluster.members.map((m) => {
                const checked = nudgeSelection.has(m.workflowId);
                const role = m.role;
                const preset = role ? presetForText(role) : null;
                const roleLabel = role
                  ? (preset?.label.toUpperCase() ?? 'CUSTOM')
                  : null;
                const depth = cluster.mailboxDepth?.[m.workflowId] ?? 0;
                const hasMail = depth > 0;
                const isBusy = m.status === 'busy';
                return (
                  <label
                    key={m.workflowId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '6px 8px',
                      border: '1px solid '
                        + (checked
                          ? 'var(--color-accent-primary)'
                          : 'var(--color-border-hairline)'),
                      background: checked ? 'var(--color-accent-primary-a06)' : 'transparent',
                      cursor: 'pointer',
                      fontSize: '11px',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleNudgeMember(m.workflowId)}
                      style={{ cursor: 'pointer' }}
                    />
                    <span
                      style={{
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        background: isBusy
                          ? 'var(--color-warning)'
                          : 'var(--color-accent-secondary)',
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        flex: 1,
                        color: checked ? 'var(--color-accent-primary)' : 'var(--color-fg)',
                        fontWeight: checked ? 600 : 400,
                      }}
                    >
                      {m.displayName}
                    </span>
                    {roleLabel && (
                      <span
                        className="display-font"
                        style={{
                          fontSize: '9px',
                          letterSpacing: '1.5px',
                          padding: '1px 6px',
                          border: '1px solid var(--color-accent-secondary-a40, var(--color-accent-secondary-dim))',
                          color: 'var(--color-accent-secondary)',
                        }}
                      >
                        {roleLabel}
                      </span>
                    )}
                    {hasMail && (
                      <span
                        className="display-font"
                        style={{
                          fontSize: '9px',
                          letterSpacing: '1px',
                          color: 'var(--color-accent-primary)',
                        }}
                        title={`${depth} pending peer message${depth === 1 ? '' : 's'}`}
                      >
                        {depth} MAIL
                      </span>
                    )}
                    {isBusy && (
                      <span
                        className="display-font"
                        style={{
                          fontSize: '9px',
                          letterSpacing: '1px',
                          color: 'var(--color-warning)',
                        }}
                      >
                        BUSY
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                onClick={cancelNudge}
                className="display-font"
                style={{
                  padding: '6px 14px',
                  background: 'transparent',
                  color: 'var(--color-fg-muted)',
                  border: '1px solid var(--color-border-hairline)',
                  cursor: 'pointer',
                  fontSize: '10px',
                  letterSpacing: '1.5px',
                }}
              >
                CANCEL
              </button>
              <button
                onClick={confirmNudge}
                disabled={nudgeSelection.size === 0}
                className="display-font"
                style={{
                  padding: '6px 14px',
                  background: nudgeSelection.size === 0
                    ? 'transparent'
                    : 'var(--color-accent-secondary)',
                  color: nudgeSelection.size === 0
                    ? 'var(--color-fg-muted)'
                    : 'var(--color-bg)',
                  border: '1px solid var(--color-accent-secondary)',
                  cursor: nudgeSelection.size === 0 ? 'not-allowed' : 'pointer',
                  fontSize: '10px',
                  letterSpacing: '1.5px',
                }}
              >
                SEND NUDGE ({nudgeSelection.size})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Recipient chooser, opened from the composer's TO chip. Starts with the
          current recipients; DONE stays disabled with nobody picked. Esc and a
          backdrop click close without changing anything. */}
      {recipientDraft !== null && (
        <div
          onClick={closeRecipients}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9200, padding: '16px', boxSizing: 'border-box' }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Choose recipients"
            data-testid="recipients-dialog"
            onClick={(e) => e.stopPropagation()}
            style={{ minWidth: '420px', maxWidth: '560px', width: '100%', boxSizing: 'border-box', background: 'var(--color-bg-dialog)', border: '1px solid var(--color-accent-primary)', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '12px' }}
          >
            <div className="display-font" style={{ fontSize: '11px', letterSpacing: '1.5px', color: 'var(--color-accent-primary)' }}>
              CHOOSE RECIPIENTS
            </div>
            <div style={{ color: 'var(--color-fg-muted)', fontSize: '11px', lineHeight: 1.4 }}>
              Your next message goes to the members you pick. Idle members start a turn; busy members receive it as a follow-up.
            </div>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <button
                type="button"
                data-testid="recipients-everyone"
                onClick={() => setRecipientDraft(new Set(cluster.members.map((m) => m.workflowId)))}
                className="display-font"
                style={{ ...headerPill, padding: '3px 8px' }}
              >
                EVERYONE
              </button>
              <button
                type="button"
                onClick={() => setRecipientDraft(new Set())}
                className="display-font"
                style={{ ...headerPill, padding: '3px 8px' }}
              >
                NONE
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {orderMembers(cluster.members, operatorReordered).map((m) => {
                const checked = recipientDraft.has(m.workflowId);
                const preset = m.role ? presetForText(m.role) : null;
                const roleLabel = m.role ? (preset?.label.toUpperCase() ?? 'CUSTOM') : null;
                const isBusy = m.status === 'busy';
                return (
                  <label
                    key={m.workflowId}
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', border: '1px solid ' + (checked ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'), background: checked ? 'var(--color-accent-primary-a06)' : 'transparent', cursor: 'pointer', fontSize: '11px' }}
                  >
                    <input type="checkbox" checked={checked} onChange={() => toggleRecipient(m.workflowId)} style={{ cursor: 'pointer' }} />
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: isBusy ? 'var(--color-warning)' : 'var(--color-accent-secondary)', flexShrink: 0 }} />
                    <span style={{ flex: 1, color: checked ? 'var(--color-accent-primary)' : 'var(--color-fg)', fontWeight: checked ? 600 : 400 }}>{m.displayName}</span>
                    {roleLabel && (
                      <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1.5px', padding: '1px 6px', border: '1px solid var(--color-accent-secondary-a40, var(--color-accent-secondary-dim))', color: 'var(--color-accent-secondary)' }}>{roleLabel}</span>
                    )}
                    {isBusy && <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-warning)' }}>BUSY</span>}
                  </label>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button onClick={closeRecipients} className="display-font" style={{ padding: '6px 14px', background: 'transparent', color: 'var(--color-fg-muted)', border: '1px solid var(--color-border-hairline)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1.5px' }}>
                CANCEL
              </button>
              <button
                onClick={confirmRecipients}
                disabled={recipientDraft.size === 0}
                data-testid="recipients-done"
                className="display-font"
                style={{ padding: '6px 14px', background: recipientDraft.size === 0 ? 'transparent' : 'var(--color-accent-primary)', color: recipientDraft.size === 0 ? 'var(--color-fg-muted)' : 'var(--color-bg)', border: '1px solid var(--color-accent-primary)', cursor: recipientDraft.size === 0 ? 'not-allowed' : 'pointer', fontSize: '10px', letterSpacing: '1.5px' }}
              >
                DONE ({recipientDraft.size})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast strip — bottom-right, stacked. Auto-dismiss after 4.5s. */}
      <div
        style={{
          position: 'fixed',
          right: '16px',
          bottom: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          zIndex: 9100,
          pointerEvents: 'none',
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="display-font"
            style={{
              background: 'var(--color-bg-panel)',
              border: '1px solid var(--color-accent-primary)',
              color: 'var(--color-fg)',
              padding: '8px 14px',
              fontSize: '11px',
              letterSpacing: '1px',
              boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
            }}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
