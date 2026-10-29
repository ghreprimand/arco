# Arco - operator-primitive protocol messages

WebSocket messages for the operator-triggered primitives: Review, Deep Research, Compare, Worktree Bake-off, AI-collaborative document editing, Agent-instruction-file tune-up, Handoff, Spawn. Split out of [`PROTOCOL.md`](PROTOCOL.md) (J2, doc-size). Conventions (direction `->`/`<-`, persistence, `seq` stamping) are defined in [`PROTOCOL.md`](PROTOCOL.md#conventions) and apply here unchanged. Source of truth: the per-domain files under [`shared/src/protocol/`](../shared/src/protocol/) (`reviews.ts`, `research.ts`, `compare.ts`, `fallback.ts`, `bakeoffs.ts`, `docEdit.ts`, `mdTuneup.ts`, `handoffs.ts`).

---

## Worktree bake-off (operator primitive)

`shared/src/protocol/bakeoffs.ts`. One prompt runs in 2-5 isolated workflow
tabs; only an explicit operator message promotes a winner.

```ts
{ type: 'bakeoff_list', workflowId }
{ type: 'bakeoff_start', workflowId, name?, prompt, attempts: BakeoffAttemptSpec[] }
{ type: 'bakeoff_promote', workflowId, bakeoffId, attemptId }
{ type: 'bakeoff_cleanup', workflowId, bakeoffId, attemptIds: string[] }
```

Server messages:

```ts
{ type: 'bakeoff_list_result', workflowId, bakeoffs: BakeoffState[] }
{ type: 'bakeoff_state', workflowId, bakeoff: BakeoffState }
{ type: 'bakeoff_error', workflowId, bakeoffId?, error }
{ type: 'bakeoff_attempts_removed', workflowId, bakeoffId, attemptIds, workflowIds }
```

`BakeoffAttemptSpec = { provider, model, effort, providerAccountRef? }`.
Attempt statuses are `creating | running | done | failed | interrupted |
cleaned`; overall status is `creating | running | ready | promoted | failed`.
Each attempt also carries its ordinary `workflowId`, managed `worktreePath`,
and branch. Attempt `workflow_created` messages include
`backgroundCreated:true`, which adds the tabs without stealing focus from the
source workflow. Manifests are durable; listing after a restart converts
orphaned `running` attempts to `interrupted`.

---

## Review (operator primitive)

### `review_request` ->

```ts
{
  type: 'review_request',
  workflowId: string,
  contextRef: ReviewContextRef,     // see below
  reviewer: { provider: ProviderName, model: ModelName, effort: EffortLevel, providerAccountRef?: string },  // providerAccountRef: Codex account routing, resolved by the RUN AS picker
  includeGitDiff?: boolean,         // for any non-`git-diff` scope, also append `git diff HEAD`
}
```

`ReviewContextRef` discriminates the slice. Five transcript-scope variants, three plan-scope variants, two cluster-plan-scope variants, the history-anchored variant, and the preview-capture variant:

```ts
type ReviewContextRef =
  // Transcript-scoped (server slices events.jsonl via buildReviewContent)
  | { kind: 'last-turn' }
  | { kind: 'last-n', n: number }
  | { kind: 'current-session' }
  | { kind: 'full' }
  | { kind: 'git-diff' }
  // Plan-scoped (server reads the plan body via buildPlanReviewContent)
  | { kind: 'plan-whole'; planId: string; mode: PlanReviewMode }
  | { kind: 'plan-phase'; planId: string; heading: string; mode: PlanReviewMode }
  | { kind: 'plan-items'; planId: string; itemIds: string[]; mode: PlanReviewMode }
  // Cluster-plan-scoped - body comes from the cluster's attached plan
  // (`clusterPlanBridge.readClusterPlan(clusterId)`, canonical under
  // <cwd>/.arco/plans/<planId>.md) instead of `readPlan(cwd, planId)`.
  // `workflowId` on the request still names
  // the worker that runs the review (a member, the cluster plan tab's REVIEW
  // PLAN / VERIFY WORK buttons pop a ClusterMemberPicker); `clusterId` names
  // the plan body being reviewed. Server-side content builder is
  // `buildClusterPlanReviewContent` in primitives/reviewContent.ts. See
  // `PRIMITIVES.md-plan-scoped review`.
  | { kind: 'cluster-plan-whole'; clusterId: string; mode: PlanReviewMode }
  | { kind: 'cluster-plan-phase'; clusterId: string; heading: string; mode: PlanReviewMode }
  // events.jsonl slice from `anchorEventSeq` onward. Wired from
  // the HISTORY tab's "REVIEW FROM HERE" button. Reviewer framing names
  // the operator label when the anchor is an `operator_label` event.
  | { kind: 'since-event'; anchorEventSeq: number }
  // - review a preview-capture report artifact. No
  // transcript: the reviewer sees the markdown report produced by a Preview
  // verification capture (screenshot reference + console/network + layout/a11y
  // notes) and evaluates the running UI from that evidence. `reportName` is the
  // artifact basename under the workflow's artifacts dir. Triggered by the
  // ATTACH TO REVIEW button on the Preview tab's capture result strip.
  | { kind: 'preview-capture'; reportName: string };

type PlanReviewMode = 'verify' | 'critique';
```

For plan-scoped variants:

- **`plan-whole`** - the whole plan body, filtered by mode.
- **`plan-phase`** - the named phase only. `heading` must match the exact `### Phase Name` text from the plan body. Filtered by mode.
- **`plan-items`** - operator-selected items via the `PlanReviewPicker`. `itemIds` are stable IDs of the form `${phaseIdx}/${taskIdx}` (zero-based). Mode affects framing/instructions only - selected items render regardless of check state.
- **`cluster-plan-whole`** / **`cluster-plan-phase`** - same shape as `plan-whole` / `plan-phase`, but the body is resolved by cluster id (`clusterPlanBridge.readClusterPlan`) rather than by plan id; an empty body rejects. No `plan-items` variant for the cluster surface today - the cluster plan tab's CUSTOM REVIEW button picks per-item via the existing `PlanReviewPicker` against a synthesized `planId` after the picked member's plan is promoted (the cluster body itself has no stable per-item slice yet).

For the preview-capture variant:

- **`preview-capture`** - no transcript. The reviewer sees the markdown report produced by a Preview verification capture (screenshot reference + console/network errors + layout/a11y notes; see [`PREVIEW_VERIFY.md`](PREVIEW_VERIFY.md)) and evaluates the running UI from that evidence. `reportName` is the artifact basename under the workflow's artifacts dir. Triggered by the ATTACH TO REVIEW button on the Preview tab's capture result strip (Preview-verification integration).

Mode semantics:

- **`verify`** - reviewer cross-checks claimed-completed work against actual code in the tree. Items filtered to `[x]` only (for `plan-whole` and `plan-phase`). Reviewer is told to use tools to verify, not take checkboxes at face value.
- **`critique`** - reviewer evaluates the plan itself (gaps, ordering, missing considerations). All items shown with check state preserved.

Content-build failures reject **before** `review_started` with a plain `error` message (no artifact): unresolvable `plan-items` IDs (plan edited since the picker - the message names the first few so the operator can re-pick), a missing plan / phase heading, an empty cluster plan, or a VERIFY slice with nothing checked. See [`PRIMITIVES.md-scoped review`](PRIMITIVES.md) for parser invariants and the local-reviewer addendum that fires for Ollama / llama.cpp.

**Drift guard.** At dispatch the server re-resolves the selected `reviewer` provider:model against the live catalog (`checkModelDrift` in [`server/src/primitiveDrift.ts`](../server/src/primitiveDrift.ts)). If the model is affirmatively gone it emits a workflow-scoped `system_notice` `[REVIEW U+2014 MODEL DRIFT] ...` and dispatches anyway - non-blocking and fail-open (a cold catalog or probe error never flags); the operator can cancel and re-pick. The same guard runs at `handoff_request` (`[HANDOFF U+2014 MODEL DRIFT]`) on `summarizer`/`newPrimary` and `spawn_from_here_request` (`[SPAWN U+2014 MODEL DRIFT]`) on the new primary.

### `review_started` <-

```ts
{
  type: 'review_started',
  workflowId: string,
  reviewId: string,
  reviewer: { provider, model, effort, providerAccountRef? },
  contextRef: ReviewContextRef,
  startedAt: number,
}
```

### `review_artifact_ready` <-

```ts
{
  type: 'review_artifact_ready',
  workflowId: string,
  reviewId: string,
  artifactName: string,             // e.g. 'review-1719999999.md' - always set, even on error (carries the partial-result name)
  verdict?: 'PASS' | 'MINOR' | 'BLOCKING',
  error?: string,
  completedAt: number,
}
```

The artifact body is fetched separately via `GET /api/workflows/artifact?path&workflowId&name`.

### `cancel_review` ->

```ts
{ type: 'cancel_review', workflowId: string, reviewId: string }
```

---

## Deep Research (operator primitive - Workbench Expansion)

Five messages defined in `shared/src/protocol/research.ts`. A bounded, agent-agnostic research run; see [`PRIMITIVES.md`](PRIMITIVES.md). `RESEARCH_DEFAULT_ROUNDS = 4`, `RESEARCH_MAX_ROUNDS_CEILING = 10` are exported alongside.

### `research_request` ->

```ts
{
  type: 'research_request',
  workflowId: string,
  researcher: { provider, model, effort, providerAccountRef? },   // resolved by the RUN AS picker, like the reviewer config
  topic: string,                  // the research brief
  maxRounds: number,              // clamped server-side to [1, RESEARCH_MAX_ROUNDS_CEILING]; drives Claude's web-tool max_uses
  seedArtifactName?: string,      // dig-deeper: existing artifact to append to
  followUp?: string,              // dig-deeper: the narrow follow-up question
}
```

`seedArtifactName` + `followUp` together select the dig-deeper path: the server reads the prior report, the worker emits a dated addendum, and it is appended to the same artifact (`isFollowUp: true`).

### `research_started` <-

```ts
{
  type: 'research_started',
  workflowId: string,
  researchId: string,
  researcher: { provider, model, effort, providerAccountRef? },
  topic: string,
  maxRounds: number,
  isFollowUp: boolean,
  artifactName: string,           // 'research-<ts>.md' (or the seed artifact's name for a follow-up)
  startedAt: number,
}
```

### `research_progress` <-

```ts
{
  type: 'research_progress',
  workflowId: string,
  researchId: string,
  round: number,                  // running web-tool invocation count (advisory)
  note: string,                   // e.g. 'searching (2/4)'
}
```

Coarse signal emitted when the worker invokes a web-search / web-fetch tool. The per-turn ACTIVITY stream remains the authoritative tool log.

### `research_complete` <-

```ts
{
  type: 'research_complete',
  workflowId: string,
  researchId: string,
  artifactName: string,
  roundsUsed: number,             // web-tool invocations actually used (≤ maxRounds)
  sourceCount: number,            // unique cited URLs, best-effort
  isFollowUp: boolean,
  error?: string,                 // set on failure / cancel
  completedAt: number,
}
```

The report body is fetched separately via `GET /api/workflows/artifact?path&workflowId&name` (same endpoint as reviews).

### `cancel_research` ->

```ts
{ type: 'cancel_research', workflowId: string, researchId: string }
```

Kills the worker (mirrors `cancel_review`); the settle resolves with an error and a `research_complete` carrying it.

## Compare (operator primitive - Workbench Expansion)

A bounded, read-only multi-provider answer race. ONE prompt fans out to N independent legs (no shared session); each streams into its own pane. Operator votes a winner; optionally has one leg synthesize. Defined in `shared/src/protocol/compare.ts`. `CompareLegConfig = { provider, model, effort, providerAccountRef? }`. Leg count is clamped `[COMPARE_MIN_LEGS=2, COMPARE_MAX_LEGS=6]`.

### `compare_request` ->

```ts
{ type: 'compare_request', workflowId, prompt: string, legs: CompareLegConfig[], blind: boolean }
```

### `compare_started` <-

```ts
{ type: 'compare_started', workflowId, compareId, prompt, legs: CompareLegConfig[], blind, startedAt }
```

### `compare_leg_delta` <-

Streamed answer text for one leg; the client appends `text` to that pane. Keyed by `(compareId, legIndex)` so concurrent leg streams never interleave. The optional synthesis pane uses `legIndex == legs.length`.

```ts
{ type: 'compare_leg_delta', workflowId, compareId, legIndex: number, text: string }
```

### `compare_leg_complete` <-

```ts
{ type: 'compare_leg_complete', workflowId, compareId, legIndex, text: string, durationMs, error?, completedAt }
```

`text` is the authoritative final answer (client replaces any streamed accumulation). On error, `error` is set and `text` may be partial.

### `compare_complete` <-

```ts
{ type: 'compare_complete', workflowId, compareId, succeededLegs: number, completedAt }
```

### `compare_vote` -> / `compare_vote_recorded` <-

Operator action - nothing auto-selects, no LLM judges the winner.

```ts
{ type: 'compare_vote', workflowId, compareId, winnerLegIndex: number }
{ type: 'compare_vote_recorded', workflowId, compareId, winnerLegIndex, winner: CompareLegConfig, votedAt }
```

`compare_vote_recorded` carries the winner's identity so a blind-mode client can reveal it. Persisted to `events.jsonl`.

### `compare_synthesize` ->

Operator-chosen follow-up: one more bounded read-only leg (run by `synthesizerLegIndex`'s agent) seeded with every answer; streams into the synthesis pane via the same `compare_leg_*` events.

```ts
{ type: 'compare_synthesize', workflowId, compareId, synthesizerLegIndex: number }
```

### `cancel_compare` ->

```ts
{ type: 'cancel_compare', workflowId, compareId }
```

Kills every still-running leg worker (and the synth worker); each leg's terminal `compare_leg_complete` carries the kill error so no pane hangs.

### `provider_fell_back` <-

```ts
{
  type: 'provider_fell_back',
  workflowId: string,
  from: { provider: ProviderName, model: ModelName },  // the leg we left
  to:   { provider: ProviderName, model: ModelName },   // the leg we're trying next
  reason: FailoverReasonName,     // classifier bucket, e.g. 'rate_limit' (open-ended string union)
  note?: string,                  // human one-liner for the chat system-notice
}
```

**Provider fallback chains.** Emitted once per chain
advance during a **bounded** job (reviewer / research leg) when its current
provider returned a classified failover error (`fallback` / `rotate` /
`backoff_then_rotate`) and an operator-configured next leg exists. Workflow-
scoped -> persisted to `events.jsonl` and replayed on resume. The client renders
it as an inline chat **system-notice** (no panel). A **live primary turn never
emits this** - it fails closed and surfaces the error to the operator instead
(the no-mid-conversation-swap fence). Chains are configured per role under
`fallbackChains` in `settings.json` (read, never written by the server); see
[`PROVIDERS.md fallback chains`](PROVIDERS.md) for the advancing-action
rule, the settings shape, and the deferred `seed` role.

---

## AI-collaborative document editing

Scoped, reviewable edit assist layered on the A6 editor. The agent **proposes text only - it has no Write/Edit tool and never touches disk.** The operator Accepts into the editor buffer (buffer only) and the existing A6 Save persists through the `resolveWithinCwd`-guarded write endpoint. In-tab only (the proposal must round-trip to the open editor buffer).

### `doc_edit_request` ->

```ts
{
  type: 'doc_edit_request',
  workflowId: string,
  editor: { provider, model, effort, providerAccountRef? },  // RUN AS picker output
  filePath: string,               // context/logging only - never a write target
  selectionText: string,          // the selected region the agent rewrites
  selectionFrom: number,          // buffer offsets; SERVER echoes them back so the
  selectionTo: number,            //   CLIENT knows which range to splice on Accept
  contextBefore: string,          // bounded surrounding text (≤ DOC_EDIT_CONTEXT_LIMIT = 2048 each)
  contextAfter: string,
  instruction: string,
  wholeDoc: boolean,              // true for the Select-All / whole-document path
}
```

Server validates a non-empty selection + instruction (friendly `error` otherwise), resolves the codex account like the research path, then spawns a short-lived **read-only, no-Write** worker for ONE bounded turn.

### `doc_edit_started` <-

```ts
{ type: 'doc_edit_started', workflowId, docEditId, filePath, editor, startedAt }
```

Optional progress signal fired when the worker is spawned.

### `doc_edit_proposed` <-

```ts
{
  type: 'doc_edit_proposed',
  workflowId: string,
  docEditId: string,
  filePath: string,
  selectionFrom: number,          // echoed - the exact range the client splices into
  selectionTo: number,
  replacement: string,            // proposed text for JUST the selection (NOT the file)
  error?: string,                 // set on failure (replacement empty)
  completedAt: number,
}
```

`replacement` is the proposal for only the selection. A leading/trailing code fence is defensively unwrapped server-side. The client previews `selectionBefore` vs `replacement` as an A3 diff; Accept splices it into `[selectionFrom, selectionTo)` of the buffer (buffer only), Reject discards. There is no cancel message - a single bounded turn settles on its own.

---

## Agent-instruction-file tune-up (TUNE MD  - sibling)

Proposes a compacted version of an instruction file (`AGENTS.md` / `CLAUDE.local.md` / `AGENTS.md` / `GEMINI.md`) - the per-turn token tax of an accreted instruction file, paid back. ONE bounded, **read-only** worker turn: the agent has **no Write/Edit tool** and never touches disk. On Accept the server re-reads the file, backs the original up to `.arco/md-backups/<name>.<ts>.bak`, then writes through the `resolveWithinCwd`-guarded path. Same propose-then-approve posture as doc-editing - operator-initiated, source is the file itself (not session traces), reviewed as a diff before any write. Defined in `shared/src/protocol/mdTuneup.ts`; `INSTRUCTION_FILE_NAMES = ['AGENTS.md','CLAUDE.local.md','AGENTS.md','GEMINI.md']`.

### `md_tuneup_candidates_request` -> / `md_tuneup_candidates` <-

```ts
{ type: 'md_tuneup_candidates_request', workflowId: string }
{
  type: 'md_tuneup_candidates',
  workflowId: string,
  candidates: { path: string, baseName: string, bytes: number }[],  // path is repo-relative to the cwd
  defaultPath?: string,           // candidate matching the tab's primary provider, pre-selected in the dialog
}
```

### `md_tuneup_request` ->

```ts
{
  type: 'md_tuneup_request',
  workflowId: string,
  editor: { provider: ProviderName, model: ModelName, effort: EffortLevel, providerAccountRef?: string },  // RUN AS picker output; read-only worker
  target: string,                 // 'auto' (server picks by provider: codex->AGENTS.md, gemini->GEMINI.md, else AGENTS.md) or a repo-relative path from the candidates; guarded by resolveWithinCwd
}
```

### `md_tuneup_started` <-

```ts
{
  type: 'md_tuneup_started',
  workflowId: string,
  tuneupId: string,
  filePath: string,               // absolute path of the resolved instruction file
  baseName: string,
  originalBytes: number,          // pre-tune size, for the "before" stat
  editor: { provider, model, effort, providerAccountRef? },
  startedAt: number,
}
```

### `md_tuneup_proposed` <-

```ts
{
  type: 'md_tuneup_proposed',
  workflowId: string,
  tuneupId: string,
  filePath: string,
  baseName: string,
  original: string,               // full file contents - the A3 diff's "before"
  proposed: string,               // full proposed contents - the diff's "after"
  notes: string,                  // agent's operator-facing summary of what it cut; NEVER written to disk
  originalBytes: number,
  proposedBytes: number,
  error?: string,                 // set on failure; content fields empty
  completedAt: number,
}
```

### `md_tuneup_accept` -> / `md_tuneup_applied` <-

```ts
{ type: 'md_tuneup_accept', workflowId: string, tuneupId: string, filePath: string, proposed: string }  // server re-reads, backs up, then writes `proposed` (authoritative - no cached copy trusted)
{
  type: 'md_tuneup_applied',
  workflowId: string,
  tuneupId: string,
  filePath: string,
  ok: boolean,
  backupPath?: string,            // absolute path of the saved original (on success)
  bytesWritten?: number,
  error?: string,                 // set on failure; nothing written
  ts: number,
}
```

There is no cancel message - the single bounded turn settles on its own (same as doc-editing).

---

## Handoff (operator primitive)

### `handoff_request` ->

```ts
{
  type: 'handoff_request',
  workflowId: string,
  mode: 'original-worker' | 'fresh-summarizer' | 'fresh-agent',
  summarizer?: { provider: ProviderName, model: ModelName, effort: EffortLevel },  // for fresh-summarizer; defaults to the tab's primary config
  newPrimary?: { provider: ProviderName, model: ModelName, effort: EffortLevel, providerAccountRef?: string },  // optional provider/model swap on rotation; providerAccountRef for Codex account routing
}
```

`'fresh-agent'` currently rejects with "not implemented yet".

### `handoff_cancel` ->

```ts
{
  type: 'handoff_cancel',
  workflowId: string,
  handoffId: string,
}
```

Cancels an in-flight handoff. `handleHandoffCancel` broadcasts a `handoff_artifact_ready` with `cancelled: true` (sticky - the worker-kill error that follows is ignored client-side), then calls the handle's `abort` which kills the reflection/summarizer worker via `manager.kill`. The kill makes `handle.settled` resolve, so the normal cleanup (`busy=false` + handoff-slot release + `wf.activeHandoff` clear) runs. The client surfaces the cancel `✕` while a handoff worker is active.

### `handoff_lock_clear` -> / `handoff_lock_snapshot` <-

cwd-scoped handoff-lock coordination (a cwd holds at most one running handoff across the tabs sharing it).

```ts
{ type: 'handoff_lock_clear', cwd: string, workflowId: string, handoffId?: string }   // force-release a stuck lock
{
  type: 'handoff_lock_snapshot',
  cwd: string,                      // cwd-scoped - broadcast to every tab on this cwd, not a single workflow
  locks: Array<{
    workflowId: string,
    workflowName?: string,
    handoffId?: string,
    status: 'preparing' | 'running',
    startedAt: number,
  }>,
}
```

### `handoff_started` <-

```ts
{
  type: 'handoff_started',
  workflowId: string,
  handoffId: string,
  mode: ExportContextMode,
  startedAt: number,
}
```

### `handoff_artifact_ready` <-

```ts
{
  type: 'handoff_artifact_ready',
  workflowId: string,
  handoffId: string,
  artifactName: string,             // handoff-<ts>.md under.arco/workflows/<wfid>/handoffs/
  error?: string,
  cancelled?: boolean,              // set when the operator cancelled; rendered as CANCEL, distinct from error
  completedAt: number,
}
```

### `handoff_complete` <-

Fires after the new session is pre-warmed and the old session is archived in `meta.history[]`.

```ts
{
  type: 'handoff_complete',
  workflowId: string,
  handoffId: string,
  archived: {
    sessionId: string,
    turnCount: number,
  },
  newSessionId?: string,            // empty/absent when Gemini (no native session id in Lite)
  completedAt: number,
}
```

### `conversation_changed` <-

Fires after handoff. Announces the new CLI session ID and prepares the client to track it.

```ts
{
  type: 'conversation_changed',
  workflowId: string,
  newSessionId: string,
  note: string,                     // "[HANDOFF] Session rotated - previous session archived (N turns). New session ready."
}
```

---

## Spawn (operator primitive)

### `spawn_from_here_request` ->

```ts
{
  type: 'spawn_from_here_request',
  parentWorkflowId: string,
  newConfig: WorkflowConfig,
  mode: 'original-worker' | 'fresh-summarizer' | 'fresh-agent',
  newDirection?: string,            // optional new direction prompt
  summarizer?: { provider: ProviderName, model: ModelName, effort: EffortLevel },
  includePlan?: boolean,            // copy parent's attached plan onto the spawn
  // truncate the parent's transcript to events with seq <= this
  // value before generating the handoff. Wired from the HISTORY tab's
  // "SPAWN FROM HERE" button. Honored by fresh-summarizer mode and by
  // Native original-worker (replayMessagesFromEvents stops at the cutoff);
  // CLI original-worker silently ignores - `claude --resume` carries the
  // full prior session and there's no clean way to truncate its view.
  cutoffEventSeq?: number,
  // b - when set, server adds the spawned workflow to this cluster
  // after creation. Validated up front (`unknown_cluster:<id8>`, and
  // `member_not_supported` unless newConfig.primaryProvider is claude or
  // codex - narrower than the cluster fence) so a rejected join never
  // leaves an orphan tab.
  // Default-checked in SpawnDialog when the source tab is itself a cluster
  // member; standalone is the escape hatch (operator unticks).
  joinClusterId?: string,
}
```

### `spawn_from_here_complete` <-

```ts
{
  type: 'spawn_from_here_complete',
  parentWorkflowId: string,
  newWorkflowId: string,
  handoffArtifactName?: string,
  error?: string,
  completedAt: number,
}
```

`workflow_created` for the new workflow fires **first** (so the tab appears before the seed turn streams). The client auto-switches to the new tab on completion.

---
