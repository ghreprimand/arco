// Data-shape declarations for the app store. Extracted verbatim from
// appStore.ts (Phase 5 file-size refactor) — move-only, no behavior change.
// This module is dependency-light: it imports only from `@arco/shared`
// (plus react/zustand types as needed) and must NOT import from
// `./appStore` or `./memoryTrim` (avoid an import cycle).
import type {
  ChatMessage, WorkerState, WorkflowConfig, ModelName, EffortLevel, Capabilities, UsageInfo,
  CodexUsageInfo, CursorUsageInfo, ZaiUsageInfo, OllamaLiveStatus, LlamacppLiveStatus, TokenUsage, GenerationSpeed, AuthStatusByProvider,
  ProviderName, PrimaryArtifactMessage, ArcoSettings, QuotaStatusMessage,
  CliChangeEntry, PrimaryBackgroundJob, PreviewHistoryEntry, ClaudeCatalogSnapshot,
  CodexCatalogSnapshot, GeminiCatalogSnapshot, CursorCatalogSnapshot, PrimaryTurnTokenUsageMessage, ClusterStatePayload,
  WorkflowSessionMetadata, HandoffLockSnapshotMessage, DiagnosticItem,
  LedgerTask, McpServerDef, McpToolInfo, McpWorkflowAllow,
  GenesisSeed, GenesisReadiness, GenesisCodebaseInfo, GenesisAssistField, GenesisAssistIntent, GenesisNameOption,
  PreviewCaptureSummary, PreviewCaptureKind, ToolPosture, BranchSource, GateStandingApprovalView, ArcoSkillRef,
  BakeoffState,
} from '@arco/shared';

// G1 — one completed (or failed) preview capture, as held in the store. Mirrors
// the `preview_capture_ready` broadcast plus the requested facets, so the PREVIEW
// tab can render the result + link to the report/screenshot artifacts.
export interface PreviewCaptureRecord {
  captureId: string;
  ok: boolean;
  error?: string;
  reportName?: string;
  imageName?: string;
  summary?: PreviewCaptureSummary;
  captures: PreviewCaptureKind[];
  completedAt: number;
}

// ARCO_OPS_PLAN.md §E1 — registry snapshot row (env-stripped — only key
// names ride the wire) + the last probe result per server.
export type McpRegistryRow = Omit<McpServerDef, 'env'> & { envKeys: string[] };
export interface McpProbeState {
  ok: boolean;
  tools: McpToolInfo[];
  error?: string;
  at: number;
}
// ARCO_OPS_PLAN.md §C1 — connection-state union for the richer header
// overlay. The pure deriver lives under ../runtime; this is a type-only import
// (no values, no cycle — runtimeState imports nothing).
import type { ConnectionState } from '../runtime/runtimeState';

// Slot 4 — process-local per-provider quota snapshot broadcast by the server
// on every state change + on each fresh WS connection. Not persisted to
// localStorage (server state is ephemeral; restart resets it).
export type QuotaSnapshot = QuotaStatusMessage['providers'];

export type ArtifactItem = Omit<PrimaryArtifactMessage, 'type'>;

// WORKBENCH_EXPANSION_PLAN.md A1 — retention snapshot for the dev MemoryHud and
// the mem-retention smoke. Reports the live in-memory footprint so a long
// session's growth curve can be measured (the store arrays are already capped;
// this proves the caps hold and surfaces any unbounded growth elsewhere).
export interface RetentionStats {
  jobs: number;
  attachmentUrls: number; // total live previewUrl blob URLs across all tabs
  notifications: number;
  perJob: Array<{
    id: string;
    messages: number;
    sessionChat: number;
    activity: number;
    historyEvents: number;
    workers: number;
    toolFiltered: number;
    turnTokenUsage: number;
  }>;
  // Chrome-only (performance.memory); undefined in other engines.
  heap?: { usedMB: number; totalMB: number; limitMB: number };
}

// A file staged in the composer — uploaded to the server, carrying a local
// blob-URL preview for image thumbnails. Owned by the store (per-workflow)
// so the preview URL survives tab-switch remounts.
export interface DraftAttachment {
  filename: string;
  path: string;            // absolute path on the server's filesystem
  previewUrl?: string;     // URL.createObjectURL result; revoke in store actions
  isImage: boolean;
}

// Phase 5 — entry-per-review for the right-pane Review tab. Built up from
// `review_started` / `review_artifact_ready` events.
export interface ReviewEntry {
  reviewId: string;
  artifactName: string;
  reviewer: { provider: ProviderName; model: ModelName; effort: EffortLevel };
  startedAt: number;
  completedAt?: number;
  verdict?: 'PASS' | 'MINOR' | 'BLOCKING';
  error?: string;
}

// WORKBENCH_EXPANSION_PLAN.md §B2 — entry-per-research-run for the right-pane
// RESEARCH tab. Built from `research_started` / `research_progress` /
// `research_complete` events. `artifactName` is the `research-<ts>.md` report;
// a dig-deeper follow-up reuses the seed artifact's name (isFollowUp).
export interface ResearchEntry {
  researchId: string;
  artifactName: string;
  researcher: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string };
  topic: string;
  maxRounds: number;
  isFollowUp: boolean;
  startedAt: number;
  completedAt?: number;
  roundsUsed?: number;
  sourceCount?: number;
  // Latest coarse progress note from research_progress (e.g. "searching (2/4)").
  progressNote?: string;
  error?: string;
}

// Live activity event for the right-pane ACTIVITY tab. Built from primary_
// tool_use + primary_thinking streams. Capped to the last N entries — the
// tab is a live readout, not a durable log. Replay from events.jsonl is
// where historical tool use lives if we ever want it.
export interface ActivityEntry {
  id: string;
  kind: 'tool_use' | 'thinking' | 'native_event';
  tool?: string;         // set when kind === 'tool_use'
  input?: string;        // JSON-stringified tool args
  text?: string;         // raw thinking delta (may be mid-sentence) or native-event detail
  status?: 'started' | 'in_progress' | 'completed' | 'failed';
  provider?: ProviderName;
  itemType?: string;
  itemId?: string;
  toolUseId?: string;
  output?: string;
  exitCode?: number;
  at: number;
}

// ULTRACODE_PLAN.md — latest snapshot of an ultracode background fleet, shown
// as a FLEET panel atop the Activity tab. Replaced in place (not appended) on
// each `ultracode_fleet_progress`; cleared on a new primary turn. Live-only —
// the server emits it transiently (not persisted to events.jsonl).
export interface UltracodeFleetAgentView {
  agentId: string;
  label: string;
  status: 'running' | 'done';
  lastTool?: string;
}
export interface UltracodeFleetSnapshot {
  total: number;
  running: number;
  done: number;
  agents: UltracodeFleetAgentView[];
}

// Phase 6 — entry-per-handoff for the right-pane Handoffs tab. Built up
// from `handoff_started` / `handoff_artifact_ready` / `handoff_complete`.
export interface HandoffEntry {
  handoffId: string;
  mode: 'original-worker' | 'fresh-summarizer' | 'fresh-agent';
  artifactName: string;
  startedAt: number;
  completedAt?: number;
  archivedSessionId?: string;
  newSessionId?: string;
  turnCount?: number;
  error?: string;
  cancelled?: boolean;
}

export type HandoffLockEntry = HandoffLockSnapshotMessage['locks'][number];

export interface JobState {
  computerTurnActive?: boolean;
  id: string;
  currentSessionId: string;
  config: WorkflowConfig;
  messages: ChatMessage[];
  workers: Record<string, WorkerState>;
  reviews: ReviewEntry[];
  research: ResearchEntry[];
  handoffs: HandoffEntry[];
  totalCost: number;
  totalTokens: TokenUsage;
  totalWorkers: number;
  resolvedPrimaryModel?: string; // concrete version from CLI init
  // §4.1 — session-local tool posture (full/coding/chat/review). Mirrors the
  // server's runtime WorkflowState.toolPosture via the tool_posture_set
  // broadcast. NOT persisted (server never writes meta.json for it); a reload
  // returns to 'full'. Undefined ⇒ 'full'.
  toolPosture?: ToolPosture;
  // DD7 — a pending project-trust prompt for this tab's cwd. Set by the
  // project_trust_prompt broadcast; cleared when the operator records a decision
  // (project_trust_set) or dismisses. The composer renders a banner with
  // trust/don't-trust buttons while this is set. Operator-prompt only.
  projectTrustPrompt?: { cwd: string; resources: string[] };
  // Most recent `turn_cancelled` reason (for surfacing the halt in
  // chat). Cleared on next operator message. Undefined when no cancel has
  // fired yet this session.
  lastTurnCancelledAt?: number;
  // Slot 5 — highest server-stamped seq we've observed for this workflow.
  // Persisted across reloads; sent back in rehydrate_workflows so the server
  // can replay events we missed during a WS drop.
  lastSeq?: number;
  // Slot 9 — set once when the workflow was resumed. Drives the RESUMED badge
  // in OrchestratorNode. Undefined for fresh workflows.
  resumedVia?: 'native' | 'bootstrapped';
  // Slot 2 — false when we're waiting for the server's authoritative
  // workflow_state_snapshot after a (re)connect; flipped true when it arrives.
  // Fresh workflows (created via WorkflowCreator) start true since there's no
  // prior server state to sync. Reset to false on WS close so the SYNCING
  // overlay re-engages on the next reconnect.
  snapshotReceived?: boolean;
  // Last orchestrator turn's token snapshot. `input + cacheCreate`
  // drives auto-compact and is the operator-relevant "context fill" number;
  // `totalTokens` is cumulative across all turns + workers, which is the wrong
  // number to compare against the 80K threshold. Set only from
  // `orchestrator_complete` (not worker completion).
  lastTurnTokens?: TokenUsage;
  // Ollama/Strata — daemon-measured decode / prefill speed of the last turn.
  // Drives the composer footer's tok/s readout and the [TURN · …] stamp.
  lastGenSpeed?: GenerationSpeed;
  // EFFICIENCY_PLAN.md Phase A — per-turn telemetry feed for the Activity
  // tab's "Token usage" section. Capped at TURN_TOKEN_USAGE_CAP entries
  // (oldest evicted). Not persisted in the client store across reloads —
  // events.jsonl on the server is the durable record; this is just the
  // sliding window for live rendering.
  turnTokenUsage?: PrimaryTurnTokenUsageMessage[];
  // EFFICIENCY_PLAN.md Phase 6b.1 — running count of primary tool calls
  // since the last handoff (or session start, whichever is later).
  // Increments on every primary_tool_use; resets on handoff_complete /
  // ctx_action.compact. Drives the composer's nudge chip — when it crosses
  // 50, a chip suggests /handoff. Client-side counter so it survives across
  // turns within a session without a server fetch; rebuilt from events on
  // resume since events.jsonl is the durable record. Phase D §8b moved
  // the live signal to `toolCallsSinceCompact` (worker-authoritative); this
  // counter stays as the audit fallback for non-Native tabs and the first
  // paint before the worker emits.
  toolCallsSinceHandoff?: number;
  // EFFICIENCY_PLAN.md Phase D §8b — worker-authoritative mirror of the
  // Claude Native worker's `toolCallCountSinceCompact`. Updated on every
  // `primary_tool_counter` server push. Native-only; undefined for CLI /
  // Codex / Gemini / Ollama / llama.cpp / Antigravity tabs. The composer
  // chip prefers this value over the local recount when defined.
  toolCallsSinceCompact?: number;
  // EFFICIENCY_PLAN.md Phase E §9 — best-effort live count of sandbox
  // chunks stored in this tab's per-workflow SQLite index. Incremented on
  // every `sandbox_chunk_added` server push; reset to 0 on
  // `sandbox_db_cleared`. The CONFIG section and Files-tab sub-section
  // can also pull `/api/workflows/:wfId/sandbox/stats` on demand for the
  // total-bytes line — this mirror just makes the chip update without
  // a refetch. Native-only; undefined for other tabs.
  sandboxChunkCount?: number;
  // EFFICIENCY_PLAN.md Phase C — per-tool-use tool_filtered annotations.
  // Keyed by toolUseId so the chat-side ToolCallPill can render a chip with
  // the original→filtered byte counts and offer raw-bytes recovery via the
  // gzipped artifact path. Populated by the `tool_filtered` WS handler;
  // never persisted on the client (events.jsonl is the durable record).
  toolFiltered?: Record<string, { filterName: string; originalBytes: number; filteredBytes: number; rawArtifactPath?: string }>;
  // Provider-reported context window for this workflow's model. Codex
  // populates it (via turn.completed or event_msg::token_count); when
  // present, the CTX-bar denominator uses this instead of the client's
  // hardcoded codexModelWindow() fallback. Sticks once observed (later
  // turns of the same workflow re-read whatever Codex reports each turn,
  // but if a turn doesn't include the field the prior value persists).
  modelContextWindow?: number;
  // Server-authoritative busy flag. True between `primary_turn_started` and
  // `primary_turn_ended` (or set from the snapshot's `busy` field on
  // reconnect). Client's composer reads this (plus its local streaming
  // heuristic as a fallback) to decide between idle and "processing"
  // states. Undefined before the first signal arrives — treated as false.
  busy?: boolean;
  // Wall-clock timestamp of the current turn's start, for the composer's
  // elapsed-time counter. Cleared on primary_turn_ended.
  turnStartedAt?: number;
  // ARCO_OPS_PLAN.md §C1 — wall-clock of the last *primary* content signal
  // (turn start / text / thinking / tool_use / activity / complete). The
  // runtime-state deriver reads `now - lastPrimaryEventAt` to tell a live-but-
  // working `busy` from a `stuck` worker that's stopped emitting. NOT bumped by
  // worker_* deltas — a child task streaming doesn't prove the primary is alive.
  lastPrimaryEventAt?: number;
  // ARCO_OPS_PLAN.md §C1 — set when this workflow is (re)created with a
  // `resumedVia` (rehydrated from disk/replay). Drives the transient
  // `replay-recovered` badge for REPLAY_RECOVERED_WINDOW_MS. Distinct from
  // `resumedVia` (which persists for the RESUMED chip); this is a freshness
  // anchor the deriver compares against `now`.
  recoveredAt?: number;
  // Wall-clock timestamp of the last primary turn's completion. Drives the
  // composer's prompt-cache warmth countdown (Anthropic's default cache TTL is
  // 5 min idle; each cached turn resets it). Set on primary_turn_ended,
  // cleared on the next turn's start so the timer hides while busy.
  lastTurnEndedAt?: number;
  // Live stream of tool_use + thinking deltas from the primary. Capped to
  // MAX_ACTIVITY_ENTRIES. Replaced (not accumulated) on each new user
  // message so the tab always reflects the current turn, not a historical
  // log — historical activity lives in events.jsonl via review/handoff.
  activity: ActivityEntry[];
  // ULTRACODE_PLAN.md — latest ultracode fleet snapshot for the FLEET panel
  // atop the Activity tab. Undefined unless this turn fanned out a background
  // fleet; cleared on each new primary turn.
  ultracodeFleet?: UltracodeFleetSnapshot | null;
  // Long-running children of the primary CLI (typically Bash calls with
  // run_in_background: true). Replaced wholesale by each `primary_activity`
  // broadcast. Empty until the server's tracker emits its first tick.
  primaryBackgroundJobs?: PrimaryBackgroundJob[];
  // Phase 1 context robustness — chat built from Claude's session JSONL
  // (not from events.jsonl). Empty for non-Claude providers. Not persisted —
  // rebuilt via session_entry WS messages on every connect/reconnect.
  sessionChat: ChatMessage[];
  // Phase 2 context robustness — byte-count context fill estimate. Updated
  // after each primary_complete and on rehydrate. Not persisted (derived).
  contextUsage?: {
    estimatedTokens: number;
    percentOfWindow: number;
    windowSize: number;
    method: string;
    messagesTokens: number;
    overheadTokens: number;
    jsonlBytes: number;
    receivedAt: number;
    calibratedAt?: number;
  };
  // Native Claude session ID (UUID) for this workflow. Set from workflow_created,
  // workflow_state_snapshot, and context_usage messages. Used to expose
  // `claude --resume <id>` in the CONFIG tab.
  claudeSessionId?: string;
  // Provider-scoped continuation metadata. Antigravity uses this to expose
  // the stored cascade id without treating it as a Claude/Codex session.
  sessionMetadata?: WorkflowSessionMetadata;
  // Tail-first hydration — set from the server's `session_history_status`
  // message (Claude JSONL path) and from the transcript REST response's
  // `hasEarlier` field (unclaimed-session-picker path). Drives the
  // "Load earlier messages" pill. Cleared once the queue is drained.
  hasEarlierSessionHistory?: boolean;
  // Next-page cursor for transcript REST pagination. Set on the initial
  // hydrate; fed back as `before=<n>` on the "load earlier" fetch.
  earlierTranscriptCursor?: number;
  // Origin of the earlier-messages queue (drives which mechanism the pill
  // invokes when clicked). 'ws' = server-side JSONL queue (Claude active
  // sessions); 'transcript' = REST endpoint paging (Claude/Codex unclaimed-
  // session resume). Undefined when nothing earlier is available.
  earlierSource?: 'ws' | 'transcript';
  // Transcript provider + session id needed to re-fetch earlier pages from
  // `/api/transcript`. Captured on the initial hydrate. Unused for 'ws'.
  transcriptFetch?: { sessionId: string; provider: 'claude' | 'codex'; cwd: string };
  // Plan attached to this tab, if any. Set from `plan_attached` events;
  // cleared by `plan_detached`. Body is fetched lazily by the Plan tab via
  // `GET /api/plans/body?path=&planId=` so this stays small. Both new
  // attachments and post-edit notifications arrive as `plan_attached` —
  // distinguished by the `updatedAt` field.
  plan?: { id: string; title: string; updatedAt: number } | null;
  // PLAN-button capture flow. Operator clicks PLAN → modal → picks a mode;
  // the mode is stashed here so the next `primary_complete` can grab the
  // agent's reply and turn it into a plan body. Cleared on capture.
  pendingPlanCapture?: 'review' | 'autosave' | null;
  // The captured assistant reply, ready to become a plan. For 'review' mode
  // the composer banner shows Save / Discard buttons; for 'autosave' the
  // banner self-fires the save and clears.
  planCandidate?: { body: string; mode: 'review' | 'autosave'; capturedAt: number } | null;
  // Preview tab — operator-bound dev-server port for this workflow. Iframe
  // renders /api/preview/<id>/ which the server proxies to 127.0.0.1:<port>.
  // Set/cleared by preview_set / preview_cleared WS messages; null while
  // unbound. `manual` records that the operator typed the port (reserved for
  // a future auto-detect path).
  preview?: { port: number; framework?: string; manual: boolean } | null;
  // Set true when an auto-detected preview binding lands (server's
  // PreviewSetMessage.freshlyBound && !manual). Cleared by markPreviewSeen
  // after RightPanel auto-switches to the PREVIEW tab. One switch per fresh
  // bind: the operator can move off PREVIEW afterward without being yanked
  // back. Hydration replays leave this false so reload doesn't re-trigger.
  previewUnread?: boolean;
  // Recent preview binds for this workflow, most-recent first. Surfaced in
  // the PREVIEW tab header as click-to-rebind pills. Updated by the
  // `preview_history` WS message; replayed alongside `preview_set` on
  // reconnect so reload doesn't lose the chain.
  previewHistory?: PreviewHistoryEntry[];
  // DEBAG sub-phase 5 — scoped standing review-gate approvals ("approve all like
  // this"), pushed via `gate_standing` (on rehydrate + on add/revoke). Rendered
  // with revoke controls in the CONFIG REVIEW SAFE-MODE section.
  standingGateApprovals?: GateStandingApprovalView[];
  // G1 — preview verification. `previewCapturing` is true while a CDP capture is
  // in flight (drives the spinner / disables the VERIFY buttons). `previewCaptures`
  // holds recent capture results most-recent first, each pointing at the report +
  // screenshot artifacts the server wrote. Ephemeral (not replayed) — re-arm by
  // capturing again after reconnect.
  previewCapturing?: boolean;
  previewCaptures?: PreviewCaptureRecord[];
  // Phase 4 — server-authoritative queue snapshot. Updated from `queue_update`
  // events. Replay reconstructs from the latest queue_update during reconnect.
  // Source-of-truth for the queue strip above the composer; the optimistic
  // ChatMessage.queued flag is still set on the originating tab so the
  // operator's send echoes immediately, but the strip's render reads from
  // here.
  queue?: { steering: Array<{ content: string; clientMessageId?: string; interrupt?: boolean }>; followUp: Array<{ content: string; clientMessageId?: string; interrupt?: boolean }> };
  // Phase 7b — set when this JobState was minted by a Task tool call from
  // another workflow. The TabBar filters parented children out of the top
  // tab strip until `promoted` is flipped (operator clicked "promote to
  // tab" on the inline card or TASKS row).
  parentWorkflowId?: string;
  promoted?: boolean;
  // Phase 8 — narrative-event timeline backing the HISTORY tab. Sourced
  // from events.jsonl replay (resume / reconnect) and from live broadcasts.
  // Append-only with dedup by seq; capped at 1000 entries via
  // appendHistoryEvent so a runaway tool-heavy workflow can't pin memory.
  historyEvents?: HistoryEventEntry[];
  // Phase 7b — Task children spawned by THIS workflow (parent view), keyed
  // by taskId. The inline chat card (rendered on the parent's Task tool_use
  // row) and the TASKS sub-tab both read from here. Populated by
  // `task_started` / `task_status` WS messages broadcast on the parent.
  // Empty on a child workflow's view; the child has no Task children of
  // its own (depth-1 cap).
  taskChildren?: Record<string, TaskChildEntry>;
  // WORKBENCH_EXPANSION_PLAN.md §C3 — latest LSP diagnostics, keyed by cwd-
  // relative file path. Each `diagnostics` WS message REPLACES the entry for
  // its file (an empty items[] clears it — that's how "fix the error, badge
  // drops" works). Transient: not persisted; rebuilt as the agent writes
  // files. Native-only; empty for transports without the write hook.
  diagnosticsByFile?: Record<string, DiagnosticItem[]>;
  // ARCO_OPS_PLAN.md Part M (Genesis, M2) — staged-ideation seed + the
  // engine's advisory readiness + next-field prompt for a from-nothing genesis
  // workflow. `genesisSeed` is mirrored from the server's `genesis_seed_updated`
  // (which the GENESIS tab also drives via `genesis_seed_update`). Present only
  // while the workflow is in its scratch ideation dir; the GENESIS tab is shown
  // only when `genesisSeed` is set AND config.workingDirectory is still a scratch
  // dir. `genesisScaffold` records the result of a completed scaffold (the bound
  // cwd + written docs + optional repo) for a one-shot success notice.
  genesisSeed?: GenesisSeed;
  genesisReadiness?: GenesisReadiness;
  genesisNextPrompt?: string;
  genesisScaffold?: { cwd: string; written: string[]; planId?: string; repoUrl?: string; repoError?: string; creative?: boolean; suggestSpawn?: boolean };
  genesisAssist?: {
    requestId: string;
    field: GenesisAssistField;
    intent: GenesisAssistIntent;
    status: 'running' | 'proposed' | 'error';
    suggestion?: string;
    rationale?: string;
    options?: GenesisNameOption[];
    error?: string;
  };
  // ARCO_OPS_PLAN.md M3 — in-workflow Creative mode. `genesisCreativeArmed`
  // tracks the operator-armed toggle on an existing real-cwd workflow (distinct
  // from a from-nothing genesis, whose seed has no `creative` flag). `genesisCodebase`
  // is the point-in-time size/established assessment shown as the late-stage warning.
  genesisCreativeArmed?: boolean;
  genesisCodebase?: GenesisCodebaseInfo;
  // NATIVE_COMPACTION_PLAN Phase 3 — CLI-grade compaction takeover. Set true on
  // `native_compacting` (the worker is mid-summarization, ~1-2 min), driving a
  // prominent "Compacting conversation…" overlay in ChatPanel and greying the
  // composer send. Cleared on `native_compacted` (success), on any compaction-
  // failure `system_notice`, and on `primary_turn_ended` / `turn_cancelled` so
  // it can't get stuck on. `compactingFoldedTurns` carries the pre-count for the
  // banner copy ("folding N turns"). Live-only; never replayed.
  compacting?: boolean;
  compactingFoldedTurns?: number;
  // NATIVE_COMPACTION_PLAN Phase 3 — post-compaction "Continue" affordance. Set
  // on `native_compacted` (cleared once the operator clicks Continue or sends any
  // message). `foldedTurns` drives the "folded N turns" summary line. Default
  // resume is MANUAL — the operator clicks Continue; auto-send is opt-in behind
  // `config.nativeCompactAutoContinue` and handled server-side, so the banner
  // simply doesn't appear when the auto path already re-seeded a turn.
  compactedResume?: { foldedTurns?: number; at: number } | null;
}

// Phase 8 — narrative event for the HISTORY tab timeline. Populated from
// events.jsonl replay on reconnect and from live broadcasts as they
// arrive. Append-only; entries dedup by `seq` so a snapshot replay that
// re-emits the same event doesn't double-render. The HISTORY tab filters
// by `category` per the filter strip presets.
export interface HistoryEventEntry {
  seq: number;
  category: 'user' | 'primary' | 'tool' | 'task' | 'handoff' | 'review' | 'label' | 'checkpoint' | 'fork';
  // Display columns. `label` is the short tag ("USER", "PRIMARY", "TOOL",
  // "TASK ⚡", etc.); `summary` is the inline-truncated text shown next to it.
  label: string;
  summary?: string;
  // Wall-clock time when known. Live receive uses Date.now(); replayed events
  // adopt whatever timestamp the source message exposes (user_message_echo.timestamp,
  // task_started.startedAt, handoff_artifact_ready.completedAt, etc.) or
  // remain undefined when no field carries one.
  at?: number;
  // Chat-message id when the event has a stable mapping back to a ChatMessage
  // row. Only user_message_echo (with clientMessageId) reliably maps today;
  // selecting other event types still drives LABEL / REVIEW / SPAWN but
  // doesn't trigger the chat-side scroll-and-flash.
  chatMessageId?: string;
  // Per-category extras for richer rendering. Populated as the receive
  // handler builds the entry.
  tool?: string;
  taskPhase?: 'running' | 'done' | 'error' | 'cancelled';
  reviewVerdict?: 'PASS' | 'MINOR' | 'BLOCKING';
  reviewArtifactName?: string;
  handoffArtifactName?: string;
  // Phase 8 — operator-pinned label rows carry the anchored event's seq so
  // they sort beside it on the timeline (not at the bottom where they
  // persisted). `pinnedAt` is the wall-clock when the label was created;
  // `at` adopts the anchor row's timestamp at append time.
  anchorSeq?: number;
  pinnedAt?: number;
  // Workbench Expansion A4 — checkpoint rows. `checkpointSeq` is the guard seq
  // the checkpoint was taken against (the value sent on revert_to_checkpoint);
  // `checkpointRef` is the git ref / tar name for display + diff. `reverted`
  // flags the checkpoint_reverted marker so HISTORY can tint it differently and
  // skip offering "revert to here" on a revert-event row.
  checkpointSeq?: number;
  checkpointRef?: string;
  reverted?: boolean;
  // PHASE_9_FORKS_PLAN.md — `fork` rows are leaf_move (REWIND CONVERSATION)
  // markers. `branchSource` is the deterministic tag (v1 always 'revert');
  // `rewindTargetSeq` is the seq the head was moved to.
  branchSource?: BranchSource;
  rewindTargetSeq?: number;
}

// Phase 8 — sort key is `anchorSeq ?? seq` so labels travel with their
// pinned row. On ties (label.anchorSeq === otherEvent.seq) the label sits
// after the anchored event so the timeline reads "anchor row, then label".
export function compareHistoryEntries(a: HistoryEventEntry, b: HistoryEventEntry): number {
  const ka = a.anchorSeq ?? a.seq;
  const kb = b.anchorSeq ?? b.seq;
  if (ka !== kb) return ka - kb;
  if (a.category === 'label' && b.category !== 'label') return 1;
  if (b.category === 'label' && a.category !== 'label') return -1;
  return a.seq - b.seq;
}

export interface TaskChildEntry {
  taskId: string;
  childWorkflowId: string;
  // Anthropic block.id from the parent assistant's tool_use block. Used as
  // the chat-side lookup key — the inline card matches its host tool_use
  // row by toolUseId. Stable across reconnects.
  toolUseId: string;
  description: string;
  phase: 'running' | 'done' | 'error' | 'cancelled';
  startedAt: number;
  settledAt?: number;
  elapsedMs?: number;
  summary?: string;
}

export function mergeTokens(a: TokenUsage, b?: TokenUsage): TokenUsage {
  if (!b) return a;
  return {
    input: a.input + (b.input ?? 0),
    output: a.output + (b.output ?? 0),
    cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
    cacheCreate: (a.cacheCreate ?? 0) + (b.cacheCreate ?? 0),
    reasoningOutput: (a.reasoningOutput ?? 0) + (b.reasoningOutput ?? 0),
    total: typeof a.total === 'number' || typeof b.total === 'number'
      ? (a.total ?? 0) + (b.total ?? 0)
      : undefined,
  };
}

export interface AppState {
  connected: boolean;
  // ARCO_OPS_PLAN.md §C1 — richer overlay on top of `connected`. Set from
  // the WS hook's /healthz probe: distinguishes a browser/network WS drop
  // (`disconnected`, server alive) from a dead server process (`server-down`).
  // `connected` stays the load-bearing boolean other code reads; this is the
  // display nuance for the header. Defaults to 'connecting' on boot.
  connectionState: ConnectionState;
  sessionId: string | null;
  capabilities: Capabilities | null;
  usage: UsageInfo | null;
  codexUsage: CodexUsageInfo | null;
  cursorUsage: CursorUsageInfo | null;
  zaiUsage: ZaiUsageInfo | null;
  shutdown: boolean;
  shutdownReason: string | null;
  authStatus: AuthStatusByProvider | null;
  // Live Ollama daemon snapshot — null when polling is disabled (provider
  // off in settings, or daemon last seen down). The header indicator reads
  // both this and authStatus.ollama: authStatus tells us the daemon is up
  // at all; ollamaLive tells us whether a model is currently loaded.
  ollamaLive: OllamaLiveStatus | null;
  // Same shape as ollamaLive but for llama.cpp. Populated only when
  // enabledProviders.llamacpp AND the auth probe sees the binary; cleared
  // otherwise so the header chip drops out cleanly.
  llamacppLive: LlamacppLiveStatus | null;
  // Live Claude model catalog — server-fetched from Anthropic's /v1/models
  // (cached for an hour server-side, refreshed at boot + on reconnect).
  // null until first fetch; empty `models` when no Native auth set up.
  // The picker falls back to the static CLAUDE_MODELS list when this is
  // null or empty.
  claudeNativeCatalog: ClaudeCatalogSnapshot | null;
  // Live Codex catalog — populated by /api/codex/catalog. Same lazy-1h-cache
  // semantics as claudeNativeCatalog. Null on cold-start or fetch failure;
  // pickers fall back to the static CODEX_MODELS list.
  codexCatalog: CodexCatalogSnapshot | null;
  // Per-account Codex catalogs, keyed by account-profile id. Codex model
  // availability is entitlement-gated per account (HOME vs WORK), so each
  // profile is polled separately (App.tsx). Account-aware pickers read this
  // via useCodexCatalogFor(accountRef); `codexCatalog` above is the
  // default-account fallback for surfaces without an account in scope.
  codexCatalogByAccount: Record<string, CodexCatalogSnapshot>;
  // Live Gemini catalog — populated by /api/gemini-native/catalog. Null on
  // cold-start or fetch failure; picker falls back to static GEMINI_MODELS.
  geminiNativeCatalog: GeminiCatalogSnapshot | null;
  // Live Cursor catalog — populated by /api/cursor/catalog. Null on cold-start
  // or fetch failure; picker falls back to a static `auto`-only seed.
  cursorCatalog: CursorCatalogSnapshot | null;
  settings: ArcoSettings | null;
  showSettings: boolean;
  showGithub: boolean;
  showManual: boolean;
  // I3 — focus mode. An operator-armed UI mode that hides secondary chrome
  // (right panel + header action groups + usage bar) to give the chat/composer
  // the full width while an agent works. Persisted to localStorage so it
  // survives a reload; fully reversible (toggle off restores everything).
  focusMode: boolean;
  // §F3 — top-level Recall search overlay. Toggled from the command palette
  // ("Recall: search conversations") or the header button. Full-screen modal,
  // not a per-tab RightPanel sub-tab.
  showRecall: boolean;
  // WORKBENCH_EXPANSION §H1 — Media studio modal host. `open` mounts the modal;
  // `path` (optional) is the on-disk file to load on open (contextual right-click
  // entry); `mode` is the initial editor (image/audio/video). All three are set
  // together by the launchers in components/media/launchers.ts. Empty open
  // (header / palette) sets just open+mode with no path (Import affordance).
  // §H4 — `edit: true` opens image mode directly in the raster editor (Open-in-
  // editor on a generated-image artifact); otherwise the viewer opens and the
  // operator toggles EDIT manually. `context` pins the cwd a RELATIVE path
  // resolves against (the emitting workflow's, e.g. an image artifact from a
  // background tab) — without it the host falls back to the ACTIVE tab's cwd,
  // which is the wrong base whenever a different tab is focused.
  mediaStudio: { open: boolean; path?: string; mode?: 'image' | 'audio' | 'video'; edit?: boolean; context?: { cwd: string; workflowId: string } };
  // Contextual help system. helpMode toggled by the floating "?" button or
  // Escape; while on, body.help-mode is set and clicks on [data-help]
  // elements are intercepted (capture-phase) and surface as a popover keyed
  // by activeHelpPopover.key. anchorRect is the clicked element's
  // boundingClientRect at click time so the popover positions deterministically.
  helpMode: boolean;
  activeHelpPopover: {
    key: string;
    anchorRect: { top: number; bottom: number; left: number; right: number; width: number; height: number };
  } | null;
  // Movable in-modal help card. The "? HELP" button on full-tool modals (Media
  // studio, Cookbook, …) opens this instead of burying the whole manual behind
  // the modal: a draggable, filterable panel listing JUST the snippets whose
  // manualSection matches `section`. `title` is the human heading.
  activeHelpCard: { section: string; title: string } | null;
  // In-app file viewer for the Manual / help popovers / anywhere a DocRef is
  // clicked. Set to a path (repo-relative) to open the modal; null to close.
  // Replace-in-place semantics: a second click on a different DocRef while
  // the modal is open just swaps the path, no stacking.
  activeDocRef: { path: string } | null;
  quotaState: QuotaSnapshot | null;
  // CLI help-surface changes detected at server boot, filtered server-side
  // to only unacknowledged version bumps. Drives the CONFIG tab red dot
  // and the CLI STATUS card. Empty array = dot off.
  cliChanges: CliChangeEntry[];
  artifactQueue: ArtifactItem[];
  // ARCO_OPS_PLAN.md §D1 — project task ledger, keyed by cwd for the default
  // board and by `${cwd}::${boardKey}` for namespaced boards. Mirrors the
  // server's task_ledger_snapshot broadcasts. A missing key = not yet loaded.
  taskLedger: Record<string, LedgerTask[]>;
  // ARCO_OPS_PLAN.md §E1 — global MCP registry snapshot (machine-wide list;
  // CRUD broadcasts replace it wholesale). Empty until the first snapshot.
  mcpRegistry: McpRegistryRow[];
  // Last probe result per serverId — drives the diagnostics + visible tool
  // list in the MCP config section. Keyed by serverId.
  mcpProbeResults: Record<string, McpProbeState>;
  // Per-workflow MCP allowlist (enable + dangerous-tool ticks), keyed by
  // workflowId. Pushed by the server on mcp_registry_list (with workflowId)
  // and after mcp_workflow_allow.
  mcpAllow: Record<string, McpWorkflowAllow[]>;
  // H21 — pending OSV malware warning from a blocked registry-add. Set when the
  // server refused a create pending operator override; cleared on proceed/cancel.
  mcpMalwareWarning: {
    pending: { name: string; command: string; args: string[]; env?: Record<string, string>; enabled?: boolean; overrideMalwareWarning?: boolean };
    packages: Array<{ name: string; ecosystem: string; ids: string[] }>;
  } | null;
  // Worker the operator clicked to inspect — opens the detail modal. Cleared
  // on close, on tab switch, or when the worker no longer exists.
  detailWorker: { jobId: string; workerId: string } | null;

  // Multi-job
  jobs: Record<string, JobState>;
  activeJobId: string | null;
  showCreator: boolean; // show workflow creator panel
  creatorRequested: boolean;
  showHome: boolean;
  creatorPrefill: CreatorPrefill | null;

  // Phase 2.5.1 — transient toasts for server-side rejections that would
  // otherwise vanish into the console. Render in the top-right corner;
  // auto-dismiss 6s after `createdAt`. Currently fed by useWebSocket's
  // `error` handler so cluster-action rejections (Native fence etc.) are
  // visible regardless of which tab is focused.
  notifications: Array<{
    id: string;
    level: 'error' | 'info';
    message: string;
    createdAt: number;
  }>;
  // Worktree bake-offs are keyed by their source workflow. The source tab
  // owns comparison/promotion; attempt tabs stay ordinary JobState entries.
  bakeoffsByWorkflow: Record<string, BakeoffState[]>;

  // CLUSTER_MODE_PLAN.md Phase 2 — cluster mirror. Server is authoritative;
  // client mirrors a `cluster_state` payload per cluster. Membership is
  // fixed-at-create in Phase 2 (member_added / member_removed messages
  // exist for forward-compat but never fire today). activeClusterId is
  // mutually exclusive with activeJobId — setting one clears the other so
  // App.tsx's routing branch picks one or the other deterministically.
  clusters: Record<string, ClusterStatePayload>;
  clusterMemberLabels: Record<string, ClusterMemberLabel>;
  activeClusterId: string | null;
  // Slice 6a — operator's currently-focused member inside each cluster tab.
  // Local UI state per cluster (not persisted); defaults to the first member
  // when a cluster is activated. Lifted to the store so the TabBar's bottom
  // row can highlight the same member ClusterTab is rendering as focused.
  clusterFocusedMember: Record<string, string>;
  // CLUSTER_GRID_PLAN.md §4 — fraction of ClusterTab body width given to
  // the MemberCard grid (left). Detail MemberPane gets the remainder.
  // Persisted via the existing zustand-persist partialize so the splitter
  // survives reload. Clamped at use-site to [240px / 360px] minimums.
  clusterGridSplit: number;
  // Operator-selected arrangement for the compact member cards in a cluster
  // tab. 'auto' preserves the historical balanced layout; explicit modes
  // let narrow clusters become top/bottom rows or horizontal strips.
  clusterCardLayout: ClusterCardLayout;
  handoffLocksByCwd: Record<string, HandoffLockEntry[]>;

  // Composer drafts MOVED to stores/draftStore.ts (2026-08-06). Same semantics
  // — per-workflow unsent text, survives tab-switch remounts, nothing crosses
  // between tabs, not persisted. They live in their own store because writing
  // appStore on every keystroke made each character pay appStore's whole
  // subscriber fan-out (measured 37.2ms vs 4.2ms). `setDraft` / `clearDraft`
  // below remain as delegating wrappers so call sites are unchanged.
  // Composer attachments — per-workflow staged files (uploaded to the server
  // but not yet sent). Lifted to the store for the same reason as `drafts`:
  // survive tab-switch remounts. `previewUrl` is a blob URL created with
  // URL.createObjectURL; revocation lives in the actions below so the URL
  // outlives component mount/unmount cycles.
  attachments: Record<string, DraftAttachment[]>;

  // Helpers
  getActiveJob: () => JobState | undefined;
  getAuthedProviders: () => ProviderName[];
  trimMemory: () => void;
  // A1 — live retention snapshot (dev MemoryHud + mem-retention smoke).
  getRetentionStats: () => RetentionStats;
  // True if the provider is enabled in settings (or settings hasn't loaded yet
  // — fail-open so the UI doesn't briefly hide everything during startup).
  isProviderEnabled: (p: ProviderName) => boolean;

  // Connection
  setConnected: (connected: boolean, sessionId?: string) => void;
  // ARCO_OPS_PLAN.md §C1 — pushed from the WS hook after each socket
  // transition / healthz probe. Drives the header's connection badge.
  setConnectionState: (state: ConnectionState) => void;
  // §C1 — stamp the last primary content signal (turn start / text / thinking
  // / tool_use / activity / complete) for the stuck-vs-busy distinction.
  bumpPrimaryEvent: (jobId: string, at: number) => void;
  // §C2 — clear the replay-recovered anchor when the operator dismisses the banner.
  clearRecovered: (jobId: string) => void;
  setCapabilities: (c: Capabilities) => void;
  setUsage: (u: UsageInfo) => void;
  setCodexUsage: (u: CodexUsageInfo) => void;
  setCursorUsage: (u: CursorUsageInfo) => void;
  setZaiUsage: (u: ZaiUsageInfo) => void;
  setShutdown: (v: boolean, reason?: string | null) => void;
  setAuthStatus: (s: AuthStatusByProvider) => void;
  setOllamaLive: (s: OllamaLiveStatus | null) => void;
  setLlamacppLive: (s: LlamacppLiveStatus | null) => void;
  setClaudeNativeCatalog: (snap: ClaudeCatalogSnapshot | null) => void;
  setCodexCatalog: (snap: CodexCatalogSnapshot | null) => void;
  setCodexCatalogForAccount: (accountRef: string, snap: CodexCatalogSnapshot) => void;
  setGeminiNativeCatalog: (snap: GeminiCatalogSnapshot | null) => void;
  setCursorCatalog: (snap: CursorCatalogSnapshot | null) => void;
  setSettings: (s: ArcoSettings) => void;
  // Themes Phase 2 — applies theme locally (optimistic), patches /api/settings,
  // reverts from authoritative state on failure. No-op on unknown ids.
  setThemeId: (id: string) => Promise<void>;
  // Font-pack override — same pattern as setThemeId. Pass null/undefined to clear.
  setFontPackOverride: (id: string | null | undefined) => Promise<void>;
  // Frosted-glass override — 'on'/'off' force the backdrop-filter; null/undefined
  // clears the override so the active theme's own `frosted` default applies.
  setFrostedOverride: (v: 'on' | 'off' | null | undefined) => Promise<void>;
  // Frosted-glass panel opacity (0.3–0.95). Higher = more opaque. null/undefined
  // clears the override so the built-in 0.6 default applies. Only affects panels
  // while frosted glass is on.
  setFrostedOpacity: (v: number | null | undefined) => Promise<void>;
  // Live preview while dragging the opacity slider — applies CSS vars without
  // persisting. setFrostedOpacity commits on release.
  previewFrostedOpacity: (v: number) => void;
  // Background / text brightness shifts (signed −30…+30 HSL lightness points,
  // 0 = stock). bg shifts `color-bg*` tokens, text shifts everything else.
  // null/undefined = 0. See themes/apply.ts.
  setBgBrightness: (v: number | null | undefined) => Promise<void>;
  setPhosphorPreference: <K extends 'phosphorEffects' | 'phosphorSoftness'>(field: K, value: NonNullable<ArcoSettings[K]>) => Promise<void>;
  setTextBrightness: (v: number | null | undefined) => Promise<void>;
  // Live preview while dragging a brightness slider — applies CSS vars without
  // persisting. setBg/TextBrightness commit on release.
  previewBgBrightness: (v: number) => void;
  previewTextBrightness: (v: number) => void;
  // Global "crisp text" toggle — kills theme text-shadow glow so small text stays
  // sharp. Only flips the data-crisp root attribute (see themes/apply.ts).
  setCrispText: (v: boolean) => Promise<void>;
  // Slice 6a — operator-set top-row tab order (workflowIds + clusterIds).
  setTabOrder: (tabOrder: string[]) => Promise<void>;
  setShowSettings: (v: boolean) => void;
  setShowGithub: (v: boolean) => void;
  setShowManual: (v: boolean) => void;
  setShowRecall: (v: boolean) => void;
  setFocusMode: (v: boolean) => void;
  // §H1 — open/close the Media studio. Open carries the initial mode + optional
  // on-disk path; close clears the companion state so the next open starts fresh.
  setMediaStudio: (v: AppState['mediaStudio']) => void;
  setHelpMode: (v: boolean) => void;
  setActiveHelpPopover: (v: AppState['activeHelpPopover']) => void;
  setActiveHelpCard: (v: AppState['activeHelpCard']) => void;
  setActiveDocRef: (v: AppState['activeDocRef']) => void;
  setQuotaState: (q: QuotaSnapshot) => void;
  setCliChanges: (c: CliChangeEntry[]) => void;
  // ARCO_OPS_PLAN.md §D1 — replace the cwd's task list from a snapshot.
  setTaskLedger: (cwd: string, tasks: LedgerTask[], boardKey?: string) => void;
  setMcpRegistry: (defs: McpRegistryRow[]) => void;
  setMcpProbeResult: (serverId: string, result: McpProbeState) => void;
  setMcpAllow: (workflowId: string, allow: McpWorkflowAllow[]) => void;
  setMcpMalwareWarning: (w: AppState['mcpMalwareWarning']) => void;
  acknowledgeCliChange: (provider: CliChangeEntry['provider'], toVersion: string) => Promise<void>;
  enqueueArtifact: (a: ArtifactItem) => void;
  dequeueArtifact: (artifactId: string) => void;
  setDetailWorker: (target: { jobId: string; workerId: string } | null) => void;

  // Job management
  createJob: (
    id: string,
    config: WorkflowConfig,
    resumedVia?: 'native' | 'bootstrapped',
    parentWorkflowId?: string,
    backgroundCreated?: boolean,
    restored?: boolean,
  ) => void;
  setActiveJob: (id: string) => void;
  showJobCreator: () => void;
  showHomeView: () => void;
  openCreatorWith: (prefill: CreatorPrefill) => void;
  takeCreatorPrefill: () => CreatorPrefill | null;
  removeJob: (id: string) => void;
  pushNotification: (level: 'error' | 'info', message: string) => void;
  dismissNotification: (id: string) => void;
  setBakeoffs: (workflowId: string, bakeoffs: BakeoffState[]) => void;
  upsertBakeoff: (workflowId: string, bakeoff: BakeoffState) => void;

  // Cluster management (Phase 2)
  setClusterState: (clusterId: string, state: ClusterStatePayload) => void;
  clearCluster: (clusterId: string) => void;
  setActiveCluster: (clusterId: string | null) => void;
  // Slice 6a — focus shifts from bottom-row member tabs and from
  // ClusterTab's first-render default. No-op when workflowId isn't a
  // member of the cluster.
  setClusterFocusedMember: (clusterId: string, workflowId: string) => void;
  setClusterGridSplit: (value: number) => void;
  setClusterCardLayout: (layout: ClusterCardLayout) => void;
  setHandoffLocks: (cwd: string, locks: HandoffLockEntry[]) => void;
  changeWorkflowSession: (jobId: string, newSessionId: string) => void;
  // Wholesale config replace from the server (workflow_config_synced /
  // workspace_snapshot) — mirrored browsers converge on the server's config.
  replaceJobConfig: (jobId: string, config: WorkflowConfig) => void;
  updateJobPrimary: (jobId: string, update: { provider?: ProviderName; model?: ModelName; effort?: EffortLevel; providerAccountRef?: string; autoHandoff?: { enabled: boolean; warnAt: number; autoAt: number; mode?: 'original-worker' | 'fresh-summarizer'; summarizer?: { provider: ProviderName; model?: ModelName; effort?: EffortLevel } }; autoFold?: { enabled: boolean; foldAt: number; tailBudget?: number }; codexTransport?: 'exec' | 'appserver'; codexContextPolicy?: 'max' | 'standard'; claudeTransport?: 'cli' | 'native'; ultracode?: boolean; webSearchMaxUses?: number; chatWebAccess?: boolean; zaiTransport?: 'native' | 'appserver'; claudeNativeCompact?: boolean; claudeNativeForceInterleavedThinkingBeta?: boolean; claudeNativeThinkingDisplay?: 'omitted' | 'summarized' | 'updates'; nativeCompactAutoContinue?: boolean; efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive'; efficiencyFactForce?: 'on' | 'off'; efficiencyConfigProtection?: 'on' | 'off'; efficiencySandbox?: 'off' | 'on'; reviewSafeMode?: 'off' | 'on'; outputStyle?: 'normal' | 'lite' | 'terse'; goalRun?: { enabled: boolean; total?: number; tokenBudget?: number }; goal?: string; pinnedSkills?: ArcoSkillRef[]; remoteEnabled?: boolean; remoteGatesEnabled?: boolean; ollamaParams?: Record<string, unknown> }) => void;
  // EFFICIENCY_PLAN.md Phase F — mirror of the server's
  // `codebase_memory_state` push onto `job.config.codebaseMemory` so the
  // CONFIG section + Files-tab Blast Radius sub-tab read from one source.
  setCodebaseMemoryState: (jobId: string, state: { attached: boolean; indexPath?: string; lastIndexedAt?: number; fileCount?: number }) => void;
  // MASTER_REFACTOR §3.3 F5 — server pushed `workflow_renamed`. Null name
  // clears back to the wfid-prefix default (the server will resolve the
  // displayName fallback; client just drops the override).
  setWorkflowName: (jobId: string, name: string | null) => void;

  // ARCO_OPS_PLAN.md M2 — Genesis seed/readiness mirror + cwd rebind + scaffold result.
  setGenesisSeed: (jobId: string, payload: { seed: GenesisSeed; readiness: GenesisReadiness; nextPrompt: string }) => void;
  setWorkflowCwd: (jobId: string, cwd: string) => void;
  setGenesisScaffold: (jobId: string, result: NonNullable<JobState['genesisScaffold']>) => void;
  setGenesisAssistStarted: (jobId: string, payload: { requestId: string; field: GenesisAssistField; intent: GenesisAssistIntent }) => void;
  setGenesisAssistProposed: (jobId: string, payload: { requestId: string; field: GenesisAssistField; intent: GenesisAssistIntent; suggestion: string; rationale?: string; options?: GenesisNameOption[]; error?: string }) => void;
  clearGenesisAssist: (jobId: string, requestId?: string) => void;
  // ARCO_OPS_PLAN.md M3 — in-workflow Creative mode arm/disarm echo.
  setGenesisCreative: (jobId: string, payload: { armed: boolean; seed: GenesisSeed; readiness: GenesisReadiness; nextPrompt: string; codebase?: GenesisCodebaseInfo }) => void;

  // Scoped actions (by jobId)
  addMessage: (jobId: string, msg: ChatMessage) => void;
  removeMessage: (jobId: string, messageId: string) => void;
  updateMessage: (jobId: string, messageId: string, patch: Partial<ChatMessage>) => void;
  // DEBAG (docs/DEBAG_PLAN.md) — merge resolution state into a gate card's
  // toolUse.input (keyed by gateId → the `gate::<gateId>` message).
  resolveGate: (jobId: string, gateId: string, patch: Record<string, unknown>) => void;
  // DEBAG sub-phase 5 — replace the per-workflow standing-approval list (full
  // snapshot from a `gate_standing` broadcast).
  setStandingGateApprovals: (jobId: string, approvals: GateStandingApprovalView[]) => void;
  prependMessages: (jobId: string, msgs: ChatMessage[]) => void;
  appendToStreamingMessage: (jobId: string, messageId: string, text: string) => void;
  finalizeMessage: (jobId: string, messageId: string) => void;
  addCost: (jobId: string, amount: number) => void;
  addTokens: (jobId: string, tokens: TokenUsage) => void;
  // Per-turn snapshot — not merged. Called only from orchestrator_complete so
  // OrchestratorNode can show the context-fill bar against auto-compact.
  setLastTurnTokens: (jobId: string, tokens: TokenUsage) => void;
  setLastGenSpeed: (jobId: string, speed: GenerationSpeed | undefined) => void;
  appendTurnTokenUsage: (jobId: string, usage: PrimaryTurnTokenUsageMessage) => void;
  bumpToolCallsSinceHandoff: (jobId: string) => void;
  resetToolCallsSinceHandoff: (jobId: string) => void;
  setToolCallsSinceCompact: (jobId: string, count: number) => void;
  bumpSandboxChunkCount: (jobId: string) => void;
  resetSandboxChunkCount: (jobId: string) => void;
  setSandboxChunkCount: (jobId: string, count: number) => void;
  recordToolFiltered: (jobId: string, entry: { toolUseId: string; filterName: string; originalBytes: number; filteredBytes: number; rawArtifactPath?: string }) => void;
  setDiagnostics: (jobId: string, file: string, items: DiagnosticItem[]) => void;
  setModelContextWindow: (jobId: string, modelContextWindow: number) => void;
  setPrimaryModel: (jobId: string, resolvedModel: string) => void;
  setToolPosture: (jobId: string, posture: ToolPosture) => void;
  setWorkflowGoal: (jobId: string, goal: string | null) => void;
  // GOAL_RUN_PLAN.md — mirror of the server's goal_run_state broadcast.
  // undefined ⇒ the run is off (armed state is never persisted server-side, so
  // a reconnect after a restart correctly shows no run).
  setGoalRun: (jobId: string, state: WorkflowConfig['goalRun']) => void;
  setProjectTrustPrompt: (jobId: string, prompt: { cwd: string; resources: string[] } | undefined) => void;
  recordTurnCancelled: (jobId: string, reason: 'operator-stop' | 'quota-exhausted' | 'round-cap') => void;
  setWorkerModel: (jobId: string, workerId: string, resolvedModel: string) => void;
  spawnWorker: (jobId: string, workerId: string, model: ModelName, effort: EffortLevel, task: string, provider?: ProviderName) => void;
  appendWorkerOutput: (jobId: string, workerId: string, text: string) => void;
  appendWorkerThinking: (jobId: string, workerId: string, text: string) => void;
  recordWorkerToolCall: (jobId: string, workerId: string, tool: string, input: string) => void;
  completeWorker: (jobId: string, workerId: string, costUsd: number, durationMs: number, tokens?: TokenUsage, permissionDenials?: Array<{ tool: string; input: string }>) => void;
  failWorker: (jobId: string, workerId: string) => void;
  setWorkerActivity: (jobId: string, workerId: string, activity: { alive: boolean; cpuActive: boolean; descendantCount: number; rssBytes: number }) => void;
  applyWorkflowSnapshot: (jobId: string, workers: Record<string, WorkerState>, busy: boolean, transcriptTail: ChatMessage[]) => void;
  // Phase 5 — insert or patch a review entry (keyed by reviewId). Called
  // from both `review_started` (initial insert with reviewer config) and
  // `review_artifact_ready` (patch with artifactName/verdict/error). An
  // out-of-order `ready` (client missed `started`) falls back to the seed
  // values in the patch.
  upsertReview: (jobId: string, reviewId: string, patch: Partial<Omit<ReviewEntry, 'reviewId'>>) => void;
  // WORKBENCH_EXPANSION_PLAN.md §B2 — insert or patch a research entry (keyed
  // by researchId). Called from `research_started` (seed) / `research_progress`
  // (progressNote) / `research_complete` (artifactName, roundsUsed, sourceCount,
  // error). Out-of-order events fall back to the patch's seed values.
  upsertResearch: (jobId: string, researchId: string, patch: Partial<Omit<ResearchEntry, 'researchId'>>) => void;
  upsertHandoff: (jobId: string, handoffId: string, patch: Partial<Omit<HandoffEntry, 'handoffId'>>) => void;
  setPlan: (jobId: string, plan: NonNullable<JobState['plan']> | null) => void;
  setPreview: (jobId: string, preview: NonNullable<JobState['preview']> | null, freshlyBound?: boolean) => void;
  setPreviewHistory: (jobId: string, entries: PreviewHistoryEntry[]) => void;
  markPreviewSeen: (jobId: string) => void;
  setPreviewCapturing: (jobId: string, capturing: boolean) => void;
  addPreviewCapture: (jobId: string, capture: PreviewCaptureRecord) => void;
  setPendingPlanCapture: (jobId: string, mode: 'review' | 'autosave' | null) => void;
  setPlanCandidate: (jobId: string, candidate: NonNullable<JobState['planCandidate']> | null) => void;
  // Server-authoritative turn lifecycle. start clears the prior turn's
  // activity feed + sets turnStartedAt. end just drops the busy flag;
  // activity lingers so operators can read what just happened.
  beginPrimaryTurn: (jobId: string, startedAt: number) => void;
  endPrimaryTurn: (jobId: string) => void;
  appendActivity: (jobId: string, entry: ActivityEntry) => void;
  setPrimaryBackgroundJobs: (jobId: string, jobs: PrimaryBackgroundJob[]) => void;
  // Clear activity on fresh user message (the NEW turn hasn't started yet
  // but the operator is steering — make the feed empty for the next turn).
  clearActivity: (jobId: string) => void;
  // ULTRACODE_PLAN.md — replace the live ultracode fleet snapshot (or null it).
  setUltracodeFleet: (jobId: string, snapshot: UltracodeFleetSnapshot | null) => void;
  // Slot 5 — monotonically advance lastSeq as the client observes server-
  // stamped events. Also called unconditionally with `force=true` to accept
  // a snapshot-provided reset (rotation fallback); Math.max logic otherwise.
  updateLastSeq: (jobId: string, seq: number, force?: boolean) => void;
  // Slot 2 — flipped true when this job's reconnect snapshot arrives.
  markSnapshotReceived: (jobId: string) => void;
  // Phase 1 — upsert a session JSONL entry into sessionChat (keyed by uuid
  // or content signature). Idempotent: re-emitting the same entry on reconnect
  // does not duplicate chat messages.
  upsertSessionChat: (jobId: string, entry: import('@arco/shared').SessionEntryMessage['entry'], attachments?: string[]) => void;
  // Tail-first hydration — set the has-earlier flag + page cursor from a
  // `session_history_status` message or transcript fetch response.
  setEarlierState: (jobId: string, patch: Partial<Pick<JobState, 'hasEarlierSessionHistory' | 'earlierTranscriptCursor' | 'earlierSource' | 'transcriptFetch'>>) => void;
  // Phase 2 — replace the current context-fill estimate.
  setContextUsage: (jobId: string, usage: NonNullable<JobState['contextUsage']>) => void;
  clearTurnUsageState: (jobId: string) => void;
  // NATIVE_COMPACTION_PLAN Phase 3 — compaction takeover lifecycle.
  // `beginCompacting` flips the takeover on (native_compacting); `endCompacting`
  // clears it and opens the post-compaction Continue affordance (native_compacted);
  // `clearCompacting` clears both the takeover AND the Continue banner (failure
  // notice, turn boundary, or the operator resuming).
  beginCompacting: (jobId: string, foldedTurns?: number) => void;
  endCompacting: (jobId: string, foldedTurns?: number) => void;
  clearCompacting: (jobId: string) => void;
  setClaudeSessionId: (jobId: string, sessionId: string) => void;
  setSessionMetadata: (jobId: string, metadata?: WorkflowSessionMetadata) => void;
  setDraft: (jobId: string, text: string) => void;
  clearDraft: (jobId: string) => void;
  addAttachment: (jobId: string, att: DraftAttachment) => void;
  removeAttachment: (jobId: string, index: number) => void;
  clearAttachments: (jobId: string) => void;

  // Phase 7b — raw WS sender registered by useWebSocket on mount. Lets
  // self-contained chat-message components (AskUserQuestionNotice) reply
  // without threading callbacks through the prop tree.
  wsSendRaw: ((msg: unknown) => void) | null;
  setWsSendRaw: (fn: ((msg: unknown) => void) | null) => void;

  // Phase 8 — HISTORY tab → ChatPanel scroll-and-flash. Set by HistoryTab
  // selection for events that carry a stable chatMessageId (today: user
  // messages); ChatPanel watches and scrolls/flashes the matching row.
  // `at` is bumped each click so a second selection of the same row
  // re-fires the effect.
  flashTarget: { jobId: string; messageId: string; at: number } | null;
  flashChatMessage: (jobId: string, messageId: string) => void;
  // Phase 8 — append a narrative event to a workflow's HISTORY timeline.
  // Dedups by seq (replay can re-emit) and caps at 1000 entries.
  appendHistoryEvent: (jobId: string, entry: HistoryEventEntry) => void;

  // Phase 7b — Task lifecycle from `task_started` / `task_status` WS
  // messages on the parent workflow. recordTaskStarted also injects a
  // synthetic ChatMessage carrying `toolUse: { tool: 'Task', toolUseId }`
  // so the inline card renders chronologically in chat (Native has no
  // Claude JSONL → no sessionChat tool_use rows).
  recordTaskStarted: (jobId: string, payload: {
    taskId: string;
    childWorkflowId: string;
    toolUseId: string;
    description: string;
    startedAt: number;
  }) => void;
  recordTaskStatus: (jobId: string, payload: {
    taskId: string;
    toolUseId: string;
    phase: 'running' | 'done' | 'error' | 'cancelled';
    elapsedMs: number;
    summary?: string;
  }) => void;
  // Operator clicked "promote to tab" on an inline Task card / TASKS row.
  // Flips `promoted` on the child JobState and switches the active tab
  // to it. No server round-trip — `workflow_created` already minted the
  // JobState; only the TabBar filter is gated on `promoted`.
  promoteTaskChild: (childWorkflowId: string) => void;
}

export interface AppMemoryStats {
  workflowCount: number;
  clusterCount: number;
  clusterMemberCount: number;
  hotRows: {
    messages: number;
    sessionChat: number;
    activity: number;
    historyEvents: number;
    workerToolCalls: number;
    mailboxDepth: number;
  };
  hotTextBytes: {
    messages: number;
    sessionChat: number;
    activity: number;
    workerOutput: number;
    workerThinking: number;
    workerToolInputs: number;
  };
  approxPersistedBytes: number;
  browserHeapBytes?: number;
}

export interface ClusterMemberLabel {
  displayName: string;
  role?: string | null;
}

export type ClusterCardLayout = 'auto' | 'rows' | 'columns' | 'grid';

export interface CreatorPrefill {
  mode: 'single' | 'chat' | 'cluster' | 'genesis';
  workDir?: string;
  resumeSessionId?: string;
}
