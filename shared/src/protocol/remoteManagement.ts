// Remote Management (Archon Ops Part K + J2) — the typed contract for the whole
// tier. See docs/REMOTE_MANAGEMENT.md §12.
//
// K1 (the per-host archon-agent) consumes the LifecycleCommand + signed-envelope
// shapes here. K2 (the hub) consumes the instance/register/heartbeat/action
// shapes. K3 (the mobile console) renders ManagedArchonInstance + the action
// surface. Defining the full contract up front — all six §13 decisions are
// resolved (2026-06-03) — keeps every phase building against one source of truth.
//
// NOTE: only the hub-link pair (HubLinkSetEnabledMessage / HubLinkStatusMessage)
// is folded into the client/server WS unions; the rest is the hub-side
// contract, imported directly by the hub and K1 agent scripts.

export type Platform = 'linux' | 'macos' | 'windows' | 'unknown';
export type ServiceMode = 'systemd' | 'launchd' | 'dev' | 'manual' | 'unknown';

// One managed Archon install. instanceId is a persisted UUID (~/.archon/instance-id,
// §13.4) so a rename/hostname change never orphans history; `name` is the
// operator-assigned friendly label the console addresses.
export interface ManagedArchonInstance {
  instanceId: string;
  name: string;
  platform: Platform;
  hostname: string;
  tailscale?: { magicDns?: string; ip?: string };
  version: string;
  gitRevision: string;
  serviceMode: ServiceMode;
  capabilities: {
    workflows: boolean; // can report/route workflow state
    requests: boolean; // surfaces pending requests
    approvals: boolean; // accepts approve/deny
    serviceRestart: boolean; // agent present + can restart the local service
    diagnostics: boolean; // exposes A-series diagnostics summary
    resourceStats: boolean; // cheap CPU/mem/disk summary available
  };
  lastHeartbeatAt: number; // ms epoch; hub derives online/stale/offline
}

// The fixed inbound vocabulary of archon-agent (§6). Nothing outside this enum
// is executable — no file access, no workflow access, no free-form shell.
export const LIFECYCLE_COMMANDS = [
  'archon.status',
  'archon.start',
  'archon.stop',
  'archon.restart',
  'archon.logs.tail',
  'archon-agent.status',
  'archon-agent.restart',
] as const;
export type LifecycleCommand = (typeof LIFECYCLE_COMMANDS)[number];

export function isLifecycleCommand(x: unknown): x is LifecycleCommand {
  return typeof x === 'string' && (LIFECYCLE_COMMANDS as readonly string[]).includes(x);
}

// The signed envelope (§13.2). The hub signs the canonical serialization of
// `payload` with its Ed25519 private key; the agent verifies with the hub public
// key, then checks freshness (issuedAt skew), single-use nonce (replay guard),
// and instanceId match before executing.
export interface LifecycleCommandPayload {
  cmd: LifecycleCommand;
  instanceId: string; // which instance this command targets
  nonce: string; // single-use replay guard
  issuedAt: number; // ms epoch; agent rejects skew beyond a window
}
export interface SignedLifecycleCommand {
  payload: LifecycleCommandPayload;
  signature: string; // base64 detached Ed25519 signature over the canonical payload
}

// The agent's reply after handling a signed command. rejectedReason is set when
// the agent refused (failed verification / allowlist) rather than executed.
export type LifecycleRejection =
  | 'bad-signature'
  | 'stale'
  | 'future'
  | 'replay'
  | 'wrong-instance'
  | 'not-allowlisted'
  | 'malformed'
  | 'unsupported-platform';

export interface LifecycleResult {
  cmd: LifecycleCommand | null; // null when the payload was malformed
  instanceId: string;
  nonce: string;
  ok: boolean; // true only when a command was executed and exited 0
  executed: boolean; // false when rejected before exec
  exitCode: number; // -1 when not executed
  stdout?: string;
  stderr?: string;
  rejectedReason?: LifecycleRejection;
}

// The narrow workflow-layer action surface the console offers (§5). v1 allowlist
// (§13.5): reply / stop / approve("continue") + deny("decline") + wait. The hub
// routes; the owning instance re-validates against its current pending request.
export type RemoteManagementAction =
  | { type: 'reply'; workflowId: string; requestId: string; body: string }
  | { type: 'wait'; workflowId: string; requestId: string }
  | { type: 'stop'; workflowId: string; requestId: string }
  | { type: 'approve'; workflowId: string; requestId: string; approvalKind: string }
  | { type: 'deny'; workflowId: string; requestId: string; reason?: string };

// The live rollup each heartbeat carries — cheap to compute, no transcript (§4).
export interface InstanceRollup {
  health: 'ok' | 'degraded' | 'down';
  activeWorkflows: number;
  waitingRequests: number;
  providers?: string; // short provider-availability summary
  cpuLoad?: number; // 1-min load average when cheap
  memPressure?: number; // 0..1 used-fraction when cheap
  diskFreeMb?: number;
  // A2 (REMOTE_CLUSTER_CONTROL_PLAN.md §10.3) — providers whose auth is
  // currently broken on this instance (native-transport signal, distinct from
  // the CLI probe). The console renders an AUTH REQUIRED banner per alert.
  authAlerts?: { provider: string; state: 'expired'; since: number; detail?: string }[];
}

// ── A2 — instance-level actions (not workflow-scoped): remote re-auth ────────
// start_reauth runs the service's PKCE bootstrap and hands the authorize URL
// back to the console; complete_reauth is the manual-paste fallback (the
// operator pastes the failed localhost callback URL from the phone browser).
export type InstanceActionRequest =
  | { type: 'start_reauth'; provider: 'claude' }
  | { type: 'complete_reauth'; provider: 'claude'; url: string };
export interface InstanceActionResult {
  actionId: string;
  ok: boolean;
  authorizationUrl?: string; // start_reauth success
  manualFallback?: boolean; // callback server couldn't bind — paste required
  error?: string;
}
export interface InstanceActionMessage {
  type: 'instance_action';
  actionId: string;
  action: InstanceActionRequest;
}
export interface InstanceActionResultMessage {
  type: 'instance_action_result';
  result: InstanceActionResult;
}

// ── Workflow-reporting layer ─────────────────────────────────────────────────
// A live Archon SERVICE (not the lifecycle agent) connects at /instance and
// pushes its workflow + pending-request state, and applies routed reply/stop/
// continue actions (re-validating locally). One machine has up to two hub
// connections: the agent (/agent, lifecycle) and the service (/instance,
// workflows) — distinguished by `role` on register, merged into one card.

export type InstanceRole = 'agent' | 'service';

export interface WorkflowSummary {
  workflowId: string;
  title: string;
  cwd: string;
  provider: string;
  model: string;
  state: 'running' | 'idle';
  busy: boolean;
  lastActivityAt?: number; // ms epoch of the most recent event
  // Decision context (§13.5 — "surface enough information to make an informed
  // decision"): the FULL last assistant message, so the operator can read what
  // the agent actually did before replying (capped only to avoid a runaway
  // payload; see initHubLink MAX_MESSAGE_CHARS).
  lastMessageRole?: 'assistant' | 'user' | 'system';
  lastMessageText?: string;
  lastTurnDurationMs?: number; // duration of the last completed turn, when known

  // ── R1 (REMOTE_CLUSTER_CONTROL_PLAN.md §4.1) — all OPTIONAL so an old hub
  // renders a new service's snapshot unchanged (additive-protocol rule §1.2).
  effort?: string; // reasoning effort when the provider carries one
  // Context pressure — lets the operator judge WHEN to compact/handoff from
  // the phone. Absent when the transport doesn't compute a budget.
  contextZone?: 'green' | 'amber' | 'red';
  contextPct?: number; // 0..1 used-fraction of the model window
  // 2026-07-18 — raw numbers behind the desktop CTX chip ("109k / 1000k 11%"),
  // straight from the last context_usage broadcast so phone === desktop.
  contextTokens?: number;
  contextWindow?: number;
  // Operator messages queued behind a busy turn (silent on the phone today).
  queueDepth?: number;
  queued?: { id: string; preview: string }[];
  // A parked AskUserQuestion — the workflow is stalled on an answer.
  pendingQuestion?: { questionId: string; text: string };
  // Parked DEBAG gates (reviewSafeMode). Args are NOT carried in the snapshot
  // (they can be large + sensitive); `argsPreview` is a bounded rendering for
  // the approve/reject decision. `resolvable` mirrors the §9.2 remote-gates
  // arming so the console knows whether to offer buttons or "resolve at desk".
  pendingGates?: {
    gateId: string;
    toolName: string;
    category: string;
    reason: string;
    argsPreview: string;
    resolvable: boolean;
  }[];
  // Verb availability — computed by the owning service (it knows provider +
  // transport), so the console shows COMPACT/FOLD only where they can work.
  // The service still re-validates on dispatch.
  canCompact?: boolean;
  canFold?: boolean;
  // Cluster membership badge (R3) — present when the workflow is a cluster
  // member reported via the cluster's own remote opt-in.
  cluster?: { clusterId: string; role?: string; tier?: string; focus?: string };
}

// v1 action surface (operator decision §13.5): reply / stop / continue.
// R1 (REMOTE_CLUSTER_CONTROL_PLAN.md §4.2) widens the fixed enum: compact /
// fold / answer_question / gate_resolve / cancel_queued. Every verb is
// re-validated by the owning instance against live state; the hub only routes.
export type WorkflowActionType =
  | 'reply'
  | 'stop'
  | 'continue'
  | 'handoff'
  | 'compact'
  | 'fold'
  | 'answer_question'
  | 'gate_resolve'
  | 'cancel_queued';
export interface WorkflowActionRequest {
  type: WorkflowActionType;
  workflowId: string;
  body?: string; // reply text; answer_question reply text
  questionId?: string; // answer_question — must match the parked question
  gateId?: string; // gate_resolve — the parked gate's id
  decision?: 'approve' | 'reject'; // gate_resolve — NO remote arg-editing (v2 scope cut)
  queuedId?: string; // cancel_queued — the queued message's id
}

// Full-conversation pull (operator: "pull the full conversation into a second
// browser tab"). The hub asks the owning service; the service reconstructs the
// transcript from its events.jsonl and replies. Correlated by requestId.
export interface TranscriptTurn {
  role: 'user' | 'assistant';
  text: string;
  at?: number;
}
export interface TranscriptRequestMessage {
  type: 'transcript_request';
  requestId: string;
  workflowId: string;
  // R2 — incremental poll for the interactive chat screen: return only
  // turns[sinceTurn..]. Absent ⇒ the full (bounded) conversation.
  sinceTurn?: number;
}
export interface TranscriptResponseMessage {
  type: 'transcript_response';
  requestId: string;
  workflowId: string;
  title?: string;
  turns: TranscriptTurn[];
  // R2 — the full turn count BEFORE any sinceTurn slice. The chat screen's
  // resync anchor: if this drops below the client's known count (log rotation /
  // compaction shifted indexes), the client re-fetches from zero.
  totalTurns?: number;
  // R2 — live busy flag so the chat screen shows "running…" without waiting
  // for the next snapshot push.
  busy?: boolean;
}
export type WorkflowActionError =
  | 'no-such-workflow'
  | 'not-running'
  | 'busy'
  | 'failed'
  | 'unsupported'
  // The workflow exists but the operator hasn't opted it in to remote
  // (`remoteEnabled` is false). The local instance rejects the routed action —
  // REMOTE_MANAGEMENT.md §1.4 per-workflow opt-in, enforced in initHubLink.
  | 'remote-disabled'
  // R1 — gate_resolve on a workflow whose §9.2 remote-gates arming
  // (`remoteGatesEnabled`) is off. Remote conversation ≠ remote approval
  // authority; the console renders such gates read-only.
  | 'gates-disabled'
  // R1 — answer_question/gate_resolve/cancel_queued against an id that is no
  // longer pending (already answered/resolved/dispatched). Stale-console guard.
  | 'stale-target';
export interface WorkflowActionResult {
  actionId: string;
  workflowId: string;
  ok: boolean;
  applied?: WorkflowActionType;
  error?: WorkflowActionError;
}

// service → hub: the current workflow snapshot.
export interface InstanceWorkflowsMessage {
  type: 'instance_workflows';
  instanceId: string;
  workflows: WorkflowSummary[];
}
// hub → service: apply a workflow action.
export interface WorkflowActionMessage {
  type: 'workflow_action';
  actionId: string;
  action: WorkflowActionRequest;
}
// service → hub: the result of applying it.
export interface WorkflowActionResultMessage {
  type: 'workflow_action_result';
  result: WorkflowActionResult;
}

// ── R3 (REMOTE_CLUSTER_CONTROL_PLAN.md §4.3) — cluster reporting + reads ─────
// A cluster is reported ONLY when its own cluster-level remoteEnabled is on
// (§3 — one switch covers all members; member-level flags are ignored while
// clustered). Member workflows ride the normal WorkflowSummary list with a
// `cluster` badge; this summary carries the cluster-scoped state.
export interface ClusterSummary {
  clusterId: string;
  name?: string;
  cwd: string;
  memberIds: string[]; // display order = members[] order (operator-arranged)
  efficiencyLevel: 'thorough' | 'balanced' | 'lean';
  autoTurnOnMailbox: boolean;
  idleNudgerEnabled: boolean;
  taskBoardMode: 'none' | 'project' | 'cluster';
  planHead?: string; // first ~500 chars of the attached plan body
  planId?: string;
  mailboxDepth: Record<string, number>; // memberId → pending peer messages
  roles?: Record<string, string>;
  tiers?: Record<string, string>;
  focuses?: Record<string, string>;
}

// service → hub, alongside instance_workflows on the same push cadence.
export interface InstanceClustersMessage {
  type: 'instance_clusters';
  instanceId: string;
  clusters: ClusterSummary[];
}

// Correlated cluster reads (same requestId pattern as transcript_request).
// All read-only: mailbox = non-destructive peek per member; board = the task
// kernel snapshot for the cluster's board key; plan = the full plan body.
export type ClusterReadKind = 'mailbox' | 'board' | 'plan' | 'activity';

// R5 — one row of the merged cluster activity timeline ("view cluster
// activity as a group"). Server-reconstructed from bounded tails of each
// member's events.jsonl; read-only, deterministic, capped.
export interface ClusterActivityRow {
  ts: number;
  memberId: string;
  kind: 'peer-sent' | 'peer-received' | 'turn-started' | 'turn-complete' | 'nudged';
  text: string; // compact human line (preview / duration / tool count)
}
export interface ClusterReadRequestMessage {
  type: 'cluster_read_request';
  requestId: string;
  clusterId: string;
  kind: ClusterReadKind;
}
export interface ClusterMailboxEntry {
  msgId: string;
  from: string; // sender workflowId
  fromName: string;
  preview: string; // bounded content preview
  createdAt: string; // ISO
}
export interface ClusterBoardTaskSummary {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  priority?: string;
}
export interface ClusterReadResponseMessage {
  type: 'cluster_read_response';
  requestId: string;
  clusterId: string;
  kind: ClusterReadKind;
  ok: boolean;
  error?: string;
  // kind-specific payloads (exactly one set when ok):
  mailbox?: Record<string, ClusterMailboxEntry[]>; // memberId → pending
  board?: { tasks: ClusterBoardTaskSummary[] };
  plan?: { body: string };
  activity?: ClusterActivityRow[]; // R5 — merged, chronological, capped
}

// ── R4 (REMOTE_CLUSTER_CONTROL_PLAN.md §4.3) — cluster actions ───────────────
// Fixed verb enum, each mapping onto an existing deterministic handler on the
// owning instance; the service re-validates the cluster's remote switch +
// membership before applying. NO structural ops (create/delete/membership) —
// those stay desktop-only (§8).
export type ClusterActionRequest =
  | { type: 'broadcast'; body: string; recipientIds?: string[] }
  // One tap = one canned, visible operator prompt to one member ("read your
  // mailbox"). Distinct from the idle nudger, which never prompts workers.
  | { type: 'nudge_member'; memberId: string }
  | { type: 'peer_send'; fromId: string; toId: string; body: string }
  | { type: 'stop_all' }
  | { type: 'set_efficiency'; level: 'thorough' | 'balanced' | 'lean' }
  | { type: 'toggle_auto_turn'; enabled: boolean }
  | { type: 'toggle_idle_nudger'; enabled: boolean }
  // §9.4 — board tap-to-advance (operator-originated task_ledger_update path;
  // the only path that may set status 'done').
  | { type: 'board_task_update'; taskId: string; status: string };
export interface ClusterActionResult {
  actionId: string;
  clusterId: string;
  ok: boolean;
  applied?: ClusterActionRequest['type'];
  error?: string;
  detail?: string; // e.g. "stopped 2 member(s)"
}
export interface ClusterActionMessage {
  type: 'cluster_action';
  actionId: string;
  clusterId: string;
  action: ClusterActionRequest;
}
export interface ClusterActionResultMessage {
  type: 'cluster_action_result';
  result: ClusterActionResult;
}

// ── Hub ⇄ instance/agent wire messages (consumed by K2's WS layer) ───────────
export interface InstanceRegisterMessage {
  type: 'instance_register';
  role?: InstanceRole; // default 'agent' (lifecycle); 'service' = workflow layer
  instance: ManagedArchonInstance;
}
export interface InstanceHeartbeatMessage {
  type: 'instance_heartbeat';
  instanceId: string;
  at: number;
  rollup: InstanceRollup;
}
// Hub → agent: a signed lifecycle command to execute.
export interface LifecycleCommandMessage {
  type: 'lifecycle_command';
  signed: SignedLifecycleCommand;
}
// Agent → hub: the result of handling a lifecycle command.
export interface LifecycleResultMessage {
  type: 'lifecycle_result';
  result: LifecycleResult;
}

// ── Workstation Archon ↔ its OWN desktop clients ─────────────────────────────
// Transparency surface (trust boundary): the desktop UI shows whether this
// instance is linked to a management hub (and thus remotely controllable), and
// offers a local kill switch. These travel on the normal Archon client/server
// WS (NOT the hub WS), so they live in ServerMessage / ClientMessage, not in
// RemoteManagementMessage.
export interface HubLinkStatusMessage {
  type: 'hub_link_status';
  connected: boolean; // true once the outbound link to the hub is open
  hubUrl?: string; // present when ARCHON_HUB_URL is configured
  // Header transparency (§9): how many of this instance's workflows are opted in
  // to remote (= reported to the hub). Lets the HUB chip show "N monitored".
  monitoredCount?: number;
  connectedSince?: number; // ts the link last opened — tooltip "linked since …"
}
export interface HubLinkSetEnabledMessage {
  type: 'hub_link_set_enabled';
  enabled: boolean; // false = local disconnect (kill switch); true = reconnect
}

export type RemoteManagementMessage =
  | InstanceRegisterMessage
  | InstanceHeartbeatMessage
  | LifecycleCommandMessage
  | LifecycleResultMessage
  | InstanceWorkflowsMessage
  | WorkflowActionMessage
  | WorkflowActionResultMessage
  | TranscriptRequestMessage
  | TranscriptResponseMessage
  | InstanceActionMessage
  | InstanceActionResultMessage
  | InstanceClustersMessage
  | ClusterReadRequestMessage
  | ClusterReadResponseMessage
  | ClusterActionMessage
  | ClusterActionResultMessage;
