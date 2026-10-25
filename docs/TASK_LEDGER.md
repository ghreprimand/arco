# Task Ledger

> Status: shipped (ARCO_OPS_PLAN.md §D1 + §D2, Tier 2). The cwd-scoped,
> durable project task list with bidirectional links (D2). D3 adds a cluster
> board view.

The task ledger is a **durable, cwd-scoped task list** — the persistent
cross-session backbone that tasks, plans, and reviews can attach to. It is a
**rebuildable projection over `events.jsonl`**, not a source of truth.

## Where it sits among the three task-ish surfaces

Arco has three distinct surfaces that all show "tasks" in some sense; do not
conflate them:

| Surface | Scope | Lifetime | What it is |
|---|---|---|---|
| **PLAN tab** | per-cwd | durable | A long-form markdown brief + plan-scoped review (whole / per-phase). |
| **TASKS panel** (Phase 7b) | one turn | transcript-bound | The Native worker's `Task` subagent children for the current turn. Depth-1. |
| **LEDGER tab** (this doc) | per-cwd | durable, cross-session | A versioned task-kernel snapshot of operator-managed tasks `{title, status, links, notes, priority, parents, review flags, assignee?}`. |

The ledger is the only one that persists a free-standing task list across
sessions. The PLAN tab is review-shaped; the TASKS panel evaporates with the
turn.

## Storage

- **Location:** `<cwd>/.arco/project/tasks.json`, scoped by working directory
  (the same `<cwd>/.arco/...` convention `planStore.ts` / `workflowMeta.ts`
  use). Many tabs can share one cwd; they all see the same ledger. Stage B
  writes a versioned task-kernel snapshot:

  ```json
  { "version": 1, "tasks": [] }
  ```

  Legacy `{ "tasks": [] }` snapshots still load and are upgraded on the next
  save.
- **Atomic writes:** tmp-file + `rename`, identical to `meta.json` /
  `index.json`. A torn write can never leave a half-rewritten snapshot.
- **Projection over the log:** every mutation appends a `task_ledger_event` to
  the originating workflow's `events.jsonl` (the durable record, four-question
  test) **and** atomically rewrites `tasks.json`. The JSON is a cache.

### Load / rebuild

`server/src/project/taskLedger.ts` exposes the storage behind a
`load() / save() / query()` boundary (so a JSON→SQLite swap is a one-file
change):

- **Normal boot:** `load()` reads `tasks.json` through the versioned snapshot
  boundary. Malformed individual entries are dropped rather than failing the
  whole load.
- **Missing / corrupt snapshot:** `load()` falls back to `rebuildFromEvents()`,
  which enumerates every workflow under the cwd (`listWorkflowMetas`), replays
  each `events.jsonl`, folds the `task_ledger_event` entries in `(at, seq)`
  order (seq is per-workflow, so the `at` timestamp orders across workflows),
  and re-materializes `tasks.json`.
- `query(cwd, { status })` is load-all + filter-in-JS. The working set is small
  and single-writer, so none of SQLite's indexing wins apply.

Mutations are serialized **per-cwd** through a promise chain
(`server/src/ws/taskLedgerHandlers.ts`) so two tabs sharing one cwd cannot
clobber each other's load-mutate-save round.

## The operator-confirmed terminal-status invariant (load-bearing)

There is **no worker/model code path that sets `status: 'done'` or
`status: 'archived'`.** No auto-done. Worker/model completion reports may be
recorded as reviewable evidence, but they are advisory and never derive a
terminal status by themselves.

- `newTask()` always produces `status: 'todo'` — there is no create-as-done
  path.
- `applyUpdate()` is the only function that may set `done` / `archived`, and
  only when the operator's `task_ledger_update` patch carries that status.
- `rebuildFromEvents()` only replays recorded operator events; it never derives
  a status.

Enforced in `server/src/project/taskLedger.ts` (`newTask` / `applyUpdate`) and
asserted by `scripts/smoke/task-ledger.ts`.

## Protocol

Types live in `shared/src/protocol/tasks.ts`.

```
TaskKernelSnapshot = { version: 1, tasks: LedgerTask[] }
LedgerTask = { id, title, status, links: TaskLink[], notes, priority, parentIds, blockedReason, reviewRequired, goalMode, createdAt, updatedAt, assignee? }
LedgerTaskStatus = 'triage' | 'todo' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'done' | 'archived'
TaskLink = { kind: 'plan' | 'review' | 'workflow' | 'url', ref, label? }
```

`assignee` (§D3) is the claimant/assigned member's `workflowId`. Absent =
unassigned. It is additive + projection-safe (pre-D3 snapshots load fine;
`isLedgerTask` does not require it). The operator `task_ledger_create` path does
not set it; `cluster_task_create` may set it explicitly without claiming or
starting the task; `cluster_task_claim` sets it and moves the task to
`in_progress`. `applyUpdate()` sets it from a non-empty string and **clears** it
on an empty string. See §D3 below.

**Client → server** (all tagged with `workflowId`; the server resolves the cwd
from the workflow):

| Message | Effect |
|---|---|
| `task_ledger_create` | Append a new `todo` task (`title`, optional `notes` / `links` / `worktreeRequired`). |
| `task_ledger_update` | Patch `title` / `status` / `notes` / `links` / `assignee` / `worktreeRequired` and task-kernel metadata of one task. The only path that may set `done` / `archived`. Empty-string `assignee` unassigns. |
| `task_ledger_delete` | Remove a task by id. |
| `task_ledger_list` | Request the current cwd snapshot. |

**Server → client:**

| Message | Effect |
|---|---|
| `task_ledger_snapshot` | The full cwd-scoped list (`cwd`, `tasks[]`). Broadcast after every mutation and on connect/rehydrate. The client keys it by `cwd`. |
| `task_ledger_event` | The durable per-mutation event (`op`, `id`, `task?`, `payload?`, `at`). This is what lands in `events.jsonl` and what `rebuildFromEvents()` folds. Live clients no-op on it (the snapshot follows). |

On rehydrate the server pushes a `task_ledger_snapshot` per workflow (see
`handoffHandlers.ts`), so a reconnecting client mirrors the ledger without an
explicit list request — consistent with the plan/preview wire echoes.

## Client

- Store: `appStore.taskLedger: Record<cwd, LedgerTask[]>` (cwd-scoped, not
  per-job) + `setTaskLedger(cwd, tasks)`; the snapshot handler in
  `handleServerMessage.ts` replaces the cwd's list in place.
- UI: the **LEDGER** right-panel tab
  (`client/src/components/RightPanel/LedgerTab.tsx`) — add a task, edit
  title/notes inline, change status via a select (the `DONE` option requires an
  explicit click; nothing auto-marks done), delete, and **manage links** (see
  §D2 below — clickable chips + attach/detach). It coexists with the TASKS
  subagent-children panel; the two never collide.

## Links (§D2 — bidirectional references)

A `TaskLink` is a small typed reference from a task to something else in Arco:
`{ kind: 'plan' | 'review' | 'workflow' | 'url', ref, label? }`. The shape ships
in D1; D2 makes it **bidirectional** and operator-editable — no new protocol.

- **Forward** (task → targets) is just `task.links[]`.
- **Reverse** (target → tasks) is `tasksLinkedTo(tasks, { kind, ref })` in
  `server/src/project/taskLedger.ts` — a pure helper returning the tasks whose
  `links[]` contains an **exact** `{kind, ref}` match. The match is exact on both
  fields: a workflow id and a URL that happen to be the same string are distinct
  targets and never cross-match. This is the half a plan/review/workflow needs to
  ask "which ledger tasks point at me?"
- **Editing** flows through the existing `task_ledger_update` message: the client
  sends the **full new `links[]` array** as the `links` patch field; `applyUpdate`
  sanitizes and replaces. Attach and detach are both just a new array. There is
  deliberately no per-link add/remove protocol — the working set per task is tiny.

### Navigation (client)

In the LEDGER tab each task's links render as clickable chips
(`client/src/components/RightPanel/LedgerLinks.tsx`). Clicking a chip is resolved
by `RightPanel` (`navigateLink` in `index.tsx`), which owns the tab + workflow
selection state the chip can't reach:

| kind | destination |
|---|---|
| `plan` | switch the right panel to the **PLAN** tab |
| `review` | switch to the **HISTORY** tab (where past reviews live) |
| `workflow` | `setActiveJob(ref)` **if** that workflow is still open; otherwise no-op |
| `url` | `window.open(ref)` in a new tab, only for `http(s)://` refs |

Unresolvable targets (a closed workflow tab, a non-URL `url` ref) fall back to a
no-op rather than throwing; the chip tooltip still shows the raw `kind: ref`. The
attach affordance (`+ LINK`) and per-chip `×` remove are operator-click-only.

Asserted by `scripts/smoke/task-links.ts` (reverse query, kind-disambiguation,
attach/detach, save/load round-trip of links).

## §D3 — Cluster task board + task peer-tools

The Arco-shaped win: a kanban **view over the ledger** for clusters, plus
worker peer-tools to read / show / claim / update / comment / block / complete
tasks. The ledger remains the source of truth — D3 adds the `assignee` field
and board sub-tab; the director/workers lifecycle slice adds durable comments
and completion reports in the same task-kernel snapshot. No second source of
truth.

### The `assignee` claim model

`assignee` is a first-class optional `LedgerTask` field carrying the claimant's
`workflowId`. Threaded through `taskLedger.ts`: `newTask` never sets it,
`applyUpdate` sets/clears it (`''` → unassigned), the rebuild fold carries it,
and `isLedgerTask` treats it as optional so pre-D3 snapshots load.

### Task peer-tools (`server/src/clusterPeerOps.ts`)

Cluster-gated — registered ONLY when `worker.config.clusterId` is set, alongside
`peer_*` and `cluster_plan_*`. Names use underscores (Anthropic regex); the
MCP-prefixed form on CLI Claude / Codex is `mcp__arco-cluster__cluster_task_*`.
**Full transport parity:** wired into the Native worker
(`claude-native/peerTools.ts`) AND the MCP child (`mcp/clusterMcpServer.ts` →
REST in `http/clusterRoutes.ts`), exactly like `cluster_plan_tick` /
`cluster_plan_write`.

| Tool | Effect | Rejections |
|---|---|---|
| `cluster_task_list` | Read the cluster cwd's ledger (id, title, status, assignee, links, kernel metadata). Read-only. | `no_cwd` |
| `cluster_task_show` | Read one task's details: task, parents, children, comments, runs. Read-only. | `no_cwd`, `not_found` |
| `cluster_task_create` | Create a new non-terminal `todo` task in the cluster cwd, with optional notes/body, assignee, priority, parentIds, links, reviewRequired, goalMode, and goalMaxTurns. | `no_cwd`, `empty_title`, `invalid_link`, `not_found`, `operator_gated` for terminal status attempts |
| `cluster_task_claim` | Set `assignee = caller`, `status = in_progress`. | `not_found`, `already_claimed` (a *different* member owns it — no stomp; re-claim by the owner is a no-op) |
| `cluster_task_update` | Change worker-allowed `status` (`triage`/`todo`/`ready`/`in_progress`/`blocked`/`review`) and/or `notes`. | `not_found`, **`operator_gated`** when `status === 'done'` or `status === 'archived'` |
| `cluster_task_heartbeat` | Create/update the caller's visible run heartbeat for a task; optional note is stored as run metadata and a durable heartbeat comment. | `no_cwd`, `not_found` |
| `cluster_task_link` | Add a dependency: `childId` depends on `parentId`. Rejects self-links and cycles. | `no_cwd`, `not_found`, `invalid_link` |
| `cluster_task_unlink` | Remove a dependency: `childId` no longer depends on `parentId`. | `no_cwd`, `not_found`, `invalid_link` |
| `cluster_task_comment` | Append a durable comment to the task handoff thread. | `no_cwd`, `not_found` |
| `cluster_task_block` | Move to `blocked`, set `blockedReason`, append a `BLOCKED` comment. | `no_cwd`, `not_found` |
| `cluster_task_complete` | Move to `review`, append a `COMPLETION REPORT` comment. Never marks `done`. | `no_cwd`, `not_found` |

cwd is derived from `clusterStore.readCluster(clusterId).cwd` (the authoritative
shared cwd — *not* the caller's possibly-unhydrated config). Mutations persist
through the D1 module via the shared `persistLedgerMutation` helper
(`ws/taskLedgerHandlers.ts`: load → `applyUpdate` → save → durable
`task_ledger_event`, under the per-cwd lock so concurrent claims serialize) and
then broadcast a fresh `task_ledger_snapshot` **cluster-wide** so every member's
board follows live.

Comments and heartbeat runs are event-sourced: `cluster_task_comment`,
`cluster_task_block`, `cluster_task_complete`, and note-bearing
`cluster_task_heartbeat` store durable handoff text in
`task_ledger_event.payload.comment`; `cluster_task_heartbeat` also stores the
visible run in `task_ledger_event.payload.run`. `loadKernel()` replays those
payloads when rebuilding after a missing/corrupt snapshot. The current snapshot
also materializes comments/runs for cheap `cluster_task_show` reads.

The one-shot dispatcher (`cluster_dispatch_once`) is operator-clicked from the
cluster BOARD. It only considers `ready` tasks with an explicit assignee that is
a current idle cluster member on a supported provider. A fired task is moved to
`in_progress` and receives a `dispatch_fired` event carrying `payload.run`
before the synthetic worker turn starts. Refusals are durable
`dispatch_skipped` task events with stable reason codes (`dependency_blocked`,
`no_assignee`, `member_busy`, etc.). The dispatcher never marks tasks `done` and
never infers routing from role/tier/focus metadata.

The armed dispatcher daemon (Stage G) uses that same dispatcher kernel on an
operator-enabled interval. Its per-cluster `dispatcher` settings live in
cluster meta, default OFF, and mirror through `cluster_state`. Turning the
daemon ON does not change assignment rules: only ready tasks with explicit idle
supported assignees can fire, the configured sweep/member caps apply, and any
open run for a task blocks re-dispatch. Turning the daemon OFF stops new fires
but does not mutate already-running attempts.

Stage J adds worktree-aware dispatch. A task can set `worktreeRequired=true`;
the dispatcher skips it by default unless the task already has a server-set
`worktree`. If the operator enables cluster dispatcher `autoWorktree`, the
dispatcher provisions the managed worktree before firing, persists the task
pointer in the same `dispatch_fired` mutation, and includes the worktree
path/branch in the synthetic prompt. This phase keeps the member workflow cwd
unchanged; the prompt tells the worker to edit in the task worktree.

Stage H adds operator recovery for individual run records through
`task_run_recover`. The server selects one `runId` under the same per-cwd lock,
records a durable `run_reclaimed` / `run_terminated` / `run_failed` event with
`payload.run`, and applies only the bounded task recovery for that action:
reclaim clears assignment and returns the task to `ready`; reassign returns it
to `ready` with a resolved cluster member assignee; terminate blocks the task;
fail either returns it to `ready` or blocks after the configured consecutive
failure limit. The stale reclaim UI sends `staleOnly` with a five-minute
threshold. None of these actions can set `done` / `archived`.

Stage I adds the swarm helper as an operator-created task graph over this same
ledger. The expected graph is one root blackboard task carrying the brief, N
parallel worker tasks linked to that root context, one verifier task depending
on all workers, and one synthesizer task depending on the verifier. The helper
must write normal task-kernel mutations and dependency fields; it is not a
second board, not a hidden router, and not a completion path. If the operator
chooses `armDispatch`, the helper may only invoke the same deterministic
dispatcher surface used by `cluster_dispatch_once` / the armed daemon; it must
not auto-mark any non-root task `done`. Asserted by
`scripts/smoke/task-swarm.ts`: topology, replay after deleting `tasks.json`,
default no-dispatch behavior, and dispatch-after-create not producing terminal
statuses for worker/verifier/synthesizer tasks.

Stage K adds orchestration-assist proposals as a preview layer above the same
ledger. A proposal may draft tasks, assignments, swarm layouts, recovery
actions, synthesis comments, and provider/model/effort suggestions, but it is
not task state. Rejecting a proposal is audit-only and must leave
`tasks.json`/the task kernel unchanged. Accepting selected task-affecting items
must go through the normal task-kernel mutation APIs and emit ordinary
`task_ledger_event` rows (`create`, `update`, `link`, `comment`, etc.) followed
by the normal snapshot broadcast. Provider/model/effort suggestions are inert
unless the operator explicitly accepts those suggestion items. Asserted by
`scripts/smoke/task-orchestration-assist.ts`.

### Orchestration-assist proposals (Stage K)

The `orchestrationProposals` module (`server/src/project/orchestrationProposals.ts`)
is a durable preview store layered **above** the task-ledger mutation kernel.
It is not a second mutation path — accepted items flow into the ledger through
exactly the same `persistLedgerMutation` path the peer-tools use.

**Proposal lifecycle:**

1. **Requested** — operator arms the ASSIST panel in the cluster BOARD tab,
   picks a kind (`task_graph` / `assignments` / `swarm` / `recovery` /
   `synthesis`), optionally supplies input refs and a prompt, and clicks REQUEST
   PROPOSAL. The server validates cluster membership, creates an
   `OrchestrationProposal` record, and persists it to
   `<cwd>/.arco/project/orchestration-proposals.json`.
2. **Proposed** — the proposal broadcasts to all cluster members as
   `cluster_orchestration_proposals_snapshot`. It is preview data: no
   `task_ledger_event` has fired, `tasks.json` is unchanged.
3. **Rejected** — operator clicks REJECT. The proposal `status` transitions to
   `rejected` and a `rejected` entry is appended to `actions[]`. **No task
   mutation.** `tasks.json` is untouched. Already-accepted proposals cannot be
   rejected.
4. **Accepted (partial or full)** — operator selects item ids and clicks ACCEPT
   SELECTED. For each selected item the server executes the **ordinary task-
   kernel mutation** under the per-cwd lock:
   - `task_create` items → `taskLedger.newTask` + optional `applyUpdate` for
     status/assignee/parents → `task_ledger_event op='create'` + `op='update'`
   - `task_update` items (mode `task_kernel`) → `taskLedger.applyUpdate` →
     `task_ledger_event op='update'`
   - `task_update` items (mode `comment`) → `taskLedger.newTaskComment` →
     `task_ledger_event op='comment'`
   - `task_comment` items → `taskLedger.newTaskComment` →
     `task_ledger_event op='comment'`
   - `note` items → no ledger mutation

   After processing, `cluster_orchestration_proposal_applied` broadcasts the
   `itemIds` and resolved `taskIds`, and a fresh `task_ledger_snapshot`
   broadcasts cluster-wide — the normal post-mutation path.

**Audit trail.** `OrchestrationProposal.actions[]` is an immutable append-only
log of `{action, workflowId, at, itemIds?, taskIds?, reason?}` entries. Every
lifecycle step appends: `requested` + `proposed` on creation; `accepted` (with
resolved task ids) on each partial accept; `rejected` on rejection. The log is
what lets a post-hoc review determine exactly which ledger tasks originated
from a given proposal.

**What the ledger events look like.** Accepted proposal items emit the same
`task_ledger_event` rows as operator-issued `task_ledger_create` /
`task_ledger_update` / comment mutations. The `task_comment` payload carries
`metadata: { source: 'orchestration_proposal', proposalId, itemId, applyMode }`
so a reviewer can trace a comment back to its proposal. The task-kernel event
stream and `rebuildFromEvents` see nothing special — proposal-origin is recorded
in the comment metadata, not in any separate field on the task itself.

**Terminal-status gate.** Items targeting `done` or `archived` (in
`task_create.status` or `task_update.patch.status`) are rejected before any
mutation fires. The §D1 no-auto-done invariant holds across the proposal path.

**Inert suggestions.** The `OrchestrationAssistModelRef` on a proposal may
carry `provider` / `model` / `effort` suggestions. These are stored verbatim for
operator reference. The server never routes, assigns, or dispatches based on
them. They become actionable only if the operator reads the rationale and
manually applies them through the CONFIG or dispatcher settings.

### Operator-gated terminal statuses at the peer layer (load-bearing)

The §D1 operator-confirmed terminal-status invariant is re-enforced here:
`peerTaskUpdate` **rejects** `status: 'done'` and `status: 'archived'` with code
`operator_gated` *before* it touches the ledger. Workers may set only
`triage` / `todo` / `ready` / `in_progress` / `blocked` / `review`; they report
completion through `cluster_task_complete` (which moves to `review`) or via
`peer_send`, and the **operator** marks done from the LEDGER tab. This is not a global block — the operator's
`task_ledger_update` WS path still reaches `applyUpdate` with terminal statuses
and succeeds. Asserted by `scripts/smoke/task-board.ts` steps (d) + (e).
Dependency graph behavior is asserted by `scripts/smoke/task-dependencies.ts`;
lifecycle comments/completion are asserted by
`scripts/smoke/task-peer-lifecycle.ts`.

### The board (`client/src/components/ClusterTaskBoardTab.tsx`)

A **BOARD** sub-tab in `ClusterRightPanel` (next to PLAN). Eight columns
(`triage`/`todo`/`ready`/`in_progress`/`blocked`/`review`/`done`/`archived`)
over the cluster cwd's `taskLedger` store entry. Cards show title, claimant
(`@name` chip or `UNCLAIMED`), parent count, and a link count. Clicking a card
opens the read-only task drawer. The drawer uses any current cluster member
workflowId to call
`GET /api/clusters/:id/peer/task-show?workflowId=&id=` and renders overview
fields, dependency parents/children, durable comments, run/heartbeat records,
and narrow recovery controls. `REASSIGN` changes only the task assignee through
the normal ledger update path. `RECLAIM` is enabled for stale open runs and
sends `task_run_recover(..., 'reclaim', { staleOnly: true })`; `TERMINATE`
targets exactly one open run after a browser confirmation. If the detail read
fails, the selected task's ledger fields remain visible and the error is shown
inline. Primarily a view — mutations come from the peer-tools and explicit
operator controls; the operator still edits terminal status via the LEDGER tab.
The `DISPATCH ONCE` button performs one deterministic dispatcher sweep for
ready explicitly-assigned work and then waits for the next operator click. The
Stage G dispatcher daemon is a separate armed mode: the BOARD header should
expose the ON/OFF state and settings, and the server must persist those settings
before interval sweeps can fire. The pure grouping / drawer helper functions
live in a React-free module (`clusterTaskBoard.helpers.ts`) so the smoke can
assert them.

## Worktrees per task (§K5)

A task can *optionally* own an **isolated git worktree** so parallel work on one
repo doesn't collide. This is local-only — it needs no VPS / hub / remote tier
(the K1 dep listed in the plan is ordering within Part K, not functional). The
git lifecycle lives in **`server/src/project/taskWorktree.ts`**; the WS glue in
**`server/src/ws/taskWorktreeHandlers.ts`**.

- **Where it lives.** The worktree is created under a **managed root outside the
  user's tree** — `~/.arco/worktrees/<cwd-hash>/<taskId>` — checked out on a
  dedicated `arco/task/<taskId>` branch off the current HEAD. It is **never**
  placed inside the project folder.
- **The task pointer.** `LedgerTask.worktree?: TaskWorktree` (`{ path, branch,
  baseRef, createdAt }`) is **server-set only** — clients ask via
  `task_worktree_create` / `task_worktree_remove`; the field is then set/cleared
  through the *same* event-sourced ledger mutation path (`persistLedgerMutation`
  → `applyUpdate`), so it is durable and projection-safe (folds through
  `rebuildFromEvents` like every other task field). The WS `task_ledger_update`
  message intentionally **cannot** carry `worktree` — only the worktree handlers
  set it.
- **Create** requires a git repo with **at least one commit** (else a typed
  `TaskWorktreeError` — `not-a-repo` / `no-commit` — surfaces as a clean WS
  error, not a 500). Idempotent: a task that already has a live worktree returns
  it unchanged. If the branch already exists, the worktree checks it out rather
  than recreating.
- **Remove** tears down the checkout (`git worktree remove --force` + `prune`)
  but **keeps the branch** — committed work on it is preserved. It refuses to
  remove any path not under the managed root (the `rm -rf`-safety invariant).
- **Checkpoints work inside it.** The shadow-git checkpoint store
  (`gitSnapshots.ts`) operates unchanged in a worktree cwd — a linked worktree
  shares the main repo's object store, so checkpoints taken in sibling worktrees
  **dedupe at the git-object level** (the plan's "single shared blob store
  dedupes across worktrees").
- **UI.** The LEDGER tab shows an **ISOLATE** button per task; once provisioned,
  a chip shows the branch + path with a **REMOVE** button.
- **Smoke:** `scripts/smoke/task-worktrees.ts` (8 steps, direct-import — no WS)
  asserts the managed-root placement, idempotency, in-worktree checkpoints, the
  main tree staying untouched, the field round-tripping save→load, branch-kept
  removal, and the typed error cases. `npm run smoke:task-worktrees`.
- **Dispatch:** Tasks may set `worktreeRequired=true`. The dispatcher skips
  those tasks by default because `autoWorktree` is OFF in cluster dispatcher
  settings. When the operator enables `autoWorktree`, dispatch creates the
  managed worktree, persists the task pointer, and includes the path/branch in
  the synthetic worker prompt. Phase 1 keeps the provider cwd unchanged. Smoke:
  `npm run smoke:task-dispatch-worktree`.

## JSON → SQLite migration trigger

JSON is correct here because the ledger is a projection over `events.jsonl`, the
working set is small, and it is single-writer (Appendix B of the ops plan).
SQLite earns its place **only** when the workload changes to one JSON can't
serve well — concretely: **>~a few thousand rows** in a single cwd's ledger, or
a **full-text search across tasks** requirement. Because storage sits behind
`load() / save() / query()`, that swap is a one-file change. This is a
documented trigger, **not** an assumed future — do not pre-migrate.
