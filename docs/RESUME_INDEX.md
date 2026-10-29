# Resume index

The Resume index is a project-local session list with generated titles and
summaries, optional model-generated titles, and controls to pin, rename, archive,
and filter sessions. Updates are recorded in the project state.

Opening a project should show what was in progress, where each session left off,
and when it was last active. The session index stores this metadata in a form the
resume surface can read without rescanning every `meta.json` and provider JSONL
file.

The index is a deterministic **projection** of persisted session data, visible
on disk and fully reversible (delete the file; it rebuilds itself).

## Where it lives, and why project-local

`<cwd>/.arco/session-index.json`, one small JSON file per project.

This is deliberately **not** the machine-global Recall index (`~/.arco/recall/
recall.db`, see `docs/RECALL.md`). Recall is the cross-project, SQLite-backed,
full-text-searchable history of every workflow ever run. The session index is the
opposite axis: a single project's resumable sessions, in a file the resume UI can
read in one `fs.readFile` with no DB open. Recall provides global search and filtering.

It is a **rebuildable projection, never a source of truth.** `meta.json` +
`events.jsonl` remain authoritative; deleting `session-index.json` costs nothing,
the next turn or resume-discovery rebuilds it. Because it's ephemeral, the
`.arco/.gitignore` Arco drops on first-workflow-init lists it alongside
`workflows/` (and in this repo `.arco/` is wholly ignored).

## Shape (`shared/src/protocol/workflows.ts`)

`SessionIndex = { version, updatedAt, entries: SessionIndexEntry[] }`. One entry
per **(provider, sessionId)**, that pair is the key. An entry carries:

| field | source / meaning |
|---|---|
| `provider`, `sessionId` | the resumable session's key. For Arco-internal continuity (Claude Native replay / Ollama, no native resume token) `sessionId` is the Arco **workflow id**, mirroring `arcoInternalSessionInfoForMeta`. |
| `workflowId?` | the owning Arco workflow, when one claims the session. Absent for a native session found on disk with no `meta.json`. |
| `cwd`, `startedAt`, `lastActiveAt` | from `meta.json`. |
| `title` | **never blank.** Resolved through the layered chain below. |
| `titleSource?` | Which layer owns `title`: `deterministic` / `dynamic` / `model` / `operator`. Drives the refresh precedence. Absent in older entries -> treated as `deterministic`. |
| `titleGeneratedAt?` | When a `model` title was generated (epoch ms). |
| `subtitle?` | one-line "where this left off". Two sources (summary wins, see below). |
| `subtitleSource?` | `summary` (sticky) or `dynamic` (refreshed each upsert). |
| `lastOutcome?`, `currentQuestion?` | Undefined in older index entries. |
| `tags?` | User tags. Preserved across derived upserts (never clobbered by a refresh). |
| `pinned?` | User pin; sorts to the top of the picker. Preserved across refreshes. |
| `archived?` | User archive flag; filtered out unless "show archived" is on. Preserved across refreshes. |
| `contextPercent?`, `quotaLabel?` | Live-workflow telemetry for the picker. Not yet populated (see Deferred behavior). |
| `sourceHash?` | Cheap material-change marker (the workflow's `lastEventSeq` as a string). Model-title generation uses it to decide whether a cached title is stale. |
| `lastSeq?` | mirrors `meta.lastEventSeq`. |

### Layered title chain

Four layers, lowest -> highest precedence. The resolved `title` is the
highest-ranked one available; `titleSource` records which it is.

1. **`deterministic`**, the first **meaningful** operator message
   (`user_message_echo`), trimmed. **Generic openers are skipped** ("continue",
   "ok", "go", ...) so a session that opens with "continue" is titled by its
   first *real* ask, not by the filler. Falls back to a non-default Arco
   workflow name, then to the `<provider> · <project> · <date>` label.
2. **`dynamic`**, when no opener qualifies (a session that's all
   "continue" until a real ask arrives), the last non-trivial operator message.
3. **`model`** (optional and gated), a background 5-8-word generated title.
   **No model is ever spawned by this module**, it only *applies* a string the
   caller generated (`applyModelTitle`). The only live caller is the opt-in
   `settings.ollama.utility.titles` trigger (`workflows/modelTitles.ts`,
   2026-09-29, local utility model, one-shot per session; see PROVIDERS.md
   §Utility / task model). Derived titles remain the default. Title generation uses the configured local utility model and makes no automatic cloud call.
4. **`operator`**, a manual rename. Always wins.

**Subtitle** ("where this left off") has two sources, **summary wins**: a
generated Recall summary's first line (`subtitleSource = 'summary'`, **sticky**,
a later upsert won't overwrite it), else the last non-trivial operator message
(`'dynamic'`, refreshed each upsert; omitted when it would just equal the title).

**Refresh precedence.** A derived (deterministic/dynamic) upsert may overwrite
`title` only when the existing title is *itself* derived (rank <= `dynamic`) **and**
either a **material change** happened (`sourceHash` differs) or the existing title
is generic/repetitive. So a `model` or `operator` title survives a refresh; an
idempotent re-upsert is a no-op. `applyModelTitle` mirrors this: it **caches** by
`sourceHash` (same hash + same text -> no-op, no duplicate log line) and is
**outranked** by an `operator` title.

## The module (`server/src/workflows/sessionIndex.ts`)

Self-contained, atomic writes (tmp + rename), path-confined to `<cwd>/.arco/`.
It imports only the `WorkflowMeta` **type** from `workflowMeta.ts` (type-only,
erased at runtime), so the one runtime edge is `writeMeta -> sessionIndex` and
there's no import cycle. Exports:

- `readSessionIndex(cwd)`, missing file -> empty index; a corrupt/legacy file
  degrades to empty rather than throwing (the next upsert rebuilds it).
- `upsertSessionIndexFromMeta(meta)`, derive an entry from `meta` + its
  `events.jsonl`, merge over any existing entry (preserving operator-/generated-title-owned
  fields), write.
- `backfillSessionIndex(cwd, readMeta)`, upsert every workflow under the cwd.
  Takes an injected `readMeta` to stay dependency-light.
- `recordSessionSummary(cwd, workflowId, summaryBody)`, set the entry's
  `subtitle` (sticky, `subtitleSource='summary'`) to the summary's first
  non-empty line.
- `applyModelTitle(cwd, workflowId, modelTitle, { sourceHash?, now? })`,
  apply a generated `model` title: caches by `sourceHash`, respects precedence
  (returns `'outranked'` under an operator title, `'cached'` on a no-op,
  `'applied'` on a real change, `'missing'` if not indexed), and event-logs each
  change.
- `readTitleEvents(cwd)`, read the title-change audit log.
- `buildTitleFraming(transcript)`, the 5-8-word prompt contract the
  worker feeds to `applyModelTitle`.

### Title-change audit log (`<cwd>/.arco/title-events.jsonl`)

Title changes are written to the project-state review record using an
append-only `title-events.jsonl` rather than minting a new per-workflow
`events.jsonl` `ServerMessage` type. Each line is a `SessionTitleEvent`
(`{ ts, workflowId, provider, sessionId, from, to, source, sourceHash? }`).
Currently emitted only when a `model` title is applied (the generation event);
Operator renames are also logged. Like `session-index.json` it's a rebuildable
projection, so the `.arco/.gitignore` seed lists it.

## Update triggers

The index updates **opportunistically**, never on its own schedule:

1. **After turns**, `writeMeta()` (`workflowMeta.ts`) fires
   `upsertSessionIndexFromMeta(meta)` alongside the Recall upsert. Every turn,
   `appendCliSession`, and `reconcileLatestCliSession` flow through `writeMeta`,
   so this is the primary trigger.
2. **On resume discovery**, `discoverSessions()` (`sessionDiscovery.ts`) fires
   `backfillSessionIndex(resolved, readMeta)`, catching workflows created by a
   prior server process that haven't taken a turn this run.
3. **From Recall summary generation**, `summarizeWorkflow()`'s persist helper
   (`recall/summarize.ts`) fires `recordSessionSummary(...)` after a summary is
   written, surfacing its first line as the subtitle.

**All three are failure-isolated**, fired-and-logged, never awaited into the
caller's result (identical to the Recall upsert's contract). A hiccup in the
index must never break a real workflow's meta write, a session-picker fetch, or a
summary write. The index is rebuildable, so failing closed loses nothing.

### Acceptance invariant

Building or updating the index **never mutates a provider's own session files**
(`~/.claude`, `~/.codex`, ...). It only reads Arco-owned state (`meta.json` +
`events.jsonl`) and only writes `<cwd>/.arco/session-index.json`.

## Resume picker

The resume picker (`client/src/components/ConversationMenu.tsx`, the `RESUME
SESSION...` view) is the consumer of everything above. On open it fetches
`/api/sessions` (discovery, the authoritative list of what exists on disk) and
`/api/session-index` (the projection), then **merges** them by the
`(provider, sessionId)` key so each discovered row is enriched with its index
entry: the layered title, the subtitle, pin/archive state. Rows sort
**pinned-first, then last-active**, and a filter box matches title / subtitle /
provider tag. The merge is safe because `(provider, sessionId)` is identical
between `SessionInfo` and `SessionIndexEntry` for both native and arco-internal
sessions (the latter both key on the workflow id).

### Server ops (`server/src/workflows/sessionIndex.ts`)

Each is an operator-initiated, reversible read-modify-write selected by the
`(provider, sessionId)` key, returning the updated entry (or null on a miss):

- `renameSession(cwd, sel, title)`, sets `title` + `titleSource='operator'` (the
  top layer; survives every derived refresh via `mergeEntry`) and logs an
  `operator` `SessionTitleEvent`. Empty title is a no-op (no "revert to derived"
  path, delete the index to rebuild).
- `setSessionPinned(cwd, sel, pinned)` / `setSessionArchived(cwd, sel, archived)`
, toggle the flags; `mergeEntry` preserves them across opportunistic upserts.

### HTTP routes (`server/src/http/workflowDataRoutes.ts`)

- `GET /api/session-index?path=<cwd>` -> `{ entries }`. Awaits a
  `backfillSessionIndex` first so the file is authoritative even for workflows
  that haven't taken a turn this run (it can't race discovery's fire-and-forget
  backfill).
- `POST /api/session-index/{rename,pin,archive}`, body `{ provider, sessionId,
  ... }`, returns `{ entry }` (the client folds it back; the server is the source
  of truth). Client store: `client/src/stores/sessionIndexStore.ts`.

### Deferred behavior

The picker rows do **not** yet show live `waiting/running/idle` status or
`contextPercent`/`quotaLabel`, those fields exist on the entry but nothing
populates them for inactive sessions, and wiring live per-workflow runtime state
into the picker is a follow-up. The picker is primarily for resuming *inactive*
sessions, so the available actions are rename, pin, archive, and filter. Rows show the title, subtitle, provider, and last-active time. Live telemetry columns remain unpopulated.

## Smoke

Two pure scenarios (no Arco server/WS, no Recall db).

`npm run smoke:resume-titles` (`scripts/smoke/resume-titles.ts`), against a
throwaway `.arco` tree it asserts: a generic opener is skipped so the title is
the first real ask; the dynamic subtitle is the last non-trivial message (and a
single-ask session gets none); `applyModelTitle` applies / caches (no duplicate
log line) / is outranked by an operator title; a model title survives a
no-material-change upsert and an operator title survives a material change; the
Recall-summary subtitle is sticky across a later upsert; and `buildTitleFraming`
states the 5-8-word contract.

`npm run smoke:session-index` (`scripts/smoke/session-index.ts`), against a
throwaway `.arco` tree it asserts:

- a single workflow builds one entry keyed on its native `(provider, sessionId)`,
  with `title` = first operator message and `lastSeq` / `sourceHash` mirroring
  `meta`;
- re-upsert is idempotent (one entry);
- an operator title survives a no-material-change re-upsert, and a material change
  (new `lastEventSeq`) refreshes the deterministic title;
- an arco-internal workflow (no `cliSessions`) keys on `(primaryProvider,
  workflowId)`;
- `recordSessionSummary` sets the subtitle to the first non-empty summary line;
- `backfillSessionIndex` indexes every workflow under a cwd;
- **Operator controls**: `renameSession` sets an `operator` title that **survives a
  material-change refresh** and logs an `operator`
  title-event; `setSessionPinned` / `setSessionArchived` toggle flags that
  survive an upsert; a mutation on an unknown key returns `null`;
- **the acceptance invariant**: after an upsert, the only changed file under the
  tree is `.arco/session-index.json`, a sentinel "provider session file" and
  everything else are byte-for-byte unchanged.
