# Recall — conversation memory & cross-session search

> Status: **F1 shipped** (session index + auto-labels), **F2 shipped** (conversation summaries), **F3 shipped**
> (full-text search). F4 (tags) is planned. See `docs/WORKBENCH_EXPANSION_PLAN.md` Part F for the full arc.

## What Recall is (and what it is *not*)

Recall is **operator-driven retrospective recall over your own conversations** — "find the conversation from
two weeks ago about X, with its context." It is a backward-looking archive of what already happened, distinct
from the forward-looking, hand-curated Knowledge base (B3) and from in-session search (A5, transcript + cwd
files). Recall is cross-session and cross-project.

### Fence-clearance (projection, not profile)

Recall superficially resembles the kind of "memories" feature this repo **fences** (see `CLAUDE.md` hard
fences + Appendix B): a silent AI-built auto-profile of the *user*, or a self-evolving agent that writes its
own instructions. Recall is **not** that, and the difference is structural, not cosmetic:

- Recall indexes **conversations**, never the operator. There is no model of "what the user is like."
- The index is a **deterministic projection** of each workflow's `meta.json` + `events.jsonl` — no inference,
  no LLM. F1 contains zero model calls. (Summaries arrive in F2 and are **one-off, operator-triggered**, with
  a deterministic fallback — the same shape that makes Handoff and the B3 wizard OK, not the rejected
  "second-LLM-in-the-agent-loop" pattern.)
- It passes the four-question test: operator-initiated (you query it); deterministic (a projection +
  ripgrep/FTS later); visible (rebuildable from the same `events.jsonl` everything else reads); reversible
  (delete the DB, edit a title, regenerate a summary).

## F1 — Session index + auto-labels

**Goal:** a machine-global, cross-cwd index of every workflow ever run, each with an intuitive, non-blank
label, so "what conversations do I have and where" is answerable in one place. Before F1, listing was scoped
per-project-folder and only Claude auto-titled.

### The index

`server/src/recall/index.ts` — a `RecallIndex` class behind a `load()` / `save()` / `query()` interface (the
interface is the contract; see the Part E storage rationale).

- **Backend: SQLite** via `better-sqlite3` (already a server dependency; F1 establishes the usage pattern).
- **One row per workflow:** `{ wfid, cwd, project, provider, title, createdAt, lastActiveAt, turnCount,
  summaryRef?, tags[] }`.
- `query()` lists all entries, optionally filtered by `project` / `provider`, sorted by `lastActiveAt` desc.
  (Rich full-text search is F3.)
- **F3-ready schema:** the `entries` table holds no FTS-specific columns, so F3 can add a `CREATE VIRTUAL
  TABLE ... USING fts5(...)` alongside it **without migrating `entries`**. The `summaryRef` (F2) and `tags`
  (F4) columns exist now so those phases don't migrate the table either. FTS5 / full-text search is **NOT**
  built in F1.

### Machine-global storage

The DB lives at **`~/.archon/recall/recall.db`** — tied to the user, never per-cwd. Path is built from
`os.homedir()` + `node:path`; the directory is created on first `load()`. (A constructor `dbPath` override
exists so smokes point the index at a temp dir — the real `~/.archon` is never touched by a test.)

### Title fallback chain (never blank)

The acceptance criterion is that **every entry has a non-empty title**. Resolved on projection, recomputable
on demand:

1. **Claude `ai-title`** — the existing auto-title. Read from the workflow's latest Claude CLI session JSONL
   at `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl` via `sessionDiscovery.extractSessionName`. Many
   sessions never get one (non-Claude workflows, or heavy tool-use sessions Claude never titled).
2. **First operator message** — the first `user_message_echo` event's `content` in the workflow's
   `events.jsonl`, trimmed to a sane length (80 chars, ellipsized).
3. **Derived label** — `<provider> · <project> · <date>`. Always available, so the chain never returns blank.

`project` is the cwd basename; `turnCount` is the count of `user_message_echo` events.

### Backfill, incremental update, rebuild

Three populate paths, all upsert by `wfid` (idempotent — re-running never duplicates):

- **Backfill** (`backfill()`) — walks every cwd in `~/.archon/known-cwds.json` (the same crash-recovery
  registry `crashRecovery.ts` maintains), reads each `<cwd>/.archon/workflows/<wfid>/meta.json`, projects it,
  and upserts. Runs on server boot. One bad/unreadable workflow is skipped, not fatal.
- **Incremental** — `writeMeta` (`server/src/workflowMeta.ts`, the single meta-write chokepoint) fires
  `getRecallIndex().upsertFromMeta(meta)` on every write, so a new or updated workflow lands in the index
  with no manual action. **Failure-isolated:** the upsert is fire-and-log (`.catch(...)`), never awaited into
  the meta-write result — an index hiccup must never break a real workflow's meta write.
- **Rebuild** (`rebuild()`) — drops `entries` and re-backfills. The escape hatch that makes the DB a pure
  projection: if `recall.db` is deleted or suspected stale, rebuild reconstructs it from disk. Boot backfill
  on a missing DB has the same effect.

### HTTP

`GET /api/recall/index[?project=<p>][&provider=<name>]` → `{ entries: RecallEntry[] }`, always 200 (degrades
to `{ entries: [] }` on a read error). Route: `server/src/http/recallRoutes.ts`. See `docs/HTTP_API.md`.

### Client

`client/src/stores/recallStore.ts` — a minimal standalone Zustand store (kept out of `appStore`, mirroring
`terminalStore`) holding the index list + a `fetchIndex(filter?)` that hits the endpoint. F1 only needs the
data reachable; the full Recall **view** (search UI) is F3.

### Smoke

`scripts/smoke/recall-index.ts` (`npm run smoke:recall-index`, no WS / LLM) seeds two fake workflows under
different cwds — one Claude workflow WITH an `ai-title`, one Codex workflow WITHOUT — under a temp
`$HOME`, backfills, and asserts: both indexed; both have non-empty titles (ai-title vs first-message
fallback); correct project/provider; idempotent re-backfill (2 entries, not 4); delete-DB + rebuild
reconstructs both.

### Files

- `server/src/recall/index.ts` — the index store + projection + title chain + backfill/rebuild.
- `shared/src/protocol/recall.ts` — `RecallEntry`, `RecallIndexQuery`, `RecallIndexResponse`.
- `server/src/http/recallRoutes.ts` — the index endpoint.
- `client/src/stores/recallStore.ts` — minimal client slice.
- Hook: `server/src/workflowMeta.ts` (`writeMeta` upsert), `server/src/index.ts` (boot backfill).

---

## §F2 — Conversation summaries

**Goal:** a durable, searchable recap per conversation — "a point in time I can go back to" (what the thread
was about, key decisions, current state, open threads). Generated **on operator action** (the Recall row's
**Summarize** button) or **operator-armed on tab close** — **never automatically in the agent loop.**

### Fence-clearance (the load-bearing part)

The rejected hard fence is *second-LLM summarization **in the agent loop*** (`distill` — doubles spend, fails
closed). F2 clears it because all four hold:

1. **Operator-triggered / operator-armed only.** The only callers are the Summarize button
   (`recall_summary_request` over WS) and a default-OFF "summarize on tab close" toggle. There is **no caller
   in any per-turn path** — `summarizeWorkflow` is never invoked from the turn engine.
2. **Deterministic fallback — never fails closed.** If the LLM call errors, returns empty, or no provider is
   authenticated, the summary degrades to the F1 title + the `summarizePriorTurns` structural digest (no LLM).
   A degraded summary is **not an error** (`ok: false`, no `error`); it's a real, useful recap.
3. **Transcript stays the source of truth.** Summaries only read `events.jsonl`; they are additive artifacts.
4. **Reversible.** Delete `~/.archon/recall/<wfid>/summary.md` and the `summaryRef` clears on the next
   regenerate.

The summary call is a **single bounded read-only turn** — no loops, no multi-pass refinement, no second LLM
judging the summary.

### The summary turn (reuses the Handoff `fresh-summarizer` shape)

`server/src/recall/summarize.ts` → `summarizeWorkflow({ wfid, summarizer, manager })`:

1. Looks up the F1 index entry (carries `cwd`), loads the transcript via `replayEvents(cwd, wfid, 0)`.
2. Runs ONE short-lived read-only worker (`manager.spawn`) over a `renderTranscript` of the events, with a
   **recall-summary framing** (dense archive recap, distinct from the Handoff "resume work" framing),
   `tools: ['Read','Grep','Glob']` for claude/ollama, `outputStyle: 'normal'`, codex account passthrough —
   mirroring `exportContext`'s `fresh-summarizer` branch but writing to the RECALL location.
3. On success writes the LLM body; on **any** failure writes the deterministic digest — to the **same file**.
4. Calls `RecallIndex.setSummary(wfid, ref, body)`; the WS handler emits `recall_summary_ready { ok }`
   (`ok=true` = LLM, `ok=false` = deterministic fallback).

`summarizeWorkflow` **never throws and never blocks** beyond the single spawn.

### Storage (machine-global — differs from Handoff)

Summaries live at **`~/.archon/recall/<wfid>/summary.md`** — the machine-global recall home (computed via
`recallHomeDir()` / `os.homedir()`, never hardcoded), **not** the per-cwd workflow artifacts dir Handoff uses.
`summaryRef` stored in the index is the stable relative ref **`<wfid>/summary.md`**. Because the recall home is
outside any cwd the `/api/workflows/artifact` endpoint serves, F2 adds a dedicated route:
**`GET /api/recall/summary?wfid=`** → `{ wfid, summary }`. The route validates `wfid` against
`/^[a-zA-Z0-9-]{1,64}$/` (no `..`, no separators) **before** joining, and only ever serves `summary.md` under
`~/.archon/recall/<wfid>/`.

### Index + FTS

`RecallIndex.setSummary(wfid, ref, summaryBody?)` upserts **only** the `summaryRef` column (never touching
F1's projection columns or F4's `tags` — symmetric with `save()`'s `ON CONFLICT` refusing to clobber it the
other way), then re-indexes FTS with a **bounded prefix of the summary BODY** (8000 chars) so **§F3 search hits
the summary text**, not just the ref string. The full body lives on disk (source of truth); `save()` and
`rebuildFts()` re-read it from disk when a `summaryRef` exists so a later meta-write upsert or a rebuild keeps
the body in FTS rather than downgrading to the bare ref.

### Client

- `RecallResultRow` action: **Summarize** when no `summaryRef` (fires `recall_summary_request`, shows
  "Summarizing…"); **Open summary** when one exists (fetches `/api/recall/summary`, renders inline).
- `recall_summary_ready` is routed (no `workflowId` → not events.jsonl) to `recallStore.onSummaryReady`, which
  flips the row and pre-fetches the body.
- **Summarize on tab close** toggle (footer, **default OFF**, localStorage-backed `recallStore.summarizeOnClose`)
  mirrors the cluster idle-nudger precedent. **Deferred (graceful TODO):** the actual close-hook that *offers*
  to summarize on tab teardown is documented at the `TabBar` close handler but not yet wired; the toggle's
  existence + default-OFF state and the per-row Summarize button (the must-have) are shipped. The on-close path
  must NEVER auto-summarize without the operator's explicit arm + confirm.

### Smoke

`scripts/smoke/recall-summary.ts` (`npm run smoke:recall-summary`, no WS / no live LLM) seeds a workflow
fixture under a temp `$HOME`, backfills, then drives `summarizeWorkflow` with a STUBBED `manager.spawn`:
the OK path emits canned text → asserts `summary.md` written + `summaryRef` set + FTS hits the body; the FAIL
path resolves with an error → asserts the deterministic `summarizePriorTurns` digest is written (degraded, NOT
an error); plus an unknown-wfid hard-failure case.

### Files

- `server/src/recall/summarize.ts` — `summarizeWorkflow` (the bounded LLM turn + deterministic fallback).
- `server/src/recall/index.ts` — `setSummary`, `recallHomeDir`, `recallSummaryPath`, FTS body indexing.
- `shared/src/protocol/recall.ts` — `RecallSummaryRequestMessage`, `RecallSummaryReadyMessage`.
- `server/src/ws/workflowHandlers.ts` — `handleRecallSummaryRequest`; dispatched in `server/src/index.ts`.
- `server/src/http/recallRoutes.ts` — `GET /api/recall/summary` (traversal-guarded).
- `client/src/components/Recall/RecallView.tsx` + `RecallResultRow.tsx`, `client/src/stores/recallStore.ts`,
  `client/src/hooks/useWebSocket.ts` (`requestRecallSummary`), `client/src/ws/handleServerMessage.ts`.

---

## §F3 — Global search surface

One **top-level Recall view** (not a per-tab RightPanel sub-tab): keyword search over every conversation in
the F1 index, filtered by project / provider / date. The core operator ask — "search in a single location
based on keywords and find relevant conversations."

**Fence-clearance:** operator-driven retrospective search, **deterministic** — FTS5 bm25 + ripgrep, **no LLM**
in the loop, no AI ranking or summarization.

### Two backends, one shared with A5

| Dimension | Backend | When |
|---|---|---|
| title + summary + tags | SQLite **FTS5** (`entries_fts`) | always on (the must-have) |
| transcript full-text | **ripgrep** over each workflow's `events.jsonl` (A5's `contentSearch.searchContent`) | operator toggle, **default OFF** |

The transcript pass deliberately reuses A5's ripgrep engine (`server/src/contentSearch.ts`) rather than
forking a second search engine or stuffing full transcripts into FTS5. **Why ripgrep over FTS for
transcripts:** full transcripts across all time would bloat the machine-global `recall.db` and force a
re-index on every turn. Scanning `events.jsonl` on demand keeps the DB small (title/summary/tags only) and
reuses an engine that already exists, is validated, and **degrades gracefully when `rg` is absent**
(`transcriptsAvailable: false` in the response; the UI disables the toggle).

### The FTS5 table

`entries_fts` is a `CREATE VIRTUAL TABLE … USING fts5(wfid UNINDEXED, title, summary, tags)` added
**alongside** the F1 `entries` table — **no migration to `entries`** (F1 shaped `entries` FTS-ready for
exactly this). It is itself a projection of `entries` (which is a projection of disk), so it's always
reconstructable.

Sync (no triggers): `RecallIndex.indexFts(entry)` is called from `save()` on every upsert and during
backfill; `rebuildFts()` re-derives every FTS row from `entries`. `save()` reads the persisted row back
before indexing so the FTS text reflects the F2/F4 columns (`summaryRef` / `tags`) that the F1 projection
upsert deliberately doesn't clobber. Since **F2**, the `summary` FTS column carries the resolved summary
**body** (bounded prefix, re-read from disk on rebuild) when a summary exists — falling back to the
`summaryRef` string only before a conversation is summarized. FTS indexing is
failure-isolated (`try/catch` + log) so a hiccup never breaks the meta-write hot path.

`search()` (`server/src/recall/search.ts`) owns the public surface; it composes filters, the transcript pass,
and the response shape on top of the narrow `RecallIndex.searchFtsRaw()` DB primitive. The operator query is
sanitized into a safe FTS5 MATCH expression (`toFtsQuery` — tokenize, strip FTS punctuation, quote +
prefix-match each token, AND them) so an operator query with FTS operator chars never throws a syntax error.
An empty query returns the recent list (lastActiveAt desc, honoring filters) so the view is never blank.

### HTTP

`GET /api/recall/search?q[&project][&provider][&from][&to][&transcripts=1]` → `{ hits: RecallSearchHit[],
transcriptsAvailable?: boolean }`, always 200 (degrades to `{ hits: [] }` on error). `from`/`to` are
inclusive epoch-ms bounds on `lastActiveAt`. Route: `server/src/http/recallRoutes.ts`. See `docs/HTTP_API.md`.

### Client

Top-level overlay `client/src/components/Recall/` (`RecallView` + `RecallResultRow`), mounted in `App.tsx`
behind `appStore.showRecall` (like `UserManual` — a portal modal, Escape / backdrop to dismiss). Entry
points: the command palette command **"Recall: search conversations"** (`CommandPalette.tsx`) and the header
**⌕ RECALL** button (`SystemHeader.tsx`). Search is debounced (180ms) on any filter change via
`recallStore.runSearch`. See `docs/CLIENT.md`.

**Result actions** (and their build state):

- **Jump to transcript / Resume** — LIVE. If the hit's workflow is an open tab, switch to it. (Hits are
  conversation-level today, so there's no per-event anchor to flash; opening the conversation is "enough" per
  the plan.) An archived conversation that isn't open can't be silently resumed from here — that needs the
  WorkflowCreator resume path — so the button surfaces a non-error hint pointing to the project folder.
- **Summarize / Open summary** — LIVE (**§F2**). When the hit has no `summaryRef`, the button reads
  **Summarize** and fires a one-off summary; when one exists it reads **Open summary** and renders the saved
  `summary.md` inline. See §F2 above.
- **Reference in current tab** — **deferred** to **D1** context references. The button is present but
  disabled with a TODO tooltip — not a half-build.

### Smoke

`scripts/smoke/recall-search.ts` (`npm run smoke:recall-search`, no WS / LLM) seeds 3 workflows under two
cwds with known distinct tokens, backfills (which also builds the FTS rows), then drives `search()` directly
against a temp `$HOME`. Asserts: a title token returns its wfid + snippet; another token returns the other;
project filter narrows; provider filter narrows; an absent token returns empty; empty query returns the
recent list; and (when `rg` is present) a transcript-only token is invisible without the toggle and found
with it (`matchedIn: 'transcript'`), degrading gracefully when `rg` is absent.

### Files

- `server/src/recall/search.ts` — the §F3 search engine (FTS5 + ripgrep composition).
- `server/src/recall/index.ts` — `entries_fts` table + `indexFts` / `rebuildFts` / `searchFtsRaw` / `get`.
- `shared/src/protocol/recall.ts` — `RecallSearchHit`, `RecallSearchQuery`, `RecallSearchResponse`, `RecallMatchField`.
- `server/src/http/recallRoutes.ts` — the `/api/recall/search` endpoint.
- `client/src/components/Recall/RecallView.tsx` + `RecallResultRow.tsx` — the top-level view.
- `client/src/stores/recallStore.ts` — the F3 search slice (`runSearch`, filters).
- Entry points: `client/src/App.tsx`, `client/src/components/CommandPalette.tsx`, `client/src/components/SystemHeader.tsx`.

---

## F4 — tags, pin-as-memory, links, distill-to-KB

F4 turns the flat recall list into an organized memory web. Everything here is
**operator-initiated HTTP CRUD** over the persisted index, **reversible**, and
**LLM-free** — the four-question clearance stays true.

### Data model

Two columns land on `entries` alongside the F4-reserved `tags`:

- `pinned INTEGER NOT NULL DEFAULT 0`
- `links TEXT NOT NULL DEFAULT '[]'` — a JSON array of `{ type: 'kb' | 'task'; id }`.

Because the `entries` table already exists on a real F1/F2 user's disk,
`CREATE TABLE IF NOT EXISTS` will **not** add these. `RecallIndex.load()` runs an
**idempotent migration** (`migrateF4()`) immediately after the `CREATE TABLE`:
it `PRAGMA table_info(entries)`s, then `ALTER TABLE entries ADD COLUMN …` for
each missing column, guarded independently. Safe to run on a fresh DB, an
old-shape DB, or twice (`load()` is idempotent).

### The meta-write ON CONFLICT guarantee

`save()` is the hot path that the meta-write hook calls on every turn — a pure
F1 projection upsert. It now supplies `pinned`/`links` as INSERT defaults (so a
first insert sets them) but the `ON CONFLICT(wfid) DO UPDATE SET` block
**deliberately omits `summaryRef`, `tags`, `pinned`, and `links`**. A re-upsert
from a meta write therefore refreshes the F1 columns (title / lastActiveAt /
turnCount / …) and never clobbers an operator's summary, tags, pin, or links.
The `recall-tags.ts` smoke proves this for all four after an `upsertFromMeta()`.

### Methods (`server/src/recall/index.ts`)

- `setTags(wfid, tags)` — replace the tag set (sanitized + deduped); **re-indexes
  FTS** (tags are an FTS column). Returns the entry, or `null` if absent.
- `setPinned(wfid, pinned)` — set/clear the pin flag. Not in FTS → no re-index.
- `addLink(wfid, link)` / `removeLink(wfid, link)` — read-modify-write the JSON
  array, deduped on `type+id`. Not in FTS.
- `backlinks(type, id, cwd?)` — every entry whose `links` include `{type,id}`
  (and matching `cwd` when given — KB article ids are unique only within a cwd).
  Full scan + filter (the index is small).
- `query({ pinned? })` — optional pinned filter; sort is `ORDER BY pinned DESC,
  lastActiveAt DESC` so pinned entries float to the top **in both the SQL layer
  and the client** (the client re-sorts pinned-first identically after a mutation).

### Routes (`server/src/http/recallRoutes.ts`)

| Method | Route | Body / query | Returns |
|---|---|---|---|
| POST | `/api/recall/tags` | `{ wfid, tags }` | `{ entry }` |
| POST | `/api/recall/pin` | `{ wfid, pinned }` | `{ entry }` |
| POST | `/api/recall/link` | `{ wfid, link }` | `{ entry }` |
| DELETE | `/api/recall/link` | `{ wfid, link }` | `{ entry }` |
| GET | `/api/recall/backlinks` | `?type=kb&id=<id>&cwd=<cwd>` | `{ entries }` |

Mutations validate `wfid` (`WFID_PATTERN`) and may 400 on bad input / 404 when
the conversation isn't indexed. The `backlinks` read degrades to an empty list
on any failure (like `/index` and `/search`). Each mutation returns the updated
`RecallEntry`; the client folds the changed fields onto the matching hit (no new
WS surface).

### Pin-as-memory vs the fenced self-writing memory

**Pin-as-memory is NOT the rejected pattern.** The fence (CLAUDE.md hard fences,
Part F preamble) rejects an *LLM auto-profiling the operator or writing its own
instructions across sessions* (Odysseus-style "memories"). F4's pin is the
**operator manually** marking one of their **own** conversations as important:

- operator-initiated (a click), never automatic — **nothing is ever pinned by
  any code path without the operator**;
- no LLM is involved at any point;
- persisted (a single `pinned` column) and **reversible** (unpin).

It's a bookmark the operator sets, not a model the agent builds. The server route
and the `setPinned()` method both carry this note.

### Distill to KB (reuses B3's draft → operator-Save path; no auto-save, no LLM call)

The recall entry already carries an **F2 summary** (`summaryRef` →
`~/.archon/recall/<wfid>/summary.md`). "Distill to KB" is available only on rows
that **have** a summary. It does **not** spawn a distiller worker and makes **no
new LLM call** — the summary is the source:

1. The view fetches the existing `summary.md` body and pre-fills a draft (title
   from the recall title, body from the summary).
2. The operator edits the draft and clicks **Save to KB**, which POSTs to the
   **existing** `POST /api/knowledge?path=<cwd>` create flow (B3). Nothing is
   written to the KB store before that operator Save.
3. On a successful Save the view creates the recall↔kb link
   (`addLink(wfid, { type: 'kb', id })`) — the operator's Save is the
   confirmation. The KNOWLEDGE tab then shows the conversation under the
   article's **Linked conversations** back-links.

### Graceful degradation (E-track not built)

Task links (`type: 'task'`) persist and round-trip through `addLink` /
`removeLink` / `backlinks`, but the E2 task track isn't built yet — so a task
link has **no resolver UI**. It renders as an inert chip in the result row and
is removable; once E2 ships it can resolve the id. No code assumes a task
resolver exists, so the absence degrades to a bare, reversible id.

### Smoke

`scripts/smoke/recall-tags.ts` (`npm run smoke:recall-tags`, no WS / LLM / server)
drives `RecallIndex` against a temp DB + fixtures and asserts: `setTags` persists
and survives a meta-write `save()` upsert; `setPinned` persists, survives upsert,
and sorts to the top (+ pinned-only filter); `addLink`/`removeLink` persist and
dedupe; `backlinks(type,id,cwd)` returns the linking entry cwd-scoped; and the
idempotent F4 migration runs cleanly on an **old-shape DB built without the new
columns** (with `load()` safe to call twice).

### Files (F4)

- `server/src/recall/index.ts` — `migrateF4()`, `setTags`/`setPinned`/`addLink`/`removeLink`/`backlinks`, widened `save()` ON CONFLICT, `query({ pinned })`.
- `shared/src/protocol/recall.ts` — `RecallLink`, `pinned`/`links` on `RecallEntry` + `RecallSearchHit`, the F4 request/response types.
- `server/src/http/recallRoutes.ts` — the five F4 routes.
- `client/src/stores/recallStore.ts` — `setTags`/`setPinned`/`addLink`/`removeLink` + pinned-first fold.
- `client/src/components/Recall/RecallResultRow.tsx` — pin toggle, tag chips, links, Distill to KB.
- `client/src/components/Recall/RecallView.tsx` — pinned-only filter + the Distill-to-KB draft form.
- `client/src/components/RightPanel/KnowledgeTab.tsx` — `LinkedConversations` back-links.
- `scripts/smoke/recall-tags.ts` — the F4 mechanism smoke.
