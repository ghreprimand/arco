// ── Clusters + peer messaging ──

// Providers that can participate in cluster peer-mode. Claude/Codex wire peer
// tools through Native/stdio-MCP. Cursor wires them through an in-process
// loopback HTTP MCP server (CURSOR_TRANSPORT_PLAN.md Phase 6 — Cursor ACP honors
// MCP over http/sse only, not stdio). Local providers (ollama/llamacpp) use
// Arco's in-process tool runtime and are serialized per provider to avoid
// local model fights.
export type ClusterMemberProvider = 'claude' | 'codex' | 'zai' | 'ollama' | 'llamacpp' | 'cursor';

export const CLUSTER_MEMBER_PROVIDERS = ['claude', 'codex', 'zai', 'ollama', 'llamacpp', 'cursor'] as const satisfies readonly ClusterMemberProvider[];

export function isClusterMemberProvider(v: unknown): v is ClusterMemberProvider {
  return typeof v === 'string' && (CLUSTER_MEMBER_PROVIDERS as readonly string[]).includes(v);
}

// Per-member information boundary. `standard` is the historical cluster
// member shape. `blind` keeps the project cwd but withholds every cluster
// surface except peer_send / peer_read. `isolated` additionally runs the
// worker against a private scratch cwd; v1 is Claude-Native-only because its
// file-tool root can be enforced by Arco and Bash can be removed.
export const CLUSTER_MEMBER_ACCESS_MODES = ['standard', 'blind', 'isolated'] as const;
export type ClusterMemberAccessMode = (typeof CLUSTER_MEMBER_ACCESS_MODES)[number];
export function isClusterMemberAccessMode(v: unknown): v is ClusterMemberAccessMode {
  return typeof v === 'string' && (CLUSTER_MEMBER_ACCESS_MODES as readonly string[]).includes(v);
}

// CLUSTER_MODE_PLAN.md Phase 1 — peer messaging events.
//
// Three kinds, all workflow-scoped (each member's events.jsonl carries
// only the events that apply to it):
//   peer_message_sent      — emitted on the SENDER's workflow when
//                             peer_send succeeds. Carries a content
//                             preview only (the full content can be
//                             reconstructed from the recipient's
//                             matching peer_message_received).
//   peer_message_received  — emitted on the RECIPIENT's workflow at
//                             injection time (pre-turn drain or mid-turn
//                             peer_read). Replay reproduces the
//                             system-block injection; ordering rule:
//                             always lands BEFORE the operator's
//                             user_message_echo on the same turn.
//   peer_send_rejected     — emitted on the SENDER's workflow when a
//                             peer_send is refused (budget exhausted,
//                             unknown peer, content too large). Plan
//                             §6.2 forbids silent budget violations.
//
// Tool-name note (plan §13 decision log): Anthropic's tool-name regex
// rejects `.`, so peer.list / peer.send / peer.read are registered as
// peer_list / peer_send / peer_read on the wire.
export interface PeerMessageSentMessage {
  type: 'peer_message_sent';
  workflowId: string;       // sender's workflow
  msgId: string;
  from: string;             // sender workflowId (== workflowId above)
  to: string;               // recipient workflowId
  contentPreview: string;   // up to 200 chars; full content lives in the recipient's record
  // Auto-turn-on-mailbox chain depth (CLUSTER_MODE_PLAN.md Phase 5b). 0 (or
  // absent) for operator-initiated sends. When the auto-turn detector fires a
  // turn on a recipient, peer_send originating during that turn carries
  // `chainDepth = senderTurnDepth + 1`. The detector refuses to auto-turn on
  // an incoming message whose chainDepth ≥ AUTO_TURN_MAX_CHAIN_DEPTH so a
  // peer→peer cascade can't run away. Stamped server-side at broadcast time
  // (peerOps doesn't see this field); see clusterAutoTurn.ts.
  chainDepth?: number;
}

export interface PeerMessageReceivedMessage {
  type: 'peer_message_received';
  workflowId: string;       // recipient's workflow
  msgId: string;
  from: string;             // sender workflowId
  fromName: string;         // sender display name (8-char prefix in Phase 1)
  content: string;          // full body — durable record, mailbox file is removed on drain
  // 2026-05-12 — original send time (ms epoch). When set, the client uses this
  // as the chat-row timestamp so peer messages sort at the moment they were
  // *sent*, not when the recipient drained them. Without this, mid-turn drains
  // make the peer row land below assistant text it actually triggered.
  ts?: number;
}

export interface PeerSendRejectedMessage {
  type: 'peer_send_rejected';
  workflowId: string;       // sender's workflow
  reason: string;           // "budget_exhausted" | "unknown_peer" | "content_too_large" | "recipient_not_in_cluster" | other code
  targetRef: string;        // resolved workflowId or operator-supplied unresolved ref
  count?: number;           // budget_exhausted: current send count this turn
  cap?: number;             // budget_exhausted: per-turn cap
}

// CLUSTER_MODE_PLAN.md Phase 2 — UI cluster tab.
//
// Phase 1 shipped the substrate (mailbox + peer tools + REST shim); Phase 2
// adds the WS surface that lets a UI tab subscribe to a cluster and broadcast
// a prompt to all idle members at once. The cluster_state push is the single
// source of truth for the operator's view; the client mirrors it under
// `clusters[clusterId]` and never derives membership from per-workflow events.
//
// Operator-only: cluster_create / cluster_delete fire only on operator clicks
// (right-click → "Add to cluster with…" or close-x on the cluster tab).
// cluster_broadcast fires only on operator submit in the broadcast composer.
// No model-triggered fan-out, no nudger — see plan §2.

export interface ClusterMember {
  workflowId: string;
  displayName: string;       // Operator-editable via rename_workflow (F5, 2026-05-11); falls back to wfid 8-char prefix when unset.
  status: 'idle' | 'busy';   // mirrors per-workflow `wf.busy`
  // CLUSTER_MODE_PLAN.md Phase 2.6 — optional free-form role hint
  // (≤120 chars). When set, the Native worker injects an
  // `Your role in this cluster: <role>` system block on every turn.
  // Empty / whitespace clears (no block). Director-vs-worker is emergent;
  // this is just a label that nudges framing.
  role?: string;
  // Builder-tier capability hint (2026-05-11). Optional enum that pairs
  // with `role` so the cluster director (an LLM reading peer_list) can
  // match task complexity to builder capability. Operator-set in the
  // Members sub-tab; persisted alongside `role` in cluster meta.json.
  // Pure metadata — the server does NO routing. Undefined ≡ no opinion.
  //   light    — quick edits, renames, simple commands
  //   standard — normal feature work
  //   heavy    — architectural changes, complex refactors
  tier?: 'light' | 'standard' | 'heavy';
  // Optional per-instance sub-specialty (2026-05-11). Free-form text ≤160
  // chars that complements `role`: where `role` is the canonical category
  // (Builder / Reviewer / etc.) `focus` is what THIS member specifically
  // does — e.g. "React frontend, Zustand store patterns" or "database
  // performance + sqlc generated code". Surfaced in peer_list so the
  // director (an LLM) can disambiguate same-role peers. Pure metadata, no
  // server-side routing.
  focus?: string;
  // Absent on old servers/records means standard. Blind/isolated modes are
  // operator-selected and persist in the cluster record, not WorkflowConfig.
  accessMode?: ClusterMemberAccessMode;
}

// Focus cap. 160 lets operators write a useful specialty line without
// blowing up the per-turn system block. Server clamps.
export const MEMBER_FOCUS_MAX = 160;

// Builder-tier values + UI label table. Mirrored by the server's
// MEMBER_TIER_VALUES guard in clusterStore. Kept here so the client can
// import a single source-of-truth list for the picker pills.
export const MEMBER_TIERS = ['light', 'standard', 'heavy'] as const;
export type MemberTier = (typeof MEMBER_TIERS)[number];
export function isMemberTier(v: unknown): v is MemberTier {
  return typeof v === 'string' && (MEMBER_TIERS as readonly string[]).includes(v);
}

// 2026-06-15 — per-cluster efficiency level. One operator-set knob that
// dials how thorough vs. lean the whole cluster behaves: how large members
// chunk work, how much they cross-review each other, and how chatty the
// peer-mailbox substrate is. Each level is a DETERMINISTIC bundle resolved
// server-side in clusterEfficiency.ts (doctrine text + peer-send budget +
// mailbox-notice variant) — the values here are just the enum + UI labels.
//
// `thorough` is the default (absent ≡ thorough) so existing clusters and
// pre-feature meta.json files keep today's exact behaviour. `balanced` and
// `lean` progressively inject a restraint doctrine, shrink the per-turn
// peer-send budget, and soften the aggressive "re-engage on every inbound"
// mailbox notice. Four-question test (CLAUDE.md / plan §2): operator-set,
// deterministic + readable presets, logged via cluster_state + the
// efficiency-set event, reversible by flipping back to thorough. NOT
// LLM-mutated instructions — the doctrine strings are static and
// operator-selected, the opposite of the headroom-learn anti-pattern.
export const CLUSTER_EFFICIENCY_LEVELS = ['thorough', 'balanced', 'lean'] as const;
export type ClusterEfficiencyLevel = (typeof CLUSTER_EFFICIENCY_LEVELS)[number];
export function isClusterEfficiencyLevel(v: unknown): v is ClusterEfficiencyLevel {
  return typeof v === 'string' && (CLUSTER_EFFICIENCY_LEVELS as readonly string[]).includes(v);
}
export const CLUSTER_EFFICIENCY_DEFAULT: ClusterEfficiencyLevel = 'thorough';

// Short UI label + one-line operator description per level. Single source of
// truth for the picker pills (WorkflowCreator + ClusterRightPanel chip) so
// the client never hard-codes the copy. The server's clusterEfficiency.ts
// owns the actual doctrine/budget bundle; this is operator-facing summary
// only.
export const CLUSTER_EFFICIENCY_LABELS: Record<ClusterEfficiencyLevel, { label: string; blurb: string }> = {
  thorough: { label: 'Thorough', blurb: 'Full cross-review, generous peer messaging (default).' },
  balanced: { label: 'Balanced', blurb: 'Substantial chunks, review on signal, trimmed messaging.' },
  lean: { label: 'Lean', blurb: 'Max chunks, no unprompted review, terse end-of-task reports.' },
};

// Optional free-text the operator appends to the canned doctrine for a
// cluster (e.g. project-specific restraint notes). Clamped server-side.
export const CLUSTER_EFFICIENCY_ADDENDUM_MAX = 1000;

export const CLUSTER_TASK_BOARD_MODES = ['none', 'project', 'cluster'] as const;
export type ClusterTaskBoardMode = (typeof CLUSTER_TASK_BOARD_MODES)[number];
export function isClusterTaskBoardMode(v: unknown): v is ClusterTaskBoardMode {
  return typeof v === 'string' && (CLUSTER_TASK_BOARD_MODES as readonly string[]).includes(v);
}

// 2026-06-29 — per-cluster progress-tracking mode. Which standing surface(s)
// the members are instructed to KEEP CURRENT as work advances: the shared plan
// (tick `- [ ]`→`- [x]` via cluster_plan_tick), the task board (move cards
// through statuses), or both. The injected doctrine is gated on what actually
// exists for the cluster — a 'plan'/'both' mode with no plan attached, or a
// 'board'/'both' mode with no board, injects nothing for the missing surface.
//
// Why this exists: plans were injected as inert read-only context, so directors
// worked the action-shaped board and let the plan's [ ]/[x] state drift. This
// is the operator knob that turns plan-upkeep into a standing instruction. The
// server (clusterProgress.ts) owns the deterministic doctrine bundle.
//
// Default is 'both' (NOT a no-op, unlike the efficiency 'thorough' default):
// pre-feature clusters with a plan SHOULD start getting the upkeep nudge — that
// is the fix. The text is deterministic + reversible (flip the chip), so it
// passes the §2 four-question test.
export const CLUSTER_PROGRESS_MODES = ['plan', 'board', 'both'] as const;
export type ClusterProgressMode = (typeof CLUSTER_PROGRESS_MODES)[number];
export function isClusterProgressMode(v: unknown): v is ClusterProgressMode {
  return typeof v === 'string' && (CLUSTER_PROGRESS_MODES as readonly string[]).includes(v);
}
export const CLUSTER_PROGRESS_DEFAULT: ClusterProgressMode = 'both';

// Short UI label + one-line operator description per mode. Single source of
// truth for the picker pills (ClusterRightPanel chip) so the client never
// hard-codes the copy. The server's clusterProgress.ts owns the doctrine text.
export const CLUSTER_PROGRESS_LABELS: Record<ClusterProgressMode, { label: string; blurb: string }> = {
  plan: { label: 'Plan', blurb: 'Keep the shared plan checkboxes current via cluster_plan_tick.' },
  board: { label: 'Board', blurb: 'Keep the task board statuses current as work moves.' },
  both: { label: 'Both', blurb: 'Keep both the plan and the board current (default).' },
};

export interface ClusterStatePayload {
  clusterId: string;
  cwd: string;
  members: ClusterMember[];
  mailboxDepth: Record<string, number>;  // workflowId → pending message count
  createdAt: string;
  // Task board mode for this cluster. `none` disables BOARD/tool/dispatcher
  // use; `project` uses the cwd's normal task ledger; `cluster` uses a fresh
  // private board under the same cwd, keyed by taskBoardKey.
  taskBoardMode: ClusterTaskBoardMode;
  taskBoardKey?: string;
  // Back-compat derived flag for older clients/transports: true for project
  // or cluster modes, false for none.
  taskBoardAttached: boolean;
  // Operator-set display name (slice 6a). When absent, the client derives a
  // default of `<basename(cwd)> · <short-id>`. Never persisted unless the
  // operator explicitly renamed — empty-string in cluster_rename clears back
  // to the derived default.
  name?: string;
  // Shared cluster plan. The body is canonical under
  // <cwd>/.arco/plans/<id>.md, and the cluster attaches exactly one active
  // plan at a time, matching workflow plan semantics. Absent ≡ no plan
  // attached. The body is capped to 32768 chars for cluster prompt injection.
  plan?: { id: string; title: string; body: string; updatedAt: number };
  // CLUSTER_MODE_PLAN.md Phase 5 — operator-armed idle-nudger toggle.
  // Default OFF (absent or false). When true, the server detector emits
  // cluster_member_nudged on the idle+pending predicate. See §10.
  idleNudgerEnabled?: boolean;
  // CLUSTER_MODE_PLAN.md Phase 5b — operator-armed auto-turn-on-mailbox.
  // Default OFF (absent or false). When true, a peer_message_sent to a
  // currently-idle recipient fires a single primary turn on the recipient
  // with the synthetic prompt "(auto-pickup) ..." — rate-capped + chain-
  // depth-capped server-side. See clusterAutoTurn.ts.
  autoTurnOnMailboxEnabled?: boolean;
  // DIRECTOR_WORKERS_WORKFLOW_PLAN.md Stage G — operator-armed task
  // dispatcher daemon. Default OFF when absent. The daemon repeatedly runs
  // the same deterministic ready-task sweep as `cluster_dispatch_once`, with
  // server-side caps. All fields are state echoes from cluster meta.
  dispatcher?: ClusterDispatcherState;
  // 2026-06-15 — per-cluster efficiency level (see CLUSTER_EFFICIENCY_LEVELS).
  // Absent ≡ 'thorough' (default; today's behaviour). When 'balanced' / 'lean'
  // the server injects a restraint doctrine into every member's system prompt,
  // shrinks the per-turn peer-send budget, and softens the mailbox re-engage
  // notice. State echo from cluster meta.
  efficiencyLevel?: ClusterEfficiencyLevel;
  // Optional operator free-text appended to the canned doctrine for this
  // cluster. Clamped to CLUSTER_EFFICIENCY_ADDENDUM_MAX. Absent ≡ none.
  efficiencyAddendum?: string;
  // 2026-06-29 — per-cluster progress-tracking mode (see CLUSTER_PROGRESS_MODES).
  // Absent ≡ 'both' (default; members are nudged to keep BOTH the plan and the
  // board current — the missing-surface halves are gated off server-side). Only
  // echoed when non-default so pre-feature snapshots stay clean. State echo from
  // cluster meta.
  progressTracking?: ClusterProgressMode;
  // R3 (REMOTE_CLUSTER_CONTROL_PLAN.md §3) — cluster-level remote opt-in.
  // Absent ≡ OFF. Drives the ◉ REMOTE header chip; while on, the hub link
  // reports the cluster + all members to the phone console.
  remoteEnabled?: boolean;
  // 2026-07-18 — cluster-level gates arming echo (⛨ GATES chip). Absent ≡ OFF.
  remoteGatesEnabled?: boolean;
}

export interface ClusterDispatcherState {
  enabled: boolean;
  intervalMs: number;
  maxTasksPerSweep: number;
  maxConcurrentRuns: number;
  autoWorktree: boolean;
  armedByWorkflowId?: string;
  updatedAt?: number;
}

export interface ClusterDispatcherSettingsPatch {
  intervalMs?: number;
  maxTasksPerSweep?: number;
  maxConcurrentRuns?: number;
  autoWorktree?: boolean;
}

export interface ClusterSwarmCreateMessage {
  type: 'cluster_swarm_create';
  clusterId: string;
  workflowId: string;        // requesting operator/member workflowId; must be a cluster member
  requestId?: string;
  goal: string;
  workerWorkflowIds: string[];
  verifierWorkflowId: string;
  synthesizerWorkflowId: string;
  armDispatch?: boolean;     // when true, run one deterministic dispatch sweep after graph creation
}

// Client → server
export interface ClusterSubscribeMessage {
  type: 'cluster_subscribe';
  clusterId: string;
}

export interface ClusterUnsubscribeMessage {
  type: 'cluster_unsubscribe';
  clusterId: string;
}

// Materialize a roster member's client-side job on demand. The roster
// (cluster_state) and each member's transcript job (workflow_created) are
// decoupled: a member that never took a turn before a server restart was never
// persisted, so it can't ride the reconnect `rehydrate_workflows` (the client
// lacks its config). The client renders its card but has no job, so the pane is
// stuck on "AWAITING REHYDRATE…". The server owns the config, so the client
// asks it to send workflow_created + replay for any member it has no job for.
export interface ClusterMemberRehydrateMessage {
  type: 'cluster_member_rehydrate';
  clusterId: string;
  workflowId: string;
}

export interface ClusterCreateMessage {
  type: 'cluster_create';
  cwd: string;
  memberWorkflowIds: string[];
}

export interface ClusterDeleteMessage {
  type: 'cluster_delete';
  clusterId: string;
}

// Slice 6a — operator renamed a cluster from the ClusterRightPanel Members
// header. Empty `name` clears back to the derived default. Server validates
// length (≤64) and persists on the cluster's meta.json; pushes cluster_state.
export interface ClusterRenameMessage {
  type: 'cluster_rename';
  clusterId: string;
  name: string;
}

// Slice 6a — operator clicked × on a member tab in the bottom row. Detaches
// the member from the cluster (existing cluster_member_removed event fires)
// and tears down the workflow itself (mirrors remove_workflow). The single ×
// is the operator's intent: "I'm done with this member."
export interface ClusterMemberRemoveMessage {
  type: 'cluster_member_remove';
  clusterId: string;
  workflowId: string;
}

// Phase 2.5 B2 — operator right-clicked a Native tab and chose "Add to
// existing cluster…". Server validates: target cluster exists, workflow is
// Native Claude, cwd matches, workflow not already in a cluster. On success,
// emits `cluster_member_added` + fresh `cluster_state`.
export interface ClusterMemberAddMessage {
  type: 'cluster_member_add';
  clusterId: string;
  workflowId: string;
}

// Phase 2.5 B3 — operator right-clicked a Native tab and chose "Create
// cluster with N fresh workers…". Server creates N new workflows (each
// sharing the source tab's cwd + primary), then creates the cluster with
// source + N new members. The Native-only fence applies. `additionalCount`
// is 1–4 (server clamps).
export interface ClusterCreateWithFreshWorkersMessage {
  type: 'cluster_create_with_fresh_workers';
  sourceWorkflowId: string;
  additionalCount: number;
  name?: string;            // operator-typed cluster name (≤64). Empty = derived default.
  // 2026-05-11 — operator picked a non-default provider/model/effort at spawn
  // time, overriding the clone-from-anchor behaviour. All three are optional;
  // when undefined, the server inherits from the anchor. Provider is fenced
  // to ClusterMemberProvider (cluster fence applies). Model is validated server-
  // side against the live catalog when populated; cold-catalog falls back
  // to non-empty-string. Effort is passed through as-is (per-provider enum).
  // Constraint: when `provider` differs from the anchor's provider, the
  // operator MUST also pass `model` (the anchor's model name doesn't make
  // sense on the new provider). UI enforces this; server rejects with
  // `unknown_model` if it slips through.
  provider?: ClusterMemberProvider;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | string;
  providerAccountRef?: string;
}

// 2026-05-11 — operator picked CLUSTER mode in the +NEW WorkflowCreator
// and submitted. No source workflow — every member is minted fresh from
// the per-row config. Mirrors ClusterCreateWithFreshWorkersMessage on the
// server side (createBlankNativeWorkflow loop + clusterStore.createCluster)
// but every member's provider/model/effort/role/tier is operator-picked
// up front. Cluster fence applies: provider is ClusterMemberProvider only.
// Server validates ≥1 member; client UI enforces ≥2. `name` is optional;
// empty = derived default per the cluster-rename rule. Per-member optional
// fields (displayName/role/tier) are written after the cluster is created
// via the existing setMemberRole / setMemberTier / rename_workflow paths.
export interface ClusterCreateFromScratchMessage {
  type: 'cluster_create_from_scratch';
  cwd: string;
  name?: string;
  // 2026-06-15 — operator-picked efficiency level for the whole cluster at
  // create time. Cluster-wide (not per-member). Omitted ≡ 'thorough'. The
  // optional addendum is appended to the canned doctrine; clamped server-side.
  efficiencyLevel?: ClusterEfficiencyLevel;
  efficiencyAddendum?: string;
  members: Array<{
    provider: ClusterMemberProvider;
    model: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | string;
    providerAccountRef?: string;
    displayName?: string;
    role?: string;
    tier?: MemberTier;
    focus?: string;
    skipPermissions?: boolean;
    fastMode?: boolean;
    efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive';
    outputStyle?: 'normal' | 'lite' | 'terse';
    accessMode?: ClusterMemberAccessMode;
  }>;
}

// 2026-05-11 — cluster presets. Operator-saved snapshot of a cluster's
// per-member configs + optional name template, so a familiar shape can be
// re-applied to a different cwd. Persisted server-side at
// ~/.arco/cluster-presets.json; consumed by the WorkflowCreator's CLUSTER
// mode (PRESETS row above DEFAULT FOR NEW MEMBERS). CWD is intentionally NOT
// part of a preset — presets are project-agnostic.
//
// Member shape mirrors ClusterCreateFromScratchMessage's per-member entries,
// minus runtime-only UI fields (react keys, expanded state). The cluster-
// create path validates models against the live catalog at apply time, so
// presets stored against a since-renamed model still surface and fail
// loudly only on apply.
export interface ClusterPresetMember {
  provider: ClusterMemberProvider;
  model: string;
  effort?: string;
  providerAccountRef?: string;
  role?: string;
  tier?: MemberTier;
  focus?: string;
  displayName?: string;
  skipPermissions?: boolean;
  fastMode?: boolean;
  efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive';
  outputStyle?: 'normal' | 'lite' | 'terse';
  accessMode?: ClusterMemberAccessMode;
}

export interface ClusterPreset {
  id: string;                   // crypto.randomUUID()
  name: string;                 // operator-typed, trimmed, ≤64; unique case-insensitive
  createdAt: string;            // ISO timestamp
  clusterNameTemplate?: string; // optional pre-fill for CLUSTER NAME on apply
  members: ClusterPresetMember[];
}

// ── Cluster snapshots ──
//
// 2026-06-12 — a snapshot is a full, restorable capture of a LIVE cluster:
// the ClusterState (config + roles/tiers/focus/dispatcher/plan id) PLUS every
// member's complete conversation history (meta.json + events.jsonl). Unlike a
// preset (config-only, project-agnostic), a snapshot is heavyweight and
// carries history, so it lives in its own on-disk directory tree at
// ~/.arco/cluster-snapshots/<snapshotId>/ rather than a flat JSON file.
//
// Restore is fork semantics: a brand-new clusterId + brand-new member
// workflowIds are minted (never reuse the originals — the source cluster may
// still be open). Every embedded workflowId in meta.json + events.jsonl is
// rewritten old→new on restore so the client routes the replayed events to
// the right member. The mailbox is transient and is NOT captured or restored.
//
// The list surface returns a lightweight summary (no member bodies); the full
// manifest + member copies are only read at restore time.
export interface ClusterSnapshotSummary {
  id: string;          // snapshotId — crypto.randomUUID()
  name: string;        // operator-typed, trimmed, ≤64; unique case-insensitive
  createdAt: string;   // ISO timestamp
  memberCount: number; // number of members captured
  sourceCwd: string;   // cwd of the cluster at save time (restore default target)
}

// Client → server: save the live cluster identified by `clusterId` under the
// operator-typed `name`. `workflowId` is the requesting member (must be a
// member of the cluster) — mirrors the requester-is-member fence used by the
// other cluster operator surfaces. Name rules match presets: trimmed,
// non-empty, ≤64 chars, unique case-insensitive. A duplicate first produces
// `cluster_snapshot_conflict`; the operator-confirmed retry echoes the exact
// existing id in `replaceSnapshotId` so a stale UI cannot overwrite a
// different snapshot by name.
export interface ClusterSnapshotSaveMessage {
  type: 'cluster_snapshot_save';
  clusterId: string;
  workflowId: string;
  name: string;
  replaceSnapshotId?: string;
}

// Client → server: list all saved snapshots (summaries only). Server replies
// with a single cluster_snapshot_list (server→client) carrying the array.
export interface ClusterSnapshotListMessage {
  type: 'cluster_snapshot_list';
}

// Client → server: restore a snapshot into a fresh cluster. `targetCwd` is
// optional — when absent or empty the server restores into the snapshot's
// captured sourceCwd. Mints a new clusterId + new member workflowIds, rewrites
// embedded workflowIds, registers the cluster, then broadcasts cluster_created
// + cluster_state so connected clients rehydrate the new cluster with full
// member history.
export interface ClusterSnapshotRestoreMessage {
  type: 'cluster_snapshot_restore';
  snapshotId: string;
  targetCwd?: string;
  // 2026-06-12 — operator-chosen "last N turns per member" truncation, applied
  // uniformly to every restored member. A turn is delimited by a
  // `primary_turn_started` event in events.jsonl. Omitted / 0 / negative ⇒
  // restore ALL turns (full history). Positive N ⇒ keep only the events from
  // the Nth-from-last `primary_turn_started` line through end-of-file. Bounds
  // both the on-disk copy and the over-the-wire replay so a real ~47k-event log
  // doesn't swamp the client before cluster_created lands.
  turnsPerMember?: number;
}

// Client → server: delete a saved snapshot directory.
export interface ClusterSnapshotDeleteMessage {
  type: 'cluster_snapshot_delete';
  snapshotId: string;
}

// Server → client: full snapshot list (reply to cluster_snapshot_list, and
// also re-pushed after a save or delete so every connected client's list view
// stays current). Same `type` string as the client request — the discriminant
// on the wire is the presence of `snapshots`.
export interface ClusterSnapshotListResultMessage {
  type: 'cluster_snapshot_list';
  snapshots: ClusterSnapshotSummary[];
}

// Server → client: a save succeeded. Carries the new summary so the client can
// toast + optimistically prepend it to the list.
export interface ClusterSnapshotSavedMessage {
  type: 'cluster_snapshot_saved';
  snapshot: ClusterSnapshotSummary;
}

// Server → client: save found a case-insensitive name collision. This is not
// an error toast: the client presents an explicit destructive confirmation,
// then retries with `replaceSnapshotId: existing.id` if approved.
export interface ClusterSnapshotConflictMessage {
  type: 'cluster_snapshot_conflict';
  clusterId: string;
  requestedName: string;
  existing: ClusterSnapshotSummary;
}

// Server → client: a snapshot operation (save / restore / delete) failed. The
// `op` discriminates which surface raised it so the client can route the toast
// to the right dialog. `message` is operator-facing.
export interface ClusterSnapshotErrorMessage {
  type: 'cluster_snapshot_error';
  op: 'save' | 'list' | 'restore' | 'delete';
  message: string;
  // Set on restore failures only — echoes the snapshotId the operator tried to
  // restore so the client can clear the right row's spinner. Absent otherwise.
  snapshotId?: string;
}

// Phase 2.5.1 — operator clicked "+ ADD WORKER" in ClusterRightPanel
// Members tab and chose "spawn N fresh." Server creates N new workflows
// inheriting the cluster's cwd + the first member's primary config, then
// adds each to the cluster. `count` clamped to [1, 4]. Native-only fence
// applies to the inherited template — if members[0] isn't Native Claude
// the request is rejected.
export interface ClusterAddFreshWorkersMessage {
  type: 'cluster_add_fresh_workers';
  clusterId: string;
  count: number;
  // 2026-05-11 — operator picked a non-default provider/model/effort at spawn
  // time. Same semantics as on ClusterCreateWithFreshWorkersMessage: when
  // undefined, the server inherits from `members[0]` (the cluster template);
  // when populated, the server overrides those three fields on the spawned
  // childConfig. Provider stays fenced to ClusterMemberProvider. Model required
  // when provider differs from the template's provider.
  provider?: ClusterMemberProvider;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | string;
  providerAccountRef?: string;
  accessMode?: ClusterMemberAccessMode;
}

// Operator replaces one cluster slot with a brand-new workflow. The new
// workflow always gets a new workflowId/provider session. WorkflowConfig and
// cluster metadata clone from `workflowId`, then the optional provider triple
// and access mode override the clone. Prior context and active task ownership
// are independent, explicit opt-ins.
export interface ClusterMemberReplaceMessage {
  type: 'cluster_member_replace';
  clusterId: string;
  workflowId: string;
  provider?: ClusterMemberProvider;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | string;
  providerAccountRef?: string;
  accessMode?: ClusterMemberAccessMode;
  includeHistory?: boolean;
  transferActiveTasks?: boolean;
}

// CLUSTER_MODE_PLAN.md Phase 2.6 — operator authored / edited the cluster's
// shared plan (markdown body). Server caps body length at 32768 chars; the
// client should warn at 28672 (soft) and refuse to send at >32768 (hard).
// Bumped from 8 KB / 7 KB on 2026-05-11 (§13). Empty / whitespace `body`
// is rejected — use `cluster_plan_clear` to wipe.
export interface ClusterPlanSetMessage {
  type: 'cluster_plan_set';
  clusterId: string;
  body: string;
}

// Attach an existing per-cwd plan to a cluster without copying the body.
export interface ClusterPlanAttachMessage {
  type: 'cluster_plan_attach';
  clusterId: string;
  planId: string;
}

// CLUSTER_MODE_PLAN.md Phase 2.6 — operator cleared the cluster's shared
// plan. Server detaches the cluster from its active per-cwd plan; the plan
// file remains available to future workers and clusters in the same cwd.
export interface ClusterPlanClearMessage {
  type: 'cluster_plan_clear';
  clusterId: string;
}

// CLUSTER_MODE_PLAN.md Phase 2.6 — operator edited a member's role hint.
// Free-form text, ≤120 chars. Empty / whitespace clears the field. The
// next turn's system block reflects the new value; in-flight turns are
// untouched.
export interface ClusterMemberRoleSetMessage {
  type: 'cluster_member_role_set';
  clusterId: string;
  workflowId: string;
  role: string;
}

// 2026-05-11 — operator edited a member's builder-tier hint. `tier` is
// one of `MEMBER_TIERS` or null to clear. Server rejects unknown strings.
// Pure metadata: the director sees `tier` in `peer_list` rows and decides
// routing; no server-side routing logic. Mirrors `ClusterMemberRoleSet`
// in handler shape — server persists in meta.json and rebroadcasts
// `cluster_state` so every observer sees the new value inline.
export interface ClusterMemberTierSetMessage {
  type: 'cluster_member_tier_set';
  clusterId: string;
  workflowId: string;
  tier: MemberTier | null;
}

// 2026-05-11 — operator set a per-member focus string (sub-specialty).
// Free-form ≤MEMBER_FOCUS_MAX chars; null clears. Mirrors tier-set in
// handler shape: server clamps + persists in meta.json + rebroadcasts
// cluster_state. Pure metadata.
export interface ClusterMemberFocusSetMessage {
  type: 'cluster_member_focus_set';
  clusterId: string;
  workflowId: string;
  focus: string | null;
}

// MASTER_REFACTOR §3.3 F5 (2026-05-11) — operator renamed a workflow.
// `name` is trimmed; ≤64 chars (mirrors `cluster_rename` cap). Empty string
// clears to default — server snapshots back to the wfid 8-char prefix for
// ClusterMember.displayName. Server persists `wf.config.name` to meta.json,
// emits `workflow_renamed`, and re-emits any affected `cluster_state`.
export interface RenameWorkflowMessage {
  type: 'rename_workflow';
  workflowId: string;
  name: string;
}

// MASTER_REFACTOR §3.3 F5 — server → all observers when a workflow's name
// changes. `name === null` ⇒ cleared back to default (wfid prefix).
export interface WorkflowRenamedMessage {
  type: 'workflow_renamed';
  workflowId: string;
  name: string | null;
}

// EFFICIENCY_PLAN.md Phase F — operator toggled "Attach codebase memory"
// in the CONFIG tab. Server flips `WorkflowConfig.codebaseMemory.attached`
// + persists to meta.json + broadcasts `codebase_memory_state`. The actual
// `--mcp-config` write-in at CLI spawn time is deferred to a follow-up
// after Cluster Phase 3 ships `mcpConfigWriter`. `indexPath` defaults to
// the workflow's `workingDirectory` when absent.
export interface AttachCodebaseMemoryMessage {
  type: 'attach_codebase_memory';
  workflowId: string;
  indexPath?: string;
}

// Phase F — operator unchecked the toggle. Server drops `attached` (keeps
// any `indexPath` the operator typed so re-attaching is one click).
export interface DetachCodebaseMemoryMessage {
  type: 'detach_codebase_memory';
  workflowId: string;
}

// Operator submitted the broadcast composer. Server resolves members; idle
// members get the message via the normal handleUserMessage path (immediate
// turn start), busy members get the message enqueued as a follow-up on their
// existing queue. Per-member dispatch reuses the user-message pipeline so
// events.jsonl ordering is identical to a manual prompt; peer_message_received
// drains still fire BEFORE user_message_echo on each member.
export interface ClusterBroadcastMessage {
  type: 'cluster_broadcast';
  clusterId: string;
  content: string;
  attachments?: string[];
  clientMessageId?: string;
  // 2026-05-11 — optional recipient subset. When present and non-empty,
  // the broadcast fans out only to these member workflowIds (must all be
  // current cluster members or the server rejects with `unknown_recipient`).
  // When omitted or empty, the broadcast goes to ALL members — the
  // existing behaviour, preserved for backward compatibility.
  // (Appended at the end of the interface body to minimize merge conflicts
  // with parallel agents extending this protocol.)
  recipientWorkflowIds?: string[];
}

export interface ClusterDispatchToggleMessage {
  type: 'cluster_dispatch_toggle';
  clusterId: string;
  workflowId: string;
  enabled: boolean;
}

export interface ClusterDispatchSettingsUpdateMessage {
  type: 'cluster_dispatch_settings_update';
  clusterId: string;
  workflowId: string;
  settings: ClusterDispatcherSettingsPatch;
}

export interface ClusterTaskBoardAttachSetMessage {
  type: 'cluster_task_board_attach_set';
  clusterId: string;
  attached: boolean;
}

export interface ClusterTaskBoardModeSetMessage {
  type: 'cluster_task_board_mode_set';
  clusterId: string;
  mode: ClusterTaskBoardMode;
}

// Operator-driven peer_send. Lets the operator paste an arbitrary chunk of
// chat content (full transcript / last turn / last N turns) into a single
// peer's mailbox FROM a worker they pick. Reuses the peer_send substrate but
// bypasses the model-facing budget + dedupe gates (operator action is
// intentional). Cap is raised to 32 KB (matches cluster-plan body cap) to
// give "last few turns" room without forcing chunking. Server emits the
// usual peer_message_sent event from the chosen sender's workflow channel
// so the recipient sees no difference between an operator-driven and a
// model-driven send.
export interface OperatorPeerSendMessage {
  type: 'operator_peer_send';
  clusterId: string;
  from: string;     // sender's workflowId (must be a cluster member)
  to: string;       // recipient's workflowId (must be a cluster member)
  content: string;  // ≤ 32 KB UTF-8
}

// Server → client
export interface ClusterStateMessage {
  type: 'cluster_state';
  clusterId: string;
  state: ClusterStatePayload;
}

// A persisted client tab subscribed to an id that no longer exists on this
// Arco instance. Structured separately from generic errors so the client can
// prune only that stale mirror instead of showing "Unknown cluster" on every
// reconnect forever.
export interface ClusterNotFoundMessage {
  type: 'cluster_not_found';
  clusterId: string;
}

export interface ClusterCreatedMessage {
  type: 'cluster_created';
  clusterId: string;
  state: ClusterStatePayload;
}

export interface ClusterDeletedMessage {
  type: 'cluster_deleted';
  clusterId: string;
}

// Reserved shapes — Phase 2 ships fixed-membership-at-create, but the wire
// types are stable so Phase 5 polish (member detach, model-proposes-sibling)
// can land without a schema bump.
export interface ClusterMemberAddedMessage {
  type: 'cluster_member_added';
  clusterId: string;
  member: ClusterMember;
}

export interface ClusterMemberRemovedMessage {
  type: 'cluster_member_removed';
  clusterId: string;
  workflowId: string;
}

export interface ClusterMemberReplacedMessage {
  type: 'cluster_member_replaced';
  clusterId: string;
  oldWorkflowId: string;
  newWorkflowId: string;
  member: ClusterMember;
  accessMode: ClusterMemberAccessMode;
  historyIncluded: boolean;
  transferredTaskCount: number;
}

// CLUSTER_MODE_PLAN.md Phase 2.6 — server push when the shared cluster
// plan body changes (set or cleared). `body` carries the new full text
// (empty string ≡ plan cleared). `updatedAt` is wall-clock ms.
// `bodyLength` is logged into events.jsonl (the lightweight audit shape —
// the full body lives on disk under <cwd>/.arco/plans/ and in the next
// cluster_state push). Fired on cluster_plan_set / attach / clear.
export interface ClusterPlanChangedMessage {
  type: 'cluster_plan_changed';
  clusterId: string;
  body: string;            // empty string = cleared
  updatedAt: number;
  bodyLength: number;      // duplicates body.length for the events.jsonl audit row
}

// EFFICIENCY_PLAN.md Phase F — server push reflecting the current
// codebase-memory attach state for a workflow. Fired on attach / detach /
// reindex. `attached === false` ⇒ indexPath / lastIndexedAt / fileCount
// may still be present (operator's last-typed values) so re-attaching
// reuses them; the section just renders them dim.
export interface CodebaseMemoryStateMessage {
  type: 'codebase_memory_state';
  workflowId: string;
  attached: boolean;
  indexPath?: string;
  lastIndexedAt?: number;
  fileCount?: number;
}

// Reply to cluster_broadcast — single transient message, used for the
// post-submit toast. `idle` = members that started a new turn now; `queued`
// = members that were busy and got the prompt enqueued as a follow-up. Sum
// equals total membership at fan-out time. Failed dispatches (member has no
// live ws session) land in `failed` so the toast can name them.
export interface ClusterBroadcastDispatchedMessage {
  type: 'cluster_broadcast_dispatched';
  clusterId: string;
  clientMessageId?: string;  // echoes the request's id for correlation
  idle: string[];            // workflowIds dispatched immediately
  queued: string[];          // workflowIds whose prompt landed on the follow-up queue
  failed: Array<{ workflowId: string; reason: string }>;
}

// Director/workers Stage F — operator-clicked one-shot dispatcher. Default
// assignment mode is intentionally explicit-assignee-only: the server does
// not infer routing from role/tier/focus yet. Eligible ready tasks with a
// concrete idle assignee are claimed and fired through the normal primary-turn
// path; all refusals are logged as dispatch_skipped task events.
export interface ClusterDispatchOnceMessage {
  type: 'cluster_dispatch_once';
  clusterId: string;
  workflowId: string;        // requesting operator/member workflowId; must be a cluster member
  requestId?: string;
  maxTasks?: number;         // optional cap for this sweep; defaults to member count
}

export type ClusterDispatchSkipReason =
  | 'dependency_missing'
  | 'dependency_blocked'
  | 'active_run'
  | 'no_assignee'
  | 'assignee_not_member'
  | 'member_not_hydrated'
  | 'member_busy'
  | 'unsupported_provider'
  | 'worktree_required'
  | 'worktree_failed'
  | 'member_cap'
  | 'cluster_cap'
  | 'race_lost';

export interface ClusterDispatchFired {
  taskId: string;
  workflowId: string;
  runId: string;
}

export interface ClusterDispatchSkipped {
  taskId: string;
  reason: ClusterDispatchSkipReason;
  assignee?: string;
  detail?: string;
}

export interface ClusterDispatchResultMessage {
  type: 'cluster_dispatch_result';
  clusterId: string;
  workflowId: string;        // requester
  requestId?: string;
  source?: 'manual' | 'daemon';
  fired: ClusterDispatchFired[];
  skipped: ClusterDispatchSkipped[];
  at: number;
}

export interface ClusterSwarmCreatedMessage {
  type: 'cluster_swarm_created';
  clusterId: string;
  workflowId: string;        // requester
  requestId?: string;
  rootTaskId: string;
  workerTaskIds: string[];
  verifierTaskId: string;
  synthesizerTaskId: string;
  armDispatch: boolean;
  at: number;
}

// CLUSTER_MODE_PLAN.md Phase 5 — operator-armed per-cluster idle-nudger
// toggle. Default OFF. When ON, the server-side detector emits
// cluster_member_nudged to alert the operator (NOT the worker) when a member
// has been idle for ≥ IDLE_FLOOR_SECONDS AND has ≥1 pending message in its
// mailbox. The four-question test (plan §2) is the gate: operator-armed,
// deterministic predicate, events.jsonl-visible, reversible toggle.
export interface ClusterIdleNudgerToggleMessage {
  type: 'cluster_idle_nudger_toggle';
  clusterId: string;
  enabled: boolean;
}

// 2026-06-15 — operator set the cluster's efficiency level (and optional
// doctrine addendum) from the ClusterRightPanel chip. Mirrors the
// idle-nudger toggle handler shape: server persists to meta.json, then
// rebroadcasts cluster_state so every observer sees the new level inline.
// `level` must be one of CLUSTER_EFFICIENCY_LEVELS (server rejects unknown
// strings). `addendum` is optional free-text appended to the canned
// doctrine; omitted ⇒ keep current addendum, empty string ⇒ clear it.
// The new level takes effect on each member's NEXT turn (in-flight turns
// are untouched, same as role/plan edits). Four-question test: operator-set,
// deterministic preset bundle, logged via cluster_state, reversible.
export interface ClusterEfficiencySetMessage {
  type: 'cluster_efficiency_set';
  clusterId: string;
  level: ClusterEfficiencyLevel;
  addendum?: string;
}

// 2026-07-17 — operator drag-reordered the member grid. `memberIds` is the
// complete new display order and must be an exact permutation of the current
// members (server rejects drops/duplicates from a stale drag). Persists to
// meta.json members[] + rebroadcasts cluster_state, so every surface that maps
// members[] (desktop grid, right panel, phone console) follows the new order.
export interface ClusterMemberReorderMessage {
  type: 'cluster_member_reorder';
  clusterId: string;
  memberIds: string[];
}

// R3 (REMOTE_CLUSTER_CONTROL_PLAN.md §3) — operator flipped the cluster-level
// ◉ REMOTE chip. ONE switch covers the whole cluster: while on, the hub link
// reports the cluster and every member to the management console (members'
// individual remoteEnabled flags are ignored while clustered). Persists to the
// cluster's meta.json + rebroadcasts cluster_state + re-pushes the hub
// snapshot immediately. Default OFF; reversible by flipping back.
export interface ClusterRemoteSetMessage {
  type: 'cluster_remote_set';
  clusterId: string;
  enabled: boolean;
}

// 2026-07-18 (§9.2 follow-up) — operator flipped the cluster-level ⛨ GATES
// chip: ONE switch arms remote DEBAG gate approval for every member (member
// flags ignored while clustered, mirroring cluster_remote_set). Default OFF —
// remote conversation never implies remote approval authority.
export interface ClusterGatesSetMessage {
  type: 'cluster_gates_set';
  clusterId: string;
  enabled: boolean;
}

// 2026-06-29 — operator picked which surface(s) the cluster keeps current from
// the ClusterRightPanel chip. Server persists to meta.json + rebroadcasts
// cluster_state. `mode` must be one of CLUSTER_PROGRESS_MODES (server rejects
// unknown strings). Takes effect on each member's NEXT turn (in-flight turns
// untouched, same as role/plan/efficiency edits). Four-question test:
// operator-set, deterministic doctrine bundle, logged via cluster_state,
// reversible by flipping the chip.
export interface ClusterProgressSetMessage {
  type: 'cluster_progress_set';
  clusterId: string;
  mode: ClusterProgressMode;
}

// CLUSTER_MODE_PLAN.md Phase 5 — server-side detector found a member that
// matches the nudge predicate (idle ≥ floor AND pending ≥ 1) and is below
// the NUDGES_PER_TURN cap. `reason` is always 'idle_with_pending' today;
// kept open for future predicate classes. Operator-only — the worker never
// sees this event. NotificationToasts surfaces a toast.
export interface ClusterMemberNudgedMessage {
  type: 'cluster_member_nudged';
  clusterId: string;
  workflowId: string;
  reason: 'idle_with_pending';
  idleSeconds: number;
  pendingCount: number;
}

// CLUSTER_MODE_PLAN.md Phase 5b — operator-armed auto-turn-on-mailbox toggle.
// Default OFF. When ON, a peer_message_sent to a currently-idle recipient
// fires a single primary turn on the recipient with a synthetic
// "(auto-pickup) ..." prompt. Three guards prevent runaway loops: 20s per-
// recipient cooldown, 10/minute per-cluster rate cap, and a chain-depth cap
// of 3 carried on PeerMessageSentMessage.chainDepth. All guards are env-
// overridable (ARCO_CLUSTER_AUTO_TURN_*). Mirrors the four-question test
// (plan §2): operator-armed, deterministic, events.jsonl-visible, reversible.
export interface ClusterAutoTurnToggleMessage {
  type: 'cluster_auto_turn_toggle';
  clusterId: string;
  enabled: boolean;
}

// CLUSTER_MODE_PLAN.md Phase 5b — server-side detector fired (or refused to
// fire) an auto-turn on a recipient after a peer_message_sent delivery. Rides
// through broadcastWorkflow so events.jsonl carries the audit trail. The
// client surfaces a toast (same pattern as cluster_member_nudged). `reason`
// distinguishes the fire path ('mailbox_arrival') from skips
// ('rate_capped' / 'depth_capped' / 'cooldown' / 'recipient_busy' /
// 'disabled'). Skip events are rate-limited to 1/min/cluster so a tight loop
// can't spam the log.
export interface ClusterAutoTurnFiredMessage {
  type: 'cluster_auto_turn_fired';
  clusterId: string;
  workflowId: string;        // recipient (the workflow whose turn fires / would have fired)
  sender: string;            // sender workflowId of the triggering peer_message_sent
  chainDepth: number;        // depth this auto-turn lands at (sender's + 1 on fire; reported as-is on skip)
  reason: 'mailbox_arrival' | 'rate_capped' | 'depth_capped' | 'cooldown' | 'recipient_busy' | 'disabled';
  fired: boolean;            // true → a turn was dispatched; false → guard refused
}

// Dev/smoke-only test hook for Phase 5b: directly invokes the auto-turn
// detector's onPeerMessageSent() with a caller-specified chainDepth. Used by
// scripts/smoke/phase-5b.ts to exercise the depth cap + rate cap without
// needing real LLM turns to generate naturally-chained peer_sends. Gated
// server-side on `process.env.ARCO_TEST === '1'`.
export interface DebugClusterAutoTurnInjectMessage {
  type: '__debug_cluster_auto_turn_inject';
  clusterId: string;
  senderWfid: string;
  recipientWfid: string;
  chainDepth: number;
}
