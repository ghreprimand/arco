# Arco - cluster-mode protocol messages

WebSocket messages for cluster mode (parent cluster tab + member workflows + the peer-tool mailbox substrate). Split out of [`PROTOCOL.md`](PROTOCOL.md) (J2, doc-size). See [`GOTCHAS.md mode`](GOTCHAS.md) for cluster invariants. Conventions are defined in [`PROTOCOL.md`](PROTOCOL.md#conventions). Source of truth: [`shared/src/protocol/clusters.ts`](../shared/src/protocol/clusters.ts) (one of the per-domain files under `shared/src/protocol/`; the legacy flat `protocol.ts` is now a barrel shim).

**Member-provider fence (current).** Cluster membership is no longer Native-Claude-only. The supported set is `ClusterMemberProvider = 'claude' | 'codex' | 'ollama' | 'llamacpp' | 'cursor'` (`isClusterMemberProvider`). Claude wires peer tools in-process on Native and via a per-spawn `--mcp-config` arco-cluster MCP child on CLI; Codex wires them through their app-server MCP override; Cursor wires them through an in-process loopback StreamableHTTP MCP server (`clusterMcpLoopback.ts`) whose URL rides `session/new`/`session/load`'s `mcpServers` - Cursor ACP honors MCP over http/sse only, not stdio (fresh-only membership); the two local providers (ollama / llamacpp) use Arco's in-process tool runtime and are serialized per provider to avoid local-model fights. The server validation helper is still named `assertAllMembersClaudeOrCodex` for legacy reasons but actually checks `isClusterMemberProvider`. **Max-one-local cap:** `cluster_create_from_scratch` rejects more than one ollama/llamacpp member (`multiple_local_members`) unless `ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL=1`. The cap counts only ollama/llamacpp - `cursor` are remote API providers and are uncapped.

**Per-member access mode.** `ClusterMember.accessMode?: 'standard' | 'blind' | 'isolated'` (absent ≡ `standard`; persisted sparse in cluster meta `memberAccessModes`, not in `WorkflowConfig`). `blind` keeps the project cwd but withholds every cluster surface except `peer_send` / `peer_read` (other peer tools return `[error] access_denied`); `isolated` additionally runs the member in a private scratch cwd and is Claude-Native-only. Accepted on `cluster_create_from_scratch` members, `cluster_add_fresh_workers`, and `cluster_member_replace`.

---

## Cluster mode messages

Cluster mode groups tabs sharing one cwd so members can hand notes between operator turns through peer tools. Three workflow-scoped events (`peer_message_sent`, `peer_message_received`, `peer_send_rejected`) persist on each member's `events.jsonl`. Arco adds a cluster-scoped subscribe / push / broadcast surface so a cluster tab in the UI can render its own state without polling. Cluster-scoped messages (everything keyed on `clusterId` instead of `workflowId`) do NOT persist to `events.jsonl` - the durable record lives in each member's events.jsonl (peer_message_*), the on-disk cluster meta (members), and the mailbox files (depth). `cluster_state` is a derived snapshot the client mirrors verbatim.

### Peer messaging (workflow-scoped)

Three workflow-scoped event kinds - emitted on each member's own `broadcastWorkflow` channel so events.jsonl carries the per-member view.

#### `peer_message_sent` <-

Emitted on the sender's workflow when `peer_send` succeeds. Carries a content preview only; the full content lives on the recipient's matching `peer_message_received`.

```ts
{
  type: 'peer_message_sent',
  workflowId: string,                  // sender's workflow
  msgId: string,
  from: string,                        // sender workflowId (== workflowId above)
  to: string,                          // recipient workflowId
  contentPreview: string,              // up to 200 chars
  chainDepth?: number, // auto-turn chain depth; stamped server-side at broadcast (operator-initiated sends ride at depth 0). The auto-turn detector refuses to fire when chainDepth ≥ AUTO_TURN_MAX_CHAIN_DEPTH.
}
```

Persisted.

#### `peer_message_received` <-

Emitted on the recipient's workflow at injection time (pre-turn drain or mid-turn `peer_read`). Replay reproduces the system-block injection. A pre-turn drain precedes that turn's `user_message_echo`; a mid-turn read retains its position among that turn's streamed events.

```ts
{
  type: 'peer_message_received',
  workflowId: string,                  // recipient's workflow
  msgId: string,
  from: string,                        // sender workflowId
  fromName: string, // sender display name (8-char workflowId prefix by default)
  content: string,                     // full body - durable record; the mailbox file is removed on drain
  ts?: number,                         // Original send time (ms epoch); workflow event sequence governs receive/reply placement.
}
```

Persisted.

Incoming and outgoing peer rows close the active assistant text segment before later text is appended. Persisted event sequence anchors keep earlier text, peer entries and subsequent replies in the same causal order on workflow and focused cluster panes. Sender creation times remain metadata and do not move received messages ahead of earlier output. Claude session JSONL is reconciled with those text segments without duplicating their content or dropping peer and tool rows; plan capture reassembles the assistant segments from the same turn. This presentation does not rewrite saved event logs or provider transcripts.

#### `peer_send_rejected` <-

Emitted on the sender's workflow when a `peer_send` is refused (budget exhausted, unknown peer, content too large, etc.). Plan forbids silent budget violations - every model-issued rejection rides this event so it's visible in the worker's transcript. Operator-driven `operator_peer_send` does NOT emit on rejection - substrate errors come back as a generic `error` reply.

```ts
{
  type: 'peer_send_rejected',
  workflowId: string,                  // sender's workflow
  reason: string,                      // see rejection-code list under `peer_send_rejected` below
  targetRef: string,                   // resolved workflowId or operator-supplied unresolved ref
  count?: number,                      // budget_exhausted: current send count this turn
  cap?: number,                        // budget_exhausted: per-turn cap
}
```

Persisted.

---


### `cluster_subscribe` ->

Client subscribes to cluster updates. Server replies with one `cluster_state` synchronously, then pushes more whenever a workflow-scoped event in the trigger set fires for any member. Per-WS subscription tracked in `Session.clusterIds`.

```ts
{ type: 'cluster_subscribe', clusterId: string }
```

### `cluster_unsubscribe` ->

```ts
{ type: 'cluster_unsubscribe', clusterId: string }
```

### `cluster_member_rehydrate` ->

Materialize one roster member's client-side job on demand. The roster (`cluster_state`) and each member's transcript job (`workflow_created`) are decoupled: after a server restart the `workflows` map fills lazily from client `rehydrate_workflows`, so a member whose config no connected client holds - a member that never took a turn before the restart, or one shadowed by a stale-localStorage twin (same display name, different id) - is never registered. Its card renders but its transcript pane is stuck on **"AWAITING REHYDRATE..."** (there is no job object at all, not even a blank one). The client emits this on `cluster_state` / `cluster_created` for any roster member it has no local job for (deduped by `workflowId`, cleared once `workflow_created` lands). The server validates membership (`clusterStore.getMembers`), reconstructs the `WorkflowConfig` from the member's persisted `meta.json` (config lives there field-by-field - `primaryProvider`/`primaryModel`/`primaryEffort`/`cwd`/`name`/..., not under a `config` key) if it isn't registered, registers the `WorkflowState`, then replies with `workflow_created` + a from-`seq 0` replay (`rehydrateOneWorkflow` filters the `workflow_created` event out of the replay so the fresh job isn't clobbered). Handler: `handleClusterMemberRehydrate` (`server/src/ws/handoffHandlers.ts`).

```ts
{ type: 'cluster_member_rehydrate', clusterId: string, workflowId: string }
```

### `cluster_create` ->

WS analogue of `POST /api/clusters` - both delegate to `clusterStore.createCluster` and pass through `assertAllMembersClaudeOrCodex` (which validates `isClusterMemberProvider` - see the fence note at the top). Reply is `cluster_created` with the auto-subscribed payload (so the new cluster tab opens with state available, no round-trip).

```ts
{ type: 'cluster_create', cwd: string, memberWorkflowIds: string[] }
```

### `cluster_delete` ->

WS analogue of `DELETE /api/clusters/:id`. Server tears down the cluster and broadcasts `cluster_deleted` to every subscribed WS.

```ts
{ type: 'cluster_delete', clusterId: string }
```

### `cluster_broadcast` ->

The operator submitted the broadcast composer. Server resolves members; idle members get the message via `handleUserMessage` (immediate fresh turn), busy members get it enqueued as `'follow-up'`. Each fan-out is a normal user message - `peer_message_received` drains still fire BEFORE `user_message_echo` per the ordering invariant. Reply: `cluster_broadcast_dispatched`.

```ts
{
  type: 'cluster_broadcast',
  clusterId: string,
  content: string,
  attachments?: string[],
  clientMessageId?: string,
  // 2026-05-11 - optional non-empty subset of `cluster.members[].workflowId`.
  // When present, fan-out is limited to these members; the server rejects with
  // `unknown_recipient` if any id isn't a current member. When omitted or
  // empty, the broadcast goes to every member (legacy behaviour). Used by:
  //  (a) the chip-row recipient picker above the composer textarea, and
  //  (b) the NUDGE modal (canned mailbox prompt; operator-armed per-member
  //      checkbox list, default empty).
  recipientWorkflowIds?: string[],
}
```

### `cluster_state` <-

Server's cluster snapshot. Pushed on subscribe + on every workflow-scoped event whose type is in `CLUSTER_STATE_TRIGGERS` (`primary_turn_started / primary_turn_ended / peer_message_sent / peer_message_received`) for any member. Other event types (streaming `primary_text` deltas, worker_*, etc.) do not churn cluster_state.

```ts
{
  type: 'cluster_state',
  clusterId: string,
  state: {
    clusterId: string,
    cwd: string,
    members: Array<{
      workflowId: string,
      displayName: string,             // operator-editable via rename_workflow; falls back to 8-char wfid prefix
      status: 'idle' | 'busy',
      role?: string,                   // optional free-form role hint (≤120 chars). Absent / empty = no role block injected into the worker's system prompt.
      tier?: 'light' | 'standard' | 'heavy',  // 2026-05-11 - builder-tier capability hint; pure metadata (no server-side routing)
      focus?: string,                  // 2026-05-11 - sub-specialty string (≤160 chars); surfaced in peer_list to disambiguate same-role peers
      accessMode?: 'standard' | 'blind' | 'isolated',  // absent ≡ standard; see the access-mode note at the top
    }>,
    mailboxDepth: Record<string, number>,
    createdAt: string,
    taskBoardMode: 'none' | 'project' | 'cluster',  // board mode. `project` = the cwd's normal task ledger; `cluster` = a private board under the same cwd keyed by taskBoardKey; `none` disables BOARD/tool/dispatcher use. New clusters default to 'cluster'; existing omitted board fields retain their legacy project/disabled interpretation.
    taskBoardKey?: string,           // set for `cluster` mode only - `cluster:<clusterId>`, the namespace key for the private board
    taskBoardAttached: boolean,      // back-compat derived flag for older clients: true for project|cluster, false for none
    name?: string,                   // slice 6a - operator-set display name; client falls back to `<basename(cwd)> · <short-id>` when absent
    plan?: {                         // shared cluster plan, canonical body under <cwd>/.arco/plans/<id>.md. Absent = no plan attached. Body capped at 32768 chars for prompt injection.
      id: string,
      title: string,
      body: string,
      updatedAt: number,             // ms epoch
    },
    idleNudgerEnabled?: boolean,     // operator-armed idle nudger toggle. Default OFF (absent ≡ false). See cluster_member_nudged.
    autoTurnOnMailboxEnabled?: boolean, // operator-armed AUTO-PICKUP toggle. Default OFF (absent ≡ false). When true, a peer_message_sent to a currently-idle recipient fires a single primary turn on the recipient with the synthetic prompt "(auto-pickup) New peer message arrived while you were idle - process your mailbox." Guarded by 20s per-recipient cooldown, 10/min per-cluster rate cap, and a chain-depth cap of 3. See cluster_auto_turn_fired.
    efficiencyLevel?: 'thorough' | 'balanced' | 'lean', // 2026-06-15 - per-cluster efficiency level. Emitted only when non-default (absent ≡ 'thorough'). See cluster_efficiency_set.
    messageGuard?: { mode: 'warn' | 'hard' | 'none', threshold: number }, // effective guard, including legacy fallback
    efficiencyAddendum?: string,    // 2026-06-15 - optional free-text appended to the canned restraint doctrine; emitted only when non-empty.
    progressTracking?: 'plan' | 'board' | 'both', // 2026-06-29 - per-cluster progress-tracking mode. Emitted only when non-default (absent ≡ 'both'). See cluster_progress_set.
    dispatcher?: {                  // Director/workers Stage G - operator-armed task dispatcher daemon. Default OFF when absent or enabled=false. Settings persist in cluster meta and mirror on every cluster_state.
      enabled: boolean,
      intervalMs: number,            // sweep cadence; server clamps to a sane floor
      maxTasksPerSweep: number,      // cluster-wide cap per interval sweep
      maxConcurrentRuns: number,     // cluster-wide open-run cap
      autoWorktree: boolean,         // Stage J - when true, dispatcher may create managed task worktrees for worktree-required tasks before firing
      armedByWorkflowId?: string,    // member workflowId that armed the daemon
      updatedAt?: number,            // ms epoch
    },
    remoteEnabled?: boolean,         // R3 - cluster-level ◉ REMOTE opt-in (absent ≡ OFF). See cluster_remote_set.
    remoteGatesEnabled?: boolean,    // cluster-level ⛨ GATES arming (absent ≡ OFF). See cluster_gates_set.
  },
}
```

### `cluster_created` <-

Wraps a fresh `cluster_state` and tells the requesting WS to flip its active tab to the new cluster. Other subscribed clients (rare in practice - one operator typically) get a `cluster_state` push instead.

```ts
{
  type: 'cluster_created',
  clusterId: string,
  state: ClusterStatePayload,    // same shape as cluster_state.state
}
```

### `cluster_deleted` <-

Broadcast to every subscribed WS when the cluster is torn down (operator clicked × on the tab -> confirmed -> `cluster_delete`, or curl-side `DELETE /api/clusters/:id`). Member workflows keep working as plain workflows on their next turn; peer tools are hidden when the worker has no cluster id.

```ts
{ type: 'cluster_deleted', clusterId: string }
```

### `cluster_rename` ->

Slice 6a - operator renamed a cluster from the `ClusterRightPanel` Members header. Empty `name` clears back to the derived default (`<basename(cwd)> · <short-id>`). Server validates length (≤64), persists to `~/.arco/clusters/<id>/meta.json`'s `name` field, and pushes a fresh `cluster_state` to subscribers.

```ts
{ type: 'cluster_rename', clusterId: string, name: string }
```

No event emitted to events.jsonl - rename is a label change, not a workflow-scoped action.

### `cluster_member_remove` ->

Slice 6a - operator clicked × on a member tab in the bottom row. Server detaches the member from the cluster AND tears down the workflow itself (single × click = "remove from cluster AND close workflow"). If detaching drops the cluster below 2 members, the cluster is collapsed (`removeMember` calls `deleteCluster` internally; subscribers receive `cluster_deleted`); otherwise the server emits `cluster_member_removed` followed by a fresh `cluster_state`. The leaving member's mailbox dir is wiped - pending peer messages destined for it lose their recipient context.

```ts
{ type: 'cluster_member_remove', clusterId: string, workflowId: string }
```

### `cluster_member_add` ->

The operator picked "ADD TO EXISTING" in the `TabContextMenu`. Server validates: cluster exists, target workflow exists + a supported cluster provider (`assertAllMembersClaudeOrCodex` -> `isClusterMemberProvider`), cwd matches the cluster, workflow is not already in a cluster. On success, emits `cluster_member_added` + a fresh `cluster_state` to all subscribers.

```ts
{ type: 'cluster_member_add', clusterId: string, workflowId: string }
```

### `cluster_create_with_fresh_workers` ->

The operator picked "CREATE WITH FRESH" in the `TabContextMenu`. Server: validates the source via `assertAllMembersClaudeOrCodex`; creates `additionalCount` new workflows (clamped to 1-4) each inheriting the source's cwd + primary config; calls `clusterStore.createCluster` with `[sourceWorkflowId,...newWorkflowIds]`; optionally `renameCluster` if `name` is non-empty. Each fresh workflow fires `workflow_created`; the cluster fires `cluster_created` on the originating socket only.

```ts
{
  type: 'cluster_create_with_fresh_workers',
  sourceWorkflowId: string,
  additionalCount: number,         // clamped to [1, 4]
  name?: string,                   // ≤64 chars; empty/absent = derived default
  // 2026-05-11 - operator override for the fresh workers' primary config.
  // Defaults clone the anchor when undefined. Provider fenced to
  // ClusterMemberProvider (claude/codex/ollama/llamacpp/cursor). When provider
  // differs from the anchor's provider, model is required (the anchor's model
  // name doesn't make sense on the new provider; UI enforces, server rejects
  // with `unknown_model` if it slips).
  provider?: ClusterMemberProvider,
  model?: string,                  // validated against the live catalog when populated
  effort?: 'low' | 'medium' | 'high' | string,
  providerAccountRef?: string,
}
```

### `cluster_member_replace` -> / `cluster_member_replaced` <-

Atomically replace one cluster slot with a new workflow ID and provider
session. The server clones the source WorkflowConfig plus name/role/tier/focus,
then applies optional provider/model/effort/account/access overrides.
`includeHistory` and `transferActiveTasks` are independent opt-ins. ISOLATED
members reject both options.

```ts
{
  type: 'cluster_member_replace',
  clusterId: string,
  workflowId: string,
  provider?: ClusterMemberProvider,
  model?: string,
  effort?: string,
  providerAccountRef?: string,
  accessMode?: 'standard' | 'blind' | 'isolated',
  includeHistory?: boolean,
  transferActiveTasks?: boolean
}

{
  type: 'cluster_member_replaced',
  clusterId: string,
  oldWorkflowId: string,
  newWorkflowId: string,
  member: ClusterMember,
  accessMode: 'standard' | 'blind' | 'isolated',
  historyIncluded: boolean,
  transferredTaskCount: number
}
```

The old workflow remains on disk for audit/resume, but its provider session,
mailbox, observer entry, and in-memory lifecycle are not inherited.

### `cluster_create_from_scratch` ->

2026-05-11 - operator picked CLUSTER mode in the `+NEW` WorkflowCreator. No source workflow - every member is minted fresh from the per-row config. Mirrors `cluster_create_with_fresh_workers` server-side but every member's provider / model / effort / role / tier is operator-picked up front. **This is the one create path that accepts local providers**: provider is the full `ClusterMemberProvider` set (`claude / codex /  ollama / llamacpp / cursor`), and the server enforces the **max-one-local cap** - more than one ollama/llamacpp member is rejected with `multiple_local_members` unless `ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL=1`. Per-member validation also covers `unknown_provider` / `missing_model` / `provider_model_mismatch` / `unknown_model` / `invalid_tier`. Server validates ≥1 member; client UI enforces ≥2. `name` is optional; empty = derived default. Per-member optional fields (`displayName` / `role` / `tier` / `focus`) are stamped into cluster meta in one shot.

```ts
{
  type: 'cluster_create_from_scratch',
  cwd: string,
  name?: string,
  efficiencyLevel?: 'thorough' | 'balanced' | 'lean',  // 2026-06-15 - cluster-wide, operator-picked at create. Omitted at new creation selects 'balanced'; omitted stored metadata still reads as 'thorough'.
  efficiencyAddendum?: string,                          // optional free-text appended to the canned doctrine; clamped to CLUSTER_EFFICIENCY_ADDENDUM_MAX
  members: Array<{
    provider: ClusterMemberProvider,   // 'claude' | 'codex' | 'ollama' | 'llamacpp' | 'cursor' (max 1 local; cursor uncapped)
    model: string,
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | string,
    providerAccountRef?: string,
    displayName?: string,
    role?: string,
    tier?: 'light' | 'standard' | 'heavy',
    focus?: string,
    skipPermissions?: boolean,
    fastMode?: boolean,
    efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive',
    outputStyle?: 'normal' | 'lite' | 'terse',
    accessMode?: 'standard' | 'blind' | 'isolated',  // isolated ⇒ provider must be claude
  }>,
}
```

Cluster presets (operator-saved snapshots) are persisted at `~/.arco/cluster-presets.json` and consumed by the CLUSTER-mode WorkflowCreator - see `ClusterPreset` / `ClusterPresetMember` in [`shared/src/protocol/clusters.ts`](../shared/src/protocol/clusters.ts). Presets are project-agnostic (cwd is intentionally NOT part of a preset); the cluster-create path validates models against the live catalog at apply time.

### `cluster_add_fresh_workers` ->

operator clicked `+ ADD FRESH` inside `ClusterRightPanel`'s Members sub-tab. Server: reads the target cluster, picks the template from `members[0]` (cwd + primary config), validates the template via `assertAllMembersClaudeOrCodex`, creates `count` new workflows (clamped to 1-4), adds each via `clusterStore.addMember`. Naming picks the next available `#k` suffix not already in use across cluster members so successive adds don't collide. Broadcasts `cluster_member_added` per add, then a final `cluster_state`.

```ts
{
  type: 'cluster_add_fresh_workers',
  clusterId: string,
  count: number,                   // clamped to [1, 4]
  // 2026-05-11 - operator override for the fresh workers' primary config.
  // Defaults clone `members[0]` (the cluster template) when undefined. Same
  // constraints as on `cluster_create_with_fresh_workers`.
  provider?: ClusterMemberProvider,
  model?: string,
  effort?: 'low' | 'medium' | 'high' | string,
  providerAccountRef?: string,
  accessMode?: 'standard' | 'blind' | 'isolated',  // isolated ⇒ provider must be claude
}
```

### `cluster_plan_set` ->

operator saved the shared cluster plan from `ClusterPlanTab`, hit `PROMOTE TO CLUSTER` from a per-workflow PLAN tab, or clicked `ATTACH TO CLUSTER` on a worker's `PlanCandidateBanner` (member tabs only - see [`PRIMITIVES.md`](PRIMITIVES.md)). Server caps body length at 32768 chars (rejects with `body_too_large:<n>` otherwise) and rejects empty / whitespace bodies with `empty_body` (operator must use `cluster_plan_clear` to wipe). Writes through `clusterPlanBridge.setClusterPlanBody`: updates the cluster's attached per-cwd plan (`<cwd>/.arco/plans/<planId>.md`), or creates one (title from the body's first `# ` heading) and stamps its id into cluster meta. Emits `cluster_plan_changed` (audit shape: timestamp + body length, the full body lives on disk + on the cluster_state push) followed by a fresh `cluster_state`.

```ts
{ type: 'cluster_plan_set', clusterId: string, body: string }
```

UI guidance: soft-warn at 28672 chars (PLAN_SOFT_WARN_BYTES), hard-disable SAVE at >32768 (`PLAN_MAX_BYTES`).

### `cluster_plan_attach` ->

Attach an existing per-cwd plan to the cluster **without copying the body** (the canonical body stays at `<cwd>/.arco/plans/<planId>.md`). The cluster holds exactly one active plan at a time, matching workflow plan semantics. Emits `cluster_plan_changed` + a fresh `cluster_state` whose `state.plan` carries `{ id, title, body, updatedAt }`.

```ts
{ type: 'cluster_plan_attach', clusterId: string, planId: string }
```

### `cluster_plan_clear` ->

operator hit `CLEAR PLAN` in `ClusterPlanTab`. `clusterPlanBridge.clearClusterPlan` drops the plan id from cluster meta (the per-cwd plan file stays, available to other workers/clusters) and deletes any legacy `~/.arco/clusters/<id>/plan.md`; subsequent member turns see no plan block. Emits a `cluster_plan_changed` with `body=''` + `bodyLength=0`, followed by a fresh `cluster_state` (the `plan` field is absent on the new payload).

> One plan substrate (`server/src/clusterPlanBridge.ts`): the body is canonical under `<cwd>/.arco/plans/<planId>.md` and cluster meta stores only `planId`, for set, attach, tick, write, and review alike. Pre-unification clusters wrote `~/.arco/clusters/<id>/plan.md`; reads lazily migrate that legacy body into the per-cwd store.

```ts
{ type: 'cluster_plan_clear', clusterId: string }
```

### `cluster_member_role_set` ->

The operator picked a role for a member via the `SET` popover in `ClusterRightPanel`'s Members sub-tab (six canonical presets from [`shared/src/clusterRolePresets.ts`](../shared/src/clusterRolePresets.ts) - DIRECTOR / BUILDER / REVIEWER / RESEARCHER / TESTER / DOCUMENTER - plus a `Custom...` branch that falls back to the inline editor) or hit `CLEAR`. A preset is just a known string the UI drops into the editor; the wire shape is free-form text. Server clamps to 120 chars (`MEMBER_ROLE_MAX`) - values longer are silently truncated. Empty / whitespace clears the field entirely (the member's `role` becomes absent from `cluster_state.members`). Persisted into `ClusterMeta.memberRoles` (sparse map). Pushes a fresh `cluster_state`; no dedicated event - role changes are state-shaped (the `role` field on each `ClusterMember` is the wire surface). Codex app-server members carry role + cluster identity + (for a Director role) the full Director operating contract in thread `developerInstructions`, so a role change recycles the app-server child on the next turn while resuming the same Codex thread.

```ts
{ type: 'cluster_member_role_set', clusterId: string, workflowId: string, role: string }
```

### `cluster_member_tier_set` ->

2026-05-11 - operator edited a member's builder-tier hint from the Members sub-tab. `tier` is one of `'light' | 'standard' | 'heavy'` (`MEMBER_TIERS`) or `null` to clear. Server rejects unknown strings. Pure metadata: the director sees `tier` on `peer_list` rows and decides routing; no server-side routing logic. Mirrors `cluster_member_role_set` in handler shape - server persists in meta.json and rebroadcasts `cluster_state` so every observer sees the new value inline.

```ts
{
  type: 'cluster_member_tier_set',
  clusterId: string,
  workflowId: string,
  tier: 'light' | 'standard' | 'heavy' | null,
}
```

### `cluster_member_focus_set` ->

2026-05-11 - operator set a per-member focus string (sub-specialty), e.g. `"React frontend, Zustand store patterns"`. Free-form text ≤160 chars (`MEMBER_FOCUS_MAX`); `null` clears. Surfaced in `peer_list` so a director LLM can disambiguate same-role peers. Pure metadata. Server clamps + persists in meta.json + rebroadcasts `cluster_state`.

```ts
{
  type: 'cluster_member_focus_set',
  clusterId: string,
  workflowId: string,
  focus: string | null,
}
```

### `cluster_idle_nudger_toggle` ->

 operator-armed per-cluster idle-nudger toggle. Default OFF. When ON, the server-side detector emits `cluster_member_nudged` to alert the operator (NOT the worker) when a member has been idle for ≥`IDLE_FLOOR_SECONDS` AND has ≥1 pending message in its mailbox. The toggle is operator-armed, uses a deterministic predicate, is visible in `events.jsonl`, and can be reversed.

```ts
{ type: 'cluster_idle_nudger_toggle', clusterId: string, enabled: boolean }
```

### `cluster_efficiency_set` ->

The Efficiency control selects deterministic coordination instructions: Thorough permits useful explanatory context, Balanced assigns complete outcomes with routine compatible decisions owned by builders, and Lean reduces optional narration and handoffs. All levels preserve required tests, safety checks, operator-requested review and the Director's final landing review. Directors reconcile relevant tasks and new evidence, assign exact placement, surfaces, invariants, dependencies and acceptance checks, then review the final diff and evidence once. Builders raise an actionable unresolved blocker before the expensive gate or return one final evidence packet. Manual idle/busy nudges, pending-mail notices and auto-pickup use the same level-aware, role-aware wording. Busy nudges remain non-interrupting; explicit recipient selection is unchanged.

Message guard is a separate control beside Efficiency and in cluster creation. `messageGuard` has `{ mode: 'warn' | 'hard' | 'none', threshold: number }`; thresholds are integers from 1 through 1000. Warn only accepts legitimate sends above the threshold and adds one warning to a successful send result per sender per primary turn. Hard limit refuses mail at the cap; refused mail is not delivered. No limit removes the peer-send quota only, retaining automatic-execution, provider, permission, size and deduplication limits. Its retained threshold is used if a bounded mode is selected later.

Successful model send results include `guard` with `mode`, `count`, `cap`, `threshold`, `remaining` and an optional `warning`. Cap/remaining are null outside Hard limit; threshold is null for No limit. Counts span all recipients and reserve capacity before enqueue to fence concurrent sends. Failed/refused sends refund their reservation. The existing `primary_turn_started` boundary resets counts and warning state for that sender; these counters are process-local and are not restored after server restart. Consolidate related information for the same recipient; do not start turns to evade a cap. Operator-driven transcript sends keep their existing explicit bypass.

```ts
{ type: 'cluster_efficiency_set', clusterId: string,
  level: 'thorough' | 'balanced' | 'lean', addendum?: string,
  messageGuard?: { mode: 'warn' | 'hard' | 'none', threshold: number } }
```

Omitted `addendum` keeps NOTE; empty clears it; non-empty replaces it, trimmed to 1000 characters. NOTE is an appended operator instruction, not a mode or budget. Omitted `messageGuard` preserves the effective guard. A legacy cluster with no guard retains a hard cap of 15/8/4 for its saved Thorough/Balanced/Lean style; that effective cap is pinned before a style or NOTE edit. Style changes therefore do not change the guard. Settings persist atomically and broadcast `cluster_state`. Style instructions apply next turn; guard changes apply on the next send, without resetting the existing counter.

All new creation paths use explicit Balanced, Warn only at 15, a cluster-local board and Keep current Both. Explicit creation settings override those defaults. Stored omitted style fields still mean Thorough; old omitted board fields keep the existing interpretation. Snapshot restore uses saved settings and old-format fallbacks rather than creation defaults. No existing board is moved, merged or copied by the new default. Guard state rides in cluster state and snapshot metadata; automatic-execution arming remains off on restore.

### `cluster_progress_set` ->

2026-06-29 - operator picked which surface(s) the cluster keeps current, from the ClusterRightPanel progress chip or the `+ NEW` cluster creator. `mode` is one of `CLUSTER_PROGRESS_MODES` (`plan` / `board` / `both`; server rejects unknown strings with `cluster_progress_set rejected: unknown_mode`, unknown cluster with `unknown_cluster`). Each mode resolves server-side (`clusterProgress.ts` `buildProgressDoctrine(mode, hasPlan, hasBoard)`) to a deterministic system-prompt doctrine block injected into every member's next turn - a plan-upkeep clause (keep the shared plan's `[ ]`/`[x]` current via `cluster_plan_tick`), a board-upkeep clause (move tasks through their statuses as work progresses), plus a reconcile line when BOTH surfaces are live. Each clause is gated on the surface actually existing (`hasPlan` / `hasBoard`), so a mode with no matching surface injects nothing. The progress default `both` is non-empty: pre-feature clusters with a plan start getting the upkeep nudge. Takes effect on each member's **next** turn (in-flight untouched). Server persists to cluster `meta.json` and rebroadcasts `cluster_state`; `cluster_state.progressTracking` is echoed only when non-default (absent ≡ `both`). Passes the four-question test: operator-set, deterministic doctrine, logged via `cluster_state`, reversible by flipping the chip.

```ts
{ type: 'cluster_progress_set', clusterId: string, mode: 'plan' | 'board' | 'both' }
```

### `cluster_member_reorder` ->

2026-07-17 - operator drag-reordered the member grid. `memberIds` must be an exact permutation of the current members (a stale drag with drops/duplicates is rejected: `cluster_member_reorder rejected: unknown_cluster_or_stale_order`; malformed payload: `bad_payload`). Persists `members[]` order to cluster meta and rebroadcasts `cluster_state`, so the desktop grid, right panel, and phone console all follow.

```ts
{ type: 'cluster_member_reorder', clusterId: string, memberIds: string[] }
```

### `cluster_remote_set` -> / `cluster_gates_set` ->

Cluster-level remote-management and gate switches. `cluster_remote_set` (◉ REMOTE chip): while on, the hub link reports the cluster and every member to the management console; members' own `remoteEnabled` flags are ignored while clustered. `cluster_gates_set` (⛨ GATES chip): arms remote DEBAG gate approval for every member - separate from REMOTE, because remote conversation never implies remote approval authority. Both default OFF, persist to cluster meta, rebroadcast `cluster_state` (`remoteEnabled` / `remoteGatesEnabled`), and re-push the hub snapshot immediately. Unknown cluster -> `error: <type> rejected: unknown_cluster`. Snapshot restore always resets both to OFF.

```ts
{ type: 'cluster_remote_set', clusterId: string, enabled: boolean }
{ type: 'cluster_gates_set', clusterId: string, enabled: boolean }
```

### `cluster_member_nudged` <-

 server-side detector found a member that matches the nudge predicate (idle ≥ floor AND pending ≥ 1) and is below the `NUDGES_PER_TURN` cap. `reason` is always `'idle_with_pending'` today; kept open for future predicate classes. Operator-only - the worker never sees this event. `NotificationToasts` surfaces a toast.

```ts
{
  type: 'cluster_member_nudged',
  clusterId: string,
  workflowId: string,
  reason: 'idle_with_pending',
  idleSeconds: number,
  pendingCount: number,
}
```

### `cluster_plan_changed` <-

server-side audit row for plan body edits (set or cleared). `body` carries the new full text (empty string = cleared). `bodyLength` duplicates `body.length` for events.jsonl scans that don't want to parse the body. `updatedAt` is wall-clock ms. Fires alongside a `cluster_state` push that carries the same body inline on `state.plan`.

```ts
{
  type: 'cluster_plan_changed',
  clusterId: string,
  body: string,            // '' when cleared
  updatedAt: number,
  bodyLength: number,
}
```

### `cluster_member_added` / `cluster_member_removed` <-

Server-pushed membership change. Slice 6a wires `cluster_member_remove` -> emits `cluster_member_removed`. Arco wires SPAWN-into-cluster and `cluster_member_add` (both emit `cluster_member_added`); Arco adds `cluster_add_fresh_workers` (also emits `cluster_member_added`, one per fresh worker).

```ts
{ type: 'cluster_member_added', clusterId: string, member: ClusterMember }
{ type: 'cluster_member_removed', clusterId: string, workflowId: string }
```

### `cluster_broadcast_dispatched` <-

Reply to `cluster_broadcast`. `idle` lists workflowIds that started a fresh turn now; `queued` lists workflowIds whose prompt landed on the follow-up queue (member was busy at fan-out time). `failed` carries any members the dispatcher couldn't reach (e.g. workflow not yet hydrated). Sum = total membership at fan-out time. Transient.

```ts
{
  type: 'cluster_broadcast_dispatched',
  clusterId: string,
  clientMessageId?: string,             // echoes the request's id
  idle: string[],
  queued: string[],
  failed: Array<{ workflowId: string; reason: string }>,
}
```

The client-side broadcast composer renders a single toast based on `idle.length` vs. `queued.length`: `"Sent to all M members"` (queued=0) or `"Queued for K of M members"`. Today the toast is co-located in `ClusterTab` and reads the local cluster state at submit-time rather than this server reply, but a future surface that needs the `failed[]` array (e.g. "couldn't reach member X") wires through this message.

### `cluster_dispatch_once` ->

Director/workers Stage F - operator-clicked one-shot task dispatcher from the
cluster BOARD. The server scans `ready` tasks in deterministic order
(priority desc, createdAt asc, id asc), only fires tasks with an explicit idle
assignee that is a current supported cluster member, persists the task/run
mutation first, and then starts the assignee's normal primary turn with a
task-dispatch prompt. Role/tier/focus metadata is not used for routing in this
slice. Stage J adds worktree awareness: a ready task marked
`worktreeRequired` is skipped unless it already has `worktree` or the operator
has enabled dispatcher `autoWorktree`; when enabled, the dispatcher creates the
managed worktree before persisting the run and includes the path/branch in the
synthetic prompt. The member workflow cwd is not changed in this phase.

```ts
{
  type: 'cluster_dispatch_once',
  clusterId: string,
  workflowId: string,        // requester; must be a cluster member
  requestId?: string,
  maxTasks?: number,         // optional sweep cap; default = member count
}
```

### `cluster_dispatch_result` <-

Transient reply to `cluster_dispatch_once`. Fired tasks also produce durable
`task_ledger_event` rows with `op: 'dispatch_fired'` and `payload.run`; refused
ready tasks produce durable `op: 'dispatch_skipped'` rows with the same reason
codes shown here.

```ts
{
  type: 'cluster_dispatch_result',
  clusterId: string,
  workflowId: string,        // requester
  requestId?: string,
  fired: Array<{ taskId: string; workflowId: string; runId: string }>,
  skipped: Array<{
    taskId: string,
    reason:
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
      | 'race_lost',
    assignee?: string,
    detail?: string,
  }>,
  at: number,
}
```

### `cluster_dispatch_toggle` ->

Director/workers Stage G - operator arms or disarms the per-cluster task
dispatcher daemon. Default OFF: absent `dispatcher` or
`dispatcher.enabled !== true` means the interval loop must not fire
synthetic task turns. Toggling persists to cluster meta and pushes a fresh
`cluster_state`. Disarming stops new interval fires; already-open task runs
remain open and finish through the normal worker lifecycle.

```ts
{
  type: 'cluster_dispatch_toggle',
  clusterId: string,
  workflowId: string,        // requester; must be a cluster member
  enabled: boolean,
}
```

### `cluster_dispatch_settings_update` ->

Patch the daemon settings without firing a sweep directly. The daemon still
uses the same Stage F dispatcher kernel: ready tasks are sorted by priority
desc, createdAt asc, id asc; routing is explicit-assignee-only; open runs block
re-dispatch. The server clamps numeric fields and persists the normalized
settings to cluster meta before broadcasting `cluster_state`.
`autoWorktree` is default OFF and must be explicitly enabled by the operator;
it does not arm the daemon by itself.

```ts
{
  type: 'cluster_dispatch_settings_update',
  clusterId: string,
  workflowId: string,        // requester; must be a cluster member
  settings: {
    intervalMs?: number,
    maxTasksPerSweep?: number,
    maxConcurrentRuns?: number,
    autoWorktree?: boolean,
  },
}
```

`ARCO_TASK_DISPATCHER_DEFAULT_INTERVAL_MS`,
`ARCO_TASK_DISPATCHER_MIN_INTERVAL_MS`, and
`ARCO_TASK_DISPATCHER_TICK_MS` are smoke/dev overrides for daemon cadence and
clamping. Production UX should keep the daemon visibly armed in the BOARD header
and should never silently enable it when tasks are created.

### Cluster task board

Two operator-driven board-control messages. New clusters default-attach a cluster-local board (`clusterStore.createCluster` stamps `taskBoardMode: 'cluster'`, `taskBoardAttached: true`), so most clusters never need these - they exist to switch a cluster's board between the shared project ledger, a private cluster board, and off. Both handlers re-sync every member's MCP config (the BOARD peer-tools register/unregister with mode), drop the cluster from the dispatcher when the board goes to `none`, then push a fresh `cluster_state` (plus a `task_ledger_snapshot` seeded from the active board whenever the board is enabled).

#### `cluster_task_board_attach_set` ->

Back-compat toggle for older clients: `attached:true` ⇒ mode `project`, `attached:false` ⇒ mode `none` (`clusterStore.setTaskBoardAttached` delegates to `setTaskBoardMode`). Rejects an unknown cluster with `error: cluster_task_board_attach_set rejected: unknown_cluster`.

```ts
{ type: 'cluster_task_board_attach_set', clusterId: string, attached: boolean }
```

#### `cluster_task_board_mode_set` ->

Sets the board mode explicitly. `project` uses the cwd's normal task ledger; `cluster` uses a fresh private board under the same cwd keyed by `taskBoardKey` (`cluster:<clusterId>`); `none` disables BOARD/tool/dispatcher use (and disarms the dispatcher if it was armed). Server validates the enum (`error: cluster_task_board_mode_set rejected: invalid_mode`) and rejects an unknown cluster with `unknown_cluster`.

```ts
{ type: 'cluster_task_board_mode_set', clusterId: string, mode: 'none' | 'project' | 'cluster' }
```

Board *content* mutations don't ride these messages: they flow over the cwd-scoped `task_ledger_*` WS messages (stamped with the cluster's `boardKey` when in `cluster` mode) (documented in [`PROTOCOL.md`](PROTOCOL.md)) and the `cluster_task_*` peer tools ([Peer tool inventory](#peer-tool-inventory-not-ws-messages) below). The plan-to-task (`PlanBodyRenderer.onPromoteTask`) and peer-to-task (`MailboxModal.onMakeTask`, transcript `PeerMessageBlock`) bridges are client-only and dispatch `task_ledger_create` with the board's key; they add no new WS message.

### `cluster_swarm_create` ->

Director/workers Stage I - operator-created swarm graph. The server validates
the requester and selected members, creates one root blackboard task carrying
the goal, N worker tasks assigned to the requested workers, one verifier task
assigned to the verifier, and one synthesizer task assigned to the synthesizer.
The root is retained as completed context; all non-root work remains
non-terminal. `armDispatch` runs one deterministic dispatcher sweep after graph
creation; it does not arm the daemon and cannot mark work `done`.

```ts
{
  type: 'cluster_swarm_create',
  clusterId: string,
  workflowId: string,        // requester; must be a cluster member
  requestId?: string,
  goal: string,
  workerWorkflowIds: string[],
  verifierWorkflowId: string,
  synthesizerWorkflowId: string,
  armDispatch?: boolean,
}
```

### `cluster_swarm_created` <-

Transient reply/event after the graph is created. The task rows themselves are
durable `task_ledger_event` records and are followed by a cluster-wide
`task_ledger_snapshot`.

```ts
{
  type: 'cluster_swarm_created',
  clusterId: string,
  workflowId: string,
  requestId?: string,
  rootTaskId: string,
  workerTaskIds: string[],
  verifierTaskId: string,
  synthesizerTaskId: string,
  armDispatch: boolean,
  at: number,
}
```

### Orchestration assist (Stage K)

Director/workers Stage K - operator-armed **draft proposals** for the cluster board. Shapes: [`shared/src/protocol/orchestrationAssist.ts`](../shared/src/protocol/orchestrationAssist.ts); handlers `handleClusterOrchestration*` in `server/src/ws/clusterHandlers.ts`; durable store `<cwd>/.arco/project/orchestration-proposals.json` (`server/src/project/orchestrationProposals.ts`). Every request/list/reject/apply validates that the requester is a current member. Proposals never mutate the task ledger, dispatcher, member config, or worktrees; only an explicit apply does, through the normal task-kernel path. Server replies fan out on both the cluster channel and the requester's workflow channel (so the requester's `events.jsonl` carries the audit row).

> **Current state:** the model-call hook is not wired. `cluster_orchestration_assist_request` persists whatever `draft` the request carries (items + rationale); with no draft the proposal is empty and its rationale says so. `model` is recorded as metadata only.

Client -> server:

```ts
{
  type: 'cluster_orchestration_assist_request',
  clusterId: string,
  workflowId: string,          // requester; must be a member
  requestId?: string,          // doubles as the proposal_started id when set
  kind?: OrchestrationAssistKind,   // 'task_graph' | 'assignments' | 'swarm' | 'recovery' | 'synthesis' - required (or legacy alias `mode`); else invalid_kind
  mode?: OrchestrationAssistKind,
  prompt?: string,             // trimmed, capped 16 KB; default "<kind> proposal requested by operator."
  inputRefs?: Array<{ kind: 'plan' | 'workflow' | 'task' | 'run' | 'review' | 'url' | 'text', ref: string, label?: string }>,
  sourceWorkflowId?: string,   // must be a member (assist_member_not_member)
  model?: { provider, model?, effort?, providerAccountRef?, memberWorkflowId? },  // default { provider: 'claude' }
  draft?: { items: OrchestrationProposalItem[], rationale?: string, raw?: unknown },
}
{ type: 'cluster_orchestration_proposal_list', clusterId: string, workflowId: string }
{ type: 'cluster_orchestration_proposal_reject', clusterId: string, workflowId?: string, proposalId: string, reason?: string }
{
  type: 'cluster_orchestration_proposal_apply',   // `cluster_orchestration_proposal_accept` is an alias routed to the same handler
  clusterId: string,
  workflowId?: string,         // optional on older clients; falls back to the proposal's requester
  proposalId: string,
  itemIds: string[],           // non-empty
  itemEdits?: Record<string, { title?: string, body?: string }>,  // operator edits applied at apply time
  applyMode?: 'task_kernel' | 'comment',                          // default task_kernel
}
```

`OrchestrationProposalItem` = `task_create` | `task_update` | `task_comment` | `note`. Items may not target a terminal status (`done` / `archived` -> `terminal_status_gated`); `done` stays operator-only. Apply rejects with `no_items`, `unknown_cluster`, `proposal_not_found`, `board_detached` (board mode `none`), `proposal_rejected`, `already_accepted:<id>`, `unknown_item:<id>`. Reject refuses an already-`accepted` proposal. Applied task mutations land as ordinary `task_ledger_event` rows followed by `task_ledger_snapshot`.

Server -> client:

```ts
{ type: 'cluster_orchestration_assist_started', clusterId, workflowId, requestId?, kind, model, inputRefs, startedAt }   // requester channel only
{ type: 'cluster_orchestration_proposal_started', clusterId, proposalId, requestId?, workflowId?, sourceWorkflowId?, provider?, model?, effort?, title?, rationale?, inputRefs?: string[], createdAt }  // requester channel only
{ type: 'cluster_orchestration_proposal_proposed', clusterId, workflowId, proposal: OrchestrationProposal }
{ type: 'cluster_orchestration_proposals_snapshot', clusterId, proposals: OrchestrationProposal[] }   // after every request/list/reject/apply
{ type: 'cluster_orchestration_proposal_rejected', clusterId, workflowId, proposalId, reason?, at }
{ type: 'cluster_orchestration_proposal_applied', clusterId, workflowId, proposalId, itemIds, taskIds, at }
```

`OrchestrationProposal` carries `id, clusterId, workflowId, requestId?, kind, status ('proposed' | 'partially_accepted' | 'accepted' | 'rejected'), prompt, inputRefs, model, items, rationale?, raw?, createdAt, updatedAt, acceptedItemIds?, rejectedAt?, actions[]` (the per-proposal audit trail).

### `cluster_auto_turn_toggle` ->

operator armed / disarmed the per-cluster AUTO-PICKUP surface. Default OFF. When ON, a `peer_message_sent` to a currently-idle recipient fires a single primary turn on the recipient with the synthetic prompt `"(auto-pickup) New peer message arrived while you were idle - process your mailbox."` Detector lives in `server/src/clusterAutoTurn.ts`.

```ts
{ type: 'cluster_auto_turn_toggle', clusterId: string, enabled: boolean }
```

Three guards prevent runaway loops, all env-overridable for smoke harnesses:

| Guard | Default | Env override |
|---|---|---|
| Per-recipient cooldown (ms) | 20000 | `ARCO_CLUSTER_AUTO_TURN_COOLDOWN_MS` |
| Per-cluster rate cap (rolling 60s) | 10 | `ARCO_CLUSTER_AUTO_TURN_RATE_CAP_PER_MINUTE` |
| Chain-depth cap | 3 | `ARCO_CLUSTER_AUTO_TURN_MAX_CHAIN_DEPTH` |

Chain depth is carried on `peer_message_sent.chainDepth` (see below); operator-initiated peer-sends ride at depth 0, so the first auto-turn lands at depth 1.

### `cluster_auto_turn_fired` <-

Server-side detector emitted on every fire-path (`fired: true`) AND on every guard refusal (`fired: false`). Rides through the recipient's `broadcastWorkflow` channel so the audit row lives next to that member's events. Skip events are rate-limited to one per `reason` per minute per cluster so a tight loop can't spam the log.

```ts
{
  type: 'cluster_auto_turn_fired',
  clusterId: string,
  workflowId: string,        // recipient (the workflow whose turn fires / would have fired)
  sender: string,            // sender workflowId of the triggering peer_message_sent
  chainDepth: number,        // depth this auto-turn lands at (sender's + 1 on fire; reported as-is on skip)
  reason: 'mailbox_arrival' | 'rate_capped' | 'depth_capped' | 'cooldown' | 'recipient_busy' | 'disabled',
  fired: boolean,            // true -> a turn was dispatched; false -> guard refused
}
```

### `peer_message_sent.chainDepth`

`peer_message_sent` is documented in [Peer messaging](#peer-messaging-workflow-scoped) above; Arco adds one optional field, `chainDepth?: number`, **stamped server-side at broadcast time** - clients never send it. Mechanics:

- Operator-initiated peer-sends ride at depth 0 (no auto-turn marker for the sender).
- When the detector fires an auto-turn for recipient R it calls `markAutoTurnDepth(R, parentDepth + 1)`; while R's turn runs, every outbound `peer_message_sent.chainDepth` is stamped from `currentAutoTurnDepth(senderWfid)`. `primary_turn_ended` clears the marker.
- The detector refuses to auto-turn on an incoming message whose `chainDepth ≥ AUTO_TURN_MAX_CHAIN_DEPTH`.

See `server/src/clusterAutoTurn.ts` for the marker lifecycle and `GOTCHAS.md mode` for the load-bearing rules.

### `__debug_cluster_auto_turn_inject` -> (dev/smoke-only)

 test hook: directly invokes the auto-turn detector's `onPeerMessageSent` with a caller-specified `chainDepth`, so `scripts/smoke/phase-5b.ts` can exercise the depth / rate caps without real LLM turns generating naturally-chained peer-sends. Gated server-side on `process.env.ARCO_TEST === '1'`.

```ts
{
  type: '__debug_cluster_auto_turn_inject',
  clusterId: string,
  senderWfid: string,
  recipientWfid: string,
  chainDepth: number,
}
```

### `operator_peer_send` ->

Operator-driven analog of model-issued `peer_send`. Lets the operator paste an arbitrary chunk of chat content (full transcript / last turn / last N turns) into a single peer's mailbox FROM a worker they pick. Surfaces via the `-> TRANSCRIPT` composer button (cluster members only; `client/src/components/TranscriptSendDialog.tsx`) and via the cluster-routed Review dispatch (`onConfirmViaMember` in `ReviewDialog`) - but Review actually uses `sendMessage` so the reviewer starts a turn immediately; only the transcript-send path rides this WS shape today. Server validates membership on both `from` and `to`, rejects `from === to`, then dispatches `clusterPeerOps.peerSend` with `{ bypassBudget: true, bypassDedupe: true, maxContentBytes: 32768 }` - the operator is in direct control, so neither the per-turn budget nor the 60s dedupe cache applies, and the byte cap is raised to match the cluster-plan body cap (`OPERATOR_PEER_SEND_MAX_BYTES` in `server/src/ws/clusterHandlers.ts`). Server emits the usual `peer_message_sent` event on the chosen sender's workflow channel; recipient sees no difference between operator-driven and model-driven sends.

```ts
{
  type: 'operator_peer_send',
  clusterId: string,
  from: string,     // sender's workflowId - must be a cluster member
  to: string,       // recipient's workflowId - must be a cluster member; !== from
  content: string,  // ≤ 32 KB UTF-8
}
```

Errors ride through the standard `error` reply when validation fails (unknown cluster, non-member from/to, self-send). Substrate errors (content cap exceeded, recipient not in cluster) come back as `error` with the underlying `peerSend` rejection code prefixed `operator_peer_send: <code>: <message>`. The operator does NOT see `peer_send_rejected` for this path - those events are reserved for model-issued sends visible in the worker's transcript.

### `peer_send_rejected` <- (rejection codes)

Updated rejection-code set, persisted to the sender's workflow events.jsonl:

- `unknown_peer` - `to` did not resolve to a member of the sender's cluster (after wfid-prefix -> exact displayName -> displayName-prefix resolution).
- `budget_exhausted` - sender already hit the per-turn `clusterBudget` cap (carries `count` + `cap`).
- `content_too_large` - body exceeds the mailbox cap (16 KB default for model-driven, `MAX_CONTENT_BYTES` in `clusterMailbox.ts`; 32 KB for operator-driven via the `maxContentBytes` opt).
- `enqueue_failed` - `clusterMailbox.enqueue` threw for some other reason.
- `recipient_not_in_cluster` - recipient is not a member at enqueue time.
- `duplicate_send` (2026-05-11) - `(from, to, sha256(content))` matched an accepted send within `ARCO_PEER_SEND_DEDUPE_MS` (default 60_000). Catches the orphan-tool-use retry pattern where a previous turn aborted mid-tool, leaving the model with no memory of having sent, and the next turn re-issues the same `peer_send`. Operator-driven `operator_peer_send` bypasses dedupe (`opts.bypassDedupe`); model-driven sends pay the check. Process-local cache; restarts clear it (which is correct - restarts also wipe the orphan state that caused the retry).
- `self_send` - `to` resolved to the sender's own workflowId. Per (2026-05-10) this is a model error, NOT a policy rejection - returned to the tool caller but no `peer_send_rejected` event is emitted.

### `peer_message_*` chat row identity (2026-05-11)

`peer_message_sent` and `peer_message_received` server events drive synthetic chat rows on the client (`client/src/ws/handleServerMessage.ts` `peer_message_sent` / `peer_message_received` cases). Each row carries a **deterministic id** - `peer-sent-<msgId>` for sent rows, `peer-recv-<msgId>` for received rows - so rehydrate-on-subscribe + tsx-watch restarts that re-emit the same event are idempotent. Both handlers check for an existing id before calling `addMessage`; `addMessage` does a defense-in-depth id check; and `onRehydrateStorage` strips duplicates on load. **Do not re-introduce non-deterministic IDs for peer rows.**

Sent rows additionally carry `targetWorkflowId: msg.to` (full recipient wfid). The `ChatMessage.PeerMessageBlock` renderer uses this to look up the recipient's current displayName + role from the cluster store and render `displayName (role)` instead of an 8-char wfid prefix. The lookup is reactive on rename / re-role.

### `attach_codebase_memory` ->

 Operator toggled "Attach codebase memory" in the CONFIG tab. Server flips `WorkflowConfig.codebaseMemory.attached` + persists to meta.json + broadcasts `codebase_memory_state`. The actual `--mcp-config` write-in at CLI spawn time is deferred to a follow-up after Cluster Arco ships `mcpConfigWriter`. `indexPath` defaults to the workflow's `workingDirectory` when absent.

```ts
{ type: 'attach_codebase_memory', workflowId: string, indexPath?: string }
```

### `detach_codebase_memory` ->

 Operator unchecked the toggle. Server drops `attached` (keeps any operator-typed `indexPath` so re-attaching is one click).

```ts
{ type: 'detach_codebase_memory', workflowId: string }
```

### `codebase_memory_state` <-

 Server push reflecting the current codebase-memory attach state for a workflow. Fired on attach / detach / re-index. `attached === false` ⇒ `indexPath` / `lastIndexedAt` / `fileCount` may still be present (operator's last-typed values) so re-attaching reuses them; the CONFIG section just renders them dim.

```ts
{
  type: 'codebase_memory_state',
  workflowId: string,
  attached: boolean,
  indexPath?: string,
  lastIndexedAt?: number,
  fileCount?: number,
}
```

### Peer tool inventory (not WS messages)

Model-facing tools registered on every cluster member (Native: in-process `server/src/providers/claude-native/peerTools.ts`; CLI Claude / Codex / Cursor: the arco-cluster MCP server, which calls the REST mirror `/api/clusters/:id/peer/<op>` in `server/src/http/clusterRoutes.ts` - `GET list`, `POST` for the rest, body carries the caller's `workflowId`). Tool results are strings; errors are `[error] <code>: <message>`. `blind` / `isolated` members get only `peer_send` / `peer_read`.

| Tool | REST op | Notes |
|---|---|---|
| `peer_list` / `peer_send` / `peer_read` | `list` / `send` / `read` | Mailbox substrate. `peer_send` uses the independent per-primary-turn message guard + 60 s dedupe; rejections emit `peer_send_rejected`. |
| `cluster_plan_read` / `cluster_plan_write` / `cluster_plan_tick` | `plan-read` / `plan-write` / `plan-tick` | See below. |
| `cluster_task_list` / `_show` / `_create` / `_claim` / `_heartbeat` / `_comment` / `_link` / `_unlink` / `_block` / `_update` / `_complete` | `task-list` ... `task-complete` | Board tools; absent (REST: rejected) when board mode is `none`. `cluster_task_complete` only works on a task the caller owns (`not_found` / `not_owner` otherwise), moves it to `review`, and appends a durable COMPLETION REPORT comment - it never marks `done` (operator-only). |

### `cluster_plan_read` (peer tool, not a WS message)

Read-only peer tool returning the full canonical plan (`{ title, body, updatedAt, byteLength }`, or `[error] no_plan:...`). Registered on every cluster member alongside the other plan tools. Added 2026-07-09: the per-turn injected plan copy is no longer guaranteed to be the whole plan on string-form transports - an over-budget plan is delivered as a deterministic OUTLINE (headings, checkbox lines, and labelled standing-directive sections; other prose omitted; header marks it as an outline) so the role hint / mailbox notice / code-mode addendum are never evicted (see `server/src/clusterStringFold.ts` + `clusterPlanOutline.ts`). CLI transports retain a 16 KB fold; Codex app-server uses a bounded 48 KB fold. This tool is the pull channel to the full body. No broadcast, no mailbox side effects. REST mirror: `POST /api/clusters/:id/peer/plan-read` with body `{ workflowId }`.

### `cluster_plan_write` (peer tool, not a WS message)

Worker-emitted peer tool (added 2026-05-11) that authors or rewrites the shared cluster plan body (markdown). By convention only the director calls it; other members propose plan changes via `peer_send`. Model-driven writes are **additive**: when a plan already exists the server rejects writes that remove existing checkbox tasks or change their `[ ]`/`[x]` status (`clusterPeerOps.ts`), routing status changes to `cluster_plan_tick` and destructive edits to the operator's PLAN tab. Body cannot be empty and is capped at 32768 chars. On success it broadcasts `cluster_plan_changed` cluster-wide. Registered on every cluster member (Native in-process + the arco-cluster MCP registry). If the injected plan copy is an outline (prose omitted on string-form transports), call `cluster_plan_read` first so a rewrite doesn't silently drop the prose.

### `cluster_plan_tick` (peer tool, not a WS message)

Worker-emitted peer tool that toggles a single `- [ ]` / `- [x]` checkbox in the shared cluster plan. Registered on every cluster member alongside `peer_list / peer_send / peer_read` (Native: in-process; CLI Claude / Codex MCP: via the arco-cluster MCP child + `POST /api/clusters/:id/peer/plan-tick`). Tool schema:

```ts
{
  // Anthropic input_schema - top-level `oneOf` is NOT permitted (returns
  // 400 invalid_request_error), so both fields are optional and the
  // dispatcher enforces exactly-one via the `invalid_matcher` error.
  lineIndex?: number,        // 0-based line offset in the plan body. Use only when the model read the plan itself and pulled a fresh line number this turn.
  taskText?: string,         // case-insensitive substring of the checkbox item text. Preferred - stable across plan edits.
}
```

Return shape on success: `{ toggledLine, before, after }` where `before`/`after` are `'[ ]'` or `'[x]'`. Errors return `[error] <code>: <message>` with codes `task_not_found` (no checkbox line contains `taskText`) / `ambiguous_task` (>1 match - returns `matches: number[]` alongside) / `not_a_checkbox_line` (`lineIndex` resolves to a non-checkbox line) / `out_of_range` / `invalid_matcher` (neither field provided, or both) / `no_plan` / `write_failed`.

On success: persists via `clusterPlanBridge.togglePlanItem(clusterId, lineIndex)` (canonical per-cwd plan) and broadcasts `cluster_plan_changed` cluster-wide so every member's PLAN tab + activity feed re-renders. The tick tool only mutates check state; the director can author/rewrite the body via the `cluster_plan_write` peer tool (additive - the server rejects model-driven writes that remove or re-status existing checkbox items), and the operator can replace/clear it from the PLAN tab.

REST surface for the MCP child: `POST /api/clusters/:id/peer/plan-tick` with body `{ workflowId, lineIndex? | taskText? }`. Server validates `workflowId` is a member, dispatches the same `peerPlanTick` call, and returns the same result/error shape. See `server/src/http/clusterRoutes.ts` (route) + `server/src/clusterPeerOps.ts` (dispatch).

---

## Cluster snapshots (2026-06-12)

Save / restore the full state of a live cluster - member configs, roles/tiers/focus, dispatcher + idle-nudger settings, plan body, and each member's full conversation history - to `~/.arco/cluster-snapshots/<id>/` (`manifest.json` + `members/<wfid>/{meta.json, events.jsonl}`). Server module: `server/src/clusterSnapshots.ts`; handlers in `server/src/ws/clusterHandlers.ts`; client store `client/src/stores/clusterSnapshotsStore.ts` + `SavedClustersList`. Smoke: `npm run smoke:cluster-snapshot`.

### `cluster_snapshot_save` ->

`{ type, clusterId, workflowId, name, replaceSnapshotId? }`. Operator-only;
`workflowId` must be a current member (`requester_not_member`). Refused while any member is
mid-turn (torn-final-line hazard - see GOTCHAS). Captures FULL member logs;
depth is chosen at restore time. A case-insensitive name collision replies
`cluster_snapshot_conflict { clusterId, requestedName, existing }`; only an
operator-confirmed retry carrying that exact `existing.id` may replace it.
Replacement builds a complete staging directory before atomically swapping the
old directory at its stable id. Success replies
`cluster_snapshot_saved { snapshot }` plus a refreshed
`cluster_snapshot_list`; other failures use
`cluster_snapshot_error { op: 'save', message }`.

### `cluster_snapshot_list` -> / <-

Request `{ type }`; reply `{ type, snapshots: ClusterSnapshotSummary[] }` (lightweight - no member bodies). Also pushed after save/delete.

### `cluster_snapshot_restore` ->

`{ type, snapshotId, targetCwd?, turnsPerMember? }`. Forks the snapshot into a brand-new cluster: new clusterId + member workflowIds, every embedded id remapped in the replayed events, fresh plan minted from the captured body. `turnsPerMember` (omit = full history) truncates each member to its last N turns; the restored copy is then compacted (text-delta coalescing, transient-row drops, latest-wins `task_ledger_snapshot`, 16 KB tool-string caps, newest-300 tool rows per member - see GOTCHAS snapshots; a real 58.9 MB 4-member snapshot restores as ~6 MB over the wire). Delivery order is load-bearing: `cluster_created` first (instant grouping), then per member a `workflow_created` followed by ONE `replay_batch { workflowId, events }` carrying its whole compacted history - atomic client ingest; streaming history as N live events is forbidden (see GOTCHAS snapshots, blank-workers bug). Provider-session resume is wired per transport: Native rebuilds context from the restored events.jsonl; claude CLI forks the captured session on same-cwd restores; codex resumes only when the original member is no longer live. Errors as `cluster_snapshot_error { op: 'restore', snapshotId, message }`.

### `cluster_snapshot_delete` ->

`{ type, snapshotId }`. Removes the snapshot dir; replies with a refreshed `cluster_snapshot_list`, or `cluster_snapshot_error { op: 'delete', ... }`.

### Portable file + encrypted cloud layer (2026-07-23)

Large snapshot bytes deliberately use HTTP rather than WebSocket messages. A
`.arcocluster` file is a gzip-compressed `ARCOCL01` regular-files-only
container with a declared SHA-256 and byte length for every entry. Import
verifies the complete container before `clusterSnapshots.importSnapshotFiles`
mints a new local snapshot id; no partial import is possible.

Cloud save wraps that verified bundle in an `ARCOCV01` AES-256-GCM envelope
using `~/.arco/cluster-vault.key`, then sends only the ciphertext to the
tailnet hub. The hub stores an opaque `.bin` plus bounded list metadata and
never receives the key. Cloud restore downloads/decrypts/imports locally, then
uses the unchanged `cluster_snapshot_restore` fork path above.

Cloud names follow the same conflict contract. A first same-name upload returns
HTTP 409; after operator confirmation,
`?replaceSnapshotId=<existing.id>` pins the exact existing hub id in
`X-Arco-Vault-Replace-Id`. The hub validates the id/name pair and updates
that row rather than creating a duplicate.

### Lost-tab recovery

`cluster_subscribe` for a missing server-side id returns the structured
`cluster_not_found { clusterId }` message. The client removes only that stale
local mirror, preventing a generic "Unknown cluster" toast on every reconnect.
This does not affect intact clusters: `GET /api/clusters` catalogs durable live
records, and `+NEW -> CLUSTER -> LIVE CLUSTERS ON THIS COMPUTER -> REOPEN` sends
the normal `cluster_subscribe` for the original id. Snapshot restore remains a
separate fork operation with new ids.

New snapshots capture each live member's full durable `WorkflowConfig`,
including client-only settings that do not round-trip through `meta.json`; older
snapshots fall back to the canonical `workflowConfigFromMeta` mapper. Restore
also preserves passive cluster configuration (efficiency/addendum, progress
mode, board mode, dispatcher limits). Operator-armed runtime state is
intentionally reset: REMOTE, remote gates, idle nudger, auto-turn, and
dispatcher execution remain OFF. The project tree, credentials, provider
session stores/resume pointers, transient creation tokens, mailboxes, and
task-board contents are not part of a cluster snapshot.
