# Operator actions

Everything Arco does reduces to explicit operator surfaces. The core ones:

| Action | What it does |
|---|---|
| **New project** | Opens a tab. The workflow creator opens a tab for the selected cwd, provider, model, effort, and tool allowlist. |
| **Resume** | Lists existing native CLI sessions for the current cwd (`~/.claude/projects/...`, `~/.codex/sessions/...`). The selected session continues inside Arco. |
| **Review** | Spawns an ephemeral reviewer (any provider/model) over the last turn or a plan slice. Output is a read-only artifact in the right pane. |
| **Compare** | Races one prompt across N providers/models; the operator votes for a winner in the overlay. |
| **Research** | Runs one bounded web-research turn; produces a cited markdown report in the RESEARCH tab. |
| **Handoff** | Rotates the current tab's session. Current agent writes a handoff document; new session starts in the same tab with that document as its seed. |
| **Spawn from here** | Forks the current context to a new tab with a configurable model/effort. Original tab continues in parallel. |
| **Live model/effort swap** | Edit MODEL and EFFORT in the CONFIG tab. Takes effect on the next turn. Provider swaps require a Handoff (session rotation). |

Deep dives: [`docs/PRIMITIVES.md`](PRIMITIVES.md).

### Right-panel tabs

The right pane groups its tabs into four sections:

- **WORKSPACE** - FILES (with LIVE / CHANGES / SOURCE / REMOTE views + BLAST RADIUS + SANDBOX), GENESIS
- **AGENT** - ACTIVITY, REVIEW, RESEARCH, HANDOFFS, PLAN, BAKE-OFF, TASKS
- **MEMORY** - KNOWLEDGE, LEDGER, HISTORY, USAGE
- **RUNTIME** - PREVIEW, CONFIG, GITHUB

Cluster tabs swap the per-workflow right pane for the cluster panel, grouped the same WORKSPACE / AGENT / MEMORY / RUNTIME way as a normal tab: MEMBERS / ACTIVITY / REVIEWS / HANDOFFS / PLAN / BOARD / MAILBOX, plus FILES / HISTORY / PREVIEW / CONFIG / GITHUB mirrors. Diagnostics / model-health / local-services live in the header SYSTEM modal, not the right pane.

### Cluster tabs (power-user)

A cluster tab hosts N member workflows pinned to one cwd, with a sticky broadcast composer and a shared peer-tool substrate. Use it for problems that benefit from multiple agents working alongside each other. The operator remains the only actor that advances a member's turn (unless the operator arms auto-turn) - clusters are about *peer-comms plumbing*, not auto-orchestration.

**Creating a cluster.** Right-click a cluster-capable tab -> `Add to cluster with...` or `Create cluster with N fresh workers...`. From inside a cluster: `+ ADD WORKER` in the Members sub-tab.

**Fresh replacements + independent auditors.** `REPLACE` swaps one member
slot to a brand-new workflow/provider session while cloning its name, role,
tier, focus, and tab configuration. Provider/model/effort/account may be
changed; prior transcript context and active task assignments are independent
choices. Fresh and replacement workers can be STANDARD, BLIND
(project-visible but no cluster coordination context; mailbox only), or
ISOLATED (Claude Native in a private scratch cwd with no project access;
mailbox only). Isolated workers can return bounded scratch artifacts through
`peer_send artifact_paths`.

**Peer messaging.** Members register three tools - `peer_list` (roster + mailbox depth), `peer_send` (deliver to a peer's mailbox), `peer_read` (drain own mailbox). Pre-turn injection delivers pending peer messages as a system block before the operator's prompt. Caps: 15 sends per operator turn; 50 pending per recipient; 16 KB per message (operator transcript-sends bypass to 32 KB).

**Shared plan + per-member roles.** Author a cluster-wide plan in the PLAN sub-tab (32 KB cap, 28 KB soft warn); attach a free-form role hint per member (<=120 chars). Both ride as system blocks on every turn - Native via forced blocks, CLI / Codex via `--append-system-prompt`. Director vs. worker stays **emergent through operator conversation** - no permission asymmetry.

**Provider support.** Cluster members are fenced to **claude** (CLI + Native), **codex** (`exec` + `app-server`), **cursor** (ACP), **ollama**, and **llamacpp**. Peer tools wire differently per provider: Native Claude registers them in-process; CLI Claude via a per-spawn `--mcp-config` arco-cluster MCP child; both Codex transports via `-c mcp_servers.arco-cluster.*` TOML overrides; the local providers (ollama / llamacpp) get the peer tools folded into their in-process tool loop; Cursor via an in-process loopback StreamableHTTP MCP server (ACP honors MCP over http/sse only, not stdio - fresh-only membership). LM Studio / Strata / DeepSeek stay outside the cluster fence. **Local members are capped at one per cluster** by default (override with `ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL=1`).

**Sub-tabs in the right panel.** MEMBERS (roster + Detach + role hints) / ACTIVITY (unified feed) / REVIEWS (aggregated reviewer queue) / HANDOFFS / PLAN (shared markdown) / **BOARD** (kanban task board) / MAILBOX (live pending depth) - plus FILES / HISTORY / PREVIEW / CONFIG / GITHUB mirrors so routine work doesn't leave the cluster tab.

**Pending mail.** Member cards show `NUDGE N` when messages are waiting. The cluster NUDGE button shows the total and opens an empty recipient picker; only an explicit selection and send starts a reminder.

**Operator-armed idle nudger.** Default OFF; the MAIL ALERTS chip arms it. When ON, the server alerts the *operator* (toast + ACTIVITY row) if a member is idle >=10s with pending mail - capped at 3 nudges per operator turn, suppressed during busy state. It NEVER sends prompts to workers.

**Operator-armed auto-turn.** Default OFF (per-cluster toggle). When ON, the server dispatches a synthetic primary turn on a recipient that has pending mail - fenced by a cooldown (default 20s/recipient), a rate cap (default 10 fires/60s/cluster), and a chain-depth cap (default 3), all env-overridable. Every fire and every guard refusal lands in `events.jsonl` as `cluster_auto_turn_fired`. Toggling OFF stops further fires; the in-flight turn finishes normally.

**Director / workers task dispatch.** Clusters carry a durable task kernel - tasks with dependencies, comments, run/attempt history, and an expanded status set (triage / todo / ready / in_progress / blocked / review / done / archived). New clusters default-attach a project task board. Workers drive their own work through lifecycle peer-tools (`cluster_task_show` / `create` / `link` / `comment` / `heartbeat` / `block` / `complete`) but can only move work to `review` - `done` and `archived` stay operator-only. The operational **BOARD** tab is a horizontal **kanban** (TODO -> ... -> DONE) with drag-to-restatus (touch-drag supported; moves to `done` / `archived` ask for confirmation), an on-board create-task composer (always `todo`), an editable card drawer (title / notes / priority / deps / delete), and one-click bridges promoting a plan task or a delivered peer message into a board task. Its automation - an **operator-armed dispatcher** (one-shot or armed daemon, default OFF, deterministic eligibility + caps, every fire/skip logged), run **recovery** (reclaim / terminate / reassign, stale-claim detection, consecutive-failure breaker), a **swarm helper** (root blackboard -> N workers -> verifier -> synthesizer), worktree-aware dispatch (`autoWorktree`, default OFF), and **orchestration assist** (operator-armed model drafts of task graph / assignments / recovery / synthesis / swarm that land as preview proposals and only mutate state when the operator accepts selected items through the normal task APIs) - collapses under an AUTOMATION header, closed by default.

See [`docs/PROTOCOL_CLUSTER.md`](PROTOCOL_CLUSTER.md) for the full design, [`docs/TASK_LEDGER.md`](TASK_LEDGER.md) for the task-dispatch layer, and [`docs/GOTCHAS.md under Cluster mode`](GOTCHAS.md) for the load-bearing invariants.

### Plans (per-cwd briefs)

A long-form markdown brief pinned to a workflow and injected into every primary turn so the agent stays oriented. Plans live at `<cwd>/.arco/plans/<id>.md`; one cwd can host many, and the same plan can attach to multiple workflows.

- **PLAN button** in the composer opens a modal: *Draft for review* or *Draft & auto-save*. Both inject a prompt synthesized from the conversation (Goal / Current state / Open questions / Next steps with `- [ ]` items).
- **PLAN tab** - list of plans with attachment counts; active inline, completed behind a toggle. Select a plan to attach it.
- **Living document loop** - an fs watcher catches agent-driven `.md` edits (like `- [ ]` -> `- [x]`) and refreshes the panel live.
- **Clickable checkboxes** - `- [ ] item` lines render as clickable boxes; click flips `[x]` and PATCHes the file (works both directions).
- **Mark complete / delete** - mark complete archives + auto-detaches; delete is permanent (with confirm).
