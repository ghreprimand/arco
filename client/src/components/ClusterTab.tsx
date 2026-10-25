// CLUSTER_MODE_PLAN.md Phase 2 + CLUSTER_GRID_PLAN.md — cluster tab.
//
// Body layout: compact MemberCard grid (left) + 4px col-resize splitter +
// single focused MemberPane detail (right) + ClusterRightPanel (Members /
// Mailbox / Activity etc.). Sticky broadcast composer at the bottom.
// Composer dispatches once per submit (cluster_broadcast); idle members
// start a fresh turn, busy members enqueue as follow-up. Toast reports the
// split.
//
// The cluster routing branch in App.tsx is mutually exclusive with the
// per-workflow active job — selecting a workflow tab clears
// activeClusterId. Closing the cluster tab keeps the cluster alive (members
// keep working as plain workflows, peer tools stay registered) until the
// operator clicks × on the tab and confirms tear-down (DELETE
// /api/clusters/:id parity).

import { useEffect, useRef, useState } from 'react';
import { NUDGE_PROMPT, ACTIVE_NUDGE_PROMPT } from '../utils/clusterNudge';
import { onVoiceDialog } from '../voice/dialogs';
import { useAppStore, type ClusterCardLayout } from '../stores/appStore';
import { MemberPane } from './MemberPane';
import { MemberCard } from './MemberCard';
import { ClusterRightPanel } from './ClusterRightPanel';
import { clusterDisplayName } from './TabBar';
import type { ClusterMemberProvider, ProviderName, ModelName, EffortLevel, WorkflowConfig, ReviewContextRef, MemberTier, ClusterEfficiencyLevel, ClusterProgressMode, ClusterTaskBoardMode, LedgerTaskStatus } from '@arco/shared';
import { presetForText } from '@arco/shared';
import type { ClusterDispatcherSettingsPatch, ClusterMemberPrimaryUpdate, ClusterSwarmCreateRequest } from './ClusterRightPanel/types';
import type { McpSenders } from './RightPanel/McpRegistrySection';

// CLUSTER_GRID_PLAN.md §5 — splitter min widths (px). Detail favored — its
// chat surface needs reading width; the grid's cards stay legible at 240.
const MIN_GRID_PX = 240;
const MIN_DETAIL_PX = 360;

const CARD_LAYOUT_OPTIONS: Array<{ id: ClusterCardLayout; label: string; title: string }> = [
  { id: 'auto', label: 'AUTO', title: 'Balanced grid based on member count' },
  { id: 'rows', label: 'ROWS', title: 'Stack member cards top to bottom' },
  { id: 'columns', label: 'COLS', title: 'Arrange member cards side by side' },
  { id: 'grid', label: 'GRID', title: 'Force the balanced grid layout' },
];

// 2026-05-11 — outer splitter between the (grid + detail) trio and the
// ClusterRightPanel. Mirrors WorkflowView.tsx's chat / right-panel splitter
// shape so cluster + workflow surfaces share the same operator gesture.
const RIGHT_PANEL_WIDTH_KEY = 'arco.clusterRightPanelWidth';
const RIGHT_PANEL_MIN_FRACTION = 0.18;
const RIGHT_PANEL_MAX_FRACTION = 0.5;
// 0.28 ≈ the ~320 px the right panel was hard-pinned to before the splitter
// existed (320 / ~1140 typical body width). Defaulting to a fraction keeps
// the first paint stable across window widths.
const RIGHT_PANEL_DEFAULT_FRACTION = 0.28;
// Operator can collapse the bottom broadcast pane to a one-line strip with a
// checkbox to bring it back. Global (not per-cluster) — it's a layout taste.
const BROADCAST_PANE_VISIBLE_KEY = 'arco.clusterBroadcastPaneVisible';

interface Props {
  clusterId: string;
  // Per-member dispatch (threaded through from App.tsx → useWebSocket).
  onSendToMember: (workflowId: string, content: string, attachments?: string[], kind?: 'steer' | 'follow-up') => boolean | void;
  onCancelMember: (workflowId: string) => void;
  onCancelQueuedForMember: (workflowId: string, clientMessageId: string) => void;
  onUpload: (file: File) => Promise<{ fileId: string; filename: string; path: string } | null>;
  onLoadEarlier?: (workflowId: string) => void;
  // Cluster-scoped helpers.
  // 2026-05-11 — recipientWorkflowIds is an optional non-empty subset of
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
  // 2026-05-11 — optional `opts` triple overrides provider/model/effort on
  // freshly spawned cluster members. Undefined fields → inherit-from-template.
  onAddFreshWorkers?: (
    clusterId: string,
    count: number,
    opts?: { provider?: ClusterMemberProvider; model?: string; effort?: string; providerAccountRef?: string; accessMode?: import('@arco/shared').ClusterMemberAccessMode },
  ) => void;
  onAddExistingMember?: (clusterId: string, workflowId: string) => void;
  // Phase 2.6 — shared cluster plan + per-member role hint editors live in
  // ClusterRightPanel. Threaded as App-level senders so this component can
  // stay stateless.
  onSetClusterPlan?: (clusterId: string, body: string) => void;
  onAttachClusterPlan?: (clusterId: string, planId: string) => void;
  onClearClusterPlan?: (clusterId: string) => void;
  onSetMemberRole?: (clusterId: string, workflowId: string, role: string) => void;
  // 2026-05-11 — operator picked a builder-tier from a member row's pill
  // row in ClusterRightPanel. Pure metadata: surfaces in peer_list so the
  // cluster director can match task complexity to builder capability.
  onSetMemberTier?: (clusterId: string, workflowId: string, tier: MemberTier | null) => void;
  // 2026-05-11 — operator edited focus (sub-specialty) on a member row.
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
  // 2026-06-15 — per-cluster efficiency level (+ optional doctrine addendum).
  onSetEfficiency?: (clusterId: string, level: ClusterEfficiencyLevel, addendum?: string) => void;
  onSetRemote?: (clusterId: string, enabled: boolean) => void;
  onSetGates?: (clusterId: string, enabled: boolean) => void;
  // 2026-07-17 — drag-to-reorder the member grid; full permutation sent.
  onReorderMembers?: (clusterId: string, memberIds: string[]) => void;
  // 2026-06-29 — per-cluster progress-tracking mode (plan / board / both).
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
    mode: 'fresh-summarizer' | 'original-worker' | 'fresh-agent',
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
  ) => void;
  onCompactMember?: (workflowId: string) => void;
  onRecalibrateMember?: (workflowId: string) => void;
  onUpdateMemberPrimary?: (workflowId: string, update: ClusterMemberPrimaryUpdate) => void;
  onAttachCodebaseMemory?: (workflowId: string, indexPath?: string) => void;
  onDetachCodebaseMemory?: (workflowId: string) => void;
  mcp?: McpSenders;
  onArmPlanModeMember?: (workflowId: string) => void;
  // 2026-05-11 — cluster PLAN tab pills (SPAWN PHASE + REVIEW PHASE /
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

  const [composerText, setComposerText] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // 2026-05-11 — broadcast recipient picker. `null` = default ("all" — every
  // current member). A non-null set is a concrete subset; if it ends up
  // equal to the full membership at submit time we still send "all" by
  // omitting the field on the wire. Set is keyed by workflowId.
  // Reconcile against current membership so a member-remove can't strand an
  // ID in the set (we drop missing IDs each render via the visible derived
  // value; the submit path normalises again before sending).
  const [recipientSelection, setRecipientSelection] = useState<Set<string> | null>(null);
  const toggleRecipient = (wfid: string) => {
    setRecipientSelection((prev) => {
      // Initialise from current membership minus the toggled one if we were
      // in default-all mode. Subsequent toggles mutate the explicit set.
      const memberIds = cluster?.members.map((m) => m.workflowId) ?? [];
      const base = prev ?? new Set(memberIds);
      const next = new Set(base);
      if (next.has(wfid)) next.delete(wfid);
      else next.add(wfid);
      // Snap back to "default all" if the explicit set re-equals membership.
      const allSelected = memberIds.length > 0 && memberIds.every((id) => next.has(id));
      return allSelected ? null : next;
    });
  };

  // CLUSTER_GRID_PLAN.md §5 — splitter drag, mirrors WorkflowView.tsx
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
        if (v !== null) setClusterGridSplit(v);
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

  // 2026-05-11 — outer splitter (trio | ClusterRightPanel). Same shape as
  // WorkflowView's chat/right splitter: persisted fraction, defensive
  // body-style restore, capture-phase pointerup, blur + visibilitychange
  // cleanup. Independent of the inner grid splitter so the operator can
  // resize either boundary without interaction.
  const outerContainerRef = useRef<HTMLDivElement | null>(null);
  const outerDraggingRef = useRef(false);
  const [rightPanelFraction, setRightPanelFraction] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(RIGHT_PANEL_WIDTH_KEY);
      if (raw) {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= RIGHT_PANEL_MIN_FRACTION && n <= RIGHT_PANEL_MAX_FRACTION) return n;
      }
    } catch { /* no-op */ }
    return RIGHT_PANEL_DEFAULT_FRACTION;
  });
  useEffect(() => {
    try { localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(rightPanelFraction)); } catch { /* no-op */ }
  }, [rightPanelFraction]);
  const [broadcastPaneVisible, setBroadcastPaneVisible] = useState<boolean>(() => {
    try { return localStorage.getItem(BROADCAST_PANE_VISIBLE_KEY) !== '0'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(BROADCAST_PANE_VISIBLE_KEY, broadcastPaneVisible ? '1' : '0'); } catch { /* no-op */ }
  }, [broadcastPaneVisible]);
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

  // Slice 6a — first-render default: pick the first member if focus isn't
  // set yet. setClusterState's reducer carries focus across membership
  // changes; this just kicks off the initial pick.
  useEffect(() => {
    if (!cluster || cluster.members.length === 0) return;
    if (!focusedMemberId || !cluster.members.some((m) => m.workflowId === focusedMemberId)) {
      setClusterFocusedMember(clusterId, cluster.members[0].workflowId);
    }
  }, [cluster, clusterId, focusedMemberId, setClusterFocusedMember]);

  // 2026-07-17 — drag-to-reorder: dragId is the picked-up member, dragOverId
  // the current drop target (dashed outline). Drop sends the full permutation;
  // the server validates + rebroadcasts cluster_state, which re-renders the
  // grid in the new order (no optimistic reorder — the round-trip is fast and
  // a stale drag must not fake success).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dropMember = (targetId: string) => {
    if (!cluster || !onReorderMembers || !dragId || dragId === targetId) return;
    const ids = cluster.members.map((m) => m.workflowId);
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

  // Typed broadcasts keep their existing follow-up delivery for busy members.
  const dispatchBroadcast = (content: string): boolean => {
    if (!content || !onBroadcast) return false;
    const clientMessageId = `cb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const allIds = cluster.members.map((m) => m.workflowId);
    let recipientList: string[] | undefined;
    if (recipientSelection !== null) {
      const sub = allIds.filter((id) => recipientSelection.has(id));
      if (sub.length === 0) return false; // operator deselected everything; no-op
      if (sub.length < allIds.length) recipientList = sub;
    }
    const targets = recipientList ?? allIds;
    // Snapshot busy state ONLY among the targets so the toast count
    // reflects the operator's mental model of "X of N members".
    const targetSet = new Set(targets);
    const targetMembers = cluster.members.filter((m) => targetSet.has(m.workflowId));
    const idle = targetMembers.filter((m) => m.status === 'idle').length;
    const queued = targetMembers.length - idle;
    onBroadcast(clusterId, content, undefined, clientMessageId, recipientList);
    const total = cluster.members.length;
    const scopeLabel = recipientList ? `${targets.length} of ${total}` : `all ${total}`;
    const toastText =
      queued === 0
        ? `Sent to ${scopeLabel} members`
        : `Queued for ${queued} of ${targetMembers.length}${recipientList ? ` (of ${total})` : ''} members`;
    setToasts((prev) => [
      ...prev,
      { id: clientMessageId, text: toastText, expiresAt: Date.now() + 4500 },
    ]);
    return true;
  };

  const submitBroadcast = () => {
    const content = composerText.trim();
    if (!content) return;
    if (dispatchBroadcast(content)) setComposerText('');
  };

  // Click NUDGE → open modal with default-empty selection. Operator picks
  // explicitly; SEND NUDGE fires with that exact set. Cancel closes without
  // dispatching. Idle+mailbox-depth-positive members are visually flagged
  // ("has mail") so the operator can pick the ones that actually need
  // waking, but no member is auto-checked.
  const openNudgeModal = () => {
    setNudgeSelection(new Set());
  };
  const confirmNudge = () => {
    if (!nudgeSelection || nudgeSelection.size === 0) return;
    // Read at click time: the member may have started/settled since the
    // picker opened. Match the composer's busy fallbacks during reconnect.
    const currentJobs = useAppStore.getState().jobs;
    let sent = 0;
    for (const member of cluster.members) {
      if (!nudgeSelection.has(member.workflowId)) continue;
      const job = currentJobs[member.workflowId];
      const active = member.status === 'busy' || job?.busy === true
        || Object.values(job?.workers ?? {}).some((w) => w.status === 'running' || w.status === 'spawning')
        || (job?.messages.some((m) => m.isStreaming) ?? false);
      const result = onSendToMember(
        member.workflowId,
        active ? ACTIVE_NUDGE_PROMPT : NUDGE_PROMPT,
        undefined,
        'steer',
      );
      if (result !== false) sent++;
    }
    if (sent === 0) return;
    setToasts((prev) => [...prev, {
      id: `nudge-${Date.now()}`,
      text: `Nudged ${sent} member${sent === 1 ? '' : 's'}`,
      expiresAt: Date.now() + 4500,
    }]);
    setNudgeSelection(null);
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
  // Computer (voice) asks for the nudge picker or the broadcast pane by
  // name; it opens exactly what a click would and sends nothing.
  useEffect(() => onVoiceDialog((r) => {
    if (r.clusterId !== clusterId) return false;
    if (r.name === 'nudge') { openNudgeModal(); return true; }
    if (r.name === 'broadcast') { setBroadcastPaneVisible(true); return true; }
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

  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      submitBroadcast();
    }
  };

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
            flex: `1 1 ${(1 - rightPanelFraction) * 100}%`,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
          }}
        >
        {/* CLUSTER_GRID_PLAN.md §2 — compact MemberCards + splitter + single
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
            const fraction = liveSplit ?? gridSplit;
            const focusedMember =
              cluster.members.find((m) => m.workflowId === focusedMemberId) ?? cluster.members[0];
            const focusedJob = focusedMember ? jobs[focusedMember.workflowId] : undefined;

            return (
              <>
                {/* GRID — compact cards */}
                <div
                  data-help="cluster.grid"
                  style={{
                    flex: `1 1 ${fraction * 100}%`,
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
                      overflowX: 'auto',
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
                  </div>

                  <div
                    style={{
                      flex: 1,
                      minHeight: 0,
                      overflowY: layout === 'columns' ? 'hidden' : 'auto',
                      overflowX: layout === 'columns' ? 'auto' : 'hidden',
                      padding: '8px',
                      display: 'grid',
                      gap: '8px',
                      ...layoutCss,
                    }}
                  >
                    {cluster.members.map((m) => (
                      <MemberCard
                        key={m.workflowId}
                        job={jobs[m.workflowId]}
                        displayName={m.displayName}
                        status={m.status}
                        role={m.role}
                        focused={focusedMemberId === m.workflowId}
                        onClick={() => setClusterFocusedMember(clusterId, m.workflowId)}
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

                {/* SPLITTER */}
                <div
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
                />

                {/* DETAIL — focused member's full MemberPane */}
                <div
                  style={{
                    flex: `1 1 ${(1 - fraction) * 100}%`,
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
                      onSend={(content, attachments, kind) =>
                        onSendToMember(focusedMember.workflowId, content, attachments, kind)
                      }
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
                          ? (newConfig, newDirection, includePlan, joinClusterId) =>
                              onSpawnMember(focusedMember.workflowId, newConfig, newDirection, includePlan, joinClusterId)
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
        <div
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
        />

        <div
          style={{
            flex: `1 1 ${rightPanelFraction * 100}%`,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
          }}
        >
        <ClusterRightPanel
          cluster={cluster}
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
            ? (newConfig, newDirection, includePlan, joinClusterId) => {
                // SPAWN PHASE in cluster context — parent the new member off
                // the cluster's first member (the cluster's template).
                // joinClusterId is the cluster the new worker joins.
                const sourceWfid = cluster.members[0]?.workflowId;
                if (!sourceWfid) return;
                onSpawnFromCluster(sourceWfid, newConfig, newDirection, includePlan, joinClusterId);
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
        </div>
      </div>

      {/* CLUSTER_MODE_PLAN.md Phase 2 — sticky broadcast composer. One
          submit fans out to every member; idle members start a fresh turn,
          busy members enqueue as follow-up. Reuse the existing per-member
          handleUserMessage path so events.jsonl ordering is identical to a
          manual prompt. No REVIEW/HANDOFF/SPAWN buttons — those stay
          per-member primitives, accessed by clicking through to a member's
          own tab.
          2026-05-11 — recipient chip row sits above the textarea/button row
          so the operator can narrow the broadcast before submitting.
          Default state: all selected (legacy behaviour preserved). */}
      {(() => {
        const paneToggle = (
          <label
            className="display-font"
            title={broadcastPaneVisible ? 'Hide the broadcast pane' : 'Show the broadcast pane'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              fontSize: '9px',
              letterSpacing: '1px',
              color: 'var(--color-fg-muted)',
              cursor: 'pointer',
              flexShrink: 0,
              marginLeft: 'auto',
            }}
          >
            <input
              type="checkbox"
              checked={broadcastPaneVisible}
              onChange={(e) => setBroadcastPaneVisible(e.target.checked)}
              style={{ margin: 0, cursor: 'pointer' }}
            />
            SHOW BROADCAST
          </label>
        );
        if (!broadcastPaneVisible) {
          return (
            <div
              style={{
                flexShrink: 0,
                borderTop: '1px solid var(--color-border-hairline)',
                background: 'var(--color-bg-panel)',
                // Right padding clears the floating help (?) bubble that
                // sits over the bottom-right corner.
                padding: '3px 72px 3px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
              }}
            >
              {paneToggle}
              {/* NUDGE stays reachable while the pane is hidden — the modal
                  has its own member picker, so it needs nothing else here. */}
              <button
                onClick={openNudgeModal}
                data-help="cluster.broadcast.nudge"
                title="Remind selected members to check their mail. Active members pick it up when able; idle members start a turn."
                className="display-font"
                style={{
                  padding: '2px 8px',
                  background: 'transparent',
                  color: 'var(--color-accent-secondary)',
                  border: '1px solid var(--color-accent-secondary-dim, var(--color-accent-secondary))',
                  cursor: 'pointer',
                  fontSize: '9px',
                  letterSpacing: '1px',
                  flexShrink: 0,
                }}
              >
                NUDGE
              </button>
            </div>
          );
        }
        const allIds = cluster.members.map((m) => m.workflowId);
        const sel = recipientSelection;
        const isSelected = (id: string) => (sel === null ? true : sel.has(id));
        const selectedCount = sel === null ? allIds.length : allIds.filter((id) => sel.has(id)).length;
        const submitDisabled = composerText.trim().length === 0 || selectedCount === 0;
        const placeholderScope =
          selectedCount === allIds.length
            ? `all ${allIds.length} members`
            : `${selectedCount} of ${allIds.length} members`;
        return (
          <div
            data-help="cluster.broadcast"
            style={{
              flexShrink: 0,
              borderTop: '1px solid var(--color-border-hairline)',
              background: 'var(--color-bg-panel)',
              padding: '10px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            {/* Recipient chip row. One chip per member, click toggles inclusion.
                Role chip (preset label or CUSTOM) + status dot render inside the
                chip so the operator can pick by role + busy state at a glance.
                Horizontally scrollable so 8+ members don't wrap mid-row. */}
            <div
              data-help="cluster.broadcast.recipient-pill"
              style={{
                display: 'flex',
                gap: '4px',
                overflowX: 'auto',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <span
                className="display-font"
                style={{
                  fontSize: '9px',
                  letterSpacing: '1px',
                  color: 'var(--color-fg-muted)',
                  marginRight: '4px',
                  flexShrink: 0,
                }}
              >
                TO:
              </span>
              {cluster.members.map((m) => {
                const active = isSelected(m.workflowId);
                const preset = m.role ? presetForText(m.role) : null;
                const roleLabel = m.role ? (preset?.label ?? 'CUSTOM') : null;
                const busy = m.status !== 'idle';
                return (
                  <button
                    key={m.workflowId}
                    onClick={() => toggleRecipient(m.workflowId)}
                    className="display-font"
                    title={
                      active
                        ? `Click to exclude ${m.displayName} from this broadcast`
                        : `Click to include ${m.displayName} in this broadcast`
                    }
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                      padding: '3px 8px',
                      background: active ? 'var(--color-accent-primary-a08)' : 'transparent',
                      border: active
                        ? '1px solid var(--color-accent-primary)'
                        : '1px solid var(--color-border-hairline)',
                      color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                      cursor: 'pointer',
                      fontSize: '10px',
                      letterSpacing: '0.5px',
                      flexShrink: 0,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        display: 'inline-block',
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        background: busy ? 'var(--color-warning)' : 'var(--color-accent-secondary)',
                        opacity: active ? 1 : 0.4,
                        flexShrink: 0,
                      }}
                    />
                    {m.displayName.toUpperCase()}
                    {roleLabel && (
                      <span
                        style={{
                          fontSize: '9px',
                          letterSpacing: '1px',
                          color: 'var(--color-fg-muted)',
                          border: '1px solid var(--color-border-hairline)',
                          padding: '0 3px',
                        }}
                      >
                        {roleLabel.toUpperCase()}
                      </span>
                    )}
                  </button>
                );
              })}
              {paneToggle}
            </div>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
              <textarea
                ref={composerRef}
                value={composerText}
                onChange={(e) => setComposerText(e.target.value)}
                onKeyDown={onComposerKey}
                placeholder={`Broadcast to ${placeholderScope} — ↵ to send`}
                rows={2}
                style={{
                  flex: 1,
                  background: 'var(--color-bg)',
                  color: 'var(--color-fg)',
                  border: '1px solid var(--color-border-hairline)',
                  padding: '8px 10px',
                  fontSize: '13px',
                  fontFamily: 'var(--font-code)',
                  resize: 'vertical',
                  minHeight: '48px',
                  maxHeight: '160px',
                }}
              />
              <button
                onClick={openNudgeModal}
                data-help="cluster.broadcast.nudge"
                title="Remind selected members to check their mail. Active members pick it up when able; idle members start a turn."
                className="display-font"
                style={{
                  padding: '10px 16px',
                  background: 'transparent',
                  color: 'var(--color-accent-secondary)',
                  border: '1px solid var(--color-accent-secondary-dim, var(--color-accent-secondary))',
                  cursor: 'pointer',
                  fontSize: '11px',
                  letterSpacing: '1px',
                }}
              >
                NUDGE
              </button>
              <button
                onClick={submitBroadcast}
                disabled={submitDisabled}
                className="display-font"
                style={{
                  padding: '10px 20px',
                  background: submitDisabled ? 'transparent' : 'var(--color-accent-primary)',
                  color: submitDisabled ? 'var(--color-fg-muted)' : 'var(--color-bg)',
                  border: '1px solid var(--color-accent-primary)',
                  cursor: submitDisabled ? 'not-allowed' : 'pointer',
                  fontSize: '11px',
                  letterSpacing: '1px',
                }}
              >
                BROADCAST
              </button>
            </div>
          </div>
        );
      })()}

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
            aria-label="Nudge — pick recipients"
            onClick={(e) => e.stopPropagation()}
            style={{
              minWidth: '420px',
              maxWidth: '560px',
              background: 'var(--color-bg-panel)',
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
              NUDGE — PICK RECIPIENTS
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

      {/* Toast strip — bottom-right, stacked. Auto-dismiss after 4.5s. */}
      <div
        style={{
          position: 'fixed',
          right: '16px',
          bottom: '88px',
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
