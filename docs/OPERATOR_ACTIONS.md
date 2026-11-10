# Operator actions

Explicit operator surfaces that move work forward in Arco, plus the right-panel
layout for workflow and cluster tabs. Deep contracts:
[Primitives](PRIMITIVES.md).

## Core actions

| Action | What it does |
| --- | --- |
| **New project** | Opens a tab. The workflow creator opens a tab for the selected cwd, provider, model, effort, and tool allowlist. |
| **Resume** | Lists existing native CLI sessions for the current cwd (`~/.claude/projects/...`, `~/.codex/sessions/...`). The selected session continues inside Arco. |
| **Review** | Spawns an ephemeral reviewer (any provider/model) over the last turn or a plan slice. Output is a read-only artifact in the right pane. |
| **SECOND OPINION** (formerly Compare) | Sends one question, or selected chat messages, to several provider/model legs; each drafts the reply the operator could send. With **Blind** on (the default) the model names stay hidden until one draft is picked; **USE THIS REPLY** puts a draft in the composer. Nothing is sent automatically. |
| **Research** | Runs one bounded web-research turn; produces a cited markdown report in the RESEARCH tab. |
| **Handoff** | Rotates the current tab's session. Quick builds a deterministic seed from recent conversation, the action digest and Git state; the new session starts in the same tab. A written handoff is optional and does not edit `DEVLOG.md`, `PLAN.md`, or other project files. |
| **Spawn from here** | Forks the current context to a new tab with a configurable model/effort. Original tab continues in parallel. |
| **Live model/effort swap** | Edit MODEL and EFFORT in the CONFIG tab. Takes effect on the next turn. Provider swaps require a Handoff (session rotation). |
| **BRIEF** | In a cluster tab the composer's BRIEF offers THIS WORKER or WHOLE CLUSTER. Ask the utility agent for a short synopsis of one worker or the whole cluster from facts Arco can see. Lists the facts; sends nothing to any worker. Needs a utility agent. |
| **CATCH ME UP** | Summarize workflow or cluster activity from the earlier of the last visit or last operator message. An empty range makes no model call and offers SINCE LAST TURN, LAST HOUR and TODAY. A failed summary stays in the dialog, not in chat. Needs a utility agent. |
| **TIDY** | Ask the utility agent to propose a clearer composer draft. **ACCEPT** replaces the draft only; TIDY never sends. Needs a utility agent. |

## Workspace name

The workspace RENAME dialog keeps Tab and Shift+Tab inside its controls, including while SAVE is pending. Closing the dialog returns focus to RENAME.

## Right-panel tabs

The right pane groups its tabs into four sections:

- **WORKSPACE** - FILES (with LIVE / CHANGES / SOURCE / REMOTE views + BLAST RADIUS + SANDBOX), GENESIS
- **AGENT** - ACTIVITY, REVIEW, RESEARCH, HANDOFFS, PLAN, BAKE-OFF, TASKS
- **MEMORY** - KNOWLEDGE, LEDGER, HISTORY, USAGE
- **RUNTIME** - PREVIEW, CONFIG, GITHUB

Cluster tabs swap the per-workflow right pane for the cluster panel, grouped the
same way as a normal tab:

- **WORKSPACE** - MEMBERS, FILES
- **AGENT** - ACTIVITY, REVIEWS, HANDOFFS, PLAN, BOARD, MAILBOX
- **MEMORY** - HISTORY (the member in view), USAGE (every member's conversations in the project folder)
- **RUNTIME** - PREVIEW, CONFIG, GITHUB

FILES, HISTORY, PREVIEW, CONFIG and GITHUB mirror the single-worker tabs. Diagnostics / model-health / local-services
live in the header SYSTEM modal, not the right pane.

## Cluster tabs

A cluster tab hosts N member workflows pinned to one cwd, with one message box
(its TO chip picks the recipients; the director by default) and a shared
peer-tool substrate. Use it for problems that
benefit from multiple agents working alongside each other. The operator remains
the only actor that advances a member's turn (unless the operator arms
AUTO-PICKUP). Clusters are about peer-comms plumbing, not auto-orchestration.

### Creating and replacing members

- Right-click a cluster-capable tab to open **CLUSTER ACTIONS**: **CREATE WITH
  EXISTING**, **ADD TO EXISTING** or **CREATE WITH FRESH**.
- From inside a cluster: **+ ADD FRESH** or **+ ADD EXISTING** in the MEMBERS
  sub-tab.
- **REPLACE** swaps one member slot to a brand-new workflow/provider session.
  The dialog starts from the old member and every choice can be changed:
  provider, model, effort, account, access, name, role, work size, focus, fast
  mode, tool filter, output style and auto-compaction. Tab settings the dialog
  does not show are copied. Prior transcript context and active task
  assignments are independent choices.
- **ADD FRESH** offers the same choices, starting from the first member's tab
  settings with no work size, focus or own auto-compaction.
- Every path refuses an empty model, a model of another provider and a model
  the catalog does not list with the same message, and refuses a picked Codex
  account that is not set up in Settings instead of using another one.
- Fresh and replacement workers can be STANDARD, BLIND (project-visible but no
  cluster coordination context; mailbox only), or ISOLATED (Claude Native in a
  private scratch cwd with no project access; mailbox only). Isolated workers
  can return bounded scratch artifacts through `peer_send artifact_paths`.

### Peer messaging and plan

Members register three tools: `peer_list` (roster + mailbox depth), `peer_send`
(deliver to a peer's mailbox), `peer_read` (drain own mailbox). Pre-turn
injection delivers pending peer messages as a system block before the
operator's prompt. An independent message guard (Warn only / Hard limit / No
limit; new clusters default Warn only at 15) bounds sends per operator turn;
50 pending per recipient; 16 KB per message (operator transcript-sends bypass
to 32 KB).

Author a cluster-wide plan in the PLAN sub-tab (32 KB cap, 28 KB soft warn);
attach a free-form role hint per member (<=120 chars). Both ride as system
blocks on every turn (Native via forced blocks, CLI / Codex via
`--append-system-prompt`). A cluster may have at most one director; other role
behavior stays emergent through conversation (no permission asymmetry beyond
that limit). Work size is a director hint and does not change model or effort.

### Provider support

Cluster members are fenced to **claude** (CLI + Native), **codex** (`exec` +
`app-server`), **cursor** (ACP), **ollama**, and **llamacpp**. Peer tools wire
differently per provider:

- Native Claude registers them in-process
- CLI Claude via a per-spawn `--mcp-config` arco-cluster MCP child
- Both Codex transports via `-c mcp_servers.arco-cluster.*` TOML overrides
- Local providers (ollama / llamacpp) fold peer tools into their in-process tool
  loop
- Cursor via an in-process loopback StreamableHTTP MCP server (ACP honors MCP
  over http/sse only, not stdio; fresh-only membership)

LM Studio / Strata / DeepSeek stay outside the cluster fence. How many members
may use each local runtime is `localClusterCapacity` in Connections (default 1
each; override the check with `ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL=1`).

### Sub-tabs and mail alerts

Sub-tabs: MEMBERS (roster + Detach + role hints) / ACTIVITY (unified feed) /
REVIEWS (aggregated reviewer queue) / HANDOFFS / PLAN (shared markdown) /
**BOARD** (kanban task board) / MAILBOX (live pending depth), plus FILES /
HISTORY / PREVIEW / CONFIG / GITHUB mirrors so routine work does not leave the
cluster tab.

Member cards show a mail mark with the count when messages are waiting (delivered at the member's next turn). It is muted while the member is busy; when the member is idle with mail it is highlighted and clicking it nudges that member (the mark then reads Nudged, and the composer NUDGE button reads NUDGED with a count, until the member starts its turn), and the tab shows Needs you. The cluster NUDGE button
shows the total and opens an empty recipient picker; only an explicit selection
and send starts a reminder. NUDGE ALL WITH MAIL (n) in the picker, and
Cluster: nudge all with mail in the command palette, nudge every member with
waiting mail at once, idle or busy; members without mail are never nudged.
The toast after SEND NUDGE or NUDGE ALL WITH MAIL names how many were nudged
and, when any were busy, how many got the busy reminder.

**Operator-armed idle nudger.** Default OFF; the MAIL ALERTS chip arms it. When
ON, the server alerts the operator (toast + ACTIVITY row) if a member is idle
>=10s with pending mail, capped at 3 nudges per operator turn, suppressed during
busy state. It never sends prompts to workers.

**Operator-armed AUTO-PICKUP.** Default Off (per-cluster control). Modes: Off,
Rule-based (recommended), Smart: Observe-only, and Smart: Automatic. Rule-based
dispatches a synthetic primary turn when idle mail arrives, with acknowledgement
filtering and adjustable wake-budget guards (shared cooldown default 20s per
recipient, rate cap default 10 fires per 60s per cluster, chain-depth default 8;
env-overridable). Smart modes need an evaluator on Claude Native, Codex, Cursor,
Ollama, LM Studio, llama.cpp, or Strata or DeepSeek through Xolotl. Every fire and every guard refusal lands in `events.jsonl` as
`cluster_auto_turn_fired`. Turning Off stops further fires; an in-flight turn
finishes normally. See [SETTINGS.md](SETTINGS.md#auto-pickup).

### Task board and automation

Clusters carry a durable task kernel: tasks with dependencies, comments,
run/attempt history, and statuses triage / todo / ready / in_progress / blocked /
review / done / archived. New clusters start with their own cluster board; the creator and the board bar can choose the project board or none instead.
Workers drive their own work through lifecycle peer-tools
(`cluster_task_show` / `create` / `link` / `comment` / `heartbeat` / `block` /
`complete`) but can only move work to `review`. `done` and `archived` stay
operator-only.

The operational **BOARD** tab is a horizontal kanban (TODO -> ... -> DONE) with
drag-to-restatus (touch-drag supported; moves to `done` / `archived` ask for
confirmation), an on-board create-task composer (always `todo`), an editable
card drawer (title / notes / priority / deps / delete), and one-click bridges
promoting a plan task or a delivered peer message into a board task.

Automation under an AUTOMATION header (closed by default):

- Operator-armed dispatcher (one-shot or armed daemon, default OFF, deterministic
  eligibility + caps, every fire/skip logged)
- Run recovery (reclaim / terminate / reassign, stale-claim detection,
  consecutive-failure breaker)
- Swarm helper (root blackboard -> N workers -> verifier -> synthesizer)
- Worktree-aware dispatch (`autoWorktree`, default OFF)

See [Cluster protocol](PROTOCOL_CLUSTER.md), [Task ledger](TASK_LEDGER.md), and
[Gotchas: Cluster mode](GOTCHAS.md) for load-bearing invariants.

## Plans (per-cwd briefs)

A long-form markdown brief pinned to a workflow and injected into every primary
turn so the agent stays oriented. Plans live at `<cwd>/.arco/plans/<id>.md`;
one cwd can host many, and the same plan can attach to multiple workflows.

- **PLAN button** in the composer opens a modal: `DRAFT → I'LL REVIEW` or
  **DRAFT & AUTO-SAVE**. Both inject a prompt synthesized from the conversation
  (Goal / Current state / Open questions / Next steps with `- [ ]` items).
- **PLAN tab** - list of plans with attachment counts; active inline, completed
  behind a toggle. Select a plan to attach it.
- **Living document loop** - an fs watcher catches agent-driven `.md` edits
  (like `- [ ]` -> `- [x]`) and refreshes the panel live.
- **Clickable checkboxes** - `- [ ] item` lines render as clickable boxes; click
  flips `[x]` and PATCHes the file (works both directions).
- **Mark complete / delete** - mark complete archives + auto-detaches; delete is
  permanent (with confirm).
