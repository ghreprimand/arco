# Arco — persistence

Where every byte goes. This doc tracks what's on disk, why, and how it's read back. Source files: `server/src/workflowStore.ts` (events.jsonl), `server/src/workflowMeta.ts` (meta.json), `server/src/planStore.ts` (plans), `server/src/crashRecovery.ts` (boot recovery).

For the higher-level lifecycle context, see [`ARCHITECTURE.md`](ARCHITECTURE.md). For replay and snapshot semantics, see [`PROTOCOL.md`](PROTOCOL.md).

---

## Two roots

Both roots use the `.arco` directory name.

Arco writes to two places:

1. **Per-workflow** under `<cwd>/.arco/workflows/<wfid>/` — tied to the workflow's working directory. Survives `git clone` only if you commit `.arco/` (Arco `.gitignore`s it by default). **Chat tabs** (`kind:'chat'`) are projectless: their synthetic persistence cwd is `~/.arco/chats/<wfid>`, so the same layout lands at `~/.arco/chats/<wfid>/.arco/workflows/<wfid>/`.
2. **Operator-global** under `~/.arco/` — tied to the user, not the project. Settings, model catalog, crash-recovery registry, isolated browser profiles, and managed bake-off worktrees/manifests.

**Incognito writes neither.** `WorkflowConfig.incognito` workflows never register a persistence cwd, never init the workflow store, never write `meta.json` / `events.jsonl` / recall / session-index rows / operational logs / PID entries, and the browser excludes them from localStorage. Transcript continuity is memory-only; an observerless incognito workflow is dropped after a 10 s reconnect grace. See `docs/CHAT.md`.

Computer supports this same Incognito boundary on Codex/Claude/Ollama. Its
full context clear also empties `incognitoEvents` and browser message arrays;
leaving a private model/history selection removes the workflow. A reconnect
after server restart discards obsolete private browser rows; no old context is
reconstructed from the page. Saved Computer
contexts retain transcript history but record a reset boundary that all provider
replays obey. The browser stores only non-content agent preferences in
`arco.computer.selection.v1` (provider/model/effort/history), never private
workflow IDs or messages. Voice diagnostic/recognition text is suppressed for
private captures. Strata's service logs/cache still exclude it from Incognito.

Conversation records are append-only as a rule — Arco never auto-deletes `events.jsonl`, `meta.json`, artifacts or handoffs. What *is* bounded or reaped: checkpoint refs beyond the per-workflow cap, `recent-files.jsonl` self-compaction, `media-scratch/` (24 h TTL + 16 GiB cap), the rotated structured log, drained mailbox files, and a tab's `sandbox.db` on close. Operator-requested deletion is explicit: PURGE (below) and bake-off worktree cleanup (which preserves branches + manifest).

---

## Per-workflow layout

```
<cwd>/.arco/
├── .gitignore                       # "workflows/" + projections — drops on first init
├── settings.json                    # per-project settings overrides (Phase 2)
├── session-index.json               # §H3 resume-picker projection (workflows/sessionIndex.ts; rebuildable, skipped for chats)
├── title-events.jsonl               # session-index title history (same module; rebuildable)
├── <workflowId>/                    # per-workflow CLI/Codex MCP config (mcp/mcpConfigWriter.ts) — cluster peer tools / codebase-memory / registry servers
│   └── mcp-config.json              # unlinked on tab close
├── workflows/
│   └── <wfid>/                      # one directory per workflow
│       ├── events.jsonl             # append-only NDJSON event log
│       ├── meta.json                # workflow identity + session ledger
│       ├── resume-summary.json      # Native resume-summary cache (claude-native/resumeSummary.ts)
│       ├── gate-approvals.json      # DEBAG gate sidecar (gateStore.ts) — only when reviewSafeMode='on'
│       ├── artifacts/               # review and worker outputs
│       │   ├── review-<ts>.md
│       │   ├── raw-tools/            # Phase C / §2.2 — gzipped pre-filter & pre-eviction raw output
│       │   │   └── <turnId>-<toolUseId>.txt.gz
│       │   └── ...
│       ├── handoffs/                # session rotation documents
│       │   ├── handoff-<ts>.md
│       │   └── ...
│       ├── sandbox.db               # Phase E — per-tab SQLite + FTS5
│       ├── sandbox.db-wal           # WAL sidecar (live)
│       ├── sandbox.db-shm           # WAL sidecar (live)
│       └── sandbox-tmp/             # Phase E — per-call exec workdirs
│           └── run-XXXX/            # script + stdout buffer; cleaned on finalize
├── plans/                           # per-cwd plan briefs (see Plan store)
│   ├── index.json
│   └── <planId>.md
├── knowledge/                       # per-cwd operator knowledge base (knowledge/store.ts)
│   ├── index.json                   # { articles: [{ id, title, tags, alwaysInclude, ... }] }
│   └── <id>.md                      # article body
├── project/
│   ├── tasks.json                   # versioned task-kernel snapshot (project/taskLedger.ts)
│   └── orchestration-proposals.json # pending orchestration-assist proposals (project/orchestrationProposals.ts)
├── skills/                          # project-scoped operator skills
│   └── <slug>/
│       └── SKILL.md                 # frontmatter (name, description) + body
├── prompts/                         # DD10 /prompt templates (project; gated behind DD7 trust)
│   └── <name>.md
├── handoff.prompt.md                # optional original-worker handoff prompt override
└── handoff.summarizer.prompt.md     # optional fresh-summarizer handoff prompt override
```

The `.gitignore` is written once (skipped if present) and lists `workflows/`, `session-index.json`, and `title-events.jsonl` — the rebuildable projections. See [.gitignore](#gitignore) below.

`<wfid>` is a UUID matching `^[a-zA-Z0-9-]{1,64}$` — that pattern is enforced as a path-traversal defense in `workflowStore.ts` and `workflowMeta.ts`.

### Purge (irreversible)

Closing a tab (`remove_workflow`) does **not** delete this tree — it tears down in-memory state, unlinks `sandbox.db` + `mcp-config.json`, and closes open plan spans; the workflow stays resumable. The HISTORY-tab **PURGE CONVERSATION** action (→ `DELETE /api/workflows/:wfid`, `server/src/workflows/purgeWorkflow.ts`) deletes this whole tree plus the out-of-tree artifacts keyed by `<wfid>`: git checkpoints (`refs/arco/<wfid>/*` — in the cwd repo and the shadow store), skipped-path sidecars and legacy tar checkpoints (`~/.arco/checkpoints/<cwd-hash>/<wfid>.*`), the recall row (`recall.db` entries + FTS), and the cluster mailbox (`~/.arco/clusters/<cid>/mailbox/<wfid>/`). The `nuclear` tier additionally removes the bound provider session files (`~/.claude/projects/…`, Codex rollout). There is no undo — the recall row is dropped immediately rather than waiting for the projection GC.

---

## events.jsonl

Per-workflow append-only NDJSON log of every server message broadcast to observers. The single source of truth for replay on reconnect.

### Format

Each line is a JSON object: `{seq, ts, parentEventSeq?, ...message}` where `message` is any `ServerMessage` that has a `workflowId`.

```json
{"seq":1,"ts":1776548525945,"type":"workflow_created","workflowId":"abc-...","config":{"primaryProvider":"claude",...}}
{"seq":2,"ts":1776548526012,"parentEventSeq":1,"type":"user_message_echo","workflowId":"abc-...","content":"hello","timestamp":1776548526010,"clientMessageId":"opt-1"}
{"seq":3,"ts":1776548526100,"parentEventSeq":2,"type":"primary_turn_started","workflowId":"abc-...","startedAt":1776548526099}
{"seq":4,"ts":1776548526340,"parentEventSeq":3,"type":"primary_text","workflowId":"abc-...","text":"Hello! ","phase":"passthrough"}
...
```

`seq` is a per-workflow monotonic counter. `ts` is `Date.now()` at the moment of stamping (slightly after the underlying message was created). The wire-message itself may also carry a `timestamp` field — that's the message's logical timestamp; `ts` is the persistence timestamp.

`parentEventSeq` (Phase 0) links each event back to its predecessor in the workflow's events.jsonl. For linear workflows this equals `seq - 1`, so it's redundant; the field exists so Phase 9 forks can express a non-linear parent (the new branch's first event points back to the fork point, not the immediately previous seq) without a second schema bump. Absent on the very first event in a workflow and on every event in pre-Phase-0 (`schemaVersion: 1`) workflows. Readers treat absent as "previous event in seq order" — both wire (`WorkflowEvent`) and disk readers should handle the absent case.

The new persisted event kinds Phase 0 introduces (no emitters in Phase 0 itself):

- `operator_label` — operator-attached note targeting a prior event by its seq. Surfaces in HISTORY (Phase 8).
- `queue_update` — snapshot of the visible message queue (`steering[]`, `followUp[]`). Phase 4 emits on every queue mutation so replay reconstructs the queue strip.
- `branch_summary` — declared Phase 0 but still reserved/unemitted; forks/rewind instead shipped via `leaf_move` (below).
- `leaf_move` (PHASE_9_FORKS_PLAN.md, Native-first) — durable head move over the immutable log, emitted by HISTORY's REWIND CONVERSATION action. Persisted to events.jsonl **and** sets `meta.leafSeq` via atomic `writeMeta`. The branch-aware replay pre-pass treats it as a REDIRECT node — walking ancestry from the leaf jumps to its `targetSeq`, pruning the abandoned span — while the abandoned branch stays byte-identical on disk. Carries `source` (`BranchSource`; v1 only emits `'revert'`) and optional `reconstructed: true` (set when the pre-`targetSeq` events had rotated off the size-capped log, so the branch was summary-reconstructed rather than byte-replayed — hygiene-B: surface lossy rewinds, never silent).

### Write path

`workflowStore.ts` `persistAndStampSeq(cwd, wfid, message)`:

1. Look up the per-workflow buffer (a `Map<key, WorkflowBuffer>` where `key = '<cwd>::<wfid>'`).
2. Allocate `seq = ++buf.seq` synchronously.
3. Build the envelope: `JSON.stringify({seq, ts: Date.now(), ...message}) + '\n'`.
4. Push to `buf.pending` and add the byte length to `buf.pendingBytes`.
5. Return the stamped message to the caller (so the wire send can include `seq`).
6. `scheduleFlush()`:
   - If `pendingBytes >= FLUSH_BYTES_THRESHOLD (64 KB)` → flush immediately.
   - Else if no flush timer is set → set a 100ms timer that flushes on fire.

### Flush

`flushBuffer(buf)`:

1. Snapshot `pending` into `chunk`, reset `buf.pending = []` and `buf.pendingBytes = 0`.
2. Cancel any pending timer.
3. `await fs.appendFile(eventsPath, chunk.join(''))`.
4. If `buf.pending.length > 0` (events arrived during the flush), loop and flush again.
5. `buf.flushInFlight = null`.

Per-workflow flushes are serialized — at most one `appendFile` in flight at a time per workflow. The loop in step 4 prevents lost writes from arrivals during a flush.

### Crash semantics

Worst case: SIGKILL during the 100ms debounce window loses up to 100ms of events. A torn final line is possible on a crash mid-append; readers skip unparseable lines. On next `initWorkflowStore`, the tail read (`INIT_TAIL_READ_BYTES` = last 1 MB, ~2500 events) scans backward for the highest valid seq, seeds the buffer's `seq` counter, and operations resume.

The client notices the gap on next reconnect: it sent `lastSeq = X`, the server's head is `Y`, but events between were lost. The client gets a `workflow_state_snapshot` with `snapshotOnly: true` and `snapshotReason: 'events-rotated'` (technically misnamed in this case — it's "lost on disk" rather than "rotated off") and force-sets its `lastSeq` to the server's head.

### Replay

`scanEventsOfTypes` supports a synchronous visitor for bounded projections.
With a visitor it returns an empty array, streams only matching event types to
the callback and retains no matching-event history. Existing array callers keep
their behavior. Computer's input checker uses this to restore one capped latest
reply even when large later board/activity records fill a fixed byte tail;
the read flushes the existing pending append buffer and never rewrites history.

`replayEvents(cwd, wfid, fromSeq)`:

1. Open the file for reading.
2. Stream line-by-line (newline-delimited).
3. Parse each line; emit each event with `seq > fromSeq` to the caller.
4. On reaching the end, return.

Used by `handleRehydrateWorkflows` to fill the gap between client `lastSeq` and server head.

**Branch-aware pre-pass (Phase 10, Native).** When `meta.leafSeq` is set, the Claude Native resume path (`resumeSummary.ts`) does *not* replay flat seq order: `walkBranchSeqs` / `filterEventsToBranch` walk the lineage from `leafSeq`, treating each `leaf_move` they land on as a redirect to that event's `targetSeq`, and filter the event stream to just the live branch's seqs. `leafSeq` ABSENT ⇒ identity (events returned unchanged) ⇒ byte-identical to pre-Phase-10 behavior — the load-bearing no-regression invariant. This feeds the Native worker's `messages[]` cold-rebuild only; CLI/Codex (session-id / rollout resume) ignore `leafSeq`, which is why REWIND CONVERSATION is gated Native-only in v1.

### First-seq detection (snapshot-only fallback)

`readFirstSeq(cwd, wfid)`:

1. Read the first 4 KB of the file.
2. Parse the first complete line.
3. Return its `seq` (or 0 if file is empty / unparseable).

Called when deciding between replay and snapshot-only. If `clientLastSeq + 1 < firstSeq`, events have been lost (on-disk file was rotated or trimmed manually) and replay can't fill the gap; fall back to snapshot-only.

### Init

`initWorkflowStore(cwd, wfid)`:

1. Validate the wfid shape.
2. Look up or create the buffer.
3. If new buffer: `mkdir -p workflows/<wfid>/artifacts/`, drop `.arco/.gitignore` if missing.
4. Read latest seq from disk to seed `buf.seq`.
5. Mark `initialized = true`.

**GOTCHA — must `await initWorkflowStore` before the first broadcast.** If `persistAndStampSeq` is called before init resolves, seq stamping silently no-ops (the message goes live but doesn't persist). `handleCreateWorkflow` and `handleRehydrateWorkflows` both await before any broadcast.

### Shutdown

`flushAll()` walks every buffer, cancels pending timers, awaits in-flight flushes, performs a final flush of any pending. Called from the SIGTERM/SIGINT handler before `process.exit`.

### What's persisted vs transient

See [`PROTOCOL.md`](PROTOCOL.md) for the full breakdown. Briefly:

- **Persisted** (workflowId-scoped): `user_message_echo`, all `primary_*` (incl. `primary_turn_token_usage` from EFFICIENCY_PLAN.md Phase A), all `worker_*` (except `worker_activity`), `review_*`, `handoff_*`, `spawn_from_here_*` (most), `system_notice`, `queued_message_cancelled`, `plan_attached/detached`, `conversation_changed`, `workflow_created`. **Phase 0** added `operator_label`, `queue_update`, `branch_summary` (reserved). **Phase 7b** added `task_started`, `task_status`, `plan_set`, `plan_exited` (persisted on the parent workflow). **EFFICIENCY_PLAN.md Phase B** added `hook_rewrote_input`, `tool_gate_triggered`, `ctx_action` (all routed via the Native worker's `workflowEventBroadcast` callback → `broadcastWorkflow` so they get standard seq + parentEventSeq stamping). **EFFICIENCY_PLAN.md Phase C** adds `tool_filtered` (same broadcast path); when `originalBytes !== filteredBytes` the worker also writes a gzipped raw-output artifact to `artifacts/raw-tools/<turnId>-<toolUseId>.txt.gz` and stamps `rawArtifactPath` (workspace-relative) on the event, so the operator can recover what the model didn't see. **§2.1/§2.2 context-management (Native)** added `context_folded` (deterministic in-place Fold marker — **load-bearing on replay**: like `native_compacted`, replay resets at it and re-seeds `summary`+`keptTail` via `compactSummarySeed`) and `tool_evicted` (aggregate per-turn spill; like `tool_filtered` it gzips the raw output to `artifacts/raw-tools/<turnId>-<toolUseId>.txt.gz` and stamps `rawArtifactPath`, so both filtered and evicted raw output stay recoverable). **DEBAG** added `gate_required` / `gate_resolved` / `gate_standing` (all via the standard persisting broadcast path; events.jsonl is the gate audit source of truth — see gate-approvals.json above). **Phase 10 forks** added `leaf_move` (load-bearing redirect node for branch-aware replay). **Tool posture (Native)** added `tool_posture_set` (broadcast via `broadcastWorkflow` so the posture pill replays after reconnect; the posture itself is session-local — recorded in events.jsonl, deliberately NOT written to `meta.json` — see `server/src/ws/postureHandlers.ts`). **Cluster mode** added `peer_message_sent` (on sender's workflow), `peer_message_received` (on recipient's workflow — fires on `peer_read`, not pre-turn), `peer_send_rejected` (on sender's workflow), `cluster_auto_turn_fired` (on recipient's workflow, rate-limited audit). **Native compact** added `native_compacted { summary, foldedTurns? }` — the operator in-place compaction marker; it is **load-bearing on replay** (Claude and Z.ai native replay reset at it like `handoff_artifact_ready` and re-seed the summary), so it must persist. **Z.ai Native** added hidden `zai_native_history` snapshots — these are provider-history state, not UI chat; replay uses them to preserve exact GLM `reasoning_content`, assistant `tool_calls`, and tool results across service restarts; after native compact, a fresh snapshot records the exact compacted GLM seed. **Director/workers task kernel** added `task_ledger_event` (every task mutation, including `dispatch_fired`, `dispatch_skipped`, `run_started`, `run_completed`, `run_failed`, `run_reclaimed`, `run_terminated`, and `comment` ops) — the durable audit that lets `rebuildFromEvents()` reconstruct both `tasks.json` and the comment/run projection without the snapshot file. **North-star** added `goal_set { goal, byteLen }` (emitted persist-then-announce by `update_primary_config` — the meta.json write lands first, so "`goal_set` observed ⇒ value already durable"; `goal` null on clear).
- **Transient** (broadcast but not persisted): `connected`, `quota_status`, `context_usage`, `session_entry` (the JSONL is the source of truth elsewhere), `session_history_status`, `worker_activity`, `primary_activity`, `workflow_state_snapshot`, `shutdown`, `error`, `capabilities_*`, `spawn_from_here_complete`, `queued_messages_drained` (Phase 4 — drain confirmation), `codex_token_snapshot` (Phase 6 — derived from the on-disk rollout), `todos_updated` (Phase 7a — Native worker holds canonical state), `context_budget` (§2.3 token-budget meter — derived each turn from the persisted `lastPromptTokens`, never persisted itself), `ultracode_fleet_progress` (ULTRACODE_PLAN.md — live per-turn snapshot of the background subagent fleet; like `context_usage` a snapshot replaces the prior in place, never landed in events.jsonl).

The transient set is derived state; if the client disconnects and reconnects, the snapshot reconstructs them.

### Task children (Phase 7b — special replay rule)

Task lifecycle events are persisted on the parent workflow but the **client-side `taskChildren` map is rebuilt from those events**, not loaded from disk. To make refresh-after-settle work, the server re-broadcasts `task_started` and `task_status` events on rehydrate **regardless of `clientLastSeq`** — without that, a workflow whose only Task fan-out happened pre-refresh would come up showing `0s · RUNNING` forever (the lifecycle events sit below the seq cutoff). The client's `recordTaskStarted` / `recordTaskStatus` actions are idempotent so re-broadcast is safe; the same `taskChildren` map is also added to the Zustand store's `partialize` allow-list so settled state survives reload without depending on the replay path.

---

## meta.json

Per-workflow identity file. Atomic writes via `atomicFile.ts`. The type is `WorkflowMeta` in `server/src/workflowMeta.ts` (exhaustive list there); `workflowConfigFromMeta()` is the single meta → `WorkflowConfig` projection used on rehydrate and Past Chats reopen — a new persisted per-tab field must be added to **both** or it silently resets on restart.

```ts
interface WorkflowMeta {
  workflowId: string;
  schemaVersion?: number;                // 2 = Phase 0 onwards; absent / 1 = pre-Phase-0 (events.jsonl has no parentEventSeq)
  name: string;
  cwd: string;
  kind?: 'workflow' | 'chat';            // 'chat' ⇒ projectless Chat tab (cwd = ~/.arco/chats/<wfid>)
  createdAt: number;
  lastActiveAt: number;
  lastUserPreview?: string;              // flattened newest operator turn — Past Chats subtitle without reading JSONL
  primaryProvider: ProviderName;
  primaryModel: ModelName;
  primaryEffort: EffortLevel;
  providerAccountRef?: string;           // bound provider-account profile (providerAccounts.ts)
  resolvedModelId?: string;              // concrete id served behind an alias tab (capability gating on turn 1 after restart)
  cliSessions: WorkflowCliSession[];     // session ledger; Computer fresh starts retire Codex entries
  history?: SessionHistoryEntry[];       // archived sessions (Handoff / Computer fresh context)
  computerContext?: ComputerContextState; // saved Computer policy + reset boundary metadata
  operator: string;
  lastEventSeq: number | null;           // bookmark
  lastTranscriptSeq: number | null;
  compactedAt: number | null;
  autoHandoff?: { enabled, warnAt, autoAt, mode?: 'original-worker' | 'fresh-summarizer', summarizer?: { provider, model?, effort? } };
  claudeTransport?: 'cli' | 'native';
  codexTransport?: 'exec' | 'appserver';
  codexContextPolicy?: 'max' | 'standard';  // absent ⇒ MAX (dynamic from the account's models_cache.json)
  zaiTransport?: 'native' | 'appserver';
  chatWebAccess?: boolean;               // chat-only; absent ⇒ chatWebArmed() default (on for saved chats)
  autoFold?: { enabled: boolean; foldAt: number; tailBudget?: number };  // §2.1 per-tab auto-fold (Native)
  reviewSafeMode?: 'off' | 'on';         // DEBAG per-tab durable review gate; absent on rehydrate ⇒ OFF
  leafSeq?: number;                       // Phase 10 fork head pointer; absent ⇒ head is physical tail
  calibration?: { ratio, overhead, lastGroundTruth };
  planId?: string;
  planLastSeenUpdatedAt?: number;
  disableRssGuard?: boolean;
  preview?: { port: number; framework?: string; manual: boolean };
  efficiencyAutoCompact?: 'off' | 'conservative' | 'aggressive';
  efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive';
  efficiencyFactForce?: 'on' | 'off';
  efficiencySandbox?: 'off' | 'on';
  outputStyle?: 'normal' | 'lite' | 'terse' | 'caveman';   // 'caveman' legacy, aliased to 'terse' on read
  goal?: string;                                           // operator-set north-star; absent ⇒ none; ≤ 2048 B
  pinnedSkills?: Array<{ scope: 'project' | 'global'; slug: string }>; // standing +SKILL pins; bodies remain in SKILL.md
  ultracode?: boolean;                                     // sticky ultracode mode; default off; claude-only
  webSearchMaxUses?: number;                               // per-tab Native web_search/web_fetch per-turn budget; absent ⇒ 15
  claudeNativeThinkingDisplay?: 'omitted' | 'summarized' | 'updates';  // adaptive-thinking display; default 'omitted'; Native-only
  claudeNativeForceInterleavedThinkingBeta?: boolean;
  claudeNativeCompact?: boolean;         // Anthropic server-side compaction opt-in
  claudeNativeCompactUserSetAt?: number; // marks an explicit re-opt-in after the default flipped off
  nativeCompactAutoContinue?: boolean;
  efficiencyConfigProtection?: 'on' | 'off';
  remoteEnabled?: boolean;               // management-hub opt-in
  remoteGatesEnabled?: boolean;          // second arming: resolve DEBAG gates from the phone console
  managedWorktreeSourceCwd?: string;     // bake-off attempt → inherit SOURCE checkout's DD7 trust
  genesisSeed?: GenesisSeed;
  ollamaParams?: Record<string, unknown>;
  codebaseMemory?: { attached: boolean; indexPath?: string; lastIndexedAt?: number; fileCount?: number };
  mcpAllow?: McpWorkflowAllow[];                            // per-server allow-list, keyed by serverId
  previewHistory?: PreviewHistoryEntry[];
  parentWorkflowId?: string;                               // set when minted by a Native Task call
}

interface WorkflowCliSession {
  provider: ProviderName;
  sessionId: string;
  createdAt: number;
  providerAccountRef?: string;            // bound provider-account id (providerAccounts.ts)
}

interface SessionHistoryEntry {
  sessionId: string;
  provider: ProviderName;
  startedAt: number;
  endedAt: number;
  turnCount: number;
  archivedReason: 'handoff' | 'fresh-cascade-reset';
  handoffArtifactName?: string;
}
```

### Atomic write pattern

**One primitive: `server/src/atomicFile.ts`.** Every JSON/text store in the server writes through it. Do not hand-roll `tmp + rename` in a new store.

```ts
import { atomicWriteFile } from './atomicFile.js';
await atomicWriteFile(path, JSON.stringify(next, null, 2) + '\n');
```

The sequence is `mkdir -p` → write temp → **fsync** → `rename` → `rm` temp in `finally`. Options: `{ durability: 'durable' | 'advisory', mode, skipMkdir }`. `atomicWriteFileSync` is the sync twin, used only by the PID registries (which write from the shutdown path, where an async write would not finish before exit).

Why each part:

- **`rename` within one filesystem is atomic per POSIX**, so a reader never sees a half-written file. This is why the temp MUST live in the target's own directory — a temp in `os.tmpdir()` can land on a different mount, where `rename` silently degrades to a copy.
- **fsync before the rename.** `rename` only orders the *directory entry*; the bytes can still be in the page cache. Without the fsync a crash can leave a **zero-length file where a good one used to be** — the actual data-loss mode, and the reason `meta.json` / `trust.json` / `settings.json` pay for it. Pass `durability: 'advisory'` for best-effort telemetry whose loss is harmless (`recent-files.jsonl`, `skill-usage.json`); those callers already swallow write failures.
- **`randomUUID()` in the temp name.** The old per-store copies keyed the temp on `${pid}` (or `${pid}.${Date.now()}`), so two writes to one target inside the same millisecond of this long-lived process collided. A UUID removes the window instead of narrowing it.
- **`finally` cleanup.** A failed serialize / write / rename used to orphan the temp file next to the target forever. (An earlier revision of this doc claimed `crashRecovery.ts` swept those — it never did; that module only rebuilds workflow state from `known-cwds.json`. The `finally` covers every in-process failure path; only a hard `SIGKILL` mid-write can still orphan a temp.)

**Deliberately NOT fsyncing the parent directory.** That would only make the *rename itself* crash-durable. Without it a crash can lose the update, but the previous good file survives intact — losing an update is safe, a truncated file is not.

**Read-modify-write needs more than an atomic write.** Unique temp names stop two writers colliding on the rename; they do **not** stop two readers loading the same old state and last-writer-wins dropping one mutation. Any store that reads-then-writes wraps the whole critical section in `withFileLock(key, fn)` (same module — an in-process promise chain keyed per file). Currently applied to `patchSettings()`, `writeTrustDecision()` / `removeTrustDecision()`, `rememberCwd()`, `recordSkillRead()`, the cluster mailbox (enqueue / drain / discard / member-replace all lock `clusterMailboxRoot(clusterId)`), cluster `meta.json` setters (`clusterStore.ts` § `withClusterMetaLock`, order meta → mailbox), the cluster plan bridge (`cluster-plan:<id>`), `planStore.ts` index mutators, `session-index.json`, and task-ledger comment appends (`appendLedgerComment`, same per-board lock as `persistLedgerMutation`). **`meta.json` read-modify-write goes through `updateMeta(cwd, wfid, mutate)`** (`workflowMeta.ts`), which holds the lock on the meta path; every helper there (`touchLastActive`, `appendCliSession`, `setResolvedModelId`, `reconcileLatestCliSession`, …) is built on it. A bare `readMeta` → `writeMeta` pair is still unserialized — convert it to `updateMeta`. `withFileLock` is not re-entrant: never call `updateMeta` (or a helper built on it) from inside a `mutate` for the same workflow.

**Not for `events.jsonl`.** That log is append-only through `workflowStore.ts` and must never be rewritten through this primitive.

### Field-by-field

- **`workflowId`** — UUID matching `^[a-zA-Z0-9-]{1,64}$`. Stable across server restarts.
- **`schemaVersion`** — current value `2` (Phase 0). Absent or `1` on pre-Phase-0 metas. Migration is **lazy-on-read**: a v1 meta loads as-is and is rewritten as v2 the next time `writeMeta` runs against it (any meta-mutating handler — `touchLastActive`, `appendCliSession`, etc.). No events.jsonl rewrite — replay infers `parentEventSeq` from seq order on v1 events.
- **`name`** — operator-provided display name. Editable.
- **`cwd`** — absolute path to the working directory. Used for everything path-scoped.
- **`createdAt` / `lastActiveAt`** — epoch ms. `lastActiveAt` updates on every primary turn (via `touchLastActive()`).
- **`primaryProvider/Model/Effort`** — current primary config. Phase 8 renamed these from `orchestrator*`; `readMeta` has a back-compat shim that maps the old keys → new keys, so pre-Phase-8 meta files still load.
- **`cliSessions[]`** — ledger of CLI sessions bound to this workflow. Newest last. Entries are added on session mint; for Codex, the placeholder UUID is reconciled in place once the real thread_id arrives (`reconcileLatestCliSession()`). Computer fresh-context boundaries retire Codex entries after archiving the active session; this prevents restart from resuming an archived thread.
- **`history[]`** — archived sessions from Handoff or Computer fresh starts (`archivedReason: 'computer-fresh-context'`). Handoff sessions can appear in both `cliSessions[]` and `history[]` (live, then later rotated). Carries timestamps and a turnCount snapshot; Handoff entries also carry their artifact link.
- **`computerContext`** — Computer-only reset policy and boundary state: `resetAtPercent` (undefined selects 50% subscription / 75% local; null means OFF), `keepContext` (default false), `resets`, optional `pendingFresh`, `pendingFreshReason`, `lastResetAt`, `lastResetSeq`, `lastResetReason` and `previousSessionId`. `voice/computerContext.ts` serializes controls/reset checks and uses `updateMeta` for atomic archive + active-ledger retirement before broadcasting `computer_context_updated`. Saved transcript/rollout remain intact; no old messages or summary reach the next model thread. Incognito state stays memory-only; losing its ephemeral Codex connection clears it visibly with reason `recovery`. Ordinary manual/threshold resets wait for a settled turn/queue; the stall watchdog only stops work and cancels queued requests, never executes a command on a timer.
- **`operator`** — currently always `'operator'`; multi-user support is unimplemented.
- **`lastEventSeq` / `lastTranscriptSeq`** — bookmarks; rarely read in Lite. Vestigial from earlier autonomous version's recovery flows.
- **`compactedAt`** — null in Lite. Vestigial.
- **`autoHandoff`** — `{ enabled: bool, warnAt: 0–100, autoAt: 0–100 }`. Persisted from the CONFIG tab. Read by `maybeAutoHandoff()` after each primary turn.
- **`autoFold`** — `{ enabled, foldAt, tailBudget? }` (§2.1). Per-tab arming of the deterministic in-place Fold auto-trigger (Claude Native). Persisted so arming survives restart; default OFF.
- **`reviewSafeMode`** — `'off' | 'on'` (DEBAG). Arms the durable edit-before-approve gate. Default OFF; **absent on rehydrate ⇒ OFF** (opting in is always explicit). Native-only. Drives whether `gate-approvals.json` is written.
- **`leafSeq`** — Phase 10 fork head. Absent ⇒ head is the physical file tail (byte-identical, no-regression invariant). When set, the Native branch-aware replay walks lineage following `leaf_move` redirects so a rewound head replays only its own branch.
- **`calibration`** — `{ ratio, overhead, lastGroundTruth }`. The persisted ground-truth context-fill ratio for the current CLI session. Seeded into `WorkflowState.calibration` on rehydrate so a server restart doesn't drop back to the default heuristic. `zonesCalibrated` (in-memory) is **not** persisted — restart re-enters zones fresh so calibration refreshes against current session state.
- **`planId` / `planLastSeenUpdatedAt`** — attached plan and the plan's `updatedAt` at last injection. If the plan body is edited between turns, the next turn detects the difference and injects a refresh notice so the agent picks up the change.
- **`disableRssGuard`** — opt-out for the 32 GB tree-RSS kill. Set only for workflows running legitimate high-memory workloads (kernel compiles, big LTO links). Honored only for primary turns; reviewers and handoff reflections always run under the global cap.
- **`preview`** — `{ port, framework?, manual }`. Currently bound dev-server port for the Preview tab. `manual: true` means the operator typed the port and hit BIND; `manual: false` means `previewAutoDetect` resolved it. The auto-detector never overwrites a `manual: true` entry. On rehydrate the server broadcasts `preview_set` with `freshlyBound: false` so the UI restores the iframe without auto-flipping the active tab.
- **`previewHistory`** — most-recent-first list of bound dev-server ports for this workflow (capped at 5). Append on every successful `set_preview_port`; consecutive same-port events dedupe to a timestamp refresh. Replayed via `preview_history` on rehydrate alongside `preview_set` so reconnect doesn't lose the chain.
- **`claudeTransport`** — `'cli' | 'native' | undefined` (Phase 7a). Per-tab override of the global `claude.transport` setting. Persisted so tab reload picks up the choice without consulting cascade. **Meta-reconcile is gated on `claudeTransport !== 'native'`** — Native sessions write no CLI rollout, so the dispatcher must not pin a phantom CLI session UUID on `wf.primarySessionId` (it would auto-degrade an original-worker Spawn into a `claude --resume <phantom>` against a missing rollout, killing the handoff silently). **Session storage note:** the Claude Native transport writes to the same `~/.claude/projects/<cwd-hash>/<sessionId>.jsonl` path that the CLI transport uses — it's Claude Code's own session file, written by the SDK's built-in JSONL logger. Arco reads this file via the session watcher (`chokidar`) to drive `session_entry` events regardless of transport.
- **`codexTransport`** — `'exec' | 'appserver' | undefined` (Phase 6e). Per-tab override of the global `codex.transport` setting; same persistence semantics.
- **`claudeNativeCompact`** / **`autoHandoff`** — Phase 7c per-tab toggles for Native server-side compaction and Arco-managed handoff. See PROVIDERS.md § Claude Native § Context management.
- **`efficiencyAutoCompact`** — `'off' | 'conservative' | 'aggressive' | undefined` (EFFICIENCY_PLAN.md Phase 6b.2). Per-tab opt-in to the auto-threshold `ctx_action {trigger: 'auto-threshold'}` emission. Honored only on Claude Native turns.
- **`efficiencyToolFilter`** — `'off' | 'conservative' | 'aggressive' | undefined` (EFFICIENCY_PLAN.md Phase C). Per-tab Native tool-result filter mode. Honored only on Claude Native turns.
- **`outputStyle`** — `'normal' | 'lite' | 'terse' | undefined` (OUTPUT_STYLE_PLAN.md). Per-tab output-style picker. Persists across server restart; honored by Claude Native, Codex app-server, and Z.ai turns. Review / Handoff seed / DOCS / GIT primitives hard-code `'normal'` regardless of the persisted value. Legacy `'caveman'` values in pre-2026-05-10 meta.json files are auto-aliased to `'terse'` on read. See PROVIDERS.md § Claude Native § Output style.
- **`goal`** — `string | undefined` (GOAL_NORTHSTAR_PLAN.md). Per-tab operator-set persistent **north-star**: a short free-text objective injected as a stable system block every turn on every transport that folds `clusterPlan` (Native, CLI Claude, both Codex, Z.ai native, Cursor (ACP + print), Ollama/llama.cpp/LM Studio). Zero model authority — pure steering context, never a controller; there is no model tool that mutates it. Persists across server restart; absent/blank on rehydrate ⇒ no block (byte-identical to pre-feature behavior). Capped at `GOAL_MAX_BYTES = 2048` (trimmed on write by `capGoal`). Set/edit/clear via `update_primary_config`, which emits a `goal_set { goal, byteLen }` event to `events.jsonl`. **Unlike `outputStyle`**, Review / Handoff / DOCS / GIT / Spawn / Task-child seeds INHERIT it. See `docs/GOAL_NORTHSTAR_PLAN.md`.
- **`ultracode`** — `boolean | undefined` (ULTRACODE_PLAN.md). Sticky ultracode mode; default OFF. Survives restart so a tab left in ultracode resumes there. Claude-only.
- **`webSearchMaxUses`** — `number | undefined`. Per-tab Native `web_search`/`web_fetch` per-turn budget (server-tool `max_uses`). Absent ⇒ server default (15). Native-only.
- **`claudeNativeThinkingDisplay`** — `'omitted' | 'summarized' | 'updates' | undefined`. Adaptive-thinking display; default `'omitted'` when absent; `'summarized'` streams thinking into the Activity tab; `'updates'` only on models with `supportsThinkingDisplayUpdates`. Native-only.
- **`kind` / `lastUserPreview` / `chatWebAccess`** — Chat-mode fields. `kind:'chat'` routes the meta to `~/.arco/chats/`, skips the project session-index upsert, and is what `GET /api/chats` filters on; `lastUserPreview` is capped + flattened on write so Past Chats never reads JSONL; `chatWebAccess` is written only for chat metas.
- **`codexContextPolicy`** — `'max' | 'standard' | undefined`. Absent ⇒ MAX, resolved at spawn from the account's `$CODEX_HOME/models_cache.json`. Part of the app-server bootstrap signature, so a change recycles the child and resumes the same thread.
- **`resolvedModelId`** — the concrete id the API served behind an alias (`opus` → `claude-opus-5-5`), written fire-and-forget by the Native worker so turn 1 after a restart gates capabilities correctly. The alias stays in `primaryModel` so auto-tracking is preserved.
- **`parentWorkflowId`** (Phase 7b) — set when this workflow was minted by a Native `Task` tool call. Both `meta.json` and the broadcast `workflow_created` carry it; the client uses it to suppress tab creation + active-tab switch while the workflow is parented + unpromoted (TabBar filters parented children where `!promoted`).

### Read / write helpers

- `readMeta(cwd, wfid)` — load + validate. Includes the `orchestrator*` → `primary*` back-compat shim. Returns `null` if missing.
- `ensureMeta(cwd, seed)` — read or create-from-seed. Used on rehydrate for metas that predate meta.json.
- `writeMeta(cwd, meta)` — atomic full-file write; stamps `schemaVersion`, then fires (never awaits) the Recall upsert and, for non-chat metas, the session-index upsert — both are rebuildable projections, so their failure never fails the meta write.
- `workflowConfigFromMeta(meta, cwd)` — meta → `WorkflowConfig` projection (rehydrate, Past Chats).
- `setResolvedModelId`, `clearProviderCliSessions`, `setMcpAllow`, `setMcpProbedTools` — single-field mutators.
- `appendCliSession(cwd, wfid, session)` — append to `cliSessions[]`.
- `reconcileLatestCliSession(cwd, wfid, realSessionId)` — replace the latest entry's `sessionId` (Codex placeholder reconciliation).
- `appendHistoryEntry(cwd, wfid, entry)` — append to `history[]`.
- `touchLastActive(cwd, wfid)` — update `lastActiveAt` only.
- `listWorkflowMetas(cwd)` — list all workflows under a cwd (tooling helper).

---

## sandbox.db (Phase E)

`<cwd>/.arco/workflows/<wfid>/sandbox.db` — per-tab SQLite database opened by `server/src/providers/claude-native/sandboxStore.ts` (via `better-sqlite3`). Holds chunks produced by `ctx_execute` for later retrieval via `ctx_search` (BM25 over FTS5) / `ctx_fetch` (by chunkId). Only created when the operator flips `efficiencySandbox = 'on'` on a Claude Native tab; tabs that never opt in have no file on disk.

Schema (one `chunks` table + one FTS5 virtual table + two triggers keeping the mirror in sync):

```sql
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  language TEXT NOT NULL,
  content TEXT NOT NULL,
  byte_len INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE chunks_fts USING fts5(content, content='chunks', content_rowid='id');
```

`journal_mode=WAL`, so the file pair `sandbox.db-wal` + `sandbox.db-shm` lives alongside while the database is open. Best-effort-unlinked together with the main file on `remove_workflow` / `destroySandbox`. The `sandbox-tmp/run-XXXX/` directories are per-call subprocess workdirs (script + cwd-writes) and are `rmSync`-cleaned when the call settles; a process-kill (SIGTERM / SIGKILL escalation on the executor's 10 s timeout) may leave one behind which the next workflow tear-down won't sweep (they're harmless but visible — a `find` reaper is a possible future cleanup task).

**Lifecycle:**

- Created lazily on first `ctx_execute` insert (or operator click on the Files-tab SANDBOX sub-section's stats endpoint, which triggers a `getSandboxStore` that opens the file with `CREATE TABLE IF NOT EXISTS`).
- Operator CLEAR DB (`POST /api/workflows/:wfId/sandbox/clear`) truncates the table and rebuilds the FTS5 index — file stays on disk, ready for new chunks.
- Tab close (`remove_workflow`) closes the cached handle and unlinks the file + WAL sidecars.
- Server restart with workflow still alive: rehydrate restores `WorkflowConfig.efficiencySandbox` from meta.json; the next ctx_execute call re-opens the file (chunks preserved).

**Not persisted via the standard event ledger.** Chunks live in SQLite, not events.jsonl. The events.jsonl ledger records `sandbox_chunk_added` / `sandbox_db_cleared` events for transcript-review attribution, but the chunk *content* is in the sandbox.db only — the rationale being that ctx_execute output may be large enough that NDJSON-stamping every byte through `persistAndStampSeq` would balloon events.jsonl pathologically. The SQLite file is per-tab and unlinked on tab close, so there's no aggregate-storage concern; if the operator wants a chunk preserved across tab closes they should ctx_fetch it and have the model commit it to a file via `Write`.

---

## gate-approvals.json (DEBAG)

`<cwd>/.arco/workflows/<wfid>/gate-approvals.json` — per-workflow, session-scoped sidecar written by `server/src/providers/claude-native/gateStore.ts` (atomic tmp+rename). Shape `{ schemaVersion: 1, pending: PendingGateRecord[], standing: StandingApproval[] }`. `pending[]` holds any UNRESOLVED gate so a systemd restart can re-surface the approval card (`rehydrateGatesOnce`); `standing[]` holds "approve all like this" approvals keyed by the gate's non-lossy `signature` (a changed signature ⇒ a fresh gate, never silently re-approved). **events.jsonl stays the durable gate audit source of truth** (`gate_required` / `gate_resolved` / `gate_standing`); this sidecar is only the fast rehydrate lookup. Per-wfid (never cross-member on a shared cwd) and Native tool dispatch is sequential, so the read-modify-write needs no lock. Only written when the operator arms `reviewSafeMode='on'` on a Claude Native tab; tabs that never opt in have no file on disk. See [`DEBAG_PLAN.md`](DEBAG_PLAN.md).

---

## Artifacts

`<cwd>/.arco/workflows/<wfid>/artifacts/review-<ts>.md` — Review primitive outputs. YAML frontmatter + body:

```markdown
---
reviewId: review-1719999999-abc
createdAt: 2026-04-26T10:30:00.000Z
verdict: MINOR
contextRef: { kind: 'last-turn' }
reviewer: { provider: codex, model: high, effort: high }
primary: { provider: claude, model: opus, effort: high }
---

## Summary
The change correctly addresses the reported bug...

## Concerns
- The `recordTurnCancelled` clear path skips...

Verdict: MINOR
```

Other artifact paths (worker-written outputs from a primary turn) live in the same `artifacts/` directory but use whatever name the primary chose.

Served by `GET /api/workflows/artifact?path=<cwd>&workflowId=<wfid>&name=<filename>`.

---

## Handoffs

`<cwd>/.arco/workflows/<wfid>/handoffs/handoff-<ts>.md` — Handoff primitive outputs.

The two modes produce different content:

- **`original-worker`** — the primary's self-reflection. Open-ended structure: the primary follows the prompt's instructions to capture git state, project docs, and current direction. Ends with `[HANDOFF_COMPLETE]`.
- **`fresh-summarizer`** — an ephemeral worker's structured summary based on the rendered transcript. Lower fidelity; doesn't see git state or project files.

Served by `GET /api/workflows/handoff?path=<cwd>&workflowId=<wfid>&name=<filename>`. Separate endpoint from `/artifact` so the path-traversal guard stays tight on each.

---

## Plan store

`server/src/planStore.ts` manages long-form markdown briefs scoped per cwd. Plans live at `<cwd>/.arco/plans/`:

```
plans/
├── index.json                       # [{ id, title, createdAt, updatedAt, attachments, completedAt }]
└── <planId>.md                      # markdown body
```

`index.json` entry shape:

```ts
{
  id: string,
  title: string,
  createdAt: number,
  updatedAt: number,
  attachments?: Array<{                // every attach/detach span (open + closed)
    workflowId: string,
    workflowName: string,              // snapshotted at attach time
    attachedAt: number,
    detachedAt: number | null,         // null = currently attached
  }>,
  completedAt?: number | null,         // null/undefined = active; timestamp = archived
}
```

Constraints:

- Title: max 200 chars
- Body: max 256 KB
- Per-cwd, not per-workflow — same plan can be attached to multiple workflows simultaneously.
- Multiple plans per cwd.
- No auto-binding by cwd; explicit attachment via `plan_attach` WS message or by clicking a plan in the Plan tab list.

### Helpers

- `listPlans(cwd)` — return summaries sorted by `updatedAt` desc.
- `readPlan(cwd, planId)` — return `PlanFull` `{ id, title, body, createdAt, updatedAt, attachments?, completedAt? }`. Returns `null` on missing.
- `readPlanSummary(cwd, planId)` — same shape minus `body`. Used by attach handlers that don't need the body.
- `createPlan(cwd, { title, body })` — mint a new planId, write `index.json` + `<id>.md`. Initializes `attachments: []` and `completedAt: null`.
- `updatePlan(cwd, planId, { title?, body?, completedAt? })` — partial update; bumps `updatedAt`. Body writes hit disk via atomic tmp+rename.
- `deletePlan(cwd, planId)` — remove the entry from index and unlink the body file. Caller is responsible for detaching workflows beforehand and setting the watcher skip-flag.
- `recordAttachment(cwd, planId, workflowId, workflowName)` — append an open attachment span (idempotent: no-op if an open span for the pair already exists, so rehydrate-replay doesn't double-add).
- `recordDetachment(cwd, planId, workflowId)` — flip the open span's `detachedAt` to now.
- `closeOpenSpansForWorkflow(cwd, workflowId)` — bulk close every open span referencing a workflow. Called from `handleRemoveWorkflow` so closing a tab marks all of its open spans complete (the spans persist in "previously attached" history rather than being deleted).
- `reconcilePlanFile(cwd, planId)` — watcher-driven re-read: if the file exists, bump `updatedAt` (and seed an entry from the H1 if the agent created the file directly); if it's gone, drop the entry and signal `kind: 'deleted'`.

### Filesystem watcher

`acquirePlansWatcher(cwd)` / `releasePlansWatcher(cwd)` (in `server/src/server/broadcast.ts`) ref-count an `fs.watch` on `<cwd>/.arco/plans/`. Acquired on `plan_attach` (and on rehydrate when meta.planId resurfaces); released on `plan_detach`, mark-complete (auto-detach path), tab close, and plan delete.

The watcher debounces 200ms and filters to `*.md`. On fire it calls `reconcilePlanFile` and:

- `kind: 'updated'` → broadcasts a fresh `plan_attached` (carrying the new `updatedAt`) to every workflow attached to the plan. Clients see `plan?.updatedAt` change → refetch body via `GET /api/plans/body` → render the new content (including any new `- [ ]` checklist lines).
- `kind: 'deleted'` → emulates `plan_detach` for every attached workflow: clears `wf.planId`, scrubs `meta.json`, broadcasts `plan_detached`, releases the watcher.

**Skip-flag dedup.** REST `PATCH` (when it touches the body) and `DELETE` both write the file themselves and broadcast directly; before doing so they push the planId onto `watcherState.skipNext` so the inevitable subsequent watcher fire on that file is consumed silently. Without this the operator UI would receive two `plan_attached` (or detached) messages per edit.

### Per-turn injection

When `wf.planId` is set, `buildPlanPrefix()` prepends a one-line `[Active project plan: …]` header to the user's prompt. The header is always a one-liner — the full body is **never** injected. Three variants based on `meta.planLastSeenUpdatedAt`:

| State | Variant |
|---|---|
| `lastSeen === 0` (first turn after attach) | `"…newly attached. Read the brief at .arco/plans/<id>.md to orient. <livingDocNote>"` |
| `plan.updatedAt > lastSeen` (edited since last turn) | `"…edited since last turn. Re-read .arco/plans/<id>.md if you need the current state. <livingDocNote>"` |
| stable | `"…file: .arco/plans/<id>.md. <livingDocNote>"` |

`<livingDocNote>` is the directive to keep the plan current as work progresses: tick `- [ ]` → `- [x]`, add findings, update open questions, append sections.

After the turn, `meta.planLastSeenUpdatedAt = plan.updatedAt` so the next turn falls back to the stable form unless another edit lands in between.

**Why one-liner only.** Earlier behavior injected the full body on first attach AND on every edit. Two problems: (a) the agent's own edits (tick-offs etc.) bumped `updatedAt`, which re-injected the body the very next turn — a feedback loop where every working turn re-injected ~1.5–5KB of plan prose; (b) Claude's session JSONL records the full prompt verbatim, so the prefix surfaced as a duplicate user bubble in chat (the clean copy comes from `user_message_echo`). One-liner only avoids both.

**`stripPlanPrefix` in `toSessionEntries`.** Even with the one-liner, the prefix would still echo into chat via the session JSONL. The session_entry emitter strips it via `PLAN_PREFIX_RE = /^\[Active project plan[^\n]*\]\n(?:<plan>\n[\s\S]*?\n<\/plan>\n)?\n/` (the optional `<plan>...</plan>` branch is kept so any historical entries written under the old behavior also strip cleanly). Anchored at message start so user-typed content that mentions plans later is untouched.

Plans survive across workflows, server restarts, and Handoffs. `wf.planId` persists in `meta.json`; rehydrate re-acquires the watcher and idempotently re-records the open attachment span.

### Plan continuity across Handoff and Spawn

- **Handoff** preserves the attachment in-place. The same workflowId and meta.json carry forward; `wf.planId` doesn't move. To make sure the post-handoff session realizes there's a plan attached (its agent has zero context of the prior session), `handleHandoffRequest` resets `meta.planLastSeenUpdatedAt = 0` so the seed turn's `buildPlanPrefix` emits the *newly-attached* form ("Read the brief at .arco/plans/<id>.md to orient") rather than the stable one-liner.
- **Spawn** is plan-free by default. A new workflowId + fresh `meta.json` means `planId` isn't carried over. The SpawnDialog exposes an "Include plan from parent" checkbox (only when the parent has one attached); checking it sets `SpawnFromHereRequestMessage.includePlan: true`. Server-side, `handleSpawnFromHere` then mirrors `handlePlanAttach` for the new workflow: writes `planId` to its meta, runs `recordAttachment` (so the plan's `attachments[]` shows the spawn under "Active in"), acquires the plans-watcher, and broadcasts `plan_attached` to the new tab. The seed turn's prefix is "newly attached" because the new meta starts with `planLastSeenUpdatedAt = 0`.

### Lifecycle: complete vs. delete

- **Mark complete** (`PATCH { completedAt: <ts> }`) — server auto-detaches every workflow currently attached (closes spans, broadcasts `plan_detached`, releases watcher refs), then sets the timestamp. The plan moves into the Plan tab's collapsed "Completed" section.
- **Reopen** (`PATCH { completedAt: null }`) — just clears the timestamp; does NOT auto-attach. The plan returns to the active list; operator clicks to re-attach.
- **Delete** (`DELETE`) — detaches all workflows first, then removes the index entry and the body file. Confirmation is required client-side; this is destructive.

### Coupling

- A deleted plan file leaves the attachment dangling (briefly) — next turn's `buildPlanPrefix()` returns empty AND clears `wf.planId` + broadcasts `plan_detached`. The watcher reconcile path independently handles the same case for external deletes.
- `meta.planId` clears on Handoff only if the operator explicitly detaches; otherwise it persists. The Handoff seed prompt acknowledges the attachment so the new session knows what's pinned.

---

## Knowledge base (per-cwd)

`server/src/knowledge/store.ts` manages an operator-owned, per-cwd knowledge base at `<cwd>/.arco/knowledge/` — `index.json` (`{ articles: [{ id, title, tags, alwaysInclude, ... }] }`, with each article's summary + byte length mirrored so list/query stay O(N)) plus `<id>.md` bodies. Atomic tmp+rename, cloned from `planStore.ts` / `workflowMeta.ts`. THE FENCE: this store is pure operator-curated state — never LLM-mutated. `alwaysInclude` articles are folded into the primary turn's system prompt up to a KB budget.

---

## Project task ledger (per-cwd)

`server/src/project/taskLedger.ts` writes `<cwd>/.arco/project/tasks.json` — a versioned task-kernel snapshot. The full shape is `{ version, tasks, comments?, runs? }` where `comments` and `runs` are omitted when empty. Legacy `{ tasks }` snapshots (no `version`) still load and are upgraded on the next save. Atomic tmp+rename.

`comments` are durable per-task notes (appended via `cluster_task_comment` / `peerTaskComment`); `runs` are per-task attempt records (opened by dispatch, closed by heartbeat timeout or recovery). Both are rebuilt from `events.jsonl` on cache miss via `rebuildCommentsFromEvents` / `rebuildRunsFromEvents`, so the file is a rebuildable projection — deleting it forces a rebuild from the event log, losing nothing permanent.

The durable record is the `task_ledger_event` stream in the cwd's workflow `events.jsonl` files. Each mutation appends one event (`op` ∈ `create | update | delete | archive | link | unlink | comment | claim | heartbeat | run_started | run_completed | run_failed | run_reclaimed | run_terminated | promote | dispatch_fired | dispatch_skipped`) with a `task?` snapshot and optional `payload.comment` / `payload.run` for comment/run-only lifecycle events.

Full field-level documentation: [`TASK_LEDGER.md`](TASK_LEDGER.md).

## Orchestration proposals (per-cwd)

`server/src/project/orchestrationProposals.ts` writes `<cwd>/.arco/project/orchestration-proposals.json` — the persisted proposal cache for Stage K operator-armed orchestration assist. Shape: `{ version, proposals: OrchestrationProposal[] }`. Atomic write via the shared `atomicFile.ts` primitive.

Proposals are stored only while they are pending operator action (accept / apply / reject). An applied proposal executes through the normal task-kernel APIs (emitting ordinary `task_ledger_event`s) and is then removed from the store; a rejected proposal is removed without mutation. The file is ephemeral by design — deleting it loses any pending proposals but nothing in the task kernel. Full shape and lifecycle: [`TASK_LEDGER.md § Orchestration proposals`](TASK_LEDGER.md).

## Managed task worktrees

`~/.arco/worktrees/<cwd-hash>/` — isolated git worktrees pinned to individual tasks (one per task when `worktreeRequired` or `autoWorktree` is set). Created by `cluster_task_worktree_create` / `task_worktree_create` WS messages via `server/src/project/taskWorktree.ts`. Removed by the corresponding `*_remove` message or when the task is archived. These are standard git worktrees (`git worktree add`) and survive server restarts; the path is stored in `LedgerTask.worktree` (task-kernel field, not a separate file). Worktrees for tasks in different cwds are isolated by the `<cwd-hash>` prefix.

---

## Operator-global state (`~/.arco/`)

```
~/.arco/
├── settings.json                    # operator preferences (global layer)
├── chats/<wfid>/.arco/workflows/<wfid>/ # saved projectless Chat meta + events (never incognito)
├── auth.json                        # Claude Native OAuth token (claude.native namespace, 0600)
├── provider-secrets.json            # Z.ai API key (providerSecrets.ts; 0600, never returned to clients)
├── models.md                        # vestigial model catalog (Settings-editable, unconsumed — see below)
├── llamacpp.json                    # GGUF catalog (alias → ggufPath + options)
├── known-cwds.json                  # crash-recovery registry
├── workspace.json                   # server-authoritative open tabs: { version, workflows: {wfid → {config, parentWorkflowId?, openedAt}}, clusters: [id] } (workspace.ts; workspace-<port>.json off 3001)
├── worker-pids.json                 # live worker PIDs + start times for orphan reaping
├── terminal-pids.json               # same shape, terminal PTYs (terminal/ptyPidRegistry.ts)
├── logs/arco.log[.1–.5]           # structured JSONL log, size-rotated (server/logger.ts; ARCO_LOG_MAX_BYTES, default 5 MB)
├── llamacpp.log                     # shared llama-server daemon log (why llama.cpp is refused for incognito)
├── media-scratch/<uuid>/            # imported media staged for ffmpeg/demucs (media/scratch.ts; 24 h TTL, 16 GiB cap)
├── camoufox-chatgpt-profile/        # headless-browser profile for the Codex usage scrape (codexUsage.ts)
├── genesis/<wfid>/                  # Genesis scaffold roots (genesis/scaffold.ts)
├── instance-id / instance-name      # management-hub identity (management/identity.ts)
├── calibration.md                   # vestigial pre-Lite calibration log (nothing writes it now)
├── notification-mutes.json          # muted notification categories (notifications.ts)
├── cluster-presets.json             # saved cluster presets (clusterPresets.ts)
├── cluster-snapshots/               # local full cluster snapshots; portable export source
├── cluster-vault.key                # local-only 256-bit cloud-envelope key (0600; never uploaded)
├── templates.json                   # workflow templates (templates/store.ts)
├── skill-usage.json                 # §5.2 skill-usage telemetry (skillUsage.ts)
├── recent-files.jsonl              # agent file-writes ledger (recentFilesLedger.ts) — powers ARCHIVE RECENTS
├── trust.json                       # DD7 project-trust decisions (projectTrust.ts)
├── prompts/                          # DD10 /prompt templates (global, ungated)
│   └── <name>.md
├── handoff.prompt.md                # optional global original-worker handoff prompt override
├── handoff.summarizer.prompt.md     # optional global fresh-summarizer handoff prompt override
├── recall/                          # Workbench §F1 — Recall session index
│   ├── recall.db                    # SQLite projection of every workflow (rebuildable)
│   └── <wfid>/summary.md            # F2 operator-triggered conversation summary (recall/summarize.ts)
├── mcp/                             # operator-registered MCP server defs (mcp/registry.ts)
│   └── registry.json                # { servers: [...] }
├── provider-accounts/               # per-account isolated provider homes (providerAccounts.ts)
│   └── codex-<id>/                  # CODEX_HOME for a configured Codex account (config.toml)
├── checkpoints/                     # non-git checkpoint store (gitSnapshots.ts)
│   └── <cwd-hash>/
│       ├── git/                     # bare shadow repo — refs/arco/<wfid>/<seq>
│       ├── <wfid>.<seq>.skipped.json
│       └── <wfid>.<seq>.tar         # LEGACY only — read, never created
├── bakeoffs/                        # operator-armed implementation races
│   └── <cwd-hash>/
│       ├── manifests/
│       │   └── <bakeoffId>.json     # durable attempts/status/winner record
│       └── worktrees/
│           └── <bakeoffId>/<attemptId>/ # managed linked git checkout
├── worktrees/                       # optional per-task git worktrees (project/taskWorktree.ts)
│   └── <cwd-hash>/
├── skills/                          # global operator skills
│   └── <slug>/
│       └── SKILL.md
├── cli-snapshots/                   # provider CLI version snapshots
│   ├── <provider>.txt               # raw --version/--help capture
│   ├── <provider>.meta.json
│   └── <diff file>                  # written when a change is detected; served by GET /api/cli-snapshot?name=
├── clusters/                        # CLUSTER_MODE_PLAN.md Phase 1
│   └── <clusterId>/
│       ├── meta.json                # ClusterState (members[], cwd, createdAt ISO, taskBoardMode, efficiencyLevel, dispatcher, memberRoles/Tiers/Focuses, progressTracking, …)
│       ├── plan.md                  # shared cluster plan body
│       ├── plan.meta.json           # { updatedAt } sidecar for plan.md
│       └── mailbox/
│           └── <recipientWfId>/
│               └── <msgId>.json     # one file per pending peer message
└── antigravity-data/                # isolated Antigravity user-data-dir
    ├── User/
    ├── CachedData/
    └── ...
```

### bakeoffs/

`server/src/bakeoffStore.ts` + `server/src/gitBakeoff.ts`. The cwd hash
partitions manifests and managed linked worktrees; every manifest read also
validates the exact source cwd and source workflow id. Worktrees are created
only from a clean recorded `HEAD`. Operator cleanup force-removes only a path
proven to be beneath this managed root and registered by git, while preserving
the attempt branch and manifest. Project workflow journals created inside an
attempt checkout are excluded from candidate diffs and promotion.

### clusters/

Per-cluster directory tree, created by `POST /api/clusters` or the WS create path (`server/src/clusterStore.ts`). `meta.json` is written under `proper-lockfile` (cross-process writer serialization) **and** through `atomicFile.ts` (crash-safe body) — complementary, neither substitutes for the other. The cluster plan body lives at `plan.md` alongside `meta.json` (`server/src/clusterPlanStore.ts`), with a `plan.meta.json` sidecar holding `{ updatedAt }`.

Phase 12's board surface introduces **no new persistence**: `taskBoardMode` (`'project'` for new clusters — the default-attach — `'none'`, or a cluster-private board keyed by `taskBoardKey`) in cluster `meta.json` selects the board, and the board reads/writes the existing per-cwd project task ledger (`<cwd>/.arco/project/tasks.json` + the `task_ledger_event` stream covered above). Cluster `meta.json` also carries `efficiencyLevel`/`efficiencyAddendum`, `dispatcher`, `memberRoles`/`memberTiers`/`memberFocuses`, `idleNudgerEnabled`, `autoTurnOnMailboxEnabled`, `planId`, and `progressTracking` (`'plan'|'board'|'both'`, set via the `cluster_progress_set` client message; persisted **only when non-default** — default `'both'` writes nothing, so pre-feature cluster meta stays byte-identical).

**Mailbox** — one file per pending peer message under `mailbox/<recipientWfId>/<msgId>.json`. `peer_send` writes the file **atomically** (`atomicFile.ts`; a concurrent drain reading a half-written message would parse-fail and be unlinked as "stale", silently losing it); the recipient's `peer_read` tool call drains (`clusterMailbox.drain` reads + unlinks all files). Drain is destructive: the file is removed after reading. The durable record of each delivered peer message lives in the recipient's `events.jsonl` as a `peer_message_received` event — mailbox files are ephemeral by design. Operator can cancel an individual pending message via `DELETE /api/clusters/:id/mailbox/:wfid/:msgId` (`clusterMailbox.discard` — unlinks the file without emitting any event). Message id format: `<epochMs>-<8-char-uuid>` — ms prefix gives lexicographic chronological order without `stat()`.

**Mailbox write path invariant:** workers are NOT pre-injected with peer message content before their turn. `handleUserMessage` calls `clusterMailbox.depthFor` and folds a notice into `appendSystemPrompt` ("You have N pending peer messages. Call `peer_read` to drain them.") so the worker knows to act; the actual content arrives only when `peer_read` fires. This avoids the false-negative where the model saw "no new peer messages" because a pre-turn drain had already consumed the files.

`DELETE /api/clusters/<id>` removes the cluster directory entirely. Members keep working as plain workflows on their next turn — peer tools simply disappear from the worker's tool list because `clusterStore.getClusterIdForWorkflow` returns undefined.

**Per-cwd handoff serialization** — Two cluster members sharing a cwd can both trigger handoffs simultaneously. `handleHandoffRequest` installs each handoff onto a `Map<cwd, Promise>` chain (`cwdHandoffChain` in `server/src/server/state.ts`, driven from `ws/handoffHandlers.ts`). A queued handoff awaits the prior one before reading repo state (git status, DEVLOG.md prepend). Slot releases via `try/finally` regardless of outcome. The operator sees a `system_notice` "[HANDOFF QUEUED]…" in chat when their handoff must wait. Standalone tabs in unrelated cwds run in parallel; only same-cwd handoffs serialize. See `docs/GOTCHAS.md § Handoffs serialize per-cwd`.

New events on workflow `events.jsonl` (one or more, depending on activity): `peer_message_sent` (sender), `peer_message_received` (recipient — fires on `peer_read`, not pre-turn), `peer_send_rejected` (sender, on policy refusal). All workflow-scoped, persisted via the standard broadcast path.

### recall/recall.db (Workbench §F1)

`server/src/recall/index.ts`. A **machine-global, cross-cwd SQLite index** of every workflow ever run — one row per workflow: `{ wfid, cwd, project, provider, title, createdAt, lastActiveAt, turnCount, summaryRef?, tags[] }` plus the F4 `pinned` flag and KB/task links, with an FTS5 table alongside for F3 search (`better-sqlite3`, as is the per-tab `sandbox.db`). F2 summaries live beside it as `~/.arco/recall/<wfid>/summary.md` (linked by `summaryRef`) — unlike the index they are operator-produced content, not a projection. Purge drops the row immediately.

**Rebuildable projection — delete-safe.** `recall.db` holds nothing authoritative; it is a deterministic projection of each workflow's `meta.json` + `events.jsonl`. Delete `recall.db` and the next server boot's backfill reconstructs it from disk (tags / pins / links are operator state stored only in the DB, so deleting it loses those; don't delete the whole `recall/` dir — it also holds the summaries). `RecallIndex.rebuild()` does the same on demand (drop + re-backfill). The index is populated three ways: (1) on boot, `getRecallIndex().backfill()` walks every cwd in `known-cwds.json`; (2) `writeMeta` fires a single failure-isolated upsert per write so live workflows stay current; (3) `rebuild()` for an explicit from-scratch reconstruction. All three upsert by `wfid` (idempotent — re-running never duplicates). See `docs/RECALL.md`.

### recent-files.jsonl

`server/src/recentFilesLedger.ts`. A machine-global, append-only NDJSON ledger of agent (and manual) file writes, newest-appended-last, at `~/.arco/recent-files.jsonl` (override `ARCO_RECENT_FILES_LEDGER` for tests). Record shape `LedgerRecord { ts, path (absolute), op:'created'|'modified', workflowId, tabTitle, provider, tool, project? }` (`project` = basename of cwd, optional for back-compat). Self-compacts: once the file exceeds `MAX_LINES = 1000` lines it is rewritten (tmp+rename) to the newest `KEEP_LINES = 500`.

**Fed from the persisting broadcast chokepoints, best-effort.** `recordFilesLedger()` (`server/src/server/broadcast.ts`) runs a pure `matchFileEvent` over each broadcast in both `send()` and `broadcastWorkflow()` — v1 matches completed `primary_tool_use` Write/Edit/NotebookEdit (→ `modified`, cwd-scoped), `review_artifact_ready` (→ `created`), and media results. The manual `POST /api/files/write` handler also appends (`fileWriteRoutes.ts`). Every append is fire-and-forget `void appendRecord(...)`; `appendRecord` swallows its own errors so a ledger write can never break a broadcast. Read side: `readRecent(limit=100)` (newest-first, skips malformed) consumed by `GET /api/explorer/recents` (`explorerRoutes.ts`).

### settings.json

`server/src/settings.ts`. Three-layer cascade: built-in defaults → `~/.arco/settings.json` (global) → `<cwd>/.arco/settings.json` (project). Deep-merge for nested objects; arrays replace. Project-level file overrides specific keys without touching the rest — useful for per-repo default provider or model.

Global shape (representative subset):

```ts
// ArcoSettings (shared/src/protocol/settings.ts)
{
  enabledProviders: Record<ProviderName, boolean>,
  workflowDefaults?: { primaryProvider?, primaryModel?, primaryEffort?, providerAccountRef?, ... },
  providerAccounts?: ProviderAccountsConfig,
  themeId?: string, fontPackOverride?: string, /* + Phosphor / frost / brightness display prefs */
  claude?: { transport? }, codex?: { transport? }, zai?: { transport? },
  ollama?: { baseUrl?, backends?, modelHostMap?, ... }, lmstudio?: { baseUrl? },
  fallbackChains?, autoHandoffDefaults?, handoffSummarizer?, defaultProjectTrust?, mediaUnconfined?, pinnedServices?, tabOrder?,
  // ...
}
```

`GET /api/settings[?cwd=]` returns the merged cascade result. `POST /api/settings` partial-updates the **global** file with an atomic write, serialized through `withFileLock` (two concurrent patches would otherwise last-writer-wins away one another's mutation). Both layers are watched via `fs.watch` on the parent dir (atomic renames replace the inode) with a 200ms debounce; changes broadcast a body-less `settings_updated { scope, cwd? }` and clients re-fetch with their own cwd. The machine-local file is ungitted — check it first when a bug reproduces on one machine only.

### models.md

`server/src/catalog.ts`. Markdown model catalog (128 KB cap), editable from SettingsPanel via `/api/catalog`. **Vestigial** — it was the pre-Lite orchestrator's routing brain (`buildCatalogInjection`, now uncalled, with `calibration.md`); model pickers are driven by the live per-provider catalogs, not this file.

A `.bak-phase1` file may be present from earlier migrations.

### llamacpp.json

Operator-maintained GGUF catalog at `~/.arco/llamacpp.json`: `{ models: LlamacppModelDef[] }` (each `{ alias, ggufPath, ctxSize?, ngl?, extraArgs?, ... }` plus optional capability flags; the first entry is the default; 64 KB cap; a commented stub is seeded on first read). Managed by `server/src/llamacppCatalog.ts`. Editable via the CONFIG tab's llama.cpp section or by hand. Arco reads it at boot and on capabilities refresh; each alias becomes a selectable model in the llama.cpp provider's model dropdown. Version-mtime cache in `llamacppManager` skips re-probing the binary when its mtime hasn't changed.

### notification-mutes.json / cluster-presets.json / templates.json / mcp/registry.json

Small global JSON stores, each written through `atomicFile.ts` (`notification-mutes.json` uses the `advisory` tier — the in-memory set is authoritative for the session):

- **`notification-mutes.json`** (`server/src/notifications.ts`) — JSON array of muted notification category strings. Path is mutable for tests via the module-level `mutesPath`.
- **`cluster-presets.json`** (`server/src/clusterPresets.ts`) — saved cluster presets (`{ version, presets: [...] }`).
- **`cluster-snapshots/`** (`server/src/clusterSnapshots.ts`) — named full-cluster captures (`manifest.json` plus each member's `meta.json` / `events.jsonl`). `clusterSnapshotBundle.ts` exports/imports the same regular files as verified `.arcocluster` containers. Confirmed same-name replacement builds a hidden complete staging directory, atomically swaps it at the stable snapshot id, then removes the hidden backup; an unconfirmed conflict or failed build leaves the old directory untouched.
- **`cluster-vault.key`** (`server/src/clusterVaultCrypto.ts`) — base64url 32-byte AES-GCM key, mode 0600. Generated on first cloud save or explicitly installed from another computer. It is never included in a snapshot bundle or hub request and must not be committed to source control.
- **`templates.json`** (`server/src/templates/store.ts`) — workflow templates (`{ version: 1, templates: [...] }`), the single-tab analogue of cluster presets; carries optional seedPrompt + plan body.
- **`mcp/registry.json`** (`server/src/mcp/registry.ts`) — operator-registered MCP server defs (`{ servers: [...] }`). Per-workflow allow-lists live in `meta.json` (`mcpAllow`), keyed by serverId. Honors `ARCO_HOME` env override.

### skill-usage.json (§5.2)

`server/src/skillUsage.ts`. Flat versioned map `{ version: 1, entries: { <canonical abs SKILL.md path>: { count, lastUsed } } }`. Incremented deterministically on a `Read` tool_use whose `file_path` resolves to a `.arco/skills/<slug>/SKILL.md` (project or global) — there is no `skill_view` tool, so the Read of the manifest path *is* the use signal. Purely diagnostic (counts render in the Skills UI; nothing is auto-archived — archiving is an operator decision). Fail-safe: a malformed/absent file reads as empty and write errors are swallowed (telemetry must never break a turn). Atomic write (`durability: 'advisory'` — telemetry); the read-modify-write is serialized through `withFileLock` so concurrent tabs don't clobber.

### trust.json (DD7)

`server/src/projectTrust.ts`. Flat versioned map `{ version: 1, entries: { <canonical abs cwd>: { decision: 'always' | 'never', at } } }`. Gates the three project-local injection surfaces (CLAUDE.md, project skills, project `.arco/settings.json`) behind an explicit operator trust decision; nearest-ancestor wins (a `never` on a subdir overrides an `always` on its parent). The fallback default lives in global `settings.json` under `defaultProjectTrust` (`'ask' | 'always' | 'never'`, default `'ask'`) — resolved from USER/GLOBAL scope ONLY before any project-local file is read, so a cloned repo cannot self-grant trust via a checked-in `.arco/settings.json`. A recorded decision is one line the operator can flip or delete by hand.

### prompts/ (DD10)

Operator-authored `<name>.md` markdown templates expanded by the `/prompt <name> args…` composer command (`server/src/prompts.ts`); bash-positional args (`$1`..`$9` / `${N}`) interpolate into the body. Two scopes: `~/.arco/prompts/` (global — the operator's own, ungated) and `<cwd>/.arco/prompts/` (project — only expanded when the repo is DD7-trusted, since a cloned repo could ship a hostile template). Project wins over global on a name clash. Optional `--- description: … ---` frontmatter; everything after is the template.

### provider-accounts/

`server/src/providerAccounts.ts`. Per-account isolated provider home directories under `~/.arco/provider-accounts/`. For Codex, `codex-<id>/` is the `CODEX_HOME` for a configured account; `ensureCodexAccountHome` `mkdir`s it and seeds a `config.toml` with `cli_auth_credentials_store = "file"`. The account list itself (labels, refs, custom homes) lives in `settings.json` under `providerAccounts`, not here.

### checkpoints/

`server/src/gitSnapshots.ts`. Non-git cwds use a bare shadow repo at `~/.arco/checkpoints/<cwd-hash>/git`, with the same `refs/arco/<wfid>/<seq>` namespace as project repos. A `<wfid>.<seq>.skipped.json` sidecar records paths excluded by the per-file cap so rewind preserves them even if their size changes. Oldest refs and sidecars beyond the per-workflow cap are pruned together; workflow purge removes both. Legacy `<wfid>.<seq>.tar` files remain readable but are no longer created. Project-repo capture uses a unique transient scratch index under `$TMPDIR` (outside the worktree); shadow capture uses the same per-operation naming inside its bare repo.

### auth.json

`server/src/providers/claude-native/auth.ts`. Claude Native OAuth token under the `claude.native` namespace. Atomic write with `mode: 0o600` (the primitive re-chmods after rename, since some filesystems lose the mode on a cross-device move). Read/refresh/write guarded by `proper-lockfile`.

### Skills

Operator-defined playbooks live in two scopes:

- **Project**: `<cwd>/.arco/skills/<slug>/SKILL.md`
- **Global**: `~/.arco/skills/<slug>/SKILL.md`

Each `SKILL.md` has YAML frontmatter (`name`, `description`) followed by the body. The slug is the directory name and is the stable identifier — renaming the skill doesn't require renaming the directory. Managed by `server/src/skills.ts`. The manifest injected into every primary turn's system prompt contains name + description + absolute path only; the agent reads the full body on demand via its `Read` tool.

### Handoff prompts

Custom handoff prompt bodies live at:

- `<cwd>/.arco/handoff.prompt.md` — project original-worker override
- `<cwd>/.arco/handoff.summarizer.prompt.md` — project fresh-summarizer override
- `~/.arco/handoff.prompt.md` — global original-worker override
- `~/.arco/handoff.summarizer.prompt.md` — global fresh-summarizer override
- `ollama.compaction.prompt.md` — `ollama-compaction` override, same two scopes

Project scope takes precedence over global; both fall back to built-in templates. Managed by `server/src/handoffPrompts.ts`. Body max 64 KB. The editor warns (advisory, non-blocking) when an `original-worker` body omits `{{handoffPath}}` or `[HANDOFF_COMPLETE]`.

### known-cwds.json

`server/src/crashRecovery.ts`. Registry of every cwd that hosts a workflow:

```json
[
  "~/Projects/Arco",
  "~/Projects/sample-app"
]
```

A plain JSON array. Appended (under `withFileLock`) on workflow create / rehydrate; **never pruned** — a deleted cwd just scans empty. Chat cwds are deliberately never registered. Also the root set for Recall backfill and the ARCHIVE explorer.

### worker-pids.json

`server/src/workers/pidRegistry.ts`. Live worker PIDs for orphan reaping, each paired with its process start time (H44), written atomically via `atomicWriteFileSync` (sync because shutdown reaping runs after the event loop has stopped):

```json
{ "procs": [{ "pid": 12345, "startTime": "…" }, { "pid": 23456, "startTime": null }] }
```

Updated synchronously on each worker spawn / settle. On boot, `reapOrphanWorkers()` (`index.ts`) kills listed pids that are still alive **and** whose start time still matches — a recycled pid now owned by an unrelated process is spared; an unknown start time fails toward kill. A legacy `{ "pids": [...] }` file is still read (start time unknown). Incognito workers are never registered. Without this, a server crash mid-turn would leave detached workers running. (A sibling `server/src/terminal/ptyPidRegistry.ts` keeps the same shape for terminal PTY pids.)

### cli-snapshots/

`server/src/capabilities.ts` writes `~/.arco/cli-snapshots/<provider>.txt` (raw `--version`/help capture) plus `<provider>.meta.json` per provider, and a diff file when a change is detected. Used to detect CLI upgrades between boots and emit `capabilities_changed` events. The CONFIG tab's red-dot indicator fires on any change.

### antigravity-data/

Isolated Chromium user-data-dir for the Antigravity desktop app spawn. Keeps Arco's automation from cross-contaminating the operator's own Antigravity install. See [`PROVIDERS.md`](PROVIDERS.md).

---

## .gitignore

On first workflow init in a cwd (`workflowStore.ts`), Arco writes `<cwd>/.arco/.gitignore` if the file doesn't already exist. It lists the rebuildable/ephemeral projections:

```
workflows/
session-index.json
title-events.jsonl
```

This stops `events.jsonl` and friends from being accidentally committed. The write is skipped if the file already exists, so operator edits aren't clobbered on rehydrate — and an existing `.gitignore` is never modified (operator's responsibility to add the rules manually).

---

## Crash recovery

On boot, `recoverWorkflowsFromDisk()` (`server/src/crashRecovery.ts`):

1. Loads `~/.arco/known-cwds.json`.
2. For each cwd, lists `<cwd>/.arco/workflows/*/meta.json` (`listWorkflowMetas`; a missing dir yields nothing — the registry is not pruned).
3. Keeps only workflows active in the last **24 h** (`RECOVERY_WINDOW_MS`); older ones stay on disk and come back via client `rehydrate_workflows` / RESUME.
4. `await initWorkflowStore` for each survivor **before** any broadcast (else seqs restart at 0 and duplicate on disk), and hands them back for in-memory cwd registration.

Separately `index.ts` runs `reapOrphanWorkers()` / `reapOrphanTerminals()`. Nothing sweeps orphaned atomic-write temp files (see Atomic write pattern). The `stores` readiness component (`/readyz`) flips when recovery settles.

The client side does its own crash-recovery via `useWebSocket.ts` — on connect, persisted jobs in localStorage send `rehydrate_workflows` and the server replays from `events.jsonl`.

Saved Chat conversations use the same `meta.json` + `events.jsonl` contract,
but their synthetic cwd is `~/.arco/chats/<wfid>` and they are intentionally
absent from `known-cwds.json` and project `session-index.json`. `GET /api/chats`
scans those metas for the Past Chats picker.

Operator usage, the exact nested disk layout, provider admission and Incognito
limits are collected in [CHAT.md](CHAT.md).

---

## Client-side localStorage

The Zustand store (`client/src/stores/appStore.ts`) persists a slim subset of state to `localStorage` under the key **`arco-jobs`** via `zustand/middleware/persist` with a custom `debouncedJSONStorage()` (`client/src/stores/persistence.ts` — stringifies once per debounced flush, flushes on `visibilitychange`/`pagehide`; do not swap back to `createJSONStorage`, which re-serializes the whole slice on every `set()`). The `partialize` function explicitly includes:

Since the server-authoritative workspace (`~/.arco/workspace.json`), this slice is a **cache**: on every connect the client reconciles `jobs` / `clusters` to the server's open set (dropping tabs closed elsewhere, materializing tabs opened elsewhere). `arco.workspaceAdopted` (separate key) records that this browser's local tabs were merged into the server set once.

- **`jobs`** — per-workflow entries: `id`, `currentSessionId`, `config`, the last 200 `messages`, cost/token totals, `resolvedPrimaryModel`, the last 40 `reviews` / `research` / `handoffs`, `lastSeq`, `taskChildren` / `parentWorkflowId` / `promoted` (Phase 7b), and the last 500 `historyEvents` (Phase 8). `workers` is persisted as `{}` — the server re-pushes live state on reconnect.
- **`activeJobId`** — the focused tab (nulled when it is incognito).
- **`clusters`** / **`activeClusterId`** / **`clusterGridSplit`** / **`clusterCardLayout`** — cluster mirror + layout; the server's `cluster_state` overwrites the mirror after subscribe.
- **`showCreator`**.

Incognito Chat jobs are filtered out of this entire persisted slice. Their
messages/config/active selection stay only in browser memory. Server-side they
also skip workflow-store/meta initialization and are removed from memory after
the last observer disconnects (10-second reconnect grace). This guarantees
Arco has no durable transcript to restore. Strict incognito also suppresses
Arco's structured log and journald output for the create/turn async tree and
registered workflow/worker ids, skips the durable worker-PID registry, disables
notifications and remote reporting, and keeps Claude framing off argv/temp
files. llama.cpp is unavailable because its shared daemon log is not separable
per request. External API retention is outside Arco's storage boundary.

**`taskChildren`** — Settled Task-child records (Phase 7b) are included in the partialize allow-list so the TASKS sub-tab and TaskCard renders correctly after a page reload without waiting for the replay path to re-deliver lifecycle events. The server also re-broadcasts `task_started` / `task_status` on rehydrate regardless of `clientLastSeq` as a belt-and-suspenders; the idempotent client-side actions make the two paths safe to combine.

**HISTORY tab filter strip** — Per-workflow filter selection is stored under `arco.historyFilter.byWorkflow.<workflowId>` in `localStorage` (separate from the main Zustand key) by `client/src/components/HistoryTab.tsx`. No server-side persistence; resets to default on first load for any given workflow.

**Computer reply voice** — `arco.voice.output.v1` stores only a validated
output-voice ID for this browser. Missing/invalid values use the server default;
choosing System default removes the key. `voice/store.ts` never persists voice
arming, a session ID, captured speech or sample audio. Reload remains mic-off.

**`operator_label` (pinned labels)** — Persisted in `events.jsonl` (standard broadcast path), not in localStorage. Labels survive server restart and are replayed to reconnecting clients like any other event. The client reconstructs them from the event stream; `anchorSeq` links each label to its anchor event.

---

## Cleanup / GC

None for conversation records — Arco is append-only by design:

- `events.jsonl` grows forever. There is **no rotation** (the "100 MB rotation cap" in `workflowStore.ts` comments is a sizing assumption, not enforced). A manual trim is survivable: the snapshot-only fallback handles `firstSeq > clientLastSeq + 1`.
- `cliSessions[]` normally grows forever; Computer fresh-context boundaries retire its Codex entries into `history[]`.
- `history[]` grows forever (one entry per Handoff or Computer fresh start).
- Artifacts and handoffs accumulate forever.

Deletion is operator-only: PURGE CONVERSATION (`DELETE /api/workflows/:wfid`, see Purge above) or by hand on disk. Closing a tab (`remove_workflow`) keeps the directory. The bounded/reaped stores are listed under [Two roots](#two-roots).

---

## Cross-references

- Where the seq is allocated and stamped: `server/src/workflowStore.ts:persistAndStampSeq`
- Where the meta is read on boot: `server/src/crashRecovery.ts` + `server/src/ws/handoffHandlers.ts:handleRehydrateWorkflows`
- Where atomic writes are performed: `server/src/atomicFile.ts` (`atomicWriteFile` / `atomicWriteFileSync` / `withFileLock`) — the single primitive every store uses
- Where files are served back to the client: `GET /api/workflows/{artifact|artifact-raw|handoff}` in `server/src/http/workflowDataRoutes.ts`
- Plans on the wire: [`PROTOCOL.md`](PROTOCOL.md) (`plan_attach`, `plan_attached`, etc.)
- "Don't regress X" invariants: [`GOTCHAS.md`](GOTCHAS.md)

### Computer completion watches

`~/.arco/computer-watches.json` holds up to 100 saved watch records, at most
32 active. `voice/watches.ts` serializes snapshots through `withFileLock` and
`atomicWriteFile` (durable, mode 0600); arm acknowledgment waits for persistence.
IDs plus busy generations bind current runs in memory. Pending saved watches
are marked interrupted on first load after restart, since killed work cannot
be inferred successful. Saved lifecycle notices also enter the Computer
transcript. Incognito watches are filtered out before every disk write and
never emit global/external notices; a private full clear/removal drops them.

### Computer conditional mailbox rules

`~/.arco/computer-mail-rules.json` holds up to 100 saved rule records (≤16
active, one per cluster). `voice/mailRules.ts` uses the shared locked durable
atomic writer, mode 0600. Arming and dispatch preflight require successful
persistence; I/O failure stops active saved rules. Exact cluster membership,
selected worker IDs/counts, final recipient, finite limits, state/reason and
announcement claims persist. Pending message-ID batches are memory-only; every
active saved rule becomes interrupted on load, so restart never replays a
nudge. Graceful shutdown interrupts rules before worker teardown. Cancellation
stops future dispatch, with lifecycle and dispatch notices in saved transcripts.
Private rules are excluded from every disk write, lifecycle audit and external
notice, stay owner-scoped, and clear with a private context/removal. A requested
standard reminder still enters its normal destination worker’s transcript.

### Computer conditional scripts

General scripts use a separate `~/.arco/computer-conditions.json` (locked
durable atomic writes, mode 0600, ≤100 retained/16 active). Records include
validated definitions/pinned scope, clause/action state, deduplication hashes
and mail IDs, worker-turn counts, expiry, status/reason and notification claims.
New definitions default `ttl_minutes`, `max_actions`, `max_worker_turns` to
null (no operator-imposed limit), with nullable `expiresAt`. Old numeric
definitions/deadlines retain their limits; no automatic migration broadens a
saved script. Counters, dispatch signatures and announcements can exceed the
old 8/128 ceilings and still validate on load. In-place edits retain spend and
deduplication; unchanged TTL retains its absolute deadline, an explicit numeric
change starts from the update and null removes expiry. Cooldown remains 30s by
default but can be operator-set to any nonnegative supported whole seconds.
Omitted budget/cooldown fields on update inherit the existing definition;
only explicit null removes a budget.
No worker reply text is copied into this file. Saved lifecycle/actions use
ordinary `system_notice` audit events; matched notices reuse `computer-watch`.
Restart marks active scripts interrupted, never replays an action. A persistence
failure refuses arming or stops saved dispatch. Private definitions, execution
state, notifications and observation budgets are memory-only and cleared with
the owning private context; asynchronous replies are identity/version fenced.
Input-observation source text/cache stays volatile and is bounded; semantic
observer turns are ephemeral, tool-free and do not write a provider session.
Observation-run counts are process-local (24 batches/owner/rolling hour);
restart also requires explicit script re-arming. Saved observer usage is visible
as metadata audits, never a second worker transcript. The legacy mailbox-rule
file is unchanged; it cannot coexist with general scripts in the same scope.

### Computer activity and agent inbox

`~/.arco/computer-activity.json` (`voice/activity.ts`/`activityStore.ts`) stores
200 public metadata facts, per-owner settings (100 max), bounded public delivery
records and rolling-hour batch counters. The shared locked durable atomic writer
uses mode 0600 and coalesces concurrent event writes. Original workflow events
remain the full saved history; this is a recent projection, never a transcript
copy. A saved config or dispatch preflight must save successfully; I/O failure
stops automatic dispatch with an operator-visible warning. Queued/in-flight
updates become interrupted on restart, never replayed. Private policy, inbox,
condition facts and usage counters are excluded before every write; private
clear/removal drops them and fences pending creation/dispatch/HTTP replies.
Private-owner updates run under operational-log suppression. Public worker
metadata remains public even when a private Computer subscribes. Paused mailbox
rules retain their fixed expiry; saved rules survive context/provider changes
independently of the optional model-update inbox.
