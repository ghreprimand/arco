import type {
  ClusterMemberProvider,
  ClusterStatePayload,
  ReviewContextRef,
  WorkflowConfig,
  ProviderName,
  ModelName,
  EffortLevel,
  MemberTier,
  ClusterEfficiencyLevel,
  ClusterProgressMode,
  ClusterTaskBoardMode,
  LedgerTaskStatus,
} from '@arco/shared';
import type { McpSenders } from '../RightPanel/McpRegistrySection';

export interface ClusterSwarmCreateRequest {
  goal: string;
  workerWorkflowIds: string[];
  verifierWorkflowId: string;
  synthesizerWorkflowId: string;
  armDispatch?: boolean;
}

export interface ClusterDispatcherSettingsPatch {
  intervalMs?: number;
  maxTasksPerSweep?: number;
  maxConcurrentRuns?: number;
  autoWorktree?: boolean;
}

export type ClusterMemberPrimaryUpdate = {
  autoCompaction?: import('@arco/shared').AutoCompactionPolicy | null;
  model?: ModelName;
  effort?: EffortLevel;
  autoHandoff?: {
    enabled: boolean;
    warnAt: number;
    autoAt: number;
    mode?: 'original-worker' | 'fresh-summarizer';
    summarizer?: { provider: ProviderName; model?: ModelName; effort?: EffortLevel };
  };
  codexTransport?: 'exec' | 'appserver'; codexContextPolicy?: 'max' | 'standard';
  claudeTransport?: 'cli' | 'native';
  claudeNativeCompact?: boolean;
  claudeNativeForceInterleavedThinkingBeta?: boolean;
  claudeNativeThinkingDisplay?: 'omitted' | 'summarized' | 'updates';
  nativeCompactAutoContinue?: boolean;
  efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive';
  efficiencyFactForce?: 'on' | 'off';
  efficiencyConfigProtection?: 'on' | 'off';
  efficiencySandbox?: 'off' | 'on';
  outputStyle?: 'normal' | 'lite' | 'terse';
  ollamaParams?: Record<string, unknown>;
};

// Phase 5 — order is members → mailbox → plan → activity → reviews so the
// new unified activity feed sits between the static plan view and the
// reviewer queue. ClusterActivityTab subsumes the previous peer-only feed.
// 2026-05-11 — added cwd-anchored tabs (github / files / history / preview)
// mirroring the per-workflow RightPanel. A cluster has exactly one shared
// cwd by construction, so these are naturally cluster-scoped. HISTORY and
// PREVIEW are intrinsically per-workflow (they send WS messages keyed by
// workflowId and read job.id state) — for those we pin to the first
// member's job, treating the cluster anchor as the canonical preview
// surface. GITHUB / FILES take only the cwd and so are pure cluster ops.
export type SubTab =
  | 'members'
  | 'mailbox'
  | 'plan'
  // §D3 — kanban view over the cluster cwd's task ledger. Sits next to PLAN
  // (both are shared cwd-scoped surfaces).
  | 'board'
  | 'activity'
  | 'reviews'
  | 'handoffs'
  | 'github'
  | 'files'
  | 'history'
  | 'preview'
  | 'config';

// Mirrors server clusterMailbox.PeerMessage. Kept local rather than promoted
// to shared/ because only the modal fetcher reads it — every other client
// path consumes peer messages via the PeerMessageSent/Received WS events.
export interface PeerMessage {
  msgId: string;
  fromWorkflowId: string;
  fromDisplayName: string;
  toWorkflowId: string;
  content: string;
  createdAt: string;
  delivered: boolean;
  deliveredAt?: string;
}

export interface Props {
  cluster: ClusterStatePayload;
  // Operator clicked a member row → focus that member's individual tab.
  onFocusMember?: (workflowId: string) => void;
  // Slice 6a — operator renamed the cluster from the Members tab header.
  // Empty string clears back to the derived `<basename(cwd)> · <short-id>`.
  onRename?: (clusterId: string, name: string) => void;
  // Phase 2.5.1 — grow membership from inside the cluster tab. Two modes:
  // (a) spawn N fresh workers inheriting the cluster's template;
  // (b) add an existing same-cwd standalone Native tab.
  // 2026-05-11 — optional `opts` triple overrides provider/model/effort on
  // freshly spawned cluster members. Undefined fields → inherit-from-template.
  onAddFreshWorkers?: (
    clusterId: string,
    count: number,
    opts?: { provider?: ClusterMemberProvider; model?: string; effort?: string; providerAccountRef?: string; accessMode?: import('@arco/shared').ClusterMemberAccessMode },
  ) => void;
  onAddExistingMember?: (clusterId: string, workflowId: string) => void;
  // Phase 2.6 — shared cluster plan + per-member role editors.
  onSetPlan?: (clusterId: string, body: string) => void;
  onAttachPlan?: (clusterId: string, planId: string) => void;
  onClearPlan?: (clusterId: string) => void;
  onSetMemberRole?: (clusterId: string, workflowId: string, role: string) => void;
  // 2026-05-11 — operator picked a builder-tier from the per-member pill row
  // (light / standard / heavy / UNSET). `tier === null` clears. Pure
  // metadata: the director sees the value in peer_list and decides routing.
  onSetMemberTier?: (clusterId: string, workflowId: string, tier: MemberTier | null) => void;
  // 2026-05-11 — operator edited focus (sub-specialty) from MEMBERS sub-
  // tab. Empty string or null clears. Pure metadata.
  onSetMemberFocus?: (clusterId: string, workflowId: string, focus: string | null) => void;
  // Phase 5 — in-panel detach button on each MemberRow (parallel to the
  // bottom-row × on the tab bar). Same wire (`cluster_member_remove`);
  // guarded by window.confirm at the call site.
  onDetachMember?: (clusterId: string, workflowId: string) => void;
  // Phase 5 — operator-armed idle-nudger toggle. The chip in the cluster
  // header makes the armed state visible at all times so it's never
  // invisible (autonomy-test answer #4: reversibility surfaced).
  onToggleIdleNudger?: (clusterId: string, enabled: boolean) => void;
  // Phase 5b — operator-armed auto-turn-on-mailbox toggle. Same visibility
  // requirement as nudges; sits next to the MAIL ALERTS chip in the header.
  onToggleAutoTurn?: (clusterId: string, enabled: boolean) => void;
  // Explicitly choose whether this cluster uses no board, the cwd project
  // board, or its own fresh cluster board.
  onSetTaskBoardMode?: (clusterId: string, mode: ClusterTaskBoardMode) => void;
  // Back-compat project attach/detach callback. New UI uses mode.
  onSetTaskBoardAttached?: (clusterId: string, attached: boolean) => void;
  // 2026-06-15 — operator set the cluster's efficiency level (+ optional
  // doctrine addendum). Sits in the header chip bar next to MAIL ALERTS. Drives
  // the doctrine block, peer-send budget, and mailbox-notice variant.
  // `addendum === undefined` keeps the current note; '' clears it.
  onSetAutoCompaction?: (clusterId: string, policy: import('@arco/shared').AutoCompactionPolicy | null) => void;
  onSetEfficiency?: (clusterId: string, level: ClusterEfficiencyLevel, addendum?: string, messageGuard?: import('@arco/shared').ClusterMessageGuard) => void;
  // R3 — cluster-level remote opt-in chip (one switch covers all members).
  onSetRemote?: (clusterId: string, enabled: boolean) => void;
  // 2026-07-18 — cluster-level remote gates arming chip (⛨ GATES).
  onSetGates?: (clusterId: string, enabled: boolean) => void;
  // 2026-06-29 — per-cluster progress-tracking mode (plan / board / both):
  // which standing surface(s) members are nudged to keep current. Takes effect
  // next turn; reversible via the chip.
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
  // Cluster BOARD operator controls. `done` / `archived` stay operator-only:
  // this callback reaches the normal task_ledger_update WS path, not worker
  // peer tools.
  onUpdateTaskStatus?: (workflowId: string, taskId: string, status: LedgerTaskStatus, boardKey?: string) => void;
  // Director/workers Stage H — task run recovery controls in the BOARD drawer.
  onReassignTask?: (workflowId: string, taskId: string, assigneeWorkflowId: string | null, boardKey?: string) => void;
  onReclaimRun?: (clusterId: string, workflowId: string, taskId: string, runId: string, boardKey?: string) => void;
  onTerminateRun?: (clusterId: string, workflowId: string, taskId: string, runId: string, boardKey?: string) => void;
  // Director/workers Stage I — operator-created swarm graph. Client-only
  // slice: build the explicit graph request and hand it to the cluster sender.
  onCreateSwarm?: (clusterId: string, workflowId: string, request: ClusterSwarmCreateRequest) => void;
  // 2026-05-11 — cluster-context PLAN tab pills. SPAWN PHASE creates a fresh
  // member off the cluster's template; REVIEW/VERIFY pop a member picker
  // and reuse the existing ReviewDialog (rides on the picked member's
  // attached plan, since cluster-plan bodies aren't backed by a `.md` file).
  onSpawnPhase?: (
    newConfig: WorkflowConfig,
    newDirection: string,
    includePlan: boolean,
    joinClusterId: string,
  ) => void;
  onReviewMember?: (
    workflowId: string,
    reviewer: { provider: ProviderName; model: ModelName; effort: EffortLevel },
    contextRef: ReviewContextRef,
    includeGitDiff: boolean,
  ) => void;
  // Cancel an in-flight review from the REVIEWS sub-tab. Cluster ops route
  // to the per-workflow `review_cancel` WS message — the reviewer is a
  // sub-worker of the reviewed member, so cancellation is keyed by
  // (workflowId, reviewId), same as the standalone Review tab.
  onCancelReview?: (workflowId: string, reviewId: string) => void;
  // Cancel an in-flight handoff from the cluster-level HANDOFFS tab.
  onCancelHandoff?: (workflowId: string, handoffId: string) => void;
  onClearHandoffLock?: (cwd: string, workflowId: string, handoffId?: string) => void;
  // Cluster-routed review (peer_send instead of sub-worker).
  onReviewViaMember?: (
    targetWorkflowId: string,
    reviewerWorkflowId: string,
    contextRef: ReviewContextRef,
    includeGitDiff: boolean,
  ) => void;
  onAttachPlanToMember?: (workflowId: string, planId: string) => void;
  onUpdateMemberPrimary?: (workflowId: string, update: ClusterMemberPrimaryUpdate) => void;
  onAttachCodebaseMemory?: (workflowId: string, indexPath?: string) => void;
  onDetachCodebaseMemory?: (workflowId: string) => void;
  mcp?: McpSenders;
}
