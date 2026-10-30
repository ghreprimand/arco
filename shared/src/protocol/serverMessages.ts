import type { OutputSavedMessage } from '../outputs.js';
// ── Server → Client messages ──

import type { OperatorQuestionMessage, OperatorQuestionReplyResultMessage, OperatorQuestionState } from './operatorQuestions.js';
import type { VoiceToolCallMessage, ComputerContextUpdatedMessage, ComputerActivityChangedMessage } from './voiceOperator.js';

import type { HubLinkStatusMessage } from './remoteManagement.js';
import type {
  BakeoffAttemptsRemovedMessage,
  BakeoffErrorMessage,
  BakeoffListResultMessage,
  BakeoffStateMessage,
} from './bakeoffs.js';
import type { PrimaryPhase, ProviderName } from './providers.js';
import type { GenerationSpeed, TokenUsage } from './usage.js';
import type { AuthRecoveryContext, Capabilities, CliChangeEntry } from './models.js';
import type { ChatMessage } from './chat.js';
import type { WorkflowConfig, WorkflowSessionMetadata, WorkspaceSnapshotPayload } from './workflows.js';
import type { PermissionDenial, PrimaryBackgroundJob, WorkerState } from './workers.js';
import type { ReviewStartedMessage, ReviewArtifactReadyMessage } from './reviews.js';
import type { ResearchStartedMessage, ResearchProgressMessage, ResearchCompleteMessage } from './research.js';
import type {
  CompareStartedMessage,
  CompareLegDeltaMessage,
  CompareLegCompleteMessage,
  CompareCompleteMessage,
  CompareVoteRecordedMessage,
} from './compare.js';
import type { ProviderFellBackMessage } from './fallback.js';
import type { DiagnosticsMessage } from './diagnostics.js';
import type { DocEditStartedMessage, DocEditProposedMessage } from './docEdit.js';
import type { MdTuneupStartedMessage, MdTuneupProposedMessage, MdTuneupAppliedMessage, MdTuneupCandidatesMessage } from './mdTuneup.js';
import type { KnowledgeDistillStartedMessage, KnowledgeDistillProposedMessage } from './knowledge.js';
import type { CookbookDownloadProgressMessage } from './cookbook.js';
import type { RecallSummaryReadyMessage } from './recall.js';
import type { WorkbenchNoticeMessage, NotificationMutesMessage } from './notifications.js';
import type {
  HandoffStartedMessage,
  HandoffArtifactReadyMessage,
  HandoffCompleteMessage,
  HandoffLockSnapshotMessage,
  SpawnFromHereCompleteMessage,
} from './handoffs.js';
import type { CheckpointCreatedMessage, CheckpointRevertedMessage } from './checkpoints.js';
import type { LiveChangesSnapshotMessage } from './liveChanges.js';
import type { GitOpResultMessage } from './gitOps.js';
import type { MediaOpResultMessage, MediaStemsResultMessage } from './media.js';
import type { TerminalOpenedMessage, TerminalKilledMessage, TerminalCommandLoggedMessage, TerminalSessionsMessage } from './terminal.js';
import type { TaskLedgerSnapshotMessage, TaskLedgerEventMessage } from './tasks.js';
import type { McpRegistrySnapshotMessage, McpProbeResultMessage, McpAllowSnapshotMessage, McpMalwareWarningMessage } from './mcp.js';
import type {
  ClusterOrchestrationAssistStartedMessage,
  ClusterOrchestrationProposalAppliedMessage,
  ClusterOrchestrationProposalProposedMessage,
  ClusterOrchestrationProposalRejectedMessage,
  ClusterOrchestrationProposalSnapshotMessage,
  ClusterOrchestrationProposalStartedMessage,
} from './orchestrationAssist.js';
import type {
  GenesisSeedUpdatedMessage,
  WorkflowCwdBoundMessage,
  GenesisScaffoldedMessage,
  GenesisCreativeArmedMessage,
  GenesisAssistStartedMessage,
  GenesisAssistProposedMessage,
} from './genesis.js';
import type {
  PreviewCaptureStartedMessage,
  PreviewCaptureReadyMessage,
} from './previewCapture.js';
import type {
  PlanAttachedMessage,
  PlanDetachedMessage,
  PlanSetMessage,
  PlanExitedMessage,
  PlanCandidateReadyMessage,
} from './plans.js';
import type {
  PeerMessageSentMessage,
  PeerMessageReceivedMessage,
  PeerSendRejectedMessage,
  ClusterStateMessage,
  ClusterNotFoundMessage,
  ClusterCreatedMessage,
  ClusterDeletedMessage,
  ClusterMemberAddedMessage,
  ClusterMemberRemovedMessage,
  ClusterMemberReplacedMessage,
  ClusterBroadcastDispatchedMessage,
  ClusterDispatchResultMessage,
  ClusterSwarmCreatedMessage,
  ClusterPlanChangedMessage,
  ClusterMemberNudgedMessage,
  WorkflowRenamedMessage,
  CodebaseMemoryStateMessage,
  ClusterAutoTurnFiredMessage,
  ClusterSnapshotListResultMessage,
  ClusterSnapshotSavedMessage,
  ClusterSnapshotConflictMessage,
  ClusterSnapshotErrorMessage,
} from './clusters.js';

export interface ConnectedMessage {
  type: 'connected';
  sessionId: string;
}

// Reply to `workspace_sync` (this socket only) and, as `workspace_changed`,
// fanned to every socket whenever a tab opens or closes anywhere.
export interface WorkspaceSnapshotMessage {
  type: 'workspace_snapshot' | 'workspace_changed';
  workspace: WorkspaceSnapshotPayload;
}

// After update_primary_config lands: the server's resolved config, so browsers
// mirroring the tab (not just the one that made the edit) converge.
export interface WorkflowConfigSyncedMessage {
  type: 'workflow_config_synced';
  workflowId: string;
  config: WorkflowConfig;
}

export interface WorkflowCreatedMessage {
  type: 'workflow_created';
  workflowId: string;
  config: WorkflowConfig;
  resumedVia?: 'native' | 'bootstrapped';
  // Phase 7b — set when this workflow was minted by a Task tool call.
  // Client creates the JobState (so promote can flip it into the top tab
  // strip without a server round-trip) but suppresses tab creation +
  // active-tab switch while it's parented and unpromoted.
  parentWorkflowId?: string;
  // Worktree bake-off attempts are ordinary top-level workflow tabs, but are
  // created as a batch. Keep the source tab focused while they materialize.
  backgroundCreated?: boolean;
  priorClaudeSessionId?: string;
  // Provider-aware prior-session hints. `priorSessionId` is the native CLI
  // session UUID (Claude or Codex) to fetch a transcript for; `priorProvider`
  // tells the client which transcript endpoint flavour to ask for. Kept
  // parallel to `priorClaudeSessionId` rather than replacing it so any
  // older client build still hydrates Claude sessions unchanged.
  priorSessionId?: string;
  priorProvider?: 'claude' | 'codex';
  claudeSessionId?: string;
  sessionMetadata?: WorkflowSessionMetadata;
  // How the client should populate chat history for this workflow:
  //   'events'     — server is streaming events.jsonl replay.
  //   'transcript' — fall back to `/api/transcript?sessionId=<priorSessionId>&provider=<priorProvider>`.
  hydrationSource?: 'events' | 'transcript';
}

// Server echo of a client `user_message`, broadcast via send() so it gets
// seq-stamped and appended to events.jsonl. Makes user prompts durable on
// reconnect / replay.
export interface UserMessageEchoMessage {
  // Server-owned input identity is this echo's stamped workflow sequence.
  ollamaReplayInput?: boolean;
  type: 'user_message_echo';
  workflowId: string;
  content: string;
  attachments?: string[];
  clientMessageId?: string;
  timestamp: number;
  // Phase 4 — present on echoes for queued (mid-turn) messages so the chat
  // surface can render the steer / follow-up / interrupt intent. Absent on
  // the regular first-turn echo (the operator's send wasn't an interjection).
  kind?: 'steer' | 'follow-up' | 'interrupt';
}

export interface PrimaryTextMessage {
  ollamaExecutionId?: string;
  type: 'primary_text';
  workflowId: string;
  text: string;
  phase: PrimaryPhase;
}

export interface PrimaryCompleteMessage {
  ollamaExecutionId?: string;
  type: 'primary_complete';
  workflowId: string;
  phase: PrimaryPhase;
  costUsd: number;
  durationMs: number;
  tokens?: TokenUsage;
  // Provider-reported context window for this turn's model, when available.
  // Codex's `event_msg::token_count.info.model_context_window` lands here and
  // beats the client's hardcoded codexModelWindow() fallback for the CTX
  // bar denominator. Stays sticky on the workflow once observed.
  modelContextWindow?: number;
  // Native/API providers: ground-truth prompt size of the LAST API round-trip
  // in this turn. This is what the model saw as "in context" right before
  // emitting the final answer. Native/API providers may make multiple calls
  // inside one operator turn; aggregate usage is useful telemetry, but this
  // field drives context_usage and resume-time CTX restore.
  lastPromptTokens?: number;
  // Ollama/Strata — daemon-measured decode / prefill speed for the turn.
  genSpeed?: GenerationSpeed;
}

// docs/PROVIDERS.md - hook stdout-parser parity.
// Native worker emits this when a PreToolUse hook returned
// `hookSpecificOutput.updatedInput` and the tool input was actually
// rewritten before dispatch. Persisted to events.jsonl so transcript
// review can attribute rtk-style rewrites back to their origin hook.
// `originalInput` and `rewrittenInput` are JSON-stringified for compact
// rendering; the chat UI shows a "rewritten by hook" chip on the affected
// tool block. Skipped when the hook returned no updatedInput (i.e. the
// hook fired but chose not to rewrite).
export interface HookRewroteInputMessage {
  type: 'hook_rewrote_input';
  workflowId: string;
  toolUseId: string;
  toolName: string;
  hookCommand: string;
  originalInput: string;
  rewrittenInput: string;
}

// docs/PROVIDERS.md - pre-tool-use guard fired on a tool call.
// `gate` identifies the rule (e.g. "config-protection",
// "fact-force-first-edit"). `decision`: "allowed" = guard inspected and
// permitted; "blocked" = synthetic tool_result returned to the model
// without executing; "mutated" = input was modified before dispatch
// (today: only B0's hook updatedInput uses `mutated`, but config-
// protection could grow into the same shape).
export interface ToolGateTriggeredMessage {
  type: 'tool_gate_triggered';
  workflowId: string;
  toolUseId: string;
  toolName: string;
  gate: string;
  decision: 'allowed' | 'blocked' | 'mutated';
  reason: string;
}

// §4.1 — ack/visibility for a posture change. Broadcast (persisted) so the
// posture pick is reviewable in events.jsonl (four-question test) and every
// observer's pill stays in sync. Session-local — not written to meta.json.
export interface ToolPostureSetMessage {
  type: 'tool_posture_set';
  workflowId: string;
  posture: 'full' | 'coding' | 'chat' | 'review';
}

// docs/GOTCHAS.md - ack/visibility for a north-star set/edit/clear.
// Broadcast (persisted to events.jsonl) so the objective is reviewable in the
// transcript (four-question test) and every observer's CONFIG field stays in
// sync. `goal` is null when cleared; `byteLen` is the UTF-8 byte length of the
// stored text (0 on clear). Durable in meta.json ⇒ reversible to byte-identical
// by clearing.
export interface GoalSetMessage {
  type: 'goal_set';
  workflowId: string;
  goal: string | null;
  byteLen: number;
}

// docs/GOTCHAS.md - current state of the north-star auto-continue. Broadcast
// (persisted) on arm, on every tick, and on stop, so the transcript carries the
// full arc of a run and the chip rehydrates from replay. Counters are NOT
// mirrored to meta.json: a server restart ends any armed run, which is the safe
// default — the restart already killed the turn, and silently resuming an
// unattended loop after a deploy is exactly the surprise this feature is
// designed to avoid.
export interface GoalRunStateMessage {
  type: 'goal_run_state';
  workflowId: string;
  enabled: boolean;
  total: number;
  remaining: number;
  tokensUsed: number;
  tokenBudget?: number;
}

// Durable acknowledgement for replacing a tab's pinned Arco skills. The
// event is persisted so pin/unpin actions remain visible in workflow history.
// `bytes` is the current UTF-8 size of the full injected block; editing a
// SKILL.md can change the next turn's size without another pin event.
export interface PinnedSkillsSetMessage {
  type: 'pinned_skills_set';
  workflowId: string;
  skills: Array<{ scope: 'project' | 'global'; slug: string; name: string }>;
  bytes: number;
  missing: string[];
}

// DD7 — project-trust prompt. Raised on a turn whose cwd has project-local
// resources (CLAUDE.md / project skills / .arco/settings.json) AND no recorded
// trust decision (defaultProjectTrust='ask'). The turn STILL PROCEEDS with those
// resources suppressed; this prompt only lets the operator grant trust for
// future turns. `resources` lists the suppressed surfaces for the dialog body.
// Operator-prompt only — never auto-grants. Deduped per cwd while one is pending.
export interface ProjectTrustPromptMessage {
  type: 'project_trust_prompt';
  workflowId: string;
  cwd: string;
  resources: string[];
}

// DD7 — ack/visibility for a recorded trust decision. Broadcast (persisted) so
// the choice is reviewable in events.jsonl (four-question test) and every
// observer dismisses any pending prompt for the cwd. Takes effect next turn.
export interface ProjectTrustSetMessage {
  type: 'project_trust_set';
  workflowId: string;
  cwd: string;
  decision: 'always' | 'never';
}

// §3.1 — the stuck-worker breaker. Cross-turn, cross-provider: the same tool
// call returning the same FAILING result over and over with no success
// interleaved (error-persistence — the only loop signal that survived being
// tested on real logs). Escalation:
//   'detected' — first trip; recommendedAction 'nudge' (heal first, surface it).
//   'persist'  — kept failing past the escalation threshold; recommendedAction
//                'pause' (reversible — a success or the operator's next turn
//                clears it; never a kill).
//   'recovered'— a success interleaved; the breaker cleared its latch.
//   'limit'    — a hard ceiling (RSS cap / MAX_TOOL_TURNS) routed THROUGH the
//                breaker so it surfaces as a structured, visible event instead
//                of a bare kill/error.
// `signature` is hash-only (toolName|inputHash|outputHash) — raw args never leak.
export interface WorkerStuckMessage {
  type: 'worker_stuck';
  workflowId: string;
  // Internal-only: present on the WorkerManager→seedWorker hop (the RSS-cap
  // path emits with a workerId; seedWorker re-stamps workflowId before
  // broadcasting). Never set on the persisted/broadcast form.
  workerId?: string;
  escalation: 'detected' | 'persist' | 'recovered' | 'limit';
  recommendedAction: 'nudge' | 'pause' | 'none';
  toolName?: string;
  signature?: string;
  streak?: number;
  reason: string;
}

// H9 — in-turn tool-loop guardrail (Native). Emitted on the FIRST call where a
// per-turn loop threshold is crossed: the model is re-running the same tool with
// identical args (`identical-repeat`) or getting the byte-identical result back
// and calling again (`no-progress`). `mode` echoes the operator arming —
// 'warn' (default, non-blocking) or 'stop' (the tool loop was aborted). Metadata
// is the tool name + an args HASH only — never the raw args (secrets/large
// pastes), matching the watchdog-instrumentation discipline.
export interface ToolLoopWarningMessage {
  type: 'tool_loop_warning';
  workflowId: string;
  toolUseId: string;
  toolName: string;
  argsHash: string;
  signal: 'identical-repeat' | 'no-progress';
  repeatCount: number;
  sameOutputCount: number;
  mode: 'warn' | 'stop';
}

// DD3 (Phase 3 — cluster correctness) — a Write/Edit had to WAIT for an
// in-flight mutation of the same real file path before it could run. Emitted
// only when a write actually queues behind another (not on every write), so its
// presence in events.jsonl is the signal that two members/Tasks contended for
// one file — exactly the case that used to silently lose a write. `path` is
// cwd-relative for readability; `waitedForMs` is the queue wait the write ate.
export interface FileMutationQueuedMessage {
  type: 'file_mutation_queued';
  workflowId: string;
  toolUseId: string;
  toolName: 'Write' | 'Edit';
  path: string;
  waitedForMs: number;
}

// Opus-5 plan Phase 2 — alias-capability resolution. Emitted by the Claude
// Native worker when the model id Anthropic echoes on message_start differs
// from the id Arco requested — i.e. the tab runs a family alias ('opus',
// 'opus[1m]') that the server resolved to a concrete model. Once per worker
// per distinct resolution, so `opus → claude-opus-5` is an explicit, durable
// release signal in events.jsonl instead of being inferred from behavior
// drift. The worker also persists `served` to meta.json (`resolvedModelId`)
// so a restarted alias tab resolves catalog capabilities (ctx-management /
// compact gating) from the concrete id on turn 1.
export interface ModelResolvedMessage {
  type: 'model_resolved';
  workflowId: string;
  requested: string;
  served: string;
}

// Opus-5 plan Phase 3 — a Native turn ended with stop_reason 'refusal'
// (HTTP 200; Anthropic's safety classifiers declined — NOT an API error, so
// errorClassifier never sees it; previously the turn just ended blank).
// `category` / `explanation` come from stop_details and are both nullable —
// stop_details can be null even on a refusal. `hadPartialOutput`
// distinguishes a mid-stream decline (billed partial kept in history) from a
// pre-output decline (empty content; the per-request scrub patches it before
// the next messages.create). Paired with an operator-facing system_notice.
export interface PrimaryRefusalMessage {
  type: 'primary_refusal';
  workflowId: string;
  category: string | null;
  explanation: string | null;
  hadPartialOutput: boolean;
}

// docs/PROVIDERS.md - worker-authoritative tool-call counter
// since the last context-reshape (auto-threshold `compact` emission OR
// worker rebuild after handoff). Emitted from Claude Native's `dispatchTool`
// after every increment AND after every reset. Drives the composer chip's
// `toolCallsSinceCompact` field: when set, the chip prefers this value over
// the client-side `toolCallsSinceHandoff` recount (which stays as audit
// fallback for non-Native tabs and for the first paint before the worker
// has emitted). Native-only.
export interface PrimaryToolCounterMessage {
  type: 'primary_tool_counter';
  workflowId: string;
  toolCallsSinceCompact: number;
}

// docs/PROVIDERS.md - best-effort UI freshness event fired
// when a ctx_execute call stored a new chunk in the per-tab SQLite index.
// Not load-bearing for correctness (the Files-tab sandbox sub-section
// can also pull `/api/workflows/:wfId/sandbox/stats` on demand); this is
// just the cheap push so the operator sees new chunks appear live.
export interface SandboxChunkAddedMessage {
  type: 'sandbox_chunk_added';
  workflowId: string;
  chunkId: number;
  byteLen: number;
  language: string;
}

// docs/PROVIDERS.md - fired after the operator clicks
// "Clear DB" in the CONFIG tab (POST /api/workflows/:wfId/sandbox/clear)
// and the SQLite chunks table is truncated. Clients drop their local
// `sandboxChunkCount` mirror to zero on receipt.
export interface SandboxDbClearedMessage {
  type: 'sandbox_db_cleared';
  workflowId: string;
}

// docs/PROVIDERS.md - context-management action ledger.
// Emitted from every code path that mutates messages[] in a way the
// operator should be able to see during transcript review. `trigger`:
// "operator" = direct click; "auto-threshold" = Phase 6b.2 auto-compact
// fired its threshold; "model" = the model itself called a context tool
// (reserved; not used today); "recovery" = a deterministic defensive
// repair of in-memory state before an API call (e.g. dropping a trailing
// orphan tool_use left by a cancel-mid-tool turn).
export interface CtxActionMessage {
  type: 'ctx_action';
  workflowId: string;
  action: 'clear_thinking' | 'clear_tool_uses' | 'compact'
        | 'sandbox_redirect' | 'first_edit_gate'
        | 'prune_orphan_tool_use' | 'scrub_empty_text_blocks'
        | 'strip_trailing_thinking'
        // docs/PROVIDERS.md - frozen-prefix deltas + API-side drops.
        | 'system_delta' | 'tool_set_change' | 'turn_notice'
        | 'thinking_dropped_by_api' | 'strip_thinking_binding_mismatch';
  // "api" = Anthropic reported a transformation it applied to the request
  // (input_transformations) — Arco did not mutate anything.
  trigger: 'operator' | 'auto-threshold' | 'model' | 'recovery' | 'api';
  detail?: string;
}

// NATIVE_COMPACTION_PLAN Phase 3 — pre-compaction marker. Emitted by
// `compactInPlace()` BEFORE the (slow, ~1-2 min) summarization round starts, so
// the client can flip a per-workflow `compacting` takeover state — a prominent
// "Compacting conversation…" banner in the chat area, distinct from the small
// `ctx_action` divider, mirroring the CLI's "everything is focused on the
// compaction" feel. Fires for BOTH the manual COMPACT button and the Phase 2
// between-turn auto path (both go through `compactInPlace`, which emits this
// once). `foldedTurns` is the count of operator turns about to be folded
// (cheaply available pre-summary). PERSISTED to events.jsonl like other workflow
// events; advisory on replay (the takeover is live-only — the paired
// `native_compacted` / failure notice clears the flag, and replay never re-opens
// it). Native-only.
export interface NativeCompactingMessage {
  type: 'native_compacting';
  workflowId: string;
  // Operator turns about to be folded into the summary, for the takeover copy
  // ("folding N turns"). Advisory; the takeover renders without it.
  foldedTurns?: number;
}

// Operator-triggered in-place compaction for native transports — the in-Arco
// equivalent of `/compact`. The worker runs one summarization round, REPLACES
// retained native history with the summary, and emits this event. It is
// PERSISTED to events.jsonl and load-bearing on replay: provider replay helpers
// reset at the marker and re-seed `summary` (same reset semantics as a handoff),
// so the compaction survives a server restart / reload. Native-only.
export interface NativeCompactedMessage {
  type: 'native_compacted';
  workflowId: string;
  summary: string;
  // Turns folded into the summary + approximate input tokens before/after, for
  // the operator-facing notice. Advisory; replay only needs `summary`.
  foldedTurns?: number;
  // NATIVE_COMPACTION_PLAN Phase 2 — the keep-last-N verbatim tail. The live
  // worker keeps the last few user/assistant messages after the seed so the
  // active working set survives the fold; those messages occur BEFORE this
  // marker, so replay (which resets at the marker) needs them persisted here.
  // Already projected to the clean resume shape (`user` → string content,
  // `assistant` → single text block) — the same shape replay produces — and
  // re-appended via the SAME `compactSummarySeed` helper at both the live and
  // replay sites, so live and replayed workers land byte-identical. Replay is
  // load-bearing on this (docs/GOTCHAS.md § Claude Native transport).
  keptTail?: Array<{ role: 'user' | 'assistant'; content: string | Array<{ type: 'text'; text: string }> }>;
}

// §2.1 — Fold marker. PERSISTED to events.jsonl and load-bearing on replay:
// like native_compacted, replay resets at the marker and re-seeds `summary` +
// `keptTail` via the SAME compactSummarySeed helper, so the Fold survives a
// server restart byte-identically. Distinct from native_compacted so the
// transcript/UI can tell a deterministic in-place Fold (no model round, instant)
// apart from an LLM /compact, and so the byte-delta fields can drive the
// anti-thrash termination (§2.1 delta 2). Native-only.
export interface ContextFoldedMessage {
  type: 'context_folded';
  workflowId: string;
  // The deterministic digest of the folded prefix (task/files/cmds/searches/
  // errors/recent-asks/open-todos). Re-seeded on replay exactly like
  // native_compacted.summary.
  summary: string;
  // Verbatim recent tail (token-budget bounded), already projected to the clean
  // resume shape — re-appended via compactSummarySeed at both live + replay
  // sites, so the Fold lands byte-identical on restart.
  keptTail?: Array<{ role: 'user' | 'assistant'; content: string | Array<{ type: 'text'; text: string }> }>;
  // Operator-facing + anti-thrash telemetry. `trigger` distinguishes a manual
  // Fold from the auto-fold threshold fire. byteDelta = originalBytes − foldedBytes.
  foldedTurns?: number;
  trigger?: 'operator' | 'auto';
  originalBytes?: number;
  foldedBytes?: number;
  byteDelta?: number;
  // Server Fold (on-demand compaction, `compact-2026-09-04`). Absent ⇒ the
  // deterministic Fold above. When 'server', replay reseeds
  // [assistant{compactionBlock}, ...keptMessages] instead of
  // compactSummarySeed(summary, keptTail); `summary` mirrors the block's text
  // for display / the summary_tail digest.
  engine?: 'server';
  // The signed block exactly as the API returned it ({type:'compaction',
  // content, signature}). Must go back byte-for-byte — any edit is a 400.
  compactionBlock?: { type: 'compaction'; content: string; signature?: string; [key: string]: unknown };
  // Verbatim kept turns (raw Anthropic message shape, thinking + tool blocks
  // included), capped at SERVER_FOLD_TAIL_MAX_BYTES. Deliberately NOT the
  // projected `keptTail`: kept thinking survives only if the messages go back
  // unchanged, so live and replay both consume this raw array.
  keptMessages?: unknown[];
  keptTurns?: number;
  // The summarization call's own spend (from usage.iterations — top-level
  // usage is zero on a compaction response). Client adds it to tab tokens.
  compactionUsage?: { input: number; output: number; cacheRead: number; cacheCreate: number };
}

// docs/PROVIDERS.md - Native tool-result filter fired on a tool
// call. Emitted from `ClaudeNativeWorker.dispatchTool` after the raw output
// is captured and BEFORE it lands in `messages[]`. Cache invariant: the
// filter only ever runs against the current turn's tool_result; prior
// turns are never touched.
//
// `originalBytes !== filteredBytes` ⇒ `rawArtifactPath` is set to the
// gzipped raw output's relative-to-cwd path (e.g.
// `.arco/workflows/<wfId>/artifacts/raw-tools/<turn-id>-<toolUseId>.txt.gz`).
// The chat chip's "expand" affordance fetches this artifact so the
// operator can recover what the model didn't see — reversibility is
// non-negotiable per `docs/ARCHITECTURE.md`
//
// `filterName` is a short stable id (e.g. "cargo-test-drop-passing");
// the chip renders it verbatim. When a pack passes through unchanged
// (same byte count) we still emit so transcript review can confirm
// "filter ran, no change" vs "filter never fired".
export interface ToolFilteredMessage {
  type: 'tool_filtered';
  workflowId: string;
  toolUseId: string;
  toolName: string;
  filterName: string;
  originalBytes: number;
  filteredBytes: number;
  // Set when `originalBytes !== filteredBytes`. Path is workspace-relative
  // (`.arco/workflows/...`); the client resolves against the workflow
  // cwd via the existing artifact-fetch endpoint.
  rawArtifactPath?: string;
}

// §2.2 — tool-result eviction. Emitted when the per-turn aggregate spill
// replaces a large tool result with a semantic 1-liner digest (operator-armed
// via efficiencyToolEvict). Distinct from tool_filtered (which trims a single
// result in place via a configured pack): eviction is the aggregate
// largest-first spill that fires only when a batch's summed cost exceeds the
// turn budget. Raw output is gzipped to rawArtifactPath — fully reversible.
export interface ToolEvictedMessage {
  type: 'tool_evicted';
  workflowId: string;
  toolUseId: string;
  toolName: string;
  originalBytes: number;
  filteredBytes: number;
  // Always set (eviction only fires when it shrinks the result). Workspace-
  // relative path to the gzipped raw output, same convention as tool_filtered.
  rawArtifactPath?: string;
}

// docs/PROVIDERS.md - per-turn token telemetry. Emitted alongside
// every primary_complete. The reason this exists separate from
// primary_complete despite duplicating `tokens`: filtering events.jsonl for
// session-total / per-turn breakdown is meaningfully cleaner with a single
// dedicated kind, and Phase C will add `toolResultBytesRaw` (pre-filter)
// vs `toolResultBytes` (post-filter) which has no place on primary_complete.
// Token fields use Anthropic API ground truth (see docs/PROVIDERS.md);
// byte fields are raw byte sums of
// the relevant content blocks this turn, intentionally labeled "bytes" not
// "tokens" to avoid claiming false token-precision.
export interface PrimaryTurnTokenUsageMessage {
  type: 'primary_turn_token_usage';
  workflowId: string;
  // Wall-clock millis at which the turn started. Used as a stable per-turn
  // identifier within a workflow — pairs with the preceding
  // primary_turn_started.startedAt.
  turnStartedAt: number;
  durationMs: number;
  provider: ProviderName;
  // Identifies the transport that produced this reading. It is optional for
  // historical events that predate transport telemetry.
  transport?: 'native' | 'cli' | 'exec' | 'appserver';
  // Anthropic-shape (Claude): input/cacheRead/cacheCreate are disjoint and
  // sum to the prompt size. OpenAI-shape (Codex): input is the full prompt
  // size, cacheRead is a subset.
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  // Native/API providers: last provider request's full prompt size. This is
  // the same value used for the CTX footer. The input/cacheRead/cacheCreate
  // fields above are turn totals across all provider requests in the user
  // turn, so they can be larger than this when a turn has multiple tool
  // rounds.
  lastPromptTokens?: number;
  // Codex-only: subset of `output` representing reasoning tokens.
  reasoningOutput?: number;
  // Sum of `thinking` content-block bytes appended this turn. Native has
  // direct visibility; CLI/Codex set 0 (we don't see the inner messages
  // array). UI surfaces "—" for 0 to avoid implying "no thinking happened."
  thinkingBytes: number;
  // Sum of `tool_result` content-block bytes appended this turn (post-filter
  // once Phase C lands). Native: real value. CLI/Codex: -1 (unknown — we
  // spawn the CLI but don't see its inner tool dispatch).
  toolResultBytes: number;
  // Pre-filter byte count. Equals toolResultBytes until Phase C. Same -1
  // semantics for CLI/Codex.
  toolResultBytesRaw: number;
  // Native Claude server tools (web_search/web_fetch/etc.) return result
  // blocks inside the assistant message, not as user-side tool_result blocks.
  // Count their serialized bytes separately so Activity can explain cases
  // where the CTX bar jumps despite small local tool_result byte counts.
  serverToolResultBytes?: number;
  // Ollama/Strata — see PrimaryCompleteMessage.genSpeed. Persisted here so a
  // later USAGE roll-up can chart decode speed over a long run.
  genSpeed?: GenerationSpeed;
}

// Fires when the CLI's init event reveals the concrete resolved model
// (e.g. "claude-opus-4-7"), so the UI can upgrade "OPUS" → "OPUS 4.7".
export interface PrimaryModelMessage {
  type: 'primary_model';
  workflowId: string;
  resolvedModel: string;
}

// Primary's interleaved reasoning blocks. Text is delta-streamed (may arrive
// as multiple messages for one reasoning block). Drives the ACTIVITY tab
// "Thinking" pill.
export interface PrimaryThinkingMessage {
  ollamaExecutionId?: string;
  type: 'primary_thinking';
  workflowId: string;
  text: string;
}

// Primary invoked a tool. `input` is JSON-stringified so the ACTIVITY tab can
// render an abbreviated summary (e.g. "Read server/src/index.ts",
// "Grep primary_thinking"). One event per tool call.
export interface PrimaryToolUseMessage {
  ollamaExecutionId?: string;
  type: 'primary_tool_use';
  workflowId: string;
  tool: string;
  input: string;
  status?: 'started' | 'in_progress' | 'completed' | 'failed';
  provider?: ProviderName;
  itemType?: string;
  itemId?: string;
  output?: string;
  exitCode?: number;
  // Watchdog instrumentation — stable, normalized hash of `output` (see
  // server/src/providers/outputSignature.ts). Lets the (not-yet-shipped) worker
  // watchdog detect error-persistence loops: same input + same outputHash +
  // failing status, recurring with no success interleaved = stuck. Populated by
  // claude-native and codex; absent on transports that don't surface output.
  outputHash?: string;
  // Server-minted id per tool call so the background-jobs tracker can
  // attribute new descendant PIDs to the Bash(run_in_background) call that
  // spawned them. Opaque to the client; currently unused there.
  toolUseId?: string;
}

// Fan-out of the current background-jobs list for a workflow. Not persisted
// to events.jsonl — it's live state rebuilt from /proc each tick.
export interface PrimaryActivityMessage {
  type: 'primary_activity';
  workflowId: string;
  jobs: PrimaryBackgroundJob[];
}

// Server-authoritative busy flag. Fires when wf.busy flips true/false around
// runPrimaryTurn. Client uses this to drive the composer status indicator
// (animated verb + elapsed timer) instead of inferring from streaming text.
export interface PrimaryTurnStartedMessage {
  ollamaInputSeqs?: number[];
  ollamaExecutionId?: string;
  type: 'primary_turn_started';
  workflowId: string;
  startedAt: number;
}

export interface PrimaryTurnEndedMessage {
  ollamaExecutionId?: string;
  type: 'primary_turn_ended';
  workflowId: string;
  endedAt: number;
}

export interface WorkerModelMessage {
  type: 'worker_model';
  workflowId: string;
  workerId: string;
  resolvedModel: string;
}

export interface WorkerSpawnedMessage {
  type: 'worker_spawned';
  workflowId: string;
  workerId: string;
  model: string;
  effort: string;
  task: string;
  provider?: ProviderName;
}

export interface WorkerTextMessage {
  type: 'worker_text';
  workflowId: string;
  workerId: string;
  text: string;
}

export interface WorkerThinkingMessage {
  type: 'worker_thinking';
  workflowId: string;
  workerId: string;
  text: string;
}

export interface WorkerToolUseMessage {
  type: 'worker_tool_use';
  workflowId: string;
  workerId: string;
  tool: string;
  input: string;
  status?: 'started' | 'in_progress' | 'completed' | 'failed';
  provider?: ProviderName;
  itemType?: string;
  itemId?: string;
  output?: string;
  exitCode?: number;
  // Watchdog instrumentation — normalized hash of `output`; see
  // PrimaryToolUseMessage.outputHash. Forwarded verbatim into that event.
  outputHash?: string;
  // Phase 7b — provider-supplied tool_use id (Anthropic block.id for Native).
  // When present, takes precedence over the server-minted one in seedWorker
  // so chat-side lookups (e.g. Task inline cards) match the assistant's
  // tool_use block stably across reconnects/replays.
  toolUseId?: string;
}

export interface WorkerCompleteMessage {
  type: 'worker_complete';
  workflowId: string;
  workerId: string;
  result: string;
  costUsd: number;
  durationMs: number;
  tokens?: TokenUsage;
  permissionDenials?: PermissionDenial[];
  // Codex-only today: provider-reported context window for this worker's
  // model. Mirrors PrimaryCompleteMessage.modelContextWindow so the client
  // can show honest CTX-bar denominators on per-worker badges too.
  modelContextWindow?: number;
  // Native/API primary turns — last round's prompt size. See
  // PrimaryCompleteMessage.lastPromptTokens for full rationale.
  lastPromptTokens?: number;
  // docs/PROVIDERS.md - per-turn byte sums for thinking and
  // tool_result blocks. Native fills both with real values; CLI/Codex set
  // thinkingBytes=0 and toolResultBytes=-1 (unknown) since they spawn the
  // CLI without visibility into its inner messages[]. seedWorker re-emits
  // these on primary_turn_token_usage; not consumed elsewhere.
  thinkingBytes?: number;
  toolResultBytes?: number;
  toolResultBytesRaw?: number;
  serverToolResultBytes?: number;
  // Ollama/Strata — see PrimaryCompleteMessage.genSpeed.
  genSpeed?: GenerationSpeed;
}

// Periodic /proc-based activity probe for subprocess workers.
export interface WorkerActivityMessage {
  type: 'worker_activity';
  workflowId: string;
  workerId: string;
  alive: boolean;
  cpuActive: boolean;
  descendantCount: number;
  rssBytes: number;
}

export interface WorkerErrorMessage {
  type: 'worker_error';
  workflowId: string;
  workerId: string;
  error: string;
}

// Provider-level out-of-band status line — surfaces cleanly in chat without
// getting routed as assistant text (no phase, no streaming, no cost / token
// accounting). Used for: stream-level transient error capture ("Anthropic
// overloaded — CLI is continuing"), retry backoff notifications, and anything
// else the provider needs to tell the operator during a turn.
export interface WorkerSystemNoticeMessage {
  authRecovery?: AuthRecoveryContext;
  type: 'worker_system_notice';
  workflowId: string;
  workerId: string;
  notice: string;
}

export interface FileUploadedMessage {
  type: 'file_uploaded';
  fileId: string;
  filename: string;
  path: string;
}

// Popup-style artifacts emitted inline. Ask-type responses come back as
// `[artifact:<id>] <answer>` follow-up user messages.
export type ArtifactKind = 'image' | 'code' | 'text' | 'diff' | 'confirm' | 'choice';

export interface PrimaryArtifactMessage {
  type: 'primary_artifact';
  workflowId: string;
  artifactId: string;
  kind: ArtifactKind;
  title?: string;
  content?: string;
  language?: string;
  path?: string;
  message?: string;
  choices?: string[];
  // §H4 — when true (image artifacts written into cwd, e.g. a Codex
  // image_generation_call result), the client offers an "Open in editor"
  // affordance that opens the H2 media editor on `path`.
  openInEditor?: boolean;
}

// Per-provider throttle snapshot.
export interface QuotaStatusMessage {
  type: 'quota_status';
  workflowId?: string;
  providers: Record<ProviderName, { throttled: boolean; resetsAt?: number }>;
  timestamp: number;
}

// Explicit "turn halted" signal — operator cancel or quota exhaustion.
export interface TurnCancelledMessage {
  type: 'turn_cancelled';
  workflowId: string;
  reason: 'operator-stop' | 'quota-exhausted' | 'round-cap';
}

export interface ConversationChangedMessage {
  type: 'conversation_changed';
  workflowId: string;
  newSessionId: string;
  note: string;
}

// Lossless state sync on reconnect. Tells the client what the server considers
// ground truth so stale client-side state snaps to truth immediately.
export interface WorkflowStateSnapshotMessage {
  type: 'workflow_state_snapshot';
  workflowId: string;
  workers: Record<string, WorkerState>;
  busy: boolean;
  transcriptTail: ChatMessage[];
  operatorQuestions?: OperatorQuestionState[];
  lastSeq?: number;
  snapshotOnly?: boolean;
  snapshotReason?: string;
  claudeSessionId?: string;
  sessionMetadata?: WorkflowSessionMetadata;
  lastTurnTokens?: TokenUsage;
  modelContextWindow?: number;
}

export interface WorkflowSessionMetadataMessage {
  type: 'workflow_session_metadata';
  workflowId: string;
  sessionMetadata?: WorkflowSessionMetadata;
}

// 2026-06-12 — atomic bulk history delivery for cluster-snapshot restore.
// `events` holds the member's compacted events.jsonl lines (server-message
// shaped, seq-ascending); the client dispatches each through its normal
// handleServerMessage reducer in ONE synchronous task. Load-bearing vs.
// streaming them as N live messages: run-to-completion makes the ingest
// all-or-nothing, so the client's persisted lastSeq can never outrun its
// persisted chat (the 2026-06-12 blank-workers bug — an interrupt mid-stream
// persisted lastSeq≈head with no messages, and reconnect replay-since-seq
// then had nothing left to resend), React batches the whole ingest into one
// render, and the debounced localStorage persist fires once instead of
// thousands of times.
export interface ReplayBatchMessage {
  type: 'replay_batch';
  workflowId: string;
  events: unknown[];
}

export interface ShutdownMessage {
  type: 'shutdown';
  reason?: string;
}

export interface CapabilitiesUpdatedMessage {
  type: 'capabilities_updated';
  capabilities: Capabilities;
  updated: boolean;
  previousVersion?: string;
}

export interface CapabilitiesChangedMessage {
  type: 'capabilities_changed';
  changes: CliChangeEntry[];
}

// Phase 2 — fired on every settings cascade change (global file or any
// project file the server is watching). Body-less by design: the cascade is
// cwd-scoped, but the broadcast is global, so each client re-fetches with
// its own cwd context via GET /api/settings?cwd=<active-cwd>.
export interface SettingsUpdatedMessage {
  type: 'settings_updated';
  scope: 'global' | 'project';
  cwd?: string;
}

export interface SystemErrorMessage {
  type: 'error';
  // Present when the failure belongs to one workflow (for example a provider
  // refusal). Omitted only for connection/global command errors.
  workflowId?: string;
  message: string;
}

// One parsed line from Claude's native session JSONL
// (~/.claude/projects/<cwd-hash>/<sessionId>.jsonl). Emitted by the
// server-side watcher so the client can render chat from the canonical
// source rather than reconstructing from our own events.jsonl.
// NOT persisted to events.jsonl (it's derived from an external file).
//
// A single JSONL line can produce multiple entries (e.g. an assistant
// message with a text block plus tool_use blocks). The server iterates
// content blocks and emits each as its own SessionEntryMessage so the
// client can render them inline in chronological order.
export interface SessionEntryMessage {
  type: 'session_entry';
  workflowId: string;
  entry:
    | {
        kind: 'message';
        role: 'user' | 'assistant';
        content: string; // already-extracted plain text
        timestamp: number;
        uuid?: string;
      }
    | {
        kind: 'tool_use';
        tool: string;               // "Read" / "Write" / "Edit" / "Bash" / ...
        input: unknown;             // parsed tool input JSON
        filePath?: string;          // extracted for Read/Write/Edit (absolute)
        toolUseId: string;          // Anthropic-issued, stable per invocation
        timestamp: number;
      };
}

// Operator cancelled a queued mid-turn message before it fired. Persisted
// so the removal survives events.jsonl replay — the client drops any chat
// message matching `clientMessageId` when this arrives.
export interface QueuedMessageCancelledMessage {
  type: 'queued_message_cancelled';
  workflowId: string;
  clientMessageId: string;
}

// Server pulled queued mid-turn messages off the interjection queue and
// merged them into the next turn's prompt. The client flips
// `queued: false` on the matching optimistic chat entries (clearing the
// composer-adjacent QUEUED indicator) and rebases their timestamps to
// `drainedAt` so the sessionChat dedup window catches Claude's JSONL
// echo that follows shortly. Without this, non-Claude providers (no
// session_entry path) would leave the QUEUED pill stuck forever, and
// Claude could leave it stuck whenever the prefix-match in
// session_entry's removeMessage loop misses (whitespace drift, prompt
// framing).
export interface QueuedMessagesDrainedMessage {
  type: 'queued_messages_drained';
  workflowId: string;
  clientMessageIds: string[];
  drainedAt: number;
}

// Phase 3 — generic in-chat system notice for server-generated alerts
// (context warnings, auto-handoff status). Persisted to events.jsonl so
// the notice appears on replay/resume.
export interface SystemNoticeMessage {
  authRecovery?: AuthRecoveryContext;
  type: 'system_notice';
  workflowId: string;
  content: string;
}

// Emitted after the session JSONL watcher's initial tail emit + after each
// `load_earlier_messages` response. Drives the "Load earlier messages" pill
// at the top of chat. Not persisted to events.jsonl — it's derived state.
export interface SessionHistoryStatusMessage {
  type: 'session_history_status';
  workflowId: string;
  hasEarlier: boolean;
  // How many raw JSONL entries remain in the server's pending-earlier queue.
  // Informational only; the pill just cares about hasEarlier.
  earlierRemaining: number;
}

// Codex per-turn snapshot — captured by reading the rollout file after the
// turn settles. The reason this exists separate from primary_complete:
// `codex exec --json`'s `turn.completed.usage` reports input_tokens
// AGGREGATED across all internal LLM calls within one operator turn (an
// agentic GPT-5.5 high turn can make 5+ internal calls each with their own
// input). That aggregated number is right for billing but wrong for
// "context window fill" — what the model actually had in its context per
// call is the LAST call's input, which lives in the rollout file as
// `event_msg::token_count.info.last_token_usage`.
//
// Server reads the rollout post-settle and emits this snapshot. Client
// overrides `JobState.lastTurnTokens` so the CTX bar reflects the per-call
// reality, not the inflated agentic sum. `JobState.totalTokens` (cumulative
// billing) is left untouched — it correctly reflects total input across all
// internal calls. NOT persisted to events.jsonl (derived from on-disk
// rollout; rebuilt on demand).
export interface CodexTokenSnapshotMessage {
  type: 'codex_token_snapshot';
  workflowId: string;
  // Per-call last_token_usage from the rollout's most recent
  // event_msg::token_count payload. Replaces the aggregated values that
  // primary_complete already broadcast for the same turn.
  tokens: TokenUsage;
  // Provider-reported model_context_window from the rollout. Same field as
  // PrimaryCompleteMessage.modelContextWindow but landed via the rollout
  // path instead of the exec --json stream (which doesn't surface it).
  modelContextWindow?: number;
}

// DEBAG - Durable Edit-Before-Approve Gate (docs/PROVIDERS.md). When the
// operator arms `reviewSafeMode` and the model proposes a sensitive tool call
// (static allowlist in `gateReview.ts`), the worker emits this BEFORE parking
// the turn (sub-phase 1 is inert — it emits then proceeds; parking + operator
// resolution land in later sub-phases). The proposal is durable in
// `events.jsonl`, so a restart can reconstruct the pending gate. `gateId` is the
// tool_use id (one gate per call). `signature` is the NON-lossy standing-approval
// key (DEBAG §4.1 — never reuse the digit-lossy `outputHash`). `category`/`reason`
// drive the operator-facing card; `proposedArgs` is the effective (post-hook)
// tool input the operator will see and (later sub-phases) edit.
export type GateCategory = 'bash' | 'git-destructive' | 'write-outside-cwd' | 'kill-shell';

export interface GateRequiredMessage {
  type: 'gate_required';
  workflowId: string;
  gateId: string;
  toolUseId: string;
  toolName: string;
  category: GateCategory;
  reason: string;
  proposedArgs: Record<string, unknown>;
  signature: string;
  createdAt: number;
}

// Emitted when an operator resolves a parked gate (DEBAG sub-phase 2+). Records
// the decision and `wasEdited` as a first-class audit bit; `finalArgs` is the
// (possibly edited) input that actually ran, `liveArgsAtFire` the proposal the
// operator was shown. Approve → the call runs with `finalArgs`; reject → the
// model gets a refusal tool_result and continues.
export interface GateResolvedMessage {
  type: 'gate_resolved';
  workflowId: string;
  gateId: string;
  toolUseId: string;
  toolName: string;
  decision: 'approve' | 'reject';
  wasEdited: boolean;
  finalArgs?: Record<string, unknown>;
  liveArgsAtFire?: Record<string, unknown>;
  // Sub-phase 5 — true when this approval came from a matching STANDING
  // approval ("approve all like this"), not a fresh operator click.
  standing?: boolean;
  createdAt: number;
}

// Sub-phase 5 — the current set of scoped standing approvals for a workflow.
// Broadcast on rehydrate and whenever one is added/revoked so the CONFIG
// REVIEW SAFE-MODE list can render them with revoke controls.
export interface GateStandingApprovalView {
  signature: string;
  toolName: string;
  approvedAt: number;
  sample?: string;
}
export interface GateStandingMessage {
  type: 'gate_standing';
  workflowId: string;
  approvals: GateStandingApprovalView[];
}

// Preview tab — server confirms the bound port for an iframe to load through
// the per-workflow proxy at /api/preview/<workflowId>/. Persisted to meta.json
// so reconnects/resumes restore the iframe without the operator re-typing.
export interface PreviewSetMessage {
  type: 'preview_set';
  workflowId: string;
  port: number;
  framework?: string;
  manual: boolean;
  // True when this is a fresh bind (auto-detect just committed, or operator
  // just typed BIND). False when the server is replaying a previously-stored
  // binding on workflow create / rehydrate. Drives the client-side
  // "auto-switch to PREVIEW once" UX — replays must not yank the operator
  // off whatever tab they were on.
  freshlyBound: boolean;
}

export interface PreviewClearedMessage {
  type: 'preview_cleared';
  workflowId: string;
}

// Preview history — every time a port is bound for this workflow (auto or
// manual) we append an entry. Surfaced in the PREVIEW tab header as
// click-to-rebind pills so an operator can jump back to a previously bound
// service without retyping the port. Capped at 5; consecutive same-port
// binds dedupe to a timestamp refresh on the existing entry.
export interface PreviewHistoryEntry {
  port: number;
  framework?: string;
  boundAt: number;
  source: 'auto' | 'manual';
}

export interface PreviewHistoryMessage {
  type: 'preview_history';
  workflowId: string;
  entries: PreviewHistoryEntry[];
}

// Phase 2 context robustness — byte-count context fill estimate emitted after
// each primary_complete and on workflow_state_snapshot. NOT persisted to
// events.jsonl (derived from the JSONL byte size; rebuilt on each connect).
export interface ContextUsageMessage {
  type: 'context_usage';
  workflowId: string;
  estimatedTokens: number;
  percentOfWindow: number;
  windowSize: number;
  method: 'byte-count' | 'calibrated' | 'ground-truth';
  calibratedAt?: number;  // epoch ms of last ground-truth calibration
  messagesTokens: number;
  overheadTokens: number;
  jsonlBytes: number;
  claudeSessionId?: string;
}

// docs/PROVIDERS.md - live progress of an ultracode background fleet. The CLI's
// WorkflowTool runs subagents in the background, writing per-agent transcripts
// to `<sessionId>/subagents/workflows/wf_*/{journal,agent-*}.jsonl` that never
// touch the parent stream — so the Activity tab would otherwise look dead while
// the fleet churns. A turn-scoped watcher polls those files and emits a fresh
// snapshot here. Transient (live telemetry only, like context_usage — NOT
// persisted to events.jsonl; a snapshot replaces the prior one in place).
export interface UltracodeFleetAgent {
  agentId: string;
  label: string;                     // first user-turn prompt, truncated
  status: 'running' | 'done';
  lastTool?: string;                 // most recent tool the subagent invoked
}
export interface UltracodeFleetProgressMessage {
  type: 'ultracode_fleet_progress';
  workflowId: string;
  total: number;                     // distinct subagents spawned this turn
  running: number;
  done: number;
  agents: UltracodeFleetAgent[];
}

// §2.3 — Token-budget meter (Claude Native). A deterministic per-turn reading
// of usable-input pressure: the count_tokens prompt size against the
// *effective* window (real window − reserved output budget), plus which
// warn/auto/fold thresholds that pct has crossed. Distinct from
// `context_usage` (which is % of the RAW window and drives the CTX bar): the
// budget meter is the signal the Fold/auto-fold trigger reads, since the
// reserved output tokens are not usable for input. Transient (derived each
// turn from persisted lastPromptTokens) — not persisted itself.
export interface ContextBudgetMessage {
  type: 'context_budget';
  workflowId: string;
  usedTokens: number;
  windowSize: number;
  reservedOutput: number;
  effectiveWindow: number;
  pct: number;
  thresholds: { warnAt: number; autoAt: number; foldAt?: number };
  crossed: { warn: boolean; auto: boolean; fold: boolean };
}

// Phase 0 — operator label. Operator-attached note targeting a prior event
// (typically from the HISTORY tab in Phase 8). `targetEventSeq` is the seq
// of the event the label is anchored to. Persisted so labels survive replay.
export interface OperatorLabelMessage {
  type: 'operator_label';
  workflowId: string;
  text: string;
  targetEventSeq: number;
  createdAt: number;
}

// Phase 4 — pending-message queue snapshot. Broadcast on every mutation
// (enqueue, drain, cancel) so replay reconstructs the visible queue on
// reconnect. The wire shape carries `clientMessageId` per entry so the
// queue-strip [×] button can target individual items by their stable id
// after a reload (the optimistic chat message that originally minted the
// id may have been pruned by Zustand's 30s onRehydrateStorage rule).
// Phase 0 declared the draft as `string[]`; the entry-object form was
// adopted in Phase 4 — see decision log.
export interface QueueEntry {
  // Priority entry in the steering bucket; not delivered by a steer hook.
  interrupt?: boolean;
  content: string;
  clientMessageId?: string;
}
export interface QueueUpdateMessage {
  type: 'queue_update';
  workflowId: string;
  steering: QueueEntry[];
  followUp: QueueEntry[];
}

// Phase 7a — Claude Native TodoWrite snapshot. Broadcast on every TodoWrite
// tool call so the Activity tab renders the operator-visible plan. Transient
// (not persisted to events.jsonl) — the worker holds the canonical state
// in memory and re-emits when needed.
export interface TodosUpdatedMessage {
  type: 'todos_updated';
  workflowId: string;
  todos: Array<{
    content: string;
    activeForm?: string;
    status: 'pending' | 'in_progress' | 'completed';
  }>;
}

// Phase 7b — Task child lifecycle, broadcast on the PARENT workflow so the
// inline chat card + right-panel TASKS tab can render without subscribing to
// the child's own event stream. `toolUseId` is the parent assistant's
// tool_use block id (Anthropic block.id), used as the chat-side lookup key
// to attach the card to its tool_use row.
export interface TaskStartedMessage {
  type: 'task_started';
  workflowId: string;          // parent
  taskId: string;
  childWorkflowId: string;
  toolUseId: string;
  description: string;
  startedAt: number;
}

// Phase 7b — settle/error/cancelled signal for a Task child. v1 fires
// start + settle only; intermediate `'running'` is reserved so a future
// periodic-progress feed can land without another schema bump.
export interface TaskStatusMessage {
  type: 'task_status';
  workflowId: string;          // parent
  taskId: string;
  toolUseId: string;
  phase: 'running' | 'done' | 'error' | 'cancelled';
  elapsedMs: number;
  summary?: string;
}

// Phase 0 — reserved for Phase 9 (in-workflow forks). Marks the event-seq
// where a fork point was created and an optional operator-supplied label.
// Declared now so events.jsonl readers (Phase 8 HISTORY) can recognize the
// kind without a second schema bump.
export interface BranchSummaryMessage {
  type: 'branch_summary';
  workflowId: string;
  fromEventSeq: number;
  label?: string;
  createdAt: number;
}

// docs/PERSISTENCE.md - deterministic classifier tag for a transcript point,
// driving the HISTORY branch-tree dots. A FIXED type→tag map, NO model judgment
// (fence: pure accounting, not a quality verdict). `source` on a `leaf_move`
// records WHY the head was moved (v1 only emits `revert`); the same classifier
// tags every other point in the tree by its own event type in the client.
export type BranchSource = 'turn-start' | 'fork' | 'operator-mark' | 'compact' | 'revert';

// Map an events.jsonl event type to its branch-tree tag. Pure + total (unknown
// types fall through to 'turn-start'). Exported so the server stamps `leaf_move`
// and the client tags the HISTORY tree from the same source of truth.
export function classifyBranchSource(eventType: string | undefined): BranchSource {
  switch (eventType) {
    case 'leaf_move':
      return 'revert';
    case 'native_compacted':
    case 'context_folded':
      return 'compact';
    case 'operator_label':
      return 'operator-mark';
    case 'handoff_artifact_ready':
    case 'branch_summary':
      return 'fork';
    default:
      return 'turn-start';
  }
}

// docs/PERSISTENCE.md - durable head move over the immutable log. Persisted to
// events.jsonl AND sets meta.leafSeq via atomic writeMeta. The branch-aware
// replay pre-pass treats this as a REDIRECT node: walking ancestry from the leaf
// jumps to `targetSeq` here, pruning the abandoned span (no write-path change).
// Reversible by construction — "undo the undo" is just another leaf_move; the
// abandoned branch stays byte-identical on disk.
export interface LeafMoveMessage {
  type: 'leaf_move';
  workflowId: string;
  targetSeq: number;
  source: BranchSource;
  createdAt: number;
  // Set when the events before `targetSeq` had rotated off the size-capped log,
  // so the branch was reconstructed from a summary rather than replayed
  // byte-for-byte (hygiene-B: surface lossy rewinds, never silent). Sub-phase 4.
  reconstructed?: boolean;
}


// docs/PROVIDERS.md - provider-protocol history checkpoint. Hidden from chat
// rendering, load-bearing for native replay: exact assistant reasoning_content,
// tool calls, and tool results survive server restart.

// Every workflow-scoped ServerMessage broadcast is also appended to
// events.jsonl with a monotonic `seq` the server stamps onto the wire payload
// so clients can track lastSeq for lossless reconnect. Messages without a
// `workflowId` (connected / capabilities_updated / shutdown) are not persisted.
//
// Phase 0 — broadcasts also carry `parentEventSeq?: number`: the seq of the
// preceding event in the same workflow's events.jsonl. For linear (un-forked)
// workflows this equals seq-1 and is implicit; Phase 9 forks emit a non-linear
// value so HISTORY can render the branch graph. Absent on the very first event
// in a workflow and on pre-Phase-0 (schemaVersion 1) workflows — replay treats
// "absent" as "previous event in seq order".
export interface UpdateCheckStatus {
  current: string;
  latest: string | null;
  url: string | null;
  publishedAt: string | null;
  checkedAt: string | null;
  updateAvailable: boolean;
  enabled: boolean;
}

export interface AppUpdateAvailableMessage {
  type: 'app_update_available';
  current: string;
  latest: string;
  url: string;
  publishedAt: string;
}

export type ServerMessage =
  | AppUpdateAvailableMessage
  | ComputerActivityChangedMessage
  | ComputerContextUpdatedMessage
  | ConnectedMessage
  | WorkflowCreatedMessage
  | WorkspaceSnapshotMessage
  | WorkflowConfigSyncedMessage
  | PrimaryTextMessage
  | PrimaryCompleteMessage
  | PrimaryTurnTokenUsageMessage
  | HookRewroteInputMessage
  | ToolGateTriggeredMessage
  | GateRequiredMessage
  | GateResolvedMessage
  | GateStandingMessage
  | ToolLoopWarningMessage
  | WorkerStuckMessage
  | ToolPostureSetMessage
  | GoalSetMessage
  | GoalRunStateMessage
  | PinnedSkillsSetMessage
  | ProjectTrustPromptMessage
  | ProjectTrustSetMessage
  | FileMutationQueuedMessage
  | ModelResolvedMessage
  | PrimaryRefusalMessage
  | CtxActionMessage
  | NativeCompactingMessage
  | ContextFoldedMessage
  | NativeCompactedMessage
  | PrimaryToolCounterMessage
  | SandboxChunkAddedMessage
  | SandboxDbClearedMessage
  | ToolFilteredMessage
  | ToolEvictedMessage
  | PeerMessageSentMessage
  | PeerMessageReceivedMessage
  | PeerSendRejectedMessage
  | PrimaryModelMessage
  | PrimaryThinkingMessage
  | PrimaryToolUseMessage
  | PrimaryTurnStartedMessage
  | PrimaryTurnEndedMessage
  | WorkerSpawnedMessage
  | WorkerTextMessage
  | WorkerThinkingMessage
  | WorkerToolUseMessage
  | WorkerCompleteMessage
  | WorkerActivityMessage
  | WorkerModelMessage
  | WorkerErrorMessage
  | FileUploadedMessage
  | CapabilitiesUpdatedMessage
  | CapabilitiesChangedMessage
  | SettingsUpdatedMessage
  | ConversationChangedMessage
  | PrimaryArtifactMessage
  | QuotaStatusMessage
  | TurnCancelledMessage
  | WorkflowStateSnapshotMessage
  | WorkflowSessionMetadataMessage
  | ReplayBatchMessage
  | ShutdownMessage
  | SystemErrorMessage
  | UserMessageEchoMessage
  | ReviewStartedMessage
  | ReviewArtifactReadyMessage
  | ResearchStartedMessage
  | ResearchProgressMessage
  | ResearchCompleteMessage
  | CompareStartedMessage
  | CompareLegDeltaMessage
  | CompareLegCompleteMessage
  | CompareCompleteMessage
  | CompareVoteRecordedMessage
  | ProviderFellBackMessage
  | DiagnosticsMessage
  | DocEditStartedMessage
  | DocEditProposedMessage
  | MdTuneupStartedMessage
  | MdTuneupProposedMessage
  | MdTuneupAppliedMessage
  | MdTuneupCandidatesMessage
  | KnowledgeDistillStartedMessage
  | KnowledgeDistillProposedMessage
  | CookbookDownloadProgressMessage
  | RecallSummaryReadyMessage
  | HandoffStartedMessage
  | HandoffArtifactReadyMessage
  | HandoffCompleteMessage
  | HandoffLockSnapshotMessage
  | SpawnFromHereCompleteMessage
  | CheckpointCreatedMessage
  | CheckpointRevertedMessage
  | LiveChangesSnapshotMessage
  | GitOpResultMessage
  | BakeoffListResultMessage
  | BakeoffStateMessage
  | BakeoffErrorMessage
  | BakeoffAttemptsRemovedMessage
  | OutputSavedMessage
  | MediaOpResultMessage
  | MediaStemsResultMessage
  | SessionEntryMessage
  | ContextUsageMessage
  | UltracodeFleetProgressMessage
  | ContextBudgetMessage
  | OperatorQuestionMessage
  | OperatorQuestionReplyResultMessage
  | VoiceToolCallMessage
  | SystemNoticeMessage
  | QueuedMessageCancelledMessage
  | QueuedMessagesDrainedMessage
  | PrimaryActivityMessage
  | SessionHistoryStatusMessage
  | PlanAttachedMessage
  | PlanDetachedMessage
  | CodexTokenSnapshotMessage
  | PreviewSetMessage
  | PreviewClearedMessage
  | PreviewHistoryMessage
  | OperatorLabelMessage
  | LeafMoveMessage
  | QueueUpdateMessage
  | TodosUpdatedMessage
  | PlanSetMessage
  | PlanExitedMessage
  | PlanCandidateReadyMessage
  | TaskStartedMessage
  | TaskStatusMessage
  | BranchSummaryMessage
  | ClusterStateMessage
  | ClusterNotFoundMessage
  | ClusterCreatedMessage
  | ClusterDeletedMessage
  | ClusterMemberAddedMessage
  | ClusterMemberRemovedMessage
  | ClusterMemberReplacedMessage
  | ClusterBroadcastDispatchedMessage
  | ClusterDispatchResultMessage
  | ClusterSwarmCreatedMessage
  | ClusterOrchestrationAssistStartedMessage
  | ClusterOrchestrationProposalStartedMessage
  | ClusterOrchestrationProposalSnapshotMessage
  | ClusterOrchestrationProposalProposedMessage
  | ClusterOrchestrationProposalRejectedMessage
  | ClusterOrchestrationProposalAppliedMessage
  | ClusterPlanChangedMessage
  | ClusterMemberNudgedMessage
  | WorkflowRenamedMessage
  | CodebaseMemoryStateMessage
  | ClusterAutoTurnFiredMessage
  | ClusterSnapshotListResultMessage
  | ClusterSnapshotSavedMessage
  | ClusterSnapshotConflictMessage
  | ClusterSnapshotErrorMessage
  | TerminalOpenedMessage
  | TerminalKilledMessage
  | TerminalCommandLoggedMessage
  | TerminalSessionsMessage
  | TaskLedgerSnapshotMessage
  | TaskLedgerEventMessage
  | McpRegistrySnapshotMessage
  | McpProbeResultMessage
  | McpAllowSnapshotMessage
  | McpMalwareWarningMessage
  | GenesisSeedUpdatedMessage
  | WorkflowCwdBoundMessage
  | GenesisScaffoldedMessage
  | GenesisCreativeArmedMessage
  | GenesisAssistStartedMessage
  | GenesisAssistProposedMessage
  | PreviewCaptureStartedMessage
  | PreviewCaptureReadyMessage
  | WorkbenchNoticeMessage
  | NotificationMutesMessage
  | HubLinkStatusMessage;

// Phase 0 — typed envelope for events read off events.jsonl or received over
// the wire. Wraps any ServerMessage with the persistence-stamped fields the
// server adds at broadcast time. Phase 8 HISTORY and Phase 9 forks read
// `parentEventSeq` directly off this shape.
export type WorkflowEvent<M extends ServerMessage = ServerMessage> = M & {
  seq: number;
  parentEventSeq?: number;
};
