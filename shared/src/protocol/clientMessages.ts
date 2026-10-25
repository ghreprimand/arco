// ── Client → Server messages ──

import type { OperatorQuestionReplyMessage } from './operatorQuestions.js';
import type { VoiceToolResultMessage, ComputerContextControlMessage } from './voiceOperator.js';

import type { HubLinkSetEnabledMessage } from './remoteManagement.js';
import type {
  BakeoffCleanupMessage,
  BakeoffListMessage,
  BakeoffPromoteMessage,
  BakeoffStartMessage,
} from './bakeoffs.js';
import type { EffortLevel, ModelName, ProviderName } from './providers.js';
import type { WorkflowConfig, ToolPosture, ArcoSkillRef } from './workflows.js';
import type { ReviewRequestMessage, CancelReviewMessage } from './reviews.js';
import type { ResearchRequestMessage, CancelResearchMessage } from './research.js';
import type {
  CompareRequestMessage,
  CompareVoteMessage,
  CompareSynthesizeMessage,
  CancelCompareMessage,
} from './compare.js';
import type { DocEditRequestMessage } from './docEdit.js';
import type { MdTuneupRequestMessage, MdTuneupAcceptMessage, MdTuneupCandidatesRequestMessage } from './mdTuneup.js';
import type { KnowledgeDistillRequestMessage } from './knowledge.js';
import type { SetNotificationMutesMessage } from './notifications.js';
import type { CookbookRecommendRequestMessage, CookbookDownloadRequestMessage, CookbookCancelDownloadMessage } from './cookbook.js';
import type { RecallSummaryRequestMessage } from './recall.js';
import type { GenesisSeedUpdateMessage, GenesisScaffoldMessage, GenesisCreativeArmMessage, GenesisAssistRequestMessage } from './genesis.js';
import type { PreviewCaptureRequestMessage } from './previewCapture.js';
import type { RevertToCheckpointMessage } from './checkpoints.js';
import type { LiveChangesSubscribeMessage, LiveChangesUnsubscribeMessage } from './liveChanges.js';
import type { TerminalOpenMessage, TerminalKillMessage, TerminalCommandMessage, TerminalListMessage } from './terminal.js';
import type {
  ClusterOrchestrationAssistRequestMessage,
  ClusterOrchestrationProposalAcceptMessage,
  ClusterOrchestrationProposalApplyMessage,
  ClusterOrchestrationProposalListMessage,
  ClusterOrchestrationProposalRejectMessage,
} from './orchestrationAssist.js';
import type {
  TaskLedgerCreateMessage,
  TaskLedgerUpdateMessage,
  TaskLedgerDeleteMessage,
  TaskLedgerListMessage,
  TaskRunRecoverMessage,
  TaskWorktreeCreateMessage,
  TaskWorktreeRemoveMessage,
} from './tasks.js';
import type {
  McpRegistryCreateMessage,
  McpRegistryUpdateMessage,
  McpRegistryDeleteMessage,
  McpRegistryListMessage,
  McpWorkflowAllowMessage,
  McpProbeMessage,
} from './mcp.js';
import type {
  HandoffRequestMessage,
  HandoffCancelMessage,
  HandoffLockClearMessage,
  SpawnFromHereRequestMessage,
} from './handoffs.js';
import type {
  PlanAttachMessage,
  PlanDetachMessage,
  EnterPlanModeRequestMessage,
} from './plans.js';
import type {
  ClusterSubscribeMessage,
  ClusterMemberRehydrateMessage,
  ClusterUnsubscribeMessage,
  ClusterCreateMessage,
  ClusterDeleteMessage,
  ClusterBroadcastMessage,
  ClusterDispatchOnceMessage,
  ClusterDispatchToggleMessage,
  ClusterDispatchSettingsUpdateMessage,
  ClusterTaskBoardAttachSetMessage,
  ClusterTaskBoardModeSetMessage,
  ClusterSwarmCreateMessage,
  OperatorPeerSendMessage,
  ClusterRenameMessage,
  ClusterMemberRemoveMessage,
  ClusterMemberAddMessage,
  ClusterCreateWithFreshWorkersMessage,
  ClusterCreateFromScratchMessage,
  ClusterAddFreshWorkersMessage,
  ClusterMemberReplaceMessage,
  ClusterPlanSetMessage,
  ClusterPlanAttachMessage,
  ClusterPlanClearMessage,
  ClusterMemberRoleSetMessage,
  ClusterMemberTierSetMessage,
  ClusterMemberFocusSetMessage,
  ClusterIdleNudgerToggleMessage,
  ClusterEfficiencySetMessage,
  ClusterRemoteSetMessage,
  ClusterGatesSetMessage,
  ClusterMemberReorderMessage,
  ClusterProgressSetMessage,
  RenameWorkflowMessage,
  AttachCodebaseMemoryMessage,
  DetachCodebaseMemoryMessage,
  ClusterAutoTurnToggleMessage,
  DebugClusterAutoTurnInjectMessage,
  ClusterSnapshotSaveMessage,
  ClusterSnapshotListMessage,
  ClusterSnapshotRestoreMessage,
  ClusterSnapshotDeleteMessage,
} from './clusters.js';

export interface CreateWorkflowMessage {
  type: 'create_workflow';
  config: WorkflowConfig;
}

export interface UserMessage {
  type: 'user_message';
  workflowId: string;
  content: string;
  attachments?: string[]; // file paths on server
  // Client-generated UUID mirrored back on the `user_message_echo` broadcast so
  // the originating tab can dedup its own prompts against the server's echo
  // (which is what persists them into events.jsonl for durable replay).
  clientMessageId?: string;
  // Set when the operator sent this mid-turn (server is busy). The server
  // enqueues rather than rejecting; the queue is drained as the next
  // primary turn's prompt when the current one completes. Matches Claude
  // Code terminal's mid-turn queue behaviour.
  interjection?: boolean;
  // Phase 4 — operator's intent for this mid-turn message. 'steer' = "do this
  // now / change direction"; 'follow-up' = "after the current task lands."
  // Phase 4 ships visible/rebindable; underlying delivery for every provider
  // is still post-turn. Phases 5–7 turn on real mid-turn delivery for
  // 'steer' per provider. Default = 'follow-up' for back-compat with
  // pre-Phase-4 clients (matches today's silent post-turn delivery).
  kind?: 'steer' | 'follow-up';
  // OUTPUT_STYLE_PLAN.md §6 — set by the in-tab DOCS / GIT composer dialogs
  // so the server forces `outputStyle: 'normal'` on this single turn even
  // when the tab's WorkflowConfig pins lite/terse. Hard-coded; not a
  // free-form knob. Other primitive sites (Review, Handoff seed) bypass
  // this path and force normal at their own spawn sites.
  primitive?: 'docs' | 'git';
  // DD8 — operator-picked Arco skills to inline into THIS turn. Each skill's
  // full SKILL.md body is folded into the model prompt server-side (no Read
  // round-trip), so this is how operator-only skills (withheld from the model
  // manifest) get applied. Resolved + inlined in handleUserMessage; the chat
  // echo stays compact (the operator's raw text only).
  pickedSkills?: Array<{ scope: 'project' | 'global'; slug: string }>;
}

export interface CancelMessage {
  type: 'cancel';
  workflowId: string;
}

// Operator-triggered in-place compaction. Provider-routed: Claude Native and
// Z.ai Native run one Arco-owned summarization round and replace retained
// native history with a summary seed; Codex app-server and Z.ai appserver
// fallback fire `thread/compact/start` against the live Codex thread. Far
// cheaper than a handoff: same tab, no portable doc, no fresh worker.
export interface CompactWorkflowMessage {
  type: 'compact_workflow';
  workflowId: string;
}

// §2.1 — operator-triggered Fold (Claude Native only). A deterministic, instant
// in-place context trim that continues the same session (no LLM round, no fresh
// worker). Gated server-side on provider=claude + transport=native + idle.
export interface FoldWorkflowMessage {
  type: 'fold_workflow';
  workflowId: string;
  // 'server' = Server Fold: one on-demand compaction call
  // (`compact-2026-09-04`) that keeps recent turns verbatim; any failure falls
  // back to the deterministic Fold. Absent ⇒ deterministic (unchanged).
  engine?: 'deterministic' | 'server';
}

// §4.1 — operator set the per-tab tool posture (full/coding/chat/review).
// SESSION-LOCAL + NON-PERSISTENT: the server sets WorkflowState.toolPosture
// (never meta.json) and acks via posture_set; takes effect on the next turn.
export interface SetToolPostureMessage {
  type: 'set_tool_posture';
  workflowId: string;
  posture: ToolPosture;
}

// DD7 — operator answered the project-trust prompt for a cwd. Records the
// decision in ~/.arco/trust.json keyed by canonical path, so future turns
// (and cluster peers sharing the cwd) honor it without re-prompting. `decision`
// 'always' ⇒ the repo's CLAUDE.md / project skills / project settings layer is
// folded into turns; 'never' ⇒ permanently suppressed (no further prompts).
// Reversible: a later 'always'/'never' overwrites the entry. `cwd` is the path
// to record; `workflowId` is only for the ack echo / events.jsonl attribution.
export interface SetProjectTrustMessage {
  type: 'set_project_trust';
  workflowId: string;
  cwd: string;
  decision: 'always' | 'never';
}

// Operator pulled a queued mid-turn message out of the pending interjection
// queue before it fired. Identified by the same `clientMessageId` the client
// minted for the original `user_message`. Server splices it from
// `pendingInterjections` and broadcasts `queued_message_cancelled` so every
// observer (and replay) removes it from chat.
export interface CancelQueuedMessageMessage {
  type: 'cancel_queued_message';
  workflowId: string;
  clientMessageId: string;
}

// Operator closed the tab. Server tears down any in-flight worker, drops the
// in-memory WorkflowState, and releases observer references. On-disk state
// under `.arco/workflows/<id>/` is preserved — the Resume picker can
// re-attach later. See INTERFACE_FIXES_PLAN.md Fix 2.
export interface RemoveWorkflowMessage {
  type: 'remove_workflow';
  workflowId: string;
}

// First message after `connected`. Carries this browser's local non-incognito
// tabs; the server merges them in only when `adopt` (this browser has never
// synced) or the server's workspace is unseeded, then answers with
// `workspace_snapshot`, which the client reconciles to before rehydrating.
export interface WorkspaceSyncMessage {
  type: 'workspace_sync';
  adopt: boolean;
  workflows: Array<{ workflowId: string; config: WorkflowConfig; parentWorkflowId?: string }>;
  clusterIds: string[];
}

// Sent on reconnect to re-register workflows the server has forgotten.
// `lastSeq` is the highest server-stamped seq the client has observed for this
// workflow (persisted to localStorage). Server replays events.jsonl entries
// with seq > lastSeq before emitting the state snapshot for lossless reconnect.
export interface RehydrateWorkflowsMessage {
  type: 'rehydrate_workflows';
  workflows: Array<{
    workflowId: string;
    config: WorkflowConfig;
    currentSessionId: string;
    lastSeq?: number;
    // First sight of a workspace-mirrored tab in this browser: replay only
    // the recent tail (server replayTailEvents) instead of seq 0 onward.
    tail?: boolean;
  }>;
}

export interface UploadCompleteMessage {
  type: 'upload_complete';
  fileId: string;
  filename: string;
  path: string;
}

// Live, same-provider edit of a workflow's primary model or effort. Provider
// stays pinned because the session UUID belongs to one CLI. The next primary
// turn spawns with the updated values; no session rotation needed.
export interface UpdatePrimaryConfigMessage {
  type: 'update_primary_config';
  workflowId: string;
  model?: ModelName;
  effort?: EffortLevel;
  // Provider-account profile id selected for this workflow. v1 is wired for
  // Codex; Claude keeps the field reserved until its native auth store is
  // made profile-aware.
  providerAccountRef?: string;
  // Phase 3 — update auto-handoff config without a provider/model change.
  // WP5 — `mode` + `summarizer` carry the operator's per-tab handoff-mode and
  // fresh-summarizer model choices (see WorkflowConfig.autoHandoff).
  autoHandoff?: {
    enabled: boolean;
    warnAt: number;
    autoAt: number;
    mode?: 'original-worker' | 'fresh-summarizer';
    summarizer?: { provider: ProviderName; model?: ModelName; effort?: EffortLevel };
  };
  // §2.1 — update per-tab auto-fold config (Claude Native). Off by default;
  // foldAt is the budget-meter pct that triggers an in-place Fold (below
  // autoHandoff.warnAt). Persists to meta.json + WorkflowConfig.autoFold.
  autoFold?: {
    enabled: boolean;
    foldAt: number;
    tailBudget?: number;
  };
  // GOAL_RUN_PLAN.md — arm / re-arm / disarm the north-star auto-continue.
  // `{ enabled: true, total }` arms for `total` iterations (re-arming resets
  // the counters, which is how the operator extends a run); `{ enabled: false }`
  // stops it immediately. The server refuses to arm without a north star set.
  goalRun?: {
    enabled: boolean;
    total?: number;
    tokenBudget?: number;
  };
  // Phase 6e — per-tab Codex transport override. `'appserver'` opts the tab
  // into the long-lived `codex app-server` worker; `'exec'` keeps the per-turn
  // worker. Only honored on Codex tabs; other providers ignore. Takes effect
  // on the next operator turn — an active app-server child stays up until the
  // tab closes (or the next turn picks the new transport up). Persists into
  // meta.json + WorkflowConfig.codexTransport so it survives server restart.
  codexTransport?: 'exec' | 'appserver';
  // Per-tab Codex context policy. MAX is Arco's default; STANDARD leaves
  // Codex on its smaller catalog default. Takes effect on the next turn.
  codexContextPolicy?: 'max' | 'standard';
  // Phase 7a — per-tab Claude transport override. `'native'` opts the
  // tab into the long-lived in-process Anthropic-API worker; `'cli'`
  // keeps the per-turn `claude` CLI spawn. Symmetric with codexTransport
  // above. Persists to meta.json + WorkflowConfig.claudeTransport.
  claudeTransport?: 'cli' | 'native';
  // ULTRACODE_PLAN.md — sticky ultracode toggle. True forces every Claude turn
  // onto the CLI transport with the Workflow tool + xhigh; false restores the
  // tab's stored claudeTransport. Persists to meta.json + WorkflowConfig.ultracode.
  // Only meaningful for primaryProvider='claude'.
  ultracode?: boolean;
  // Per-tab Claude Native web_search/web_fetch per-turn budget (server-tool
  // max_uses). Absent leaves it unchanged; persists to meta.json +
  // WorkflowConfig.webSearchMaxUses. Native-only.
  webSearchMaxUses?: number;
  // Chat-only web-access toggle (WorkflowConfig.chatWebAccess). Persists to
  // meta.json for saved chats; incognito chats hold it in memory only.
  chatWebAccess?: boolean;
  // Z.ai transport selector. 'native' calls Z.ai Chat Completions directly;
  // 'appserver' keeps the legacy Codex app-server proxy path.
  zaiTransport?: 'native' | 'appserver';
  // Phase 7c-followup — Claude Native server-side compaction toggle.
  // Persists to meta.json + WorkflowConfig.claudeNativeCompact. Missing
  // means default-on for Native tabs; explicit false disables it. The server
  // gates emission against the model's catalog capability flag.
  claudeNativeCompact?: boolean;
  // Claude Native debug override. Default false: adaptive-thinking models
  // skip `interleaved-thinking-2025-05-14` because interleaving is automatic.
  // True forces the beta on the next turn for A/B testing.
  claudeNativeForceInterleavedThinkingBeta?: boolean;
  // Adaptive-thinking display for Claude Native. 'omitted' (default) asks the
  // API for no thinking stream — a long think reads as total silence in the
  // Activity tab. 'summarized' streams summarized thinking back as
  // primary_thinking rows. Persists to meta.json +
  // WorkflowConfig.claudeNativeThinkingDisplay. Native-only; takes effect
  // next turn. No effect on budget-thinking models (always summarized).
  claudeNativeThinkingDisplay?: 'omitted' | 'summarized' | 'updates';
  // NATIVE_COMPACTION_PLAN Phase 3 — opt-in auto-continue after a Native
  // compaction. Persists to meta.json + WorkflowConfig.nativeCompactAutoContinue.
  // Default false (manual resume); Native-only.
  nativeCompactAutoContinue?: boolean;
  // EFFICIENCY_PLAN.md Phase C — Native tool-result filter mode toggle.
  // Persists to meta.json + WorkflowConfig.efficiencyToolFilter. Only
  // honored on Native transport; CLI/Codex ignore.
  efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive';
  // EFFICIENCY_PLAN.md Phase D — fact-force first-edit gate toggle. Persists
  // to meta.json + WorkflowConfig.efficiencyFactForce. Native-only.
  efficiencyFactForce?: 'on' | 'off';
  // Config-protection write-gate toggle. Persists to meta.json +
  // WorkflowConfig.efficiencyConfigProtection. Native-only; default 'on'
  // (the gate is a safety default — the operator flips to 'off' to relax it
  // for one workflow). Takes effect on the next turn.
  efficiencyConfigProtection?: 'on' | 'off';
  // EFFICIENCY_PLAN.md Phase E — opt-in sandbox tools toggle. Persists to
  // meta.json + WorkflowConfig.efficiencySandbox. Native-only; CLI / Codex /
  // Gemini ignore. Takes effect on the next turn (tool surface is rebuilt
  // per turn). Default 'off'; flip via the CONFIG-tab toggle.
  efficiencySandbox?: 'off' | 'on';
  // DEBAG_PLAN.md — operator-armed durable review-gate toggle. Persists to
  // meta.json + WorkflowConfig.reviewSafeMode. Native-only; CLI / Codex /
  // Gemini ignore. Takes effect on the next turn. Default 'off'.
  reviewSafeMode?: 'off' | 'on';
  // OUTPUT_STYLE_PLAN.md — per-tab output-style picker. Persists to
  // meta.json + WorkflowConfig.outputStyle. Only honored on Native
  // transport; CLI/Codex/Gemini ignore. Takes effect on the next turn.
  // Renamed from `caveman` → `terse` 2026-05-10 for operator UX clarity;
  // legacy `caveman` accepted on the wire for back-compat (server
  // aliases to `terse` on rehydrate).
  outputStyle?: 'normal' | 'lite' | 'terse';
  // GOAL_NORTHSTAR_PLAN.md — operator-set persistent north-star. Persists to
  // meta.json + WorkflowConfig.goal; injected as a stable system block every
  // turn on every transport that folds clusterPlan. An empty / whitespace-only
  // string CLEARS it (server deletes the field) — symmetric with the picker's
  // "off". Cap GOAL_MAX_BYTES = 2048 (server trims + soft-warns). Takes effect
  // on the next turn (system block is rebuilt per turn).
  goal?: string;
  // Replace the tab's complete pinned-skill set. Empty clears it. The server
  // validates + resolves these references before persisting them.
  pinnedSkills?: ArcoSkillRef[];
  // REMOTE_MANAGEMENT.md §1.4 — per-workflow hub opt-in (`REMOTE CONTINUATION`).
  // Persists to meta.json + WorkflowConfig.remoteEnabled. Default false. Flipping
  // it re-pushes the hub snapshot immediately and re-broadcasts hub_link_status
  // (so the header monitored-count updates). See server/src/management/initHubLink.ts.
  remoteEnabled?: boolean;
  // R1 (REMOTE_CLUSTER_CONTROL_PLAN.md §9.2) — second arming for remote DEBAG
  // gate resolution (approve/reject from the phone). Default false; persists to
  // meta.json + WorkflowConfig.remoteGatesEnabled. Flipping re-pushes the hub
  // snapshot so the console's gate buttons appear/disappear at once.
  remoteGatesEnabled?: boolean;
  // LOCAL_AI_MASTER_PLAN.md M3 — per-tab Ollama generation-param preset blob.
  // Replaces the whole blob (not a patch): the CONFIG-tab affordance sends the
  // full edited record so an operator can clear a field by dropping the key.
  // Persists to meta.json + WorkflowConfig.ollamaParams. Only honored on Ollama
  // tabs; merged into /api/chat through the typed allowlist (num_ctx
  // trusted-only). A change is treated as a prefix-cache invalidation event and
  // logged, mirroring the effort-switch handling.
  ollamaParams?: Record<string, unknown>;
}

// Operator asked for the previous page of chat history. On initial load the
// Claude session JSONL watcher emits only the tail (last N raw entries) so
// huge sessions hydrate quickly; clicking the "Load earlier messages" pill
// sends this so the server pops the next N and emits them as `session_entry`.
// Transcript (REST) pagination is separate — see `/api/transcript` `before`
// query param.
export interface LoadEarlierMessagesMessage {
  type: 'load_earlier_messages';
  workflowId: string;
}

// Operator-triggered ground-truth context calibration. Normally calibration
// fires automatically when a turn crosses into an uncalibrated zone (E/A/B/C);
// this lets the operator force one now — useful after a long run of tool
// turns changed the bytes-per-token ratio, or to refresh a stale reading. The
// server runs `claude --print /context` on the pinned session, updates the
// ratio/overhead, persists to meta.json, and broadcasts a fresh context_usage.
export interface RecalibrateRequestMessage {
  type: 'recalibrate_request';
  workflowId: string;
}

// Antigravity-only: forget the currently stored cascade id. The next primary
// turn starts a fresh Antigravity cascade; this does not compact or inspect
// Antigravity's internal context/cache.
export interface FreshAntigravityCascadeMessage {
  type: 'fresh_antigravity_cascade';
  workflowId: string;
}

// Preview tab — operator binds a port for the dev server the agent is running.
// Server persists to meta.json, tracks it on WorkflowState, and rebroadcasts as
// `preview_set` so every observer (and replay) hydrates the iframe target.
// `manual: true` records that the operator typed it; reserved for a future
// auto-detect path that would set `manual: false`.
export interface SetPreviewPortMessage {
  type: 'set_preview_port';
  workflowId: string;
  port: number;
  framework?: string;
  manual?: boolean;
}

export interface ClearPreviewPortMessage {
  type: 'clear_preview_port';
  workflowId: string;
}

// Phase 7b — Claude Native AskUserQuestion reply. Pairs with the
// `[ASK:claude-native:<questionId>]` system_notice the worker emits when
// the model calls AskUserQuestion. The composer-prompt UI submits this
// when the operator answers; the worker resolves the awaiting tool-result
// promise so the agent loop continues.
export interface AskUserQuestionReplyMessage {
  type: 'ask_user_question_reply';
  workflowId: string;
  questionId: string;
  reply: string;
}

// DEBAG (docs/DEBAG_PLAN.md) — operator resolves a parked review gate. `approve`
// runs the call (with `finalArgs` if the operator edited the proposal in
// sub-phase 3, else the original proposal); `reject` refuses it and the model
// continues. `gateId` is the tool_use id the matching `gate_required` carried.
export interface GateReplyMessage {
  type: 'gate_reply';
  workflowId: string;
  gateId: string;
  decision: 'approve' | 'reject';
  finalArgs?: Record<string, unknown>;
  // Sub-phase 5 — "approve all like this": persist a standing approval keyed by
  // the call's non-lossy signature so identical future calls auto-approve.
  // Honored only on an UNEDITED approve (the signature must match what runs).
  remember?: boolean;
}

// DEBAG sub-phase 5 — operator revokes a standing approval by its signature.
export interface GateRevokeRequestMessage {
  type: 'gate_revoke';
  workflowId: string;
  signature: string;
}

// Phase 8 — operator pinned a label to a prior event from the HISTORY tab.
// Server validates (text ≤ 200 chars, targetEventSeq exists in events.jsonl),
// then broadcasts `operator_label` so it persists to events.jsonl and shows
// up on every observer's HISTORY timeline. v1 is append-only — no edit/delete.
export interface CreateLabelRequestMessage {
  type: 'create_label_request';
  workflowId: string;
  text: string;
  targetEventSeq: number;
}

// PHASE_9_FORKS_PLAN.md — operator clicked REWIND CONVERSATION in HISTORY,
// moving the workflow's live head to an earlier transcript point. The server
// validates (targetSeq in-range, workflow not busy), appends a durable
// `leaf_move` event, and sets meta.leafSeq. The next turn forks a child of
// `targetSeq`; the abandoned branch stays byte-identical on disk. Deliberately
// NOT `revert_to_checkpoint` (that is the git working-tree restore).
export interface RevertToPointRequestMessage {
  type: 'revert_to_point_request';
  workflowId: string;
  targetSeq: number;
}

// Dev/smoke-only test hook: directly invokes the registered Claude Native
// `EnterPlanMode` broadcast for a workflow with a caller-provided plan body,
// without going through a real Anthropic API turn. Gated server-side on
// `process.env.ARCO_TEST === '1'`. Used by scripts/smoke/phase-2.6.ts to
// verify the cluster-member auto-attach gate fires `plan_candidate_ready`
// instead of `plan_attached` — without burning real API spend.
export interface DebugNativePlanSetMessage {
  type: '__debug_native_plan_set';
  workflowId: string;
  plan: string;
}

// NATIVE_COMPACTION_PLAN Phase 2 — dev/smoke-only hook. Seeds the cached Claude
// Native worker with a caller-provided history, sets the workflow's
// lastContextPercent + efficiencyAutoCompact mode, then runs the real
// `maybeAutoCompactNative` trigger at a synthetic turn boundary. The probe
// worker uses a canned summary (no Anthropic API call), so the smoke can assert
// the real native_compacted emission + keep-tail + bounded-once behavior without
// spend. Gated server-side on `process.env.ARCO_TEST === '1'`. Used by
// scripts/smoke/native-auto-compact.ts.
export interface DebugNativeAutoCompactProbeMessage {
  type: '__debug_native_auto_compact_probe';
  workflowId: string;
  // Conversation history to seed (clean user/assistant shape; the probe accepts
  // tool_use blocks too so the keep-tail projection can be exercised).
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  // Window-relative context fill % the trigger reads (wf.lastContextPercent).
  contextPercent: number;
  mode: 'off' | 'conservative' | 'aggressive';
}

export type ClientMessage =
  | ComputerContextControlMessage
  | CreateWorkflowMessage
  | UserMessage
  | CancelMessage
  | CompactWorkflowMessage
  | FoldWorkflowMessage
  | SetToolPostureMessage
  | SetProjectTrustMessage
  | RemoveWorkflowMessage
  | RehydrateWorkflowsMessage
  | WorkspaceSyncMessage
  | UploadCompleteMessage
  | ReviewRequestMessage
  | CancelReviewMessage
  | ResearchRequestMessage
  | CancelResearchMessage
  | CompareRequestMessage
  | CompareVoteMessage
  | CompareSynthesizeMessage
  | CancelCompareMessage
  | DocEditRequestMessage
  | MdTuneupRequestMessage
  | MdTuneupAcceptMessage
  | MdTuneupCandidatesRequestMessage
  | KnowledgeDistillRequestMessage
  | CookbookRecommendRequestMessage
  | CookbookDownloadRequestMessage
  | CookbookCancelDownloadMessage
  | RecallSummaryRequestMessage
  | HandoffRequestMessage
  | HandoffCancelMessage
  | HandoffLockClearMessage
  | SpawnFromHereRequestMessage
  | UpdatePrimaryConfigMessage
  | CancelQueuedMessageMessage
  | LoadEarlierMessagesMessage
  | RecalibrateRequestMessage
  | FreshAntigravityCascadeMessage
  | PlanAttachMessage
  | PlanDetachMessage
  | SetPreviewPortMessage
  | ClearPreviewPortMessage
  | OperatorQuestionReplyMessage
  | VoiceToolResultMessage
  | AskUserQuestionReplyMessage
  | GateReplyMessage
  | GateRevokeRequestMessage
  | EnterPlanModeRequestMessage
  | CreateLabelRequestMessage
  | RevertToPointRequestMessage
  | ClusterSubscribeMessage
  | ClusterMemberRehydrateMessage
  | ClusterUnsubscribeMessage
  | ClusterCreateMessage
  | ClusterDeleteMessage
  | ClusterBroadcastMessage
  | ClusterDispatchOnceMessage
  | ClusterDispatchToggleMessage
  | ClusterDispatchSettingsUpdateMessage
  | ClusterTaskBoardAttachSetMessage
  | ClusterTaskBoardModeSetMessage
  | ClusterSwarmCreateMessage
  | ClusterOrchestrationAssistRequestMessage
  | ClusterOrchestrationProposalListMessage
  | ClusterOrchestrationProposalRejectMessage
  | ClusterOrchestrationProposalAcceptMessage
  | ClusterOrchestrationProposalApplyMessage
  | OperatorPeerSendMessage
  | ClusterRenameMessage
  | ClusterMemberRemoveMessage
  | ClusterMemberAddMessage
  | ClusterCreateWithFreshWorkersMessage
  | ClusterCreateFromScratchMessage
  | ClusterAddFreshWorkersMessage
  | ClusterMemberReplaceMessage
  | ClusterPlanSetMessage
  | ClusterPlanAttachMessage
  | ClusterPlanClearMessage
  | ClusterMemberRoleSetMessage
  | ClusterMemberTierSetMessage
  | ClusterMemberFocusSetMessage
  | ClusterIdleNudgerToggleMessage
  | ClusterEfficiencySetMessage
  | ClusterRemoteSetMessage
  | ClusterGatesSetMessage
  | ClusterMemberReorderMessage
  | ClusterProgressSetMessage
  | ClusterSnapshotSaveMessage
  | ClusterSnapshotListMessage
  | ClusterSnapshotRestoreMessage
  | ClusterSnapshotDeleteMessage
  | RenameWorkflowMessage
  | AttachCodebaseMemoryMessage
  | DetachCodebaseMemoryMessage
  | DebugNativePlanSetMessage
  | DebugNativeAutoCompactProbeMessage
  | ClusterAutoTurnToggleMessage
  | DebugClusterAutoTurnInjectMessage
  | RevertToCheckpointMessage
  | LiveChangesSubscribeMessage
  | LiveChangesUnsubscribeMessage
  | TerminalOpenMessage
  | TerminalKillMessage
  | TerminalCommandMessage
  | TerminalListMessage
  | TaskLedgerCreateMessage
  | TaskLedgerUpdateMessage
  | TaskLedgerDeleteMessage
  | TaskLedgerListMessage
  | TaskRunRecoverMessage
  | TaskWorktreeCreateMessage
  | TaskWorktreeRemoveMessage
  | McpRegistryCreateMessage
  | McpRegistryUpdateMessage
  | McpRegistryDeleteMessage
  | McpRegistryListMessage
  | McpWorkflowAllowMessage
  | McpProbeMessage
  | GenesisSeedUpdateMessage
  | GenesisScaffoldMessage
  | GenesisCreativeArmMessage
  | GenesisAssistRequestMessage
  | PreviewCaptureRequestMessage
  | BakeoffListMessage
  | BakeoffStartMessage
  | BakeoffPromoteMessage
  | BakeoffCleanupMessage
  | SetNotificationMutesMessage
  | HubLinkSetEnabledMessage;
