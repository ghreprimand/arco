// ── Operator-armed orchestration assist proposals ──
//
// A model/member may draft coordination ideas only as durable proposals. The
// server never routes, dispatches, or marks work complete from the draft path;
// accepted items are applied later through the ordinary task-ledger mutation
// kernel so `task_ledger_event` remains the source of truth.

import type { EffortLevel, ModelName, ProviderName } from './providers.js';
import type { LedgerTaskStatus, TaskLink } from './tasks.js';

export type OrchestrationAssistKind =
  | 'task_graph'
  | 'assignments'
  | 'swarm'
  | 'recovery'
  | 'synthesis';

export type OrchestrationProposalStatus =
  | 'proposed'
  | 'partially_accepted'
  | 'accepted'
  | 'rejected';

export type OrchestrationInputRefKind =
  | 'plan'
  | 'workflow'
  | 'task'
  | 'run'
  | 'review'
  | 'url'
  | 'text';

export interface OrchestrationInputRef {
  kind: OrchestrationInputRefKind;
  ref: string;
  label?: string;
}

export interface OrchestrationAssistModelRef {
  provider: ProviderName;
  model?: ModelName;
  effort?: EffortLevel;
  providerAccountRef?: string;
  // Optional cluster member whose context/model should be used for the assist
  // turn. Validation is server-side; suggestions do not become routing.
  memberWorkflowId?: string;
}

export type OrchestrationProposalTaskStatus = Exclude<LedgerTaskStatus, 'done' | 'archived'>;

export interface OrchestrationProposalTaskCreateItem {
  id: string;
  type: 'task_create';
  title: string;
  notes?: string;
  priority?: number;
  links?: TaskLink[];
  parentItemIds?: string[];
  parentTaskIds?: string[];
  assignee?: string;
  status?: OrchestrationProposalTaskStatus;
  reviewRequired?: boolean;
  goalMode?: boolean;
  goalMaxTurns?: number;
  worktreeRequired?: boolean;
  rationale?: string;
}

export interface OrchestrationProposalTaskUpdateItem {
  id: string;
  type: 'task_update';
  taskId: string;
  patch: {
    title?: string;
    status?: OrchestrationProposalTaskStatus;
    notes?: string;
    links?: TaskLink[];
    priority?: number;
    parentIds?: string[];
    blockedReason?: string;
    reviewRequired?: boolean;
    goalMode?: boolean;
    goalMaxTurns?: number | null;
    worktreeRequired?: boolean;
    assignee?: string;
  };
  rationale?: string;
}

export interface OrchestrationProposalTaskCommentItem {
  id: string;
  type: 'task_comment';
  taskId: string;
  body: string;
  rationale?: string;
}

export interface OrchestrationProposalNoteItem {
  id: string;
  type: 'note';
  title?: string;
  body: string;
  rationale?: string;
}

export type OrchestrationProposalItem =
  | OrchestrationProposalTaskCreateItem
  | OrchestrationProposalTaskUpdateItem
  | OrchestrationProposalTaskCommentItem
  | OrchestrationProposalNoteItem;

export interface OrchestrationProposalAction {
  action: 'requested' | 'proposed' | 'accepted' | 'rejected';
  workflowId: string;
  at: number;
  itemIds?: string[];
  taskIds?: string[];
  reason?: string;
}

export interface OrchestrationProposal {
  id: string;
  // Client preview store compatibility; equals `id` on the wire.
  proposalId?: string;
  clusterId: string;
  workflowId: string;        // requesting operator/member workflowId
  requestId?: string;
  kind: OrchestrationAssistKind;
  status: OrchestrationProposalStatus;
  prompt: string;
  inputRefs: OrchestrationInputRef[];
  model: OrchestrationAssistModelRef;
  items: OrchestrationProposalItem[];
  rationale?: string;
  raw?: unknown;
  createdAt: number;
  updatedAt: number;
  acceptedItemIds?: string[];
  rejectedAt?: number;
  actions: OrchestrationProposalAction[];
}

export interface ClusterOrchestrationAssistRequestMessage {
  type: 'cluster_orchestration_assist_request';
  clusterId: string;
  workflowId: string;        // requester; must be a current cluster member
  requestId?: string;
  kind?: OrchestrationAssistKind;
  // Existing client sender uses `mode`; server aliases it to `kind`.
  mode?: OrchestrationAssistKind;
  prompt?: string;
  inputRefs?: OrchestrationInputRef[];
  model?: OrchestrationAssistModelRef;
  sourceWorkflowId?: string;
  // Stage K server/shared slice: until the model-call hook lands, smoke can
  // drive the durable proposal kernel by supplying bounded draft content.
  draft?: {
    items: OrchestrationProposalItem[];
    rationale?: string;
    raw?: unknown;
  };
}

export interface ClusterOrchestrationProposalListMessage {
  type: 'cluster_orchestration_proposal_list';
  clusterId: string;
  workflowId: string;        // requester; must be a current cluster member
}

export interface ClusterOrchestrationProposalRejectMessage {
  type: 'cluster_orchestration_proposal_reject';
  clusterId: string;
  workflowId?: string;       // requester; optional on older client builds
  proposalId: string;
  reason?: string;
}

export interface ClusterOrchestrationProposalApplyMessage {
  type: 'cluster_orchestration_proposal_apply';
  clusterId: string;
  workflowId?: string;       // requester; optional on older client builds
  proposalId: string;
  itemIds: string[];
  itemEdits?: Record<string, { title?: string; body?: string }>;
  applyMode?: 'task_kernel' | 'comment';
}

export interface ClusterOrchestrationProposalAcceptMessage {
  type: 'cluster_orchestration_proposal_accept';
  clusterId: string;
  workflowId?: string;
  proposalId: string;
  itemIds: string[];
  itemEdits?: Record<string, { title?: string; body?: string }>;
  applyMode?: 'task_kernel' | 'comment';
}

export interface ClusterOrchestrationAssistStartedMessage {
  type: 'cluster_orchestration_assist_started';
  clusterId: string;
  workflowId: string;
  requestId?: string;
  kind: OrchestrationAssistKind;
  model: OrchestrationAssistModelRef;
  inputRefs: OrchestrationInputRef[];
  startedAt: number;
}

export interface ClusterOrchestrationProposalStartedMessage {
  type: 'cluster_orchestration_proposal_started';
  clusterId: string;
  proposalId: string;
  requestId?: string;
  workflowId?: string;
  sourceWorkflowId?: string;
  provider?: string;
  model?: string;
  effort?: string;
  title?: string;
  rationale?: string;
  inputRefs?: string[];
  createdAt: number;
}

export interface ClusterOrchestrationProposalSnapshotMessage {
  type: 'cluster_orchestration_proposals_snapshot';
  clusterId: string;
  proposals: OrchestrationProposal[];
}

export interface ClusterOrchestrationProposalProposedMessage {
  type: 'cluster_orchestration_proposal_proposed';
  clusterId: string;
  workflowId: string;
  proposal: OrchestrationProposal;
}

export interface ClusterOrchestrationProposalRejectedMessage {
  type: 'cluster_orchestration_proposal_rejected';
  clusterId: string;
  workflowId: string;
  proposalId: string;
  reason?: string;
  at: number;
}

export interface ClusterOrchestrationProposalAppliedMessage {
  type: 'cluster_orchestration_proposal_applied';
  clusterId: string;
  workflowId: string;
  proposalId: string;
  itemIds: string[];
  taskIds: string[];
  at: number;
}
