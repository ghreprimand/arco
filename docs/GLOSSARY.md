# Arco - glossary

**Chat tab** - Projectless conversation (`kind:'chat'`, reaching workers as
`interactionMode:'chat'`), with a lightweight composer and no Agent workbench.
Claude, Codex, Cursor, Ollama, llama.cpp, LM Studio, Strata; not Gemini.
The per-tab **web toggle** (`chatWebAccess`, Claude/Codex/Ollama/Strata; decided by
`chatWebArmed()`) adds web search + fetch and nothing else. Saved chats reopen via
PAST CHATS. Not the same as Claude Native's `chat` tool posture. See [CHAT.md](CHAT.md).

**Incognito Chat** - Memory-only Chat with no Arco transcript/meta/operational
log/notification/browser persistence; attachments are refused and web defaults off.
Close, refresh or restart loses it. Provider retention remains provider-controlled;
Cursor, llama.cpp and Strata are excluded.

**Arco Classic / Arco Phosphor** - Separate theme families. Classic preserves
43 original selections; Phosphor generates 68 `phosphor:arco:<id>` variants from
the local Phosphor palette catalog. Palette, glow/effects, fonts and brightness are
independent. See [PHOSPHOR_DEMO.md](PHOSPHOR_DEMO.md).

Vocabulary used throughout the codebase and the rest of the docs. Sorted alphabetically.

---

**Activity feed** - Right-pane ACTIVITY tab. Live stream of `primary_tool_use` + `primary_thinking` deltas plus `primary_activity` (long-running background jobs). Capped at `MAX_ACTIVITY_ENTRIES = 500` per workflow.

**Agent** - Synonym for "primary." The single long-lived AI process that owns the conversation in a tab. Distinct from "worker" (short-lived sub-process spawned by a primitive).


**Arco Lite** - The current operator-driven architecture uses Review, Handoff, and Spawn primitives, with bounded, visible, logged, and reversible operator-armed automations. See [`PRIMITIVES.md`](PRIMITIVES.md) for the operator primitives and [`PROTOCOL_CLUSTER.md`](PROTOCOL_CLUSTER.md) for cluster roles and behavior.

**Artifact** - A markdown file written to disk by a primitive. Two flavors:
- **Review artifact** - `<cwd>/.arco/workflows/<wfid>/artifacts/review-<ts>.md` (YAML frontmatter + body)
- **Handoff artifact** - `<cwd>/.arco/workflows/<wfid>/handoffs/handoff-<ts>.md`

Also: **inline artifact** - fenced `arco-artifact` blocks the primary emits during chat; renders as inline-expand pills (`ArtifactPill.tsx`) and persists as `PrimaryArtifactMessage` events.

**Auto-handoff** - Configurable threshold (default 90% of context window) at which the workflow automatically generates a handoff document and rotates to a fresh session. Warning fires at a lower threshold (default 75%). Runs only for providers with a trusted context-fill signal: Claude CLI/Native, Codex (both transports, via the rollout snapshot), and Ollama.

**Broadcast** - Server-side fan-out of a server message to every observer of a workflow. `send(ws, message)` first persists the message to `events.jsonl` (if `workflowId` is set) then writes to every member of `wf.observers`. See also: **transient broadcast**.

**Busy** - Server-authoritative flag on `WorkflowState.busy`. True between `primary_turn_started` and `primary_turn_ended`. Mirrored to client `JobState.busy` and gates the composer's queue mode.

**Calibration** - Per-session ratio between byte-count token estimates and ground-truth `/context` output. Persisted on `WorkflowState.calibration` and `meta.json`. Fired on idle moments when a turn crosses an uncalibrated zone (E/A/B/C = 8-15% / 20-30% / 45-55% / 70-80%). See `server/src/contextCalibrator.ts`. Claude-only.

**cacheCreate** - `TokenUsage.cacheCreate`. Tokens written to the provider's prefix cache on this turn. Populated by Claude's `cache_creation_input_tokens`. **Codex never populates this** - its prefix cache reads land as `cacheRead` instead. See **ctx**.

**cacheRead** - `TokenUsage.cacheRead`. Tokens served from the provider's prefix cache on this turn. Populated by Claude's `cache_read_input_tokens` and Codex's `cached_input_tokens`. **Critical semantic difference between providers**: for **Claude**, `input`, `cacheRead`, and `cacheCreate` are disjoint and sum to the total prompt. For **Codex (OpenAI)**, `cached_input_tokens` is a SUBSET of `input_tokens` - `input_tokens` is already the full prompt, and `cached_input_tokens` is informational ("of those, this many were cached"). Adding the two for Codex double-counts the cached portion. See **ctx**.

**codexModelWindow** - `client/src/utils/format.ts:codexModelWindow(model)`. Final static fallback for the composer's `CTX: NN / NN NN%` denominator. TokensFooter first uses provider-reported `model_context_window`, then the selected account/model catalog under the tab's MAX/STANDARD policy, then this fallback. Astra's current MAX fallback is 828.4K effective; unknown models retain 272K. The dot flips ● (reported) vs ○ (estimate).

**modelContextWindow** - Provider-reported operational context window for the workflow's current model. Captured from Codex's `turn.completed` or `event_msg::token_count.info.model_context_window`, forwarded through `primary_complete.modelContextWindow -> JobState.modelContextWindow`. The honest source of the CTX-bar denominator on Codex tabs (the published "400K" for GPT-5.5 is misleading; Codex itself reports ~258K).

**reasoningOutput** - `TokenUsage.reasoningOutput`. Codex-only subset of `output` representing the model's hidden reasoning trace. High-effort GPT-5.x turns can put significant tokens here, and they roll forward into the next turn's prompt as the running thread accumulates - explains why Codex session ctx grows faster than visible chat would suggest.

**Capability detection** - `probeCapabilities()` runs each provider CLI's version probe at boot, every 4 hours, and on demand. Differences from the cached snapshot become `capabilities_changed` events surfaced as red-dot CONFIG indicators.

**CDP** - Chrome DevTools Protocol. Arco uses it for local browser preview capture.

**Claim** - A server-side reservation written to a task's run history when the dispatcher (or a worker's `cluster_task_claim` tool call) assigns a task to a member. A claim records `assignee`, `claimedAt`, and `runId`; the task status moves to `in_progress`. Recovery via `task_run_recover` can reclaim, terminate, reassign, or fail a stale claim. See `server/src/project/taskLedger.ts`.

**Cluster** - Operator-created group of N workflows that share a cwd and a peer-messaging substrate. The cluster's directory lives at `~/.arco/clusters/<clusterId>/`. No nested clusters; no cross-cluster messaging - both fences enforced at `clusterStore.createCluster`. See [`PROTOCOL_CLUSTER.md`](PROTOCOL_CLUSTER.md).

**Cluster plan** - Shared markdown brief attached to the cluster as a whole (distinct from the per-tab workflow plan). The cluster attaches one plan by `planId`; the body lives in the per-cwd plan store (`<cwd>/.arco/plans/<planId>.md`), accessed through `server/src/clusterPlanBridge.ts` (the legacy `~/.arco/clusters/<clusterId>/plan.md` / `clusterPlanStore.ts` is read-only and lazily migrated). Capped at 32 KB. On string-form transports an over-budget plan is folded as an outline (`clusterPlanOutline.ts`); `cluster_plan_read` returns the full body. Members can tick checkboxes via the `cluster_plan_tick` peer tool; model-driven `cluster_plan_write` calls are additive once a plan exists and cannot remove existing checkbox tasks or change their status. Edits broadcast `cluster_plan_changed` to all subscribers. Reviewed via `cluster-plan-whole` / `cluster-plan-phase` context-ref kinds. See `docs/PRIMITIVES.md section Cluster-plan-scoped review`.

**Code-skew banner** - H43 diagnostics signal (`server/src/diagnostics/codeSkew.ts`). The prod systemd unit serves compiled `dist/`, so on-disk source can drift ahead of the running build. `captureBootRev()` snapshots the git HEAD the build booted from; `classifyCodeSkew()` reports how many commits the live dist is behind on-disk HEAD and surfaces a banner (Diagnostics check `core.code-skew`) prompting a rebuild + restart. Dev (`tsx watch`) hot-reloads, so it reports as never stale.

**Composer** - The text input at the bottom of the chat panel. Owned by `TerminalInput.tsx`. Has two modes: idle (fresh prompt) and queue (interjection - when a primary turn is in flight).

**Config-value interpolation** - DD12 (`server/src/configValue.ts`). Lets the operator store a secret / base URL indirectly instead of pasting a literal: `!cmd args...` runs a command at resolve time and uses its stdout (e.g. a 1Password-backed key); `${ENV_VAR}` expands a process env var (`$$`->`$`, `$!`->`!` escapes); anything else is a literal. `describeConfigValue()` classifies the raw string for the `{ configured, source }` badge WITHOUT resolving (never touches the secret); `resolveConfigValue()` resolves only where needed. Resolved values are secrets - never logged (only the kind / env-var name). Backs the Ollama / LM Studio base URLs.

**Cwd** - Working directory. Each workflow is pinned to one cwd. All persistence (events.jsonl, meta.json, artifacts) lives under `<cwd>/.arco/workflows/<wfid>/`.

**ctx** - Context-fill number shown on the composer footer and per-worker badges. Provider-aware: **Claude** = `input + cacheCreate` (the three input flavours are disjoint, this sum matches the auto-compact threshold). **Codex** = just `input` - OpenAI's `input_tokens` IS the full prompt size; `cached_input_tokens` is a subset that's purely informational. Computed by `contextTokens(usage, provider?)` in `client/src/utils/format.ts`. Other providers fall back to the Claude shape (effectively `input` since they don't populate cache fields).

**Cursor** - Ninth provider (`server/src/providers/cursor/`). Talks to the `cursor-agent` CLI over the **Agent Client Protocol (ACP)** - a bidirectional JSON-RPC 2.0 stream where the agent sends mid-turn `fs/*` and `session/request_permission` requests the client must answer. Two transports: `acp` (default - a long-lived `cursor-agent acp` worker cached per workflow, warm across turns) and `print` (a stateless `cursor-agent -p --mode ask` one-shot, routed **only** when `config.sandbox === 'read-only'` so reviewer / fresh-summarizer / DOCS / research / compare primitives never hijack the operator's live ACP session). Effort is baked into the model id (`-low`/`-high`/`-xhigh`/`-max`), so the familyxeffort picker looks up an exact catalog id and the worker never synthesizes one; the Usage tab is dashboard-polled (ACP exposes no per-turn tokens). Cluster-eligible via an in-process loopback StreamableHTTP MCP server (ACP honors MCP over http/sse, not stdio). Badge **R**. See [`PROVIDERS.md`](PROVIDERS.md) and [`PROVIDERS.md`](PROVIDERS.md).

**DEBAG gate** (Durable Edit-Before-Approve Gate, `docs/PRIMITIVES.md`) - When **reviewSafeMode** is on and the model proposes a sensitive tool call (`GateCategory: 'bash' | 'git-destructive' | 'write-outside-cwd' | 'kill-shell'`; allowlist in `gateReview.ts`), the Native worker parks the turn (`pendingGates`) and emits `gate_required` (durable in events.jsonl + a `gateStore.ts` sidecar at `<cwd>/.arco/workflows/<wfid>/gate-approvals.json`, so a restart reconstructs pending gates). The operator resolves via the editable `GateApprovalNotice` card - `gate_reply` (`decision: 'approve' | 'reject'`, with an optionally edited `finalArgs`) or `gate_revoke`; resolution emits `gate_resolved` (carrying a `wasEdited` audit bit). A standing "approve all like this" (`gate_reply.remember`, honored only on an unedited approve) is keyed by the call's non-lossy signature and surfaced via `gate_standing` with revoke controls. Native-only v1. See **reviewSafeMode**.

**Director** - A cluster member whose role hint is `DIRECTOR` (one of the six canonical `clusterRolePresets`). By convention, the director owns the task graph: it creates and links tasks, assigns workers, monitors progress, and reads synthesis results. Arco enforces no machine-level distinction between a director and other members - the role is a human-readable label and a system-prompt hint. The director cannot set tasks `done` (operator-only fence). See `docs/PROTOCOL_CLUSTER.md`.

**Dispatcher** - The operator-armed server-side daemon (`server/src/taskDispatcher.ts`) that deterministically assigns `ready` tasks to idle cluster members. Two modes: `cluster_dispatch_once` (one-shot sweep) and an armed daemon (persistent, toggled via `cluster_dispatch_toggle`). Eligibility: task status `ready`, no open run at the per-member cap, matching member capability. Creates a claim + run before firing the synthetic worker turn. Default OFF; persisted in cluster meta; no double-dispatch on server restart.

**displayMessages** - Memoized array in `ChatPanel.tsx` that merges `job.sessionChat` (Claude JSONL) with `job.messages` (optimistic adds + streaming + system notices), dedupes user echoes within a 5-second proximity window, and sorts by timestamp. The render-side "what to show" computation.

**Efficiency level** - Per-cluster operator knob that fights cluster over-review loops. `ClusterEfficiencyLevel = 'thorough' | 'balanced' | 'lean'` (default `'thorough'`; `shared/src/protocol/clusters.ts`). `server/src/clusterEfficiency.ts` is the single source of truth: each level is a DETERMINISTIC bundle of three effects - a restraint doctrine injected into member system prompts, a smaller peer-send budget (15 -> 8 -> 4, `sendBudgetFor`), and a softer mailbox-notice variant (`mailboxNoticeVariantFor`). Set via the cluster header chip or the `+ NEW` creator; takes effect next turn; reversible. See [`PROTOCOL_CLUSTER.md`](PROTOCOL_CLUSTER.md) section13.

**Effort** - Reasoning-budget setting. Provider-specific: Claude has `low / medium / high / xhigh / max` (model-gated; ultracode forces `xhigh`); Codex is catalog-driven per model - values pass through 1:1 and clamp to the model's highest supported level (GPT-6 Astra / Sol reach `max` / `ultra`, Luna `max`); Cursor bakes effort into the model id; Ollama offers `low` (thinking off, `/no_think`) plus each model's advertised thinking levels (`/api/show` `thinking.values`; `shared/src/protocol/ollamaThinking.ts`); llama.cpp / LM Studio offer `low` / `high`, where `low` injects `/no_think`; Gemini have none.

**events.jsonl** - Per-workflow append-only NDJSON log at `<cwd>/.arco/workflows/<wfid>/events.jsonl`. Every server message broadcast to observers gets stamped with a monotonic seq and persisted here. The server-side source of truth for replay on reconnect.

**Fold** - Deterministic, model-free in-place transcript trim for Claude Native (section2.1). Replaces a folded prefix with a reproducible digest (task / files / cmds / searches / errors / open-todos via `buildFoldDigest`, `server/src/providers/claude-native/foldDigest.ts`) plus a verbatim recent tail bounded by a token budget (~20% of the window). Far cheaper than a Handoff - no model round, instant. Fired manually via the composer Fold button (`fold_workflow` WS message) or automatically when `autoFold` is enabled and the token-budget meter crosses `foldAt` (which sits below `autoHandoff.warnAt`). Emits `context_folded` (`trigger: 'operator' | 'auto'` + byte-delta fields for anti-thrash termination); re-seeds byte-identically on replay like `native_compacted`. Native-only. Config: `WorkflowConfig.autoFold = { enabled, foldAt }` (default OFF). See **token-budget meter**.

**Fresh-summarizer** - A handoff mode where an ephemeral worker reads a rendered transcript and writes the handoff doc, instead of asking the primary to self-reflect. Lower fidelity; used when the primary can't be resumed (Ollama).

**Ghost worker** - A primary worker process that has silently exited (e.g., crash, server restart mid-turn) without emitting `primary_turn_ended`. The server's `handleCancel` unconditionally broadcasts `turn_cancelled` + `primary_turn_ended` as the escape hatch - without it, the UI would stay stuck on busy forever.

**Heartbeat** - A `cluster_task_heartbeat` peer-tool call a worker makes during a long-running task to signal it is still active. Stored on the open run record as `lastHeartbeatAt`. The dispatcher's staleness detector flags runs whose heartbeat age exceeds the stale threshold, making them eligible for `task_run_recover`. Workers that complete without calling heartbeat are still finalized normally by `cluster_task_complete`.

**Handoff** - One of the three operator primitives. Rotates the current tab's session: the current primary writes a handoff document, the old session is archived in `meta.history[]`, and a fresh session is pre-warmed in the same tab with the handoff as its seed turn. See [`PRIMITIVES.md`](PRIMITIVES.md).

**Handoff seed** - The first user message in a handoff-rotated session. Carries the handoff body. Detected client-side by the `[HANDOFF -` prefix; collapses into a single `HANDOFF SEED  /  click to expand` pill instead of a 300-line bubble.

**Interjection** - A user message sent during an in-flight primary turn. Queued in `wf.pendingInterjections[]`; drained when the turn settles. Multiple interjections join with `\n\n` into one follow-up turn.

**JobState** - Per-workflow client-side state in the Zustand store. Keyed by workflowId. Holds chat messages, busy flag, workers, reviews, handoffs, lastSeq, calibration, etc. See [`CLIENT.md`](CLIENT.md).

**JSONL** - Newline-delimited JSON. The format Claude and Codex use for native session storage and streaming output. Also the format of `events.jsonl`.

**lastSeq** - The highest workflow-scoped seq the client has received. Persisted to localStorage and sent in `rehydrate_workflows` on reconnect so the server can stream missed events.

**Idle nudger** - Operator-armed per-cluster setting (default OFF). When a `peer_message_sent` lands and the recipient is idle, the nudger fires a toast notification to the operator; it does NOT send any prompt to the worker. Distinct from AUTO-PICKUP, which dispatches real turns. `server/src/clusterIdleNudger.ts`.

**Mailbox** - In cluster mode, the file-per-message store at `~/.arco/clusters/<clusterId>/mailbox/<recipientWorkflowId>/<msgId>.json`. One directory per recipient; `peer_send` writes one file atomically. The recipient worker calls `peer_read` to drain and receive the content (drain removes the file). `peer_message_received` events in events.jsonl are the durable record; mailbox files are ephemeral. Operator can cancel pending messages via the MAILBOX modal (calls `clusterMailbox.discard`). Cap: 16 KB per model-driven message, 32 KB for operator-sent transcript; 50 pending per recipient.

**Manager** - Synonym for `WorkerManager` instance. Per-workflow process supervisor. Tracks live workers, runs the activity probe, kills the tree on cancel.

**MD tune-up** (`md_tuneup_*`) - Operator-triggered primitive that PROPOSES a compacted rewrite of a project agent-instruction file (`CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md` / `GEMINI.md`; `INSTRUCTION_FILE_NAMES`). Opened from the composer `TUNE MD` button: `md_tuneup_candidates_request` lists the repo's instruction files, the operator picks one (or `'auto'` -> the file matching the tab's primary provider), and `md_tuneup_request` fires ONE bounded, READ-ONLY worker turn (no `Write` tool). The proposal returns as `md_tuneup_proposed`; the client previews an original-vs-proposed diff, and on Accept (`md_tuneup_accept`) the server backs the original up to `.arco/md-backups/<name>.<ts>.bak` before writing through the `resolveWithinCwd`-guarded path (reversible). Operator-reviewed - the opposite of the rejected autonomous `headroom learn` pattern. `server/src/primitives/runMdTuneup.ts`; protocol `shared/src/protocol/mdTuneup.ts`. See **Primitive**.

**Member** - A workflow that belongs to a cluster. Each member is otherwise a normal workflow (own events.jsonl, own meta.json, own primary turn machinery); the cluster registers `peer_*` tools into the member's tool list and notifies the member of pending mailbox messages via a pre-turn system-prompt notice (the content itself is only delivered when the worker calls `peer_read`).

**Meta** - `meta.json`. Per-workflow identity file. Atomic tmp+rename writes. See [`PERSISTENCE.md`](PERSISTENCE.md).

**North-star** - Per-tab operator-set persistent objective (`WorkflowConfig.goal`, byte-capped at `GOAL_MAX_BYTES = 2048`, `server/src/providers/goalBlock.ts`). `goalBlock(goal)` folds a small block into the stable per-turn prefix on every transport that folds the cluster plan - null-when-empty (zero extra tokens on the default path), with a load-bearing anti-autonomy trailer. Pure context, zero model authority: operator-only write, model read-only, no tool mutates it. Operator entry points: the CONFIG **NORTH STAR** field, the `/goal <text>` composer command, and the always-visible `NorthStarBar` chip above the composer. `update_primary_config { goal }` persists to `meta.json` then broadcasts **`goal_set { goal, byteLen }`** (persist-then-announce, reviewable in events.jsonl; empty string clears). Unlike **Output style**'s forced `'normal'`, all primitives (Review / Handoff / DOCS / GIT / Spawn / Task-child) **inherit** the goal. See [`TASK_LEDGER.md`](TASK_LEDGER.md).

**Observer** - A WebSocket connection subscribed to a workflow. Stored in `wf.observers: Set<WebSocket>`. Multiple browser tabs can observe the same workflow; broadcasts fan to all of them.

**Operator** - The human user. Distinct from "primary" (the AI agent) and "worker" (the sub-process). Arco's design rule: no hidden model authority. Actions are explicit operator clicks, operator-armed deterministic automations, or visible model-assisted proposals applied through explicit approval / bounded tools.

**Operator-only skill** - DD8. A skill whose `SKILL.md` frontmatter carries `operator-only: true` (`operatorOnly`, `server/src/skills.ts`) is OMITTED from the model-facing `<arco-skills>` manifest. The operator can explicitly **APPLY ONCE** (`pickedSkills` on `user_message`) or **PIN TO TAB** (`WorkflowConfig.pinnedSkills`, standing per-turn system block). See **Skills**.

**Orchestration assist** - Operator-armed ASSIST panel on the cluster BOARD tab (Stage K). The operator picks a mode (`task_graph / assignments / recovery / synthesis / swarm`) and fires a `cluster_orchestration_assist_request`. The server generates a draft proposal stored in `<cwd>/.arco/project/` via `orchestrationProposals.ts` and broadcasts it back. The client previews it in `orchestrationAssistStore`; the operator accepts selected items (applied through normal task-kernel APIs, emitting ordinary `task_ledger_event`s) or rejects (mutates nothing). Suggested provider/model/effort stay inert unless explicitly accepted. See **proposal**.

**OSV pre-check** - H21 supply-chain guard (`server/src/mcp/osvCheck.ts`). Before persisting an MCP registry entry that runs a package (`npx -y ...`, `uvx ...`), Arco queries OSV (osv.dev `querybatch`) and BLOCKS-WITH-OVERRIDE if the package carries a known-malicious `MAL-...` advisory - the operator must explicitly acknowledge to proceed. Fail-open (any network error / timeout / parse failure never blocks the add); malware-only (ordinary CVEs do not block - keyed strictly on the `MAL-` advisory prefix). See **MCP registry**.

**Output style** - Per-tab `WorkflowConfig.outputStyle` toggle (`'normal' | 'lite' | 'terse'`). Honored by Claude Native, Codex app-server by appending `outputStyleAddendum(level)` to the provider's stable prompt prefix. Persisted in `meta.json`. `'terse'` was previously exposed as `'caveman'` in operator-facing UI; legacy meta.json entries with `'caveman'` are auto-aliased to `'terse'` on read. Review / Handoff seed / DOCS / GIT primitives hard-code `'normal'` regardless of source tab. Spawn-from-here inherits. `server/src/providers/outputStyle.ts`.

**Original-worker mode** - A handoff mode where the primary that did the work self-reflects via `--resume <sessionId>` and writes the handoff doc itself. Highest fidelity. Default when the primary is resumable (Claude/Codex).

**Passthrough** - `phase: 'passthrough'` on chat messages. Indicates the message came from the primary worker's text stream (translated by `seedWorker.ts`). The other phase value is `'orchestrator'`, kept around for legacy reasons but unused in Lite.

**Peer message** - A short text note sent from one cluster member to another via `peer_send`. The `to` target resolves by workflow id/prefix, unique display-name exact/prefix, or unique role text (for example `Director` / `Coordinator`). Stored in the mailbox until the recipient calls `peer_read`; arrival is signalled by a pre-turn system-prompt notice ("You have N pending peer messages. Call `peer_read` to drain them."). `peer_message_received` events fire on the `peer_read` call, not pre-turn. Capped at 16 KB per model-driven send (32 KB for operator-driven transcript-send); 15 sends per sender per turn (plan section4 hard caps). Deduped by `(from, to, sha256(content))` within a 60s window to absorb orphan-tool-use retries.

**Peer tools** - Cluster tools registered into each cluster member's tool surface: `peer_list` (enumerate peers), `peer_send` (enqueue a message to a peer's mailbox), `peer_read` (drain and receive all pending messages from the mailbox), `cluster_plan_read` (read the full canonical plan when the injected copy is a truncated outline), `cluster_plan_tick` (toggle a checkbox in the shared cluster plan), and `cluster_plan_write` (director-authored additive plan write). On Claude Native, registered in-process; on CLI Claude and Codex, delivered via a per-spawn MCP stdio child (`--mcp-config` / `-c mcp_servers`) wired by `server/src/mcp/clusterMcpServer.ts`; on Ollama, exposed through the local server-side tool registry when the worker is a cluster member; on Cursor, served over an in-process loopback StreamableHTTP MCP server (`clusterMcpLoopback.ts`) since ACP honors MCP only over http/sse.

**Persisting / persisted** - Written to `events.jsonl`. Persisted messages survive server restart and are streamed to clients on reconnect. Non-persisted messages (e.g. `quota_status`, `context_usage`, `session_entry`) are derived state, broadcast transiently.

**Plan** - A long-form markdown brief stored at `<cwd>/.arco/plans/<planId>.md`. Operators attach a plan to a workflow (Plan tab); the body is prepended to the primary turn's prompt invisibly. Plans live in the cwd, not the workflow, so the same plan can be attached to multiple workflows.

**`/prompt` command** - DD10 operator-facing parameterized prompt template (`server/src/prompts.ts`), distinct from the model-facing **Skills**. Typing `/<name> args...` in the composer expands the body of a template file BEFORE the turn is recorded (so events.jsonl carries the real prompt, not the shorthand). Templates live at `<cwd>/.arco/prompts/<name>.md` (project - gated behind **project-trust**) or `~/.arco/prompts/<name>.md` (global - ungated). Bash-positional substitution: `$1`..`$9` / `${1}`.., `$@` / `$*` (all args space-joined), `$$` (literal `$`); args tokenized with shell-style quotes.

**Primary** - The single long-lived AI agent owning a tab's conversation. Synonym for "agent." Configured by `WorkflowConfig.primaryProvider/Model/Effort`. Distinct from "worker." The metadata fields were renamed from `orchestrator*` to `primary*`; `readMeta` carries a back-compat shim for older meta files, and `settings.ts` accepts the old `orchestratorProvider/Model/Effort` keys on read.

**Primary turn** - One operator-prompt -> one round-of-agent-work cycle. Bracketed by `primary_turn_started` / `primary_turn_ended`. Implemented by `runPrimaryTurn()` in `server/src/primitives/seedWorker.ts`.

**Primary session ID** - `WorkflowState.primarySessionId`. The CLI session UUID currently pinned to this workflow (Claude UUID or Codex thread_id). Cleared on Handoff so the next turn mints fresh.

**Primitive** - One of three operator-triggered server-side flows: Review, Handoff, Spawn. The "primary turn" is sometimes called a primitive too (it's `seedWorker.ts`), but in operator-facing language "primitive" usually means the three explicit-button flows. The DOCS and GIT composer buttons are operator surfaces but not full primitives - they ride the primary-turn machinery instead of spawning their own workers.

**Project-trust** - DD7 gate (`server/src/projectTrust.ts`) closing the cloned-repo prompt-injection vector. A repo's project-local surfaces that Arco would otherwise fold into the agent unread - `CLAUDE.md`, project `.arco/skills/`, project `.arco/settings.json`, project `/prompt` templates - stay SUPPRESSED until the operator vouches for the repo. `decideTrust()` is a pure read over a flat `trust.json` (nearest-ancestor wins); a two-pass bootstrap resolves trust from USER/GLOBAL scope only, so a cloned repo can't self-grant via its own `defaultProjectTrust`. The decision + suppressed-resource list land in events.jsonl; flipping/deleting the `trust.json` line reverses it.

**Provider** - One of the AI back-ends Arco talks to: Claude, Codex, Gemini, Ollama, llama.cpp, LM Studio, Cursor. Each has a module under `server/src/providers/`. (`ProviderName` in `shared/src/protocol/providers.ts`.)

**Plan-scoped review** - A review whose subject is a plan body instead of workflow transcript. Trigger surfaces in the Plan tab pair REVIEW (critique mode by default - audit the plan structure) with VERIFY (verify mode + INCLUDE GIT DIFF on by default - audit the claimed-done work against the changes) at both whole-plan and per-section granularity: `REVIEW PLAN` / `VERIFY WORK` (top), `▷ REVIEW PHASE PLAN` / `▷ VERIFY PHASE WORK` (per section), plus `CUSTOM REVIEW` (operator-selected items, verify mode). Either button's mode + git-diff stay editable in the resulting dialog. VERIFY mode filters items to `[x]` only and tells the reviewer to cross-check claims against the code; CRITIQUE mode shows everything with check state preserved and asks for plan-level evaluation. Implemented via `kind: 'plan-whole' | 'plan-phase' | 'plan-items'` on `ReviewContextRef`. See [`PRIMITIVES.md section Plan-scoped review`](PRIMITIVES.md).

**PlanReviewMode** - `'verify' | 'critique'`. Carried on plan-scoped `ReviewContextRef` variants. See **plan-scoped review**.

**Proposal** - A draft orchestration plan stored by `orchestrationProposals.ts` and held in `orchestrationAssistStore.byCluster`. Each proposal has an `id`, `kind` (`task_graph / assignments / recovery / synthesis / swarm`), `status` (`pending / applied / rejected`), and a `draft` body. Proposals are preview-only: accept-selected applies their content through normal task-kernel APIs; reject is a no-op on the task store. The live model-call hook is deferred - the server currently accepts the requester's provided `draft` as the proposal body.

**RUN AS picker** - Shared component (`RunAsPicker.tsx`) used by `GitDialog` and `DocsUpdateDialog`. Lets the operator override the current tab's primary provider/model/effort for the one-off prompt. If unchanged, the prompt dispatches in-tab. If changed, the dialog spawns a new tab with the picked config (via `spawnConfigFromRunAs`) and runs the work there, leaving the current chat alone.

**DOCS button** - `✎ DOCS` composer button. Opens `DocsUpdateDialog`, which sends a structured prompt to update repo markdown docs based on recent git activity. Excludes `.arco/plans/` (load-bearing reason: plan files have checkbox / H3 structure that the Plan tab parses for per-section review). See [`PRIMITIVES.md section DOCS and GIT one-off prompts`](PRIMITIVES.md).

**GIT button** - `⎇ GIT` composer button. Opens `GitDialog`, which combines a live `GET /api/git/status` view, branch dropdown + create form (server-side dirty-tree refusal on switch), action picker (commit / +push / +PR), protected-branch warnings, per-repo localStorage prefs, and a structured prompt builder. See [`PRIMITIVES.md section DOCS and GIT one-off prompts`](PRIMITIVES.md) and [`HTTP_API.md section Git operations`](HTTP_API.md).

**Protected branch** - A branch matched by `/^(main|master|release\/.*|prod|production)$/i`. The GIT button refuses to default to push+PR on these and bakes a "pause and confirm before pushing" instruction into the prompt.

**llama.cpp** - Sixth provider, alongside Ollama for local-model coding. Operator-managed GGUF catalog at `~/.arco/llamacpp.json` (alias -> `ggufPath` + `ctxSize` + `ngl` + capability flags). Singleton `llama-server` process owned by Arco (`llamacppManager`); switching aliases SIGTERMs the old and warms the new. OpenAI-compatible chat-completions endpoint with SSE streaming. Same tool-loop runtime as Ollama. In-place auto-recovery for reasoning runaway / stall / tool-cap / context fill so local conversations keep going. See [`PROVIDERS.md section llama.cpp`](PROVIDERS.md).

**llamacppManager** - `server/src/providers/llamacppManager.ts`. Singleton that owns the one long-lived `llama-server` child process for the llama.cpp provider. Tracks the active alias, handles SIGTERMs on alias switch, exposes `ensureRunning()` / `stop()` / `getPort()`. Version-mtime cache skips re-probing the binary when it hasn't changed; stale-orphan reaping kills any leftover `llama-server` pids from a prior crash.

**GGUF catalog** - `~/.arco/llamacpp.json`. Operator-maintained JSON map of alias -> `{ ggufPath, ctxSize, ngl, ... }`. Populated via the CONFIG tab's llama.cpp section or hand-edited. Arco reads it at boot and on `capabilities` refresh; each alias becomes a selectable model in the provider's model dropdown.

**LM Studio** - Seventh provider (`server/src/providers/lmstudio.ts`). Local-model coding via LM Studio's OpenAI-compatible HTTP endpoint (default `http://localhost:1234/v1`, base URL configurable), NOT the closed-source native SDK. Reuses the same tool-loop runtime + resilience layer as Ollama / llama.cpp. `effort: 'low'` maps to a no-think hint; other levels are ignored. See [`PROVIDERS.md`](PROVIDERS.md).

**Handoff prompts** - Operator-customizable prompt bodies for the two handoff modes. Project scope: `<cwd>/.arco/handoff.prompt.md` (original-worker) and `<cwd>/.arco/handoff.summarizer.prompt.md` (fresh-summarizer). Global scope: `~/.arco/handoff.prompt.md` / `~/.arco/handoff.summarizer.prompt.md`. If a project override exists it takes precedence; otherwise falls back to the global override, then to the built-in template. Managed by `server/src/handoffPrompts.ts`. The editor (`HandoffPromptsEditor.tsx`) warns when the `original-worker` body omits `{{handoffPath}}` or `[HANDOFF_COMPLETE]` - but saves are never blocked (advisory only). See `docs/GOTCHAS.md section Handoff prompt validation`.

**Local-reviewer addendum** - Extra prompt addendum (`LOCAL_REVIEWER_ADDENDUM` in `runReviewer.ts`) appended to the base review framing when the reviewer's provider is `ollama` or `llamacpp`. Tells the local reviewer to use its read-only tools (Read, Grep, Glob, WebSearch, WebFetch) to verify diff claims against the live tree, not just opine on the diff text. Verdict rule: PASS only if tools were used and nothing came back wrong. See [`PRIMITIVES.md section Local-reviewer addendum`](PRIMITIVES.md).

**Quota** - Per-provider throttle state tracked in `server/src/quota.ts`. Surfaced as `quota_status` events and the QuotaBadge in the UI. Detected from rate-limit responses; recovers automatically when `resetsAt` passes.

**Ready task** - A task in the `ready` status: all dependency parents are `done`, and no open run exists. The dispatcher treats `ready` as the only eligible status for automatic dispatch. A task at `blocked` (explicit operator block) or with unfinished parents is not eligible regardless of other fields.

**Recalibrate** - Operator-triggered context calibration via the `recalibrate_request` WS message. Bypasses zone gating. Click the CTX cluster in the tokens footer.

**Rehydrate** - On reconnect, the client sends `rehydrate_workflows` with each persisted workflow's `lastSeq`. Server replays events `> lastSeq` then sends a `workflow_state_snapshot`. If too much rotated off disk, fallback is snapshot-only.

**Replay** - Event stream from `events.jsonl` sent to a reconnecting client to reconstruct state. See `replayEvents()` in `server/src/workflowStore.ts`.

**Resume** - Two senses:
- **Resume picker** - UI surface (`WorkflowCreator`) listing native CLI sessions for a cwd; operator picks one to continue inside Arco
- **CLI resume** - Provider-specific: Claude `--resume <uuid>`, Codex `codex exec resume <uuid>` (app-server `thread/resume`), Gemini `-r <index>` re-resolved from the stored UUID each spawn, Cursor ACP `session/load`. Claude Native and the local HTTP providers replay from `events.jsonl` instead

**Review** - Two senses:
1. **(Primitive)** One of the three operator primitives. Spawns an ephemeral reviewer worker (any provider/model) over a turn slice; output is a read-only artifact in the right-pane Review tab. See [`PRIMITIVES.md`](PRIMITIVES.md).
2. **(Task status)** A task status meaning "worker believes the task is complete and is requesting operator or reviewer verification." Workers can move tasks to `review`; only the operator can move them to `done`. Distinct from the Review primitive.

**reviewSafeMode** - Per-tab `WorkflowConfig.reviewSafeMode = 'off' | 'on'` (default off, persisted to `meta.json`). Arms the **DEBAG gate**. Native-only; CLI / Codex ignore it.

**REWIND CONVERSATION** (conversation rewind / restore-point / leaf) - Native-first branch-aware history rewind (`docs/CHECKPOINTS.md`). The HISTORY-tab `REWIND CONVERSATION` button (two-click confirm) fires `revert_to_point_request`, which moves the live head to a chosen prior event, records a `leaf_move` event, and sets `meta.leafSeq`; the next turn forks a child of that point. Reversible - "undo the undo" is just another rewind. Branch-aware replay pre-pass: when `leafSeq` is absent, replay is byte-identical. Surfaced in the HISTORY-tab `REWINDS` sub-tab (event category `fork`) with fork markers. Rejected on CLI / Codex. (`branch_summary` is reserved/unemitted - forks ship via `leaf_move`.) Distinct from **Checkpoint** (shadow-git working-tree snapshot - files, not transcript).

**Run** - One attempt to execute a task. Created by the dispatcher (or a worker's `cluster_task_claim`) when a task is assigned; records `runId`, `assignee`, `claimedAt`, `lastHeartbeatAt`, and `outcome` (open / completed / failed / reclaimed). Multiple runs can accumulate over a task's lifetime (e.g., after recovery). The dispatcher's `maxOpenRuns` cap counts only runs whose `outcome` is still open. See `server/src/project/taskLedger.ts`.

**RSS guard** - `RSS_KILL_BYTES = 32 GB` per-process-tree memory cap enforced by `WorkerManager.startActivityPoll`. Per-workflow opt-out is available through `meta.disableRssGuard`; `ARCO_RSS_KILL_BYTES` overrides the cap. The guard bounds runaway worker memory use.

**Sandbox** - `WorkerConfig.sandbox` permissions level: `read-only` / `workspace-write` / `danger-full-access`. Codex-native; also load-bearing for Cursor - `read-only` is the exclusive signal that routes a Cursor turn to the stateless `cursor-agent -p` print path instead of the long-lived ACP worker. Reviewers force `read-only`.

**Seed** - The first user message in a fresh CLI session, used by Handoff and Spawn to inject context. See **handoff seed** / **spawn seed**.

**seq** - Per-workflow monotonic counter stamped on every persisted event. Allocated synchronously in `persistAndStampSeq()`. Drives lossless replay; gaps signal disk rotation.

**Session** (CLI session) - Native conversation state inside Claude or Codex, identified by a UUID. Stored at `~/.claude/projects/<cwd-hash>/<sessionId>.jsonl` (Claude CLI) or `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` (Codex). Arco pins one as `primarySessionId`; multiple may exist in `meta.cliSessions[]`. Claude Native writes **no** session JSONL - its history lives in `events.jsonl` and is replayed on restart; the session watcher and `/context` calibration are gated to the CLI transport (a stale CLI id on a Native tab once caused phantom bubbles, 2026-08-02).

**Settings cascade** - Three-layer read order: built-in defaults -> `~/.arco/settings.json` (global) -> `<cwd>/.arco/settings.json` (project). Deep-merge for nested objects; arrays replace. Managed by `server/src/settings.ts`. A project-level `settings.json` overrides specific keys (e.g., `defaultPrimaryProvider`) without touching the rest. Both files watched via `fs.watch` with 200ms debounce; updates broadcast `settings_changed` so live CONFIG tabs reflect the change. See `docs/OPERATIONS.md section Settings cascade`.

**Session entry** - `session_entry` WS message. A raw JSONL entry from the Claude session watcher. Not persisted (derived from the session file, which is the source of truth). Drives the `sessionChat` array client-side.

**Session watcher** - Chokidar file watcher on the active Claude session JSONL. Emits `session_entry` for each new line. Re-pinned on Handoff so the new session's writes surface.

**SeedWorker** - `server/src/primitives/seedWorker.ts`. The one and only primary-turn implementation; wraps the provider event stream into protocol messages.

**Skill audit** - H35 operator-triggered, read-only DIAGNOSTIC scan of a `SKILL.md` body (`server/src/skillAudit.ts`; `POST /api/skills/audit`; editor `AUDIT` button). Surfaces invisible-unicode and known threat-patterns as `AuditFinding`s (`severity: 'info' | 'warn'`). It deliberately does NOT gate install - there is no allow/deny verdict (a server-authoritative quality judgment is a non-goal); the operator reads the findings and decides.

**Skills** - Operator-defined reusable playbooks stored as `SKILL.md` files under `<cwd>/.arco/skills/<slug>/SKILL.md` (project scope) or `~/.arco/skills/<slug>/SKILL.md` (global scope). Frontmatter: `name` + `description` (+ optional `operator-only`). Each primary turn's system prompt includes a compact `<arco-skills>` XML manifest so an eligible agent can read a body on demand. `+SKILL` also supports explicit **APPLY ONCE** (full body in one turn) and **PIN TO TAB** (stable ref in meta; current full body re-injected every turn until removed). Operator-only skills are absent from automatic discovery but remain available to both explicit modes. section5.2 usage telemetry lives in `skill-usage.json`. Managed by `server/src/skills.ts`. See also: **toolbox** (provider-runtime-native catalog, deliberately separate).

**snapshotOnly** - Field on `workflow_state_snapshot`. True when events couldn't be replayed (rotated off disk). Tells the client to force-set its `lastSeq` to the server's head, accepting that some history is lost.

**Swarm** - A `cluster_swarm_create` shortcut that scaffolds a standard multi-agent task graph: one root blackboard task + N worker tasks + one verifier task (depends on all workers) + one synthesizer task (depends on verifier). Each layer's dependency chain enforces ordering without operator-managed sequencing. The resulting tasks are ordinary ledger tasks that the operator can edit, add to, or remove freely. See `docs/PROTOCOL_CLUSTER.md`.

**Spawn** - One of the three operator primitives. Forks the current conversation to a new tab. The current primary self-reflects on its session, writes a handoff document, and a new tab opens with that doc as its seed. Original tab continues in parallel. See [`PRIMITIVES.md`](PRIMITIVES.md).

**Spawn seed** - Like a handoff seed but for Spawn. Detected client-side by the `\n\n---\n\n(New direction|Acknowledge with "READY")` suffix; collapses into a `SPAWN SEED` pill.

**Stuck-worker breaker** - section3.1 cross-turn, cross-provider detector (`server/src/workers/stuckBreaker.ts`). Keyed on ERROR-PERSISTENCE, not action-pattern loops (the latter was falsified on real logs - a model legitimately re-runs the same shape of command). Signature `toolName | inputHash | outputHash` (the outputHash is the normalized/fuzzed hash from `server/src/providers/outputSignature.ts`); the same FAILING signature recurring with no success interleaved is the stuck signal. Escalation: streak >= DETECT_AT -> `'nudge'` (surface once, `worker_stuck` / `system_notice`); >= ESCALATE_AT -> `'pause'` (recommend a reversible pause, never a kill); a success or a different signature -> `'recovered'`. Fully deterministic (a counter, no model judges quality). Composes with the in-turn Native-only H9 tool-loop guardrail (`ARCO_TOOL_LOOP_GUARD`).

**SYNCING overlay** - Client-side gate. Fires when the WS is up but a persisted job hasn't received its `workflow_state_snapshot` yet. Cleared per-job on snapshot arrival.

**System notice** - `system_notice` WS message. In-chat alert (rate-limit warnings, calibration progress, context-fill warnings, etc.). Persisted.

**Tab** - Browser-tab-equivalent in the UI. One tab = one workflow. Persisted to localStorage; restored on page reload.

**Throttle** - See **quota**.

**Token-budget meter** - section2.3 Claude-Native context accounting (`server/src/providers/claude-native/contextBudget.ts`). Emits the transient `context_budget` event each turn - `usedTokens / windowSize / reservedOutput / effectiveWindow / pct`, plus `thresholds { warnAt, autoAt, foldAt }` and `crossed { warn, auto, fold }`. Unlike `context_usage` (percent of the RAW window, drives the CTX bar) the budget meter discounts reserved output tokens, and is the signal the Fold / auto-fold trigger reads. Native-only; not persisted (derived each turn from `lastPromptTokens`).

**Tool posture** - section4.1 posture-based toolset for Claude Native. `ToolPosture = 'full' | 'coding' | 'chat' | 'review'` (`shared/src/protocol/workflows.ts`, default `'full'`), a per-tab pill that filters the Native tool union down to the posture's bundle (source of truth `server/src/providers/claude-native/toolPosture.ts`). Set via `set_tool_posture`, acked by the persisted `tool_posture_set` broadcast (reviewable in events.jsonl). SESSION-LOCAL: stored on `WorkflowState.toolPosture`, never in `meta.json`; takes effect next turn. `'full'`/unset means no filtering. Native-only.

**Tool-result eviction** - section2.2 per-turn aggregate tool-result spill for Claude Native (`server/src/providers/claude-native/toolResultEviction.ts`). Operator-armed (off by default; `ARCO_TOOL_EVICT`). When a batch's summed tool-result tokens exceed the turn budget (`ARCO_TURN_TOOL_TOKEN_BUDGET`) it spills the largest results first, replacing each with a 1-line note; the raw output is gzipped under `.arco/workflows/<wfid>/artifacts/raw-tools/` and a `tool_evicted` event carries the byte counts + `rawArtifactPath` (fully reversible). Distinct from `tool_filtered`, which trims a single result in place via a configured filter pack.

**Tool use** - A primary or worker invoking a tool (Bash, Read, Grep, etc.). Surfaces in chat as inline `ToolCallPill` rows; full input visible on click. Every provider with tools emits `tool_use` events; Cursor's are mapped from ACP tool-call updates.

**Transient broadcast** - `broadcastTransient(workflowId, message)`. Fans to observers WITHOUT persisting to `events.jsonl`. Used for derived state like `session_entry` (already on disk in the JSONL) and ephemeral state like `context_usage`.

**Turn** - Synonym for "primary turn" in most contexts. Sometimes also "review turn" or "handoff turn" in primitive code.

**Ultracode** - Sticky per-tab mode (`WorkflowConfig.ultracode`, Claude-only, default OFF). At turn time it forces `claudeTransport = 'cli'` + xhigh effort + the CLI `Workflow` tool (the fan-out harness lives only in the `claude` binary, not Native's raw SDK) WITHOUT overwriting the stored transport - flipping it off restores the base transport. The harness spawns background subagents whose transcripts never reach the parent stream, so `server/src/ultracodeFleetWatcher.ts` polls the `<sessionId>/subagents/.../wf_*` run dirs (turn-scoped, deterministic, read-only) and emits the transient **`ultracode_fleet_progress`** snapshot (`total`/`running`/`done` + `agents[]`) - NOT persisted to events.jsonl (snapshot-replace, like `context_usage`). Surfaced in the ACTIVITY tab's `⚡ FLEET` panel and a composer fleet-count pill. Set via the CONFIG `ULTRACODE` toggle. See [`PROVIDERS.md`](PROVIDERS.md).

**WorkerManager** - Per-workflow process supervisor. One instance lives on `WorkflowState.manager`. Tracks live worker subprocesses, runs the `/proc`-based activity probe, kills the tree on cancel. Code in `server/src/workers/`.

**Worker** - A short-lived subprocess (or HTTP/CDP client) running one slice of work for a primitive. Distinct from "primary" (long-lived). Reviewers, summarizers, handoff reflections are all workers.

**Workflow** - Server-side: an entry in the in-memory workflows Map. Client-side: a `JobState` keyed by `workflowId`. Operator-side: a tab. All three names refer to the same thing seen from different layers.

**WorkflowState** - Server-side per-workflow record. See "Mental model" in [`ARCHITECTURE.md`](ARCHITECTURE.md).

**Wfid** - Short for `workflowId`. UUID. Used in URL paths and persisted directories.

**Worktree picker** - FilesTab control (`useWorktreeSelection` / `WorktreePicker`, `client/src/components/RightPanel/FilesTab.tsx`) that points the LIVE / CHANGES / SOURCE / REMOTE panels at the git worktree a worker (or cluster member) is actually editing rather than always the tab's base cwd. AUTO resolves the worker's active-task worktree from the store `taskLedger`, plus enumerates linked worktrees via `GET /api/git/worktrees?wfid=...` (`server/src/http/gitWorktreeRoutes.ts`, 200 with `{ isRepo:false, worktrees:[] }` in the non-git case). Uses the shared `WorktreeInfo` / `WorktreeListResponse` types (`shared/src/protocol/checkpoints.ts`).


**Zone** - Calibration zone. Bands E/A/B/C at 8-15% / 20-30% / 45-55% / 70-80% of context window. Calibration fires on the first turn that crosses into an uncalibrated zone.

---

**HISTORY tab** - right-pane tab. Read-only timeline of seq-stamped narrative events for the current workflow. Operator actions: LABEL THIS (`create_label_request` -> persisted `operator_label`), REVIEW FROM HERE (since-event Review), SPAWN FROM HERE (cutoff-aware Spawn). Filter strip persists per-workflow under `arco.historyFilter.byWorkflow`. See [`PRIMITIVES.md section 6 HISTORY-tab actions`](PRIMITIVES.md).

**operator_label** - Operator-pinned label (<= 200 chars) anchored to a prior event by its `seq`. Persisted to `events.jsonl` so labels survive replay. Append-only in v1; re-label freely.

**since-event Review** - `ReviewContextRef` variant with `kind: 'since-event'; anchorEventSeq: number`. Slices the transcript from `anchorEventSeq` onward. Wired from the HISTORY tab. Reviewer framing names the operator's label when the anchor is an `operator_label` event.

**cutoffEventSeq** - Field on `spawn_from_here_request`. Truncates the parent's transcript to events with `seq <= cutoffEventSeq` before rendering for fresh-summarizer / Native original-worker. CLI original-worker ignores it (`--resume` carries the full session).

**Task children** -. The Anthropic `Task` tool spawns a sub-agent in an isolated child workflow. Server-side: child is a first-class workflow with `parentWorkflowId` set on `meta.json` + `workflow_created`. Client-side: child renders scoped to its parent (inline `TaskCard` on the parent's `Task` tool_use row + a TASKS sub-tab; TabBar filters parented children where `!promoted`). Depth-1 only.

**task_started / task_status** - Lifecycle WS events broadcast on the **parent** workflow when a `Task` child spawns / settles. Re-broadcast on rehydrate regardless of `clientLastSeq` so refresh-after-settle doesn't pin the TaskCard at `0s  /  RUNNING` forever. Idempotent client-side actions (`recordTaskStarted` / `recordTaskStatus`) make re-broadcast safe.

**parentWorkflowId** - Field on `WorkflowMeta` + `WorkflowCreatedMessage`. Set when the workflow was minted by a Task tool call. Drives the TabBar parented-child filter.

**promoted** - Client-only flag on `JobState`. A parented child can be promoted into the top tab strip via the `PROMOTE` button on its TaskCard.

**Claude Native transport** - alternative to the CLI transport. In-process worker using `@anthropic-ai/sdk` directly with OAuth subscription auth + the Claude-Code wire fingerprint (pinned `CLAUDE_CLI_VERSION` in `wireFingerprint.ts`; bumped only when Anthropic rejects it for a new model). Request prefix is append-only - see **Append-only prefix**. Owns its own agent loop; reimplements the daily-use tool surface (Read / Edit / Write / Bash / Grep / Glob / KillShell / TodoWrite / EnterPlanMode / ExitPlanMode / AskUserQuestion / Task / TaskOutput). Per-tab toggle (`WorkflowConfig.claudeTransport`); cascade default in `settings.json`'s `claude.transport`. Reviewers and handoff seeds always run on CLI regardless. See [`PROVIDERS.md section Claude Native`](PROVIDERS.md).

**claudeTransport / codexTransport** - Per-tab transport overrides on `WorkflowConfig` + `meta.json`. Cascade defaults in `settings.json` (`claude.transport` / `codex.transport`). Ultracode forces `cli` at turn time without overwriting the stored value; Incognito forces Codex `exec` `native` the same way.

**clear_thinking / clear_tool_uses / compact** - Anthropic context-management edit types for Claude Native (`context_management.edits` array). `clear_thinking_20251015` strips prior thinking blocks; `clear_tool_uses_20250919` strips prior tool-use pairs. Native intentionally does not send those two clear edits by default because they can remove live web-search evidence before the model has integrated it. `compact_20260112` triggers server-side conversation compaction and is **off by default** - sent only when the tab's `claudeNativeCompact` is `true` (CONFIG SERVER-SIDE COMPACTION; new tabs seed from `settings.claudeNativeCompactDefault`). Gated on catalog capability flags (`supportsClearThinking`, `supportsClearToolUses`, `supportsCompact`). If clear edits are added behind a future explicit operator action, order is load-bearing: Anthropic rejects if `clear_thinking` isn't before `clear_tool_uses`. See `docs/PROVIDERS.md section Claude Native section Context management`.

**Plan-mode arming** - operator-initiated plan-mode entry (Native only). Inline checkbox above the composer arms `pendingPlanModeEntry`; the next `user_message` triggers an `enter_plan_mode_request` send-time-fire that sets `worker.planMode = true` at the start of `runTurn`. Single-turn - auto-clears on send.

**Live model catalog** -. `server/src/catalog.ts` polls `https://api.anthropic.com/v1/models` hourly, distills to the picker shape (capability flags + supported efforts), serves via `GET /api/claude-native/catalog`. The CONFIG-tab clickable model/effort picker reads from this; Native worker calls `getCachedModelCapabilities(modelId)` per request to gate context-management betas.

**Codex appserver transport** - alternative to `exec`. Long-lived `codex app-server` child per tab. Cancel is a structured `turn/interrupt` message; mid-turn steering uses `turn/steer` with `expectedTurnId`. Per-tab toggle (`WorkflowConfig.codexTransport`). Reviewers and handoff seeds always run on `exec`. Session storage at `~/.codex/sessions/`.

**Circuit breaker** (Codex appserver) - safeguard in `server/src/providers/codex-appserver/index.ts`. Counts consecutive `ensureStarted` / spawn failures; after N failures degrades the tab back to `exec` transport so one dead app-server process doesn't permanently block that tab. Resets on a successful turn completion.

**Role preset** - One of the six canonical cluster-member role hints (DIRECTOR / BUILDER / REVIEWER / RESEARCHER / TESTER / DOCUMENTER) defined in [`shared/src/clusterRolePresets.ts`](../shared/src/clusterRolePresets.ts). Operator picks via the `SET` popover on a `MemberRow`; written to `cluster_member_role_set` as the preset's body text. `presetForText` round-trips a stored body back to its preset id (used to highlight the active preset on EDIT and to label the `MemberCard` chip - free-form text labels as `CUSTOM`).

**ATTACH TO CLUSTER** - Third button on `PlanCandidateBanner` when the active workflow is a cluster member. Routes the plan candidate to the cluster's shared PLAN via `cluster_plan_set` instead of attaching to the worker's per-tab plan slot. See [`PRIMITIVES.md section Cluster-attached plan + role hints`](PRIMITIVES.md).

**BACK TO CLUSTER** - Button in `TerminalInput`'s status row, mounted only on cluster-member tabs. Switches the active top-level tab back to the parent cluster tab via `setActiveCluster(clusterId)`.

**AUTO-PICKUP** - Operator-armed per-cluster toggle (default OFF) in `ClusterRightPanel`'s header. When ON, the server-side detector (`server/src/clusterAutoTurn.ts`) fires a single synthetic primary turn on any idle recipient that gets a `peer_message_sent` - synthetic prompt `"(auto-pickup) New peer message arrived while you were idle - process your mailbox."` Three guards: 20s per-recipient cooldown, 10 fires per rolling 60s per cluster, chain-depth <=3 (all env-overridable via `ARCO_CLUSTER_AUTO_TURN_*`). Distinct from the idle nudger - the nudger is toast-only and never sends prompts to workers; AUTO-PICKUP dispatches real turns. See [`PROTOCOL_CLUSTER.md section13 (2026-05-11)`](PROTOCOL_CLUSTER.md) + [`PROTOCOL.md section cluster_auto_turn_toggle`](PROTOCOL.md).

**NUDGE modal** - Operator-driven canned-prompt fan-out. Click NUDGE in the cluster broadcast composer -> modal with per-member checkbox list (default empty - operator must pick) -> SEND NUDGE fires the canned `"(nudge) Check your mailbox for any pending peer messages and continue with your assignment."` at the picked members. Rides on the same `cluster_broadcast` wire shape with `recipientWorkflowIds`. Modal shows role chip + mailbox depth + BUSY badge per member. Distinct from the chip-row recipient picker above the broadcast textarea (which targets typed prompts).

**chainDepth** - Optional field on `peer_message_sent` (server-stamped, never sent by clients) carrying the in-flight auto-turn depth at the sender. Operator-initiated sends ride at 0; AUTO-PICKUP fires set `markAutoTurnDepth(recipient, parentDepth + 1)` before dispatch and the broadcast hook stamps subsequent peer_sends from that recipient's turn at the elevated depth. Cleared on `primary_turn_ended`. Drives the chain-depth guard on AUTO-PICKUP.

**`cluster_plan_read`** - Read-only peer tool returning the full canonical cluster plan (`{ title, body, updatedAt, byteLength }`). Added 2026-07-09: on string-form transports an over-budget plan is injected as a deterministic outline (headings, checkbox lines, and labelled standing-directive sections), so this is the pull channel to the full body. REST mirror: `POST /api/clusters/:id/peer/plan-read`.

**`cluster_plan_tick`** - Peer tool registered alongside `peer_list / peer_send / peer_read / cluster_plan_read`. Toggles a single `- [ ]` / `- [x]` checkbox in the shared cluster plan. Matches by `taskText` (preferred - case-insensitive substring, stable across edits) or `lineIndex` (0-based, must be read this turn). Errors: `task_not_found / ambiguous_task / not_a_checkbox_line / out_of_range / invalid_matcher / no_plan / write_failed`. On success broadcasts `cluster_plan_changed`. Mirror REST endpoint at `POST /api/clusters/:id/peer/plan-tick` for CLI Claude + Codex MCP children. Schema constraint: top-level `oneOf` is rejected by Anthropic - both fields are optional in the schema; dispatcher enforces exactly-one via `invalid_matcher`.

**`cluster_plan_write`** - Director-side peer tool for writing the shared cluster plan. Empty bodies and >32 KB bodies are rejected. If a plan already exists, model-driven writes must preserve every existing checkbox task and its `[ ]` / `[x]` state; removing items or changing status returns `destructive_write_requires_operator`. Operators can still replace or clear the full plan from the PLAN tab.

**Code-mode** - OpenAI's catalog-marked multi-agent harness, used by gpt-5.6 sol/terra/luna and the GPT-6 family (astra / sol / luna), where the model is `/root` with native `spawn_agent`/`send_message` tools and its tool surface becomes a JS `exec` cell. Arco's cluster MCP tools still exist but appear under mangled `tools.mcp__arco_cluster__<tool>` names inside the exec cell. `codexModelUsesCodeMode()` (`server/src/providers/codexCodeMode.ts`) detects it catalog-driven (reads `$CODEX_HOME/models_cache.json` `tool_mode`/`multi_agent_version`, not a name regex); when matched, `codexCodeModeClusterAddendum()` folds a block naming the real tool forms so a member doesn't ignore the peer substrate. Codex app-server repeats the assigned Arco role and Director contract through `developerInstructions`. Incident: `docs/CODEX_GPT56_CLUSTER_INCOMPAT.md`.

**Cluster-plan review** - Plan-scoped Review where the body comes from `clusterPlanBridge.readClusterPlan(clusterId)` instead of `readPlan(cwd, planId)`. ContextRef kinds: `cluster-plan-whole` + `cluster-plan-phase` (no per-item variant for the cluster body). The `workflowId` on the review request names the worker that runs the review (picked via `ClusterMemberPicker` from the cluster plan tab); `clusterId` names the plan body. Content builder: `buildClusterPlanReviewContent` in `server/src/primitives/reviewContent.ts`. See [`PRIMITIVES.md section Cluster-plan-scoped review`](PRIMITIVES.md).

**Observer attach on cluster_subscribe** - Server-side bookkeeping: when a WS sends `cluster_subscribe`, the server adds it to every member workflow's `wf.observers` set so per-member events (`primary_tool_use`, `primary_thinking`, etc.) reach the cluster tab without the operator pre-opening each member tab. Tracked in `Session.clusterObserved: Map<clusterId, Set<workflowId>>`; symmetric detach on unsubscribe / member-remove / cluster-delete. Preserves observer entries added from other sources (explicit tab subscribe, parallel cluster subscriber on a shared member).

**`PlanBodyRenderer`** - Shared rich-plan renderer (`client/src/components/PlanBodyRenderer.tsx`) extracted from `RightPanel.tsx`'s inline `PlanBody`. Renders H1/H2/H3 styling, clickable `- [ ]` / `- [x]` checkboxes (optimistic toggle), per-H3 action pill rows. Used by both the per-worker PLAN tab and `ClusterPlanTab.tsx`. Exports `CHECKBOX_RE` for line-parsing reuse.

**Plan candidate detection fallback** - `useWebSocket.ts` `primary_complete` handler (`phase: 'passthrough'`) auto-sets `planCandidate` to review mode when `pendingPlanCapture` is unset AND the reply matches H1 + >=3 markdown checkbox lines. Catches free-form plan asks (operator didn't click PLAN) and page-reload-mid-turn races. Operator can DISCARD on false positives.

**Per-member rename** - `rename_workflow` WS message persists a 64-char-capped friendly name to `meta.json`. `ClusterMember.displayName` resolves to `wf.config.name?.trim() || workflowId.slice(0, 8)`; empty rename reverts to the wfid 8-char prefix. Surfaced by the pencil affordance in the Members sub-tab and consumed by every `MemberCard` / bottom-row tab. See [`PROTOCOL.md section rename_workflow`](PROTOCOL.md).

**Tool-driven peer mailbox** (2026-05-11) - Workers no longer get peer messages auto-injected pre-turn. `handleUserMessage` peeks `clusterMailbox.depthFor` and folds a short notice into `appendSystemPrompt` ("You have N pending peer messages. Call the `peer_read` tool to drain and read them. ..."); the worker MUST call `peer_read` to actually receive content. `peer_message_received` events fire on the `peer_read` call (where they belong). Removes the false-negative where `peer_read` returned empty after pre-turn drain had already consumed the files, and the model conflated "I have nothing to read" with "I have no work to do." See [`GOTCHAS.md section Cluster-polish push gotchas`](GOTCHAS.md) and [`PROTOCOL_CLUSTER.md section13 (2026-05-11 afternoon)`](PROTOCOL_CLUSTER.md).

**Operator transcript-send** (2026-05-11) - Operator-driven peer-substrate surface. The `-> TRANSCRIPT` composer button on a cluster member tab opens `TranscriptSendDialog`; operator picks recipient + scope (Last turn / Last N turns / Full transcript); client fires `operator_peer_send` WS message; server dispatches `clusterPeerOps.peerSend` with `{ bypassBudget: true, bypassDedupe: true, maxContentBytes: 32_768 }`. Recipient sees a normal `peer_message_sent` on the chosen sender's channel - no different from a model-driven `peer_send`. The slicer filters rendering noise (ctx-divider, tool pills, single-line metadata system pills) but keeps substantive multi-line system content (inlined review bodies). Intended flow: forward reviewer findings (or any chat slice) from one cluster member to another. See [`PRIMITIVES.md section Operator transcript-send`](PRIMITIVES.md).

**Sub-worker reviewer** (Review primitive default) - The original Review primitive: spawns a one-shot disposable subprocess via `runReviewer`, writes a `.md` artifact to `<cwd>/.arco/workflows/<wfid>/reviews/`, emits `review_started` + `review_artifact_ready`, surfaces in the per-workflow REVIEWS tab + cluster REVIEWS tab. Picked via `SUB-WORKER` pill in `ReviewDialog`'s STEP 2 row (default).

**Member reviewer** / **Cluster-routed review** (2026-05-11) - Alternative dispatch path picked via the STEP 2 row in `ReviewDialog` when opened from a cluster member's pane. Operator picks a cluster peer instead of a fresh sub-worker; `App.tsx -> buildClusterReviewTask` assembles a directive-styled task (with mode-specific prompts for VERIFY WORK vs CRITIQUE PLAN); dispatch uses `sendMessage` (NOT `operator_peer_send`) so the reviewer starts a turn immediately. No `.md` artifact, no `review_started` event - findings live in the reviewer's chat + activity feed. Operator forwards findings via `-> TRANSCRIPT`; the task explicitly tells the reviewer NOT to auto-route. See [`PRIMITIVES.md section Cluster-routed reviews`](PRIMITIVES.md).

---

**Compare** - Operator-initiated bounded multi-provider answer race. One prompt fans out to N independent read-only legs, each its own `{provider, model, effort}`, spawned fresh with no shared session; answers stream into per-leg panes (`client/src/components/compare/`). Optionally **blind** - provider/model labels hidden until the operator votes. No hidden routing and no LLM-judges-the-winner step. Protocol in `shared/src/protocol/compare.ts`.

**Deep Research** - Operator-initiated bounded research primitive. Spawns one short-lived worker with read-only local tools plus the provider's native web-search/web-fetch path, prompted to plan -> search -> read -> synthesize a cited markdown report inside one bounded agentic turn. Output persists as a `research-<ts>.md` artifact in the RESEARCH tab (`ResearchDialog.tsx`). No second-LLM synthesis, no "is it done?" judge. Protocol in `shared/src/protocol/research.ts`.

**Checkpoint** - Shadow-git working-tree snapshot taken before a file-mutating operator turn, so the operator can undo-the-agent independent of real git history (`server/src/gitSnapshots.ts`). In a git repo it uses a separate `GIT_INDEX_FILE` + `write-tree`/`commit-tree` to store a parentless commit at `refs/arco/<wfid>/<seq>` - the user's `git status` is byte-identical before and after. Non-git workspaces fall back to a shadow bare repo under `~/.arco/checkpoints/<cwd-hash>/git` (size-capped - see `docs/CHECKPOINTS.md`; legacy tar checkpoints in the same store stay revertible). WS messages `checkpoint_created` / `revert_to_checkpoint` / `checkpoint_reverted`. The model never sees checkpoints - pure operator infrastructure.

**Recall** - Machine-global cross-cwd index of every workflow ever run, stored in SQLite at `~/.arco/recall/recall.db` (`server/src/recall/`). A rebuildable deterministic projection of `meta.json` + `events.jsonl` - delete the DB and the next backfill reconstructs it. F2 adds operator-triggered (or operator-armed-on-close) conversation **summaries** written to `~/.arco/recall/<wfid>/summary.md`, with a deterministic structural-digest fallback so the LLM path never fails closed; F3 adds FTS5 full-text search over titles/summaries/transcripts. No LLM in the per-turn loop.

**ARCHIVE** - Standalone chromeless project-artifact browser window (`?app=explorer`; `client/src/explorer/`, opened via the `⌸ ARCHIVE` header button). Three lenses: ARTIFACTS (per-project cards + a recent-across-all-projects strip, joined server-side by `explorerArtifacts.ts`), RECENTS (the agent-writes ledger + an exhaustive changed-within scan `explorerChanged.ts`), and TREE. Backed by `GET /api/explorer/{open,artifacts,docs,recents,changed}` (`server/src/http/explorerRoutes.ts`) - read-only except `open`, every listing $HOME-jailed and fail-soft (always 200, empty collection on error). Read-only, zero model authority. See [`CHECKPOINTS.md`](CHECKPOINTS.md).

**recent-files ledger** - Append-only NDJSON at `~/.arco/recent-files.jsonl` (`server/src/recentFilesLedger.ts`; env-overridable `ARCO_RECENT_FILES_LEDGER`). Records `{ ts, path, op: 'created'|'modified', workflowId, tabTitle, provider, tool, project? }`; compacted in place past `MAX_LINES = 1000` -> newest `KEEP_LINES = 500` via tmp+rename. Fed from the persisting broadcast chokepoints (`recordFilesLedger` in `broadcast.ts` matches `primary_tool_use` Write/Edit/NotebookEdit + `review_artifact_ready` + media ops) and by manual `POST /api/files/write`. Advisory / best-effort - `appendRecord` swallows its own errors so a write failure never breaks a broadcast. Read newest-first by `readRecent()` for the ARCHIVE RECENTS lens.

**Knowledge base** - Per-cwd operator-owned KB under `<cwd>/.arco/knowledge/` (`index.json` + `<id>.md` bodies; `server/src/knowledge/`). Articles carry `tags` + an `alwaysInclude` flag (those bodies are injected into the turn prompt up to `KNOWLEDGE_INJECT_BUDGET`). Pure operator-driven CRUD - no agent write path. The wizard's "distill from session" produces a DRAFT the operator edits and saves through the same manual create/update path.

**Cookbook** - Read-only, fit-scored catalog of local-LLM candidates for the Ollama / llama.cpp providers (`server/src/cookbook/`, `client/src/components/Cookbook/`). Crosses two sources - the live Hugging Face Hub GGUF API and a bundled, in-repo curated Ollama-library manifest - against a deterministic hardware fit score (`scoreFit`, gated on a cached `nvidia-smi` probe). Search only; download/pull/register is a separate later phase.

**Genesis** - Idea-to-build-direction ladder (`server/src/genesis/`). A compressed 4-rung stage ladder - Spark -> Concept -> The Case -> Build-direction (`GenesisStage`) - with one primary narrative field per rung and non-blocking advisory readiness checks. The operator drives stage transitions; Genesis never gates a turn on readiness. The prompts module folds the staged system block into the turn.

**LSP integration** - Per-language Language Server Protocol client (`server/src/lsp/`) that resolves a server command from a file extension via a cross-platform PATH lookup, used to surface diagnostics. Bring-your-own-upstream: when no candidate resolves the caller no-ops. TS diagnostics need `typescript-language-server` on PATH (bare `tsserver` speaks TSServer, not LSP, so it's deliberately excluded).

**MCP registry** - Global operator-curated registry of MCP server definitions at `~/.arco/mcp/registry.json` (`server/src/mcp/registry.ts`). Per-workflow enablement + dangerous-tool ticks live in `meta.json` (`mcpAllow`), keyed by `serverId`. A dependency-free stdio JSON-RPC client (`server/src/mcp/client.ts`) lets a worker act as an MCP host. `env` values are secret-bearing - persisted but never logged. Distinct from `clusterMcpServer.ts` (which serves the `peer_*` tools to CLI/Codex cluster members).

**Diagnostics** - Operator-triggered, read-only machine self-test behind `GET /api/diagnostics` (`server/src/diagnostics/`), surfaced in the DIAGNOSTICS tab. Each check is a deterministic probe of one moving part (six groups: Core / Providers / Local Tools / Workbench / Storage / Security & Exposure). **Support bundle** (`supportBundle.ts`) produces a paste-ready, allowlist-redacted snapshot of the diagnostics report + version + git rev + platform for issue reports.

**Task kernel** - The set of server-side primitives that underpin durable cwd-scoped task management: the task store (`taskLedger.ts`), status machine (triage -> todo -> ready -> in_progress -> blocked / review -> done / archived), dependency system (a child stays `todo` until all parents are `done`), comment threads, run/attempt history, and the `done` / `archived` operator-only gate. Exposed to workers via peer tools (`cluster_task_show / create / link / unlink / comment / heartbeat / block / complete`) and the existing `list / claim / update` aliases. Protocol: `shared/src/protocol/tasks.ts`. See `docs/TASK_LEDGER.md`.

**Task board** (cluster kanban) - client-only kanban VIEW over the cwd-scoped task ledger (`server/src/clusterPeerOps.ts`). New clusters default-attach a project board (`taskBoardMode: 'project'`; `ClusterTaskBoardMode = 'none' | 'project' | 'cluster'` in `shared/src/protocol/clusters.ts`; toggled via `cluster_task_board_mode_set` / `cluster_task_board_attach_set`, `normalizeTaskBoardMode` the source of truth). Horizontal kanban columns with dnd-kit drag-to-restatus (4px activation; done/archived require a confirm) + TouchSensor touch-drag; a create-task composer (always `todo`); an editable card drawer (title / notes / priority / deps / delete); a plan->task bridge (`PlanBodyRenderer onPromoteTask`) and a peer->task bridge (`MailboxModal onMakeTask`, board-attached only) plus promote-a-delivered-peer-message-in-transcript; and a collapsed AUTOMATION header (dispatch-once / dispatcher / swarm / draft-assist, default closed). Distinct from the **Task ledger** (the durable backing store) and the per-tab **Plan** brief.

**Task ledger** - Durable, cwd-scoped task-kernel snapshot at `<cwd>/.arco/project/tasks.json` (`server/src/project/taskLedger.ts`), a rebuildable projection over `events.jsonl` (each mutation appends a `task_ledger_event`). The snapshot is versioned (`{ version, tasks }`) while legacy `{ tasks }` caches still load. Statuses are `triage / todo / ready / in_progress / blocked / review / done / archived`; `done` and `archived` may only be set by an explicit operator-originated update. Tasks may carry a server-set `worktree` pointer and an operator-set `worktreeRequired` flag; automated dispatch skips required tasks unless a worktree already exists or dispatcher `autoWorktree` is explicitly armed. Distinct from the Plan tab (per-cwd markdown brief) and the Tasks panel (in-turn `Task` subagent children) - the ledger is the persistent cross-session backbone. Protocol in `shared/src/protocol/tasks.ts`.

**Local services** - Read-only local-service discovery behind `GET /api/services` (`server/src/services/discover.ts`, SERVICES tab). Enumerates listening TCP sockets via `lsof` and resolves each to its process / cwd / framework (ported from LocalWebManager). Cross-platform (Linux + macOS); no kill or mutation in the discovery layer.

**Terminal** - Operator-only PTY session pool (`server/src/terminal/`). A session is a long-lived `node-pty` child that outlives any window or WS connection; the floating terminal window is just a view that attaches/detaches a data listener. Only an explicit Kill (or workflow-close / shutdown teardown) reaps the shell. The raw byte stream rides a dedicated `/terminal` WS path - not `events.jsonl`. HARD FENCE: the PTY is never registered as a model-callable tool.

**Notification hub** - Server-side chokepoint (`server/src/notifications.ts`) that mints + broadcasts `WorkbenchNotice` events from every source (turn-finished, quota-recovered, ...) through one `emit()`. Per-category mute is applied server-side and persisted to `~/.arco/notification-mutes.json` so it survives restart. In-app surfaces: `NotificationCenter.tsx` + toasts. Inform-only - the only inbound client message is `set_notification_mutes`.

**ntfy transport** - Optional external notification sink (`server/src/ntfyTransport.ts`). INERT unless `ARCO_NTFY_URL` is set; when configured it registers a fire-and-forget sink at the notification-hub chokepoint that POSTs each surviving notice to an ntfy topic. A prompt channel, not a command channel - nothing inbound is ever read.

**Remote management** - The live Arco service's outbound link to a management hub (`server/src/management/`, `docs/REMOTE_MANAGEMENT.md`). `hubLink.ts` reports a live Arco's workflow + pending-request state and applies routed reply/stop/continue actions, registering with role `service`. Distinct from the lifecycle agent (`scripts/agent`), which restarts a *dead* Arco and registers with role `agent`; one machine runs both, merged by `instanceId`. Gated on `ARCO_HUB_URL`.

**Append-only prefix** - Claude Native request-shape rule (`server/src/providers/claude-native/appendOnlyPrefix.ts`, [`PERSISTENCE.md`](PERSISTENCE.md)). `system` + `tools` freeze on the worker's first request; later config changes (north star, output style, cluster plan, posture, plan mode, MCP attach) are appended `role:'system'` messages, and thinking blocks persist across turns. Binding-enforcing models (`enforcesPreservedThinking()`: Fable 5.1, Mythos 5.1, Opus 5.5) 400 on an edited prefix; for the rest it keeps the prompt cache alive. Every prefix mutation is a `ctx_action` in `events.jsonl`.

**Codex context policy** - Per-tab `WorkflowConfig.codexContextPolicy = 'max' | 'standard'` (absent => MAX). MAX passes the selected account/model's `max_context_window` from `$CODEX_HOME/models_cache.json` as `-c model_context_window=<n>` on both transports; STANDARD omits it. Resolver: `server/src/providers/codexContextWindow.ts`; fails safe to Codex's default on missing metadata.

**Goal run** - Per-tab operator-armed north-star auto-continue (`WorkflowConfig.goalRun`, default OFF; `/goal run <n>`, n <= 500, default 10). After each settled turn `maybeGoalRun` dispatches one deterministic continuation turn until the budget is spent or a stop trips (turn error, throttle, context >=92%, north star cleared, optional token ceiling). Busy/queued is a skip, not a stop. Every tick is a real turn + `goal_run_state`; the `RUN n/N` chip stops it. Counters are not persisted - a restart ends the run. A model signal may shorten a run, never extend one. `server/src/goalRun.ts`; [`TASK_LEDGER.md`](TASK_LEDGER.md).

**Gemini Native (stub)** - Planned in-process Gemini worker (`docs/PROVIDERS.md`). NOT shipped: only `server/src/providers/gemini-native/auth.ts` + `catalog.ts` exist (the catalog is prefetched for the picker); there is no worker and no `geminiTransport` toggle. Gemini today runs only through the `cli` transport.


**MoE / routed expert** - Mixture of experts: each token selects a subset of
expert weights for computation. In the prepared Strata setup, hot weights can
live on the GPU, a bounded complement in RAM, and remaining experts in files.
Sparse computation does not mean the unselected weights can be deleted.

**PLE / n-gram table** - Learned lookup table stored in Flash Next's second
GGUF shard. The prepared Strata profiles read it from NVMe. Separate from the
expert cache, conversation KV, and external retrieval.

**Resident KV working set** - KV cells kept on the GPU while the authoritative
cache lives in host RAM. Strata's 32768 resident cells do not shorten its
262144-token conversation window. Tool-result text caps are a third independent
limit. See [STRATA.md](STRATA.md).

**Strata profile** - Operator-prepared weights, native pack, tokenizer, encoder
and memory-limited user service registered in `~/.arco/strata-profiles.json`.
A tab's selection loads on its next message; one profile is resident at a time.
Distinct from an Ollama model alias. See [STRATA.md](STRATA.md).
