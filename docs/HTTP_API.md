# Arco - HTTP API reference

The HTTP surface served alongside the WebSocket endpoint at `/ws`. `server/src/index.ts` creates the server; every route is dispatched by `handleHttpRequest` in `server/src/http/router.ts`, which runs inline routes and delegates to the `tryHandle*Routes` modules in `server/src/http/*Routes.ts` (order matters - prefix matches like `/api/usage` vs `/api/usage-stats` are resolved by placement). Most state-changing operations go through the WebSocket (see [`PROTOCOL.md`](PROTOCOL.md)); HTTP is reserved for one-shot reads (transcripts, artifact bodies, settings) and operations that don't naturally fit the WS event model (file uploads, auth flows, GitHub proxy).

For terminology see [`GLOSSARY.md`](GLOSSARY.md). For where these are called from on the client, see [`CLIENT.md`](CLIENT.md).

---

## Conventions

- All routes live on the server port (default `3001`). The Vite dev server proxies `/api/*` from `5173` to `3001`.
- Error responses are JSON: `{ "error": "<message>" }` with an HTTP 4xx/5xx status. Several read routes deliberately degrade to `200` with an empty body instead (called out per route) so a picker never dead-ends.
- CORS: the allowed request `Origin` is echoed (`originGuard.ts`; foreign origins get `403`) with `Access-Control-Allow-Credentials: true`; `OPTIONS` answers `204`.
- **Session cookie required** on every `/api/*` route and `/upload` (`401 { "error": "Session required" }` otherwise) - see cookie. Exempt: `/api/session`, the agent tool surface (`/api/clusters/:id/peer/<op>`, `/api/plans`, `/api/plans/attach`, `/api/plans/refs`, `/api/plans/refs/body`), the `/api/preview/<wfid>/...` proxy, and `/healthz` / `/health` / `/readyz`.
- Unmatched requests fall through (in order) to the Referer-based preview fallback, the prod static client serve, then `404`.
- Path-traversal-sensitive endpoints (artifacts, handoffs, file contents) validate their `path` and `name` parameters strictly. Out-of-range values 400 immediately.
- `path` query parameters always mean an **absolute filesystem path** (the workflow cwd or a file under it). Never a URL path.

---

## Session cookie (WS gate)

### `POST /api/session`

Mints the `arco_session_<port>` cookie that `/ws` and `/terminal` upgrades and the gated HTTP routes require (`server/src/http/wsAuth.ts`). `204` with `Set-Cookie: ...; HttpOnly; SameSite=Strict; Path=/` - deliberately session-only (no `Max-Age`), so browsers keep it in memory instead of the on-disk cookie store; the server still rejects tokens older than an hour. Only a same-origin browser `fetch` qualifies: `Origin` present plus `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: cors|same-origin`, `Sec-Fetch-Dest: empty` - anything else is `403 { "error": "Session mint refused" }` and a `refused session mint` log line. The token is HMAC-signed with a per-boot in-memory key, so a restart invalidates every cookie; the client re-mints before each socket connect, every 20 min, on tab focus, and once on any gated-route `401` (`client/src/utils/wsSession.ts`). `ARCO_WS_AUTH=off` turns this into a no-op `204`. No body.

---

## Liveness & readiness

Two distinct signals: liveness ("the process is up and serving") vs readiness ("the process has finished boot and can take real traffic"). Both are unauthenticated `GET`s, never gated on `ARCO_SERVE_CLIENT`, and route ahead of the static-client fallback.

### `GET /healthz`

Liveness. Returns `200 OK` the instant the server is listening - the route only runs when the HTTP server is up, so it is unconditionally 200. Use it for systemd `ExecStartPost`, an uptime monitor, or a load-balancer liveness check.

```ts
{
  status: 'live',
  version: '0.1.0',
  pid: 12345,        // process.pid
  uptimeSec: 42      // integer seconds since the process booted
}
```

```
curl http://localhost:3001/healthz
# -> {"status":"live","version":"0.1.0","pid":12345,"uptimeSec":42}
```

### `GET /health`

Back-compat alias of `/healthz` - identical `200 OK` `{ status: 'live', ... }` body. Prefer `/healthz` in new callers.

### `GET /readyz`

Readiness. `200 OK` only once **both** required components have come up: the boot-time `capabilities` probe and the workflow-store recovery (`stores`). Before that - the window between `listen` and store recovery completing - it returns **`503`** with the still-`pending` component names. Use it for a load balancer's "add to pool when ready" gate or a k8s readiness probe.

Ready (`200`):

```ts
{
  status: 'ready',
  components: { capabilities: true, stores: true },
  pending: [],                                  // empty when ready - shape mirrors the 503 body
  uptimeSec: 42
}
```

Not ready (`503`):

```ts
{
  status: 'not-ready',
  pending: ['stores'],                          // components not yet up
  components: { capabilities: true, stores: false }
}
```

Readiness is **exactly** capabilities + stores. Best-effort boot prefetches (settings, catalogs, recall backfill) are deliberately excluded - a failed/slow prefetch must not wedge readiness false (and store recovery itself marks `stores` ready in a `.finally`, so a recovery error still flips the gate rather than blocking it forever). `arco service status` surfaces the live `/readyz` result. See [`SERVICE_MODE.md` & readiness](SERVICE_MODE.md).

---

## File uploads

### `POST /upload`

Raw binary body upload. Body is the file bytes directly; the filename is passed in the `X-Filename` header. `Content-Type` is used as a fallback when the filename has no extension (maps common image MIME types to extensions).
An empty body is rejected with `400 { error: 'Empty upload body' }`; a zero-byte image would otherwise
become an invalid Anthropic image block and poison a long-lived Native worker's history.

**Response:**
```ts
{
  fileId: string,           // 8-char hex prefix
  filename: string,         // resolved filename (original name + inferred ext if needed)
  path: string,             // absolute path <server cwd>/uploads/<fileId>-<filename> (UPLOADS_DIR; the repo root in dev + the systemd unit)
}
```

A write failure answers `500 { error: 'Upload failed' }`. The route itself is not workflow-scoped; the strict-incognito fence lives on the WS side (an incognito `user_message` carrying `attachments` is refused), and the chat UI hides the attach control in Incognito.

The client may follow up with an `upload_complete` WS message; the server echoes `file_uploaded` back to **that socket only** (not a workflow broadcast - uploads are unscoped).

### `GET /api/file-content?path=<path>[&cwd=<cwd>][&workflowId=<wfid>]`

JSON-wrapped file read for `FileViewerModal` (uploaded attachments, files clicked from a `ToolCallPill`, chat `[artifact:...]` popups). Always answers **200** with a discriminated body from `readFileForExplorer` (`server/src/http/fileRead.ts`):

```ts
| { type: 'text',  content: string, size: number }          // ≤ 2 MiB (MAX_TEXT_SIZE); NUL in first 8 KiB -> 'binary'
| { type: 'image', dataUrl: string, size: number }          // png/jpg/gif/webp/svg/bmp/ico, ≤ 10 MiB (MAX_IMAGE_SIZE)
| { type: 'binary', size: number }
| { type: 'too-large', size: number, kind: 'text' | 'image' }
| { type: 'error', error: string }                          // every candidate failed
```

Candidate resolution, first hit wins (why: agents routinely name files they wrote by bare basename, and `resolve(path)` alone resolves against the *server* cwd): (1) a **relative** `path` with `cwd` -> resolved inside the cwd (skipped if it escapes); (2) `resolve(path)`; (3) with `cwd`+`workflowId`, the basename inside that workflow's `artifacts/` dir. Only `ENOENT` advances to the next candidate.

### `GET /api/files?path=<dir>`

One-level directory listing for the `FileExplorer` panel (lazy - the explorer requests deeper levels on expand):

```ts
{ path: string /* resolved */, files: Array<{ name: string, path: string, isDirectory: boolean }> }
```

Dot-entries hidden; directories first, then name-sorted. An unreadable dir answers `200 { path: '', files: [] }`.

### `POST /api/mkdir`

Create a directory. Body:

```ts
{ parent: string, name: string }  // parent is an absolute path; name is the new directory name
```

`name` must be a single non-hidden path segment (`400` otherwise); `parent` must resolve inside `$HOME` (`403`). Returns `200 { path: <created dir> }` (`mkdir -p` - existing dirs succeed). Used by the cwd folder-browser when an operator creates a fresh project directory.

### `GET /api/list-dirs?path=<absolute>`

Lists subdirectories of the given path. Used by the cwd folder-browser in `WorkflowCreator` and the `DEFAULT WORKING DIRECTORY` picker in Settings.

- **No `path`** -> starts at `settings.defaultWorkingDirectory` (operator-set, Settings), else `~/Projects`, else `$HOME`.
- **Unreadable `path`** (a Linux default opened on a Mac, a deleted folder, ...) -> falls back to listing `$HOME` rather than returning an empty `{parent:'',dirs:[]}`, so the browser always has a non-empty parent with a working `↑ UP` and is never a dead-end. (Returning empty is the last-resort only if `$HOME` itself can't be read.)

**Response:** `{ parent: <resolved absolute path>, dirs: Array<{ name, path }> }` (hidden dirs filtered, name-sorted).

---

## Sessions and transcripts

These power the **Resume** picker (UI surface in `WorkflowCreator`) and the chat hydration of unclaimed sessions.

### `GET /api/sessions?path=<cwd>`

Unified list of native CLI sessions for the given cwd. Walks:

- **Claude** - `~/.claude/projects/<cwd-hash>/*.jsonl`
- **Codex** - `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` (last 30 days)

**Response:**
```ts
{
  sessions: Array<{
    provider: ProviderName,
    sessionId: string,            // UUID (or an Arco wfid for arcoInternal rows)
    cwd: string,
    startedAt: number,
    name: string,                 // first-user-message preview (≤80 chars)
    lastUserPreview?: string,     // most-recent user-message preview
    aiTitle?: string,             // Claude only - best-guess conversation title
    arcoWorkflowId?: string,    // set if claimed by an existing workflow
    arcoName?: string,
    arcoInternal?: boolean,     // continuity is Arco-managed (Native event replay, Ollama) - resume by wfid
    providerAccountRef?: string, providerAccountLabel?: string, providerAccountShortLabel?: string,
  }>,
}
```

`SessionInfo` in `shared/src/protocol/workflows.ts`. Any error degrades to `200 { sessions: [] }`.

Claimed sessions render with a `★` and the workflow name; selecting one reuses its `workflowId`. Unclaimed sessions get a fresh wfid pinned to the native session UUID.

### `GET /api/session-index?path=<cwd>` The resume-picker's session-index read. Awaits a backfill (`backfillSessionIndex`) first so the file is authoritative even for workflows that haven't taken a turn this run, then returns the on-disk projection. Always answers **200** with `{ entries }` (degrades to `{ entries: [] }` on error - never a 500). Backed by `server/src/http/workflowDataRoutes.ts`.

### `POST /api/session-index/rename` · `POST /api/session-index/pin` · `POST /api/session-index/archive` Operator mutations on a session-index entry. Each takes a JSON body identifying the entry plus the mutation field - `rename`: `{ title }`; `pin`: `{ pinned: boolean }`; `archive`: `{ archived: boolean }`. Routed through the shared `handleSessionIndexMutation` helper.

### `GET /api/transcript?path=<cwd>&sessionId=<uuid>&provider=<claude|codex>[&account=<profileId>][&limit=200&before=<cursor>]`

Fetches a slice of a native CLI session's chat history as `ChatMessage[]`. `path` and `sessionId` are required (`400`), `sessionId` must be a UUID (`400`). `limit` defaults to 200, capped at 1000. `account` (Codex only) selects the provider-account profile whose `$CODEX_HOME` holds the rollout. Used by:

1. **Unclaimed-session resume hydration** - when a session is picked from the Resume picker, the client fetches the tail (last 200) to populate `sessionChat` immediately.
2. **Load-earlier paging** - clicking `↑ LOAD EARLIER MESSAGES` fetches the next page going backwards.

Codex sessions are located via `findCodexRolloutPath(sessionId)` (by rollout filename); Claude sessions read from `~/.claude/projects/<cwd-hash>/<sessionId>.jsonl`. Provider defaults to `claude` when omitted.

**Response:**
```ts
{
  messages: ChatMessage[],
  hasEarlier: boolean,
  earlierCursor?: number,         // pass back as `before` for the next page (numeric index)
  total: number,
}
```

Tool-use blocks and reasoning-block entries are intentionally **not** materialized - only `role: 'user' | 'assistant'` text. Matches the shape of the in-memory `loadTranscript` path. A read failure answers `500 { error, messages: [] }`.

### `GET /api/transcript-export?path=<cwd>&sessionId=<uuid>`

Returns the full **Claude CLI** session (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`) as one markdown download (`Content-Disposition: attachment; filename="arco-<id8>-<date>.md"`; `## Operator` / `## Arco` sections). No pagination. There is no `provider` switch - Codex rollouts are not exportable here. `path` + `sessionId` required (`400`).

---

## Workflows

### `GET /api/chats`

Lists saved, machine-global Chat conversations under
`~/.arco/chats/<workflowId>/.arco/workflows/<workflowId>/meta.json`, sorted
by `lastActiveAt` descending. Returns `{ chats: SavedChatSummary[] }`; every row
includes identity/provider fields, an optional latest-user preview, and a
server-reconstructed `config` carrying `kind:'chat'` plus `resumeWorkflowId`.
The client can pass that config directly to `create_workflow`; the server
re-derives the storage path and verifies the target meta is actually Chat.
Incognito conversations never write meta and therefore cannot appear here.

### `GET /api/workflows?path=<cwd>`

Lists workflows seen on disk for a cwd (tooling / debugging - the Resume picker reads `/api/sessions`). Returns `{ workflows: WorkflowMetaSummary[] }`:

```ts
{ workflows: Array<{
  workflowId: string,
  name: string,
  cwd: string,
  createdAt: number,
  lastActiveAt: number,
  primaryProvider: ProviderName,
  primaryModel: ModelName,
  primaryEffort: EffortLevel,
  lastClaudeSessionId?: string,   // newest Claude entry in meta.cliSessions
}> }
```

Reads `meta.json` for each `<cwd>/.arco/workflows/<wfid>/` (`listWorkflowMetas`). Sorted by `lastActiveAt` desc; errors degrade to `{ workflows: [] }`.

### `GET /api/workflows/artifact?path=<cwd>&workflowId=<wfid>&name=<filename>`

Fetches a Review artifact (or other worker-written file) from `<cwd>/.arco/workflows/<wfid>/artifacts/<filename>`.

- `path`, `workflowId`, `name` required (`400`). `name` must be a bare basename: no `/`, `\`, NUL, `.`/`..`, or leading dot; the resolved target is re-checked to stay inside `artifacts/` (`400`).
- `404` if missing; `413 { error, bytes }` over 2 MiB; else **200** JSON `{ contents: string, bytes: number, name }` (UTF-8 text - use `/artifact-raw` for images).

### `GET /api/workflows/artifact-raw?path=<cwd>&workflowId=<wfid>&name=<filename>`

Streams the **raw bytes** of an artifact (vs the markdown-as-text `/api/workflows/artifact`), so an `<img src>` can render a worker-written image directly (G1 preview screenshots). Matched **before** the JSON artifact route (whose `/api/workflows/artifact` prefix also matches this longer path). Backed by `server/src/http/workflowDataRoutes.ts`.

- `path` (the cwd), `workflowId`, and `name` are all required (`400` otherwise). `name` has the same guard as `/artifact` (no slashes / NUL / `.` / `..` / leading dot) plus a resolved-path re-check that the target stays inside the workflow's `artifacts/` dir.
- Content-Type is by extension (`.jpg`/`.jpeg` -> `image/jpeg`, `.png`, `.webp`, `.gif`, else `application/octet-stream`); served with `Cache-Control: no-store`.
- `404` if missing; `413` when the file exceeds the 16 MiB cap (`{ error, bytes }`); `200` with the bytes otherwise.

### `GET /api/workflows/handoff?path=<cwd>&workflowId=<wfid>&name=<filename>`

Same shape as `/api/workflows/artifact` but reads from `handoffs/` rather than `artifacts/`. Separate route so the path-traversal guard stays tight on each.

### `GET /api/workflows/events?path=<cwd>&workflowId=<wfid>[&limit=250&beforeSeq=<seq>]`

Backward-paging read of a workflow's persisted `events.jsonl` (the HISTORY-tab "load earlier" path). `path` + `workflowId` required (`400` otherwise); `workflowId` is UUID-validated. `limit` defaults to 250, capped at 1000; `beforeSeq` is the exclusive upper `seq` bound (omit for the tail). Returns the page object from `readWorkflowEventsPageBefore`; a read error answers 500 with `{ error, events: [] }`.

### `DELETE /api/workflows/:wfid?path=<cwd>&mode=arco|nuclear`

**Conversation purge - irreversible.** Deletes a workflow's on-disk footprint. Body: `{ "confirm": true }`; **`nuclear` additionally requires `{ "confirmName": "<workflow name>" }`** matching `meta.json`'s `name` (the secondary verification - else `400`).

- `mode=arco` (default) - removes everything Arco wrote: the `<cwd>/.arco/workflows/<wfid>/` tree (events.jsonl, meta.json, artifacts, handoffs, sandbox, mcp-config), git (`refs/arco/<wfid>/*`, cwd repo + shadow store) + legacy tar checkpoints, the recall row (+ FTS), and the cluster mailbox. Leaves the provider's own session file.
- `mode=nuclear` - all of the above **plus** the bound provider session files (`~/.claude/projects/.../<sessionId>.jsonl`, Codex rollout) from `meta.cliSessions`, so the conversation is gone from those CLIs too.
- In-memory teardown (`handleRemoveWorkflow`) runs first, so purging an open tab is clean. Every deletion is best-effort/isolated; returns `{ ok, removed: string[], error? }`. Backed by `server/src/workflows/purgeWorkflow.ts`. Smoke: `npm run smoke:purge`.

### `GET /api/workflows/diff?wfid=<wfid>[&path=<cwd>][&from=<rev>][&to=<rev|WORKTREE>]`

Workbench Expansion A3. Returns a unified-diff patch for the in-app DiffView. Backed by `server/src/gitDiff.ts` (the git logic) + `server/src/http/diffRoutes.ts` (the route). Read-only - runs `git diff` via `execFile` with an argv array; never touches the user's index/HEAD.

- `wfid` - required; validated against `[A-Za-z0-9._-]+`. Resolves the workflow's live cwd when `path` is omitted.
- `path` - explicit cwd (mirrors the other workflow-scoped routes). Wins over the resolved wfid cwd.
- `from` / `to` - git revisions. A revision can be a shadow checkpoint ref (`refs/arco/<wfid>/<seq>`, from A2), `HEAD`, a sha, or a branch. `to` may also be the literal `WORKTREE` sentinel (the default when omitted), which compares the live working tree (incl. staged) against `from` (or `HEAD` when `from` is also omitted - the pre-commit diff).
- Always answers **200** with `{ patch, isRepo, from, to, missingRef? }`. Non-git dirs return `isRepo:false` + empty `patch`; an unresolvable revision returns `missingRef` + empty `patch`; a clean tree returns an empty `patch`. None of these is an error.

---

### `GET /api/git/diff?wfid=<wfid>[&path=<cwd>][&file=<repo-rel-path>][&staged=1]`

Workbench Expansion I1. Powers the FILES -> SOURCE "Source Control" view: list the working tree's changed files grouped staged / unstaged / untracked, then fetch one file's unified diff on click. **Distinct from `/api/workflows/diff`** (A3, which produces a single whole-tree or ref-vs-ref patch); both feed the same source-agnostic `DiffView`. Backed by `server/src/gitWorking.ts` (`getWorkingChanges` + `getFileDiff`) + `server/src/http/gitDiffRoutes.ts` (the route). Read-only - runs `git status` / `git diff` via `execFile` with an argv array, always passing `--` so a path can't be re-read as a flag; never touches the index/HEAD.

- `wfid` - required; validated against `[A-Za-z0-9._-]+`. Resolves the workflow's live cwd when `path` is omitted.
- `path` - explicit cwd (mirrors the other workflow-scoped routes). Wins over the resolved wfid cwd.
- `file` - repo-relative path of one changed file. **Absent -> list mode; present -> per-file diff mode.** A `-`-leading or NUL-containing path is rejected (empty patch, not a flag injection).
- `staged` - `1`/`true` selects the staged diff (`git diff --cached`, index vs HEAD); otherwise the unstaged diff (`git diff`, work tree vs index). Ignored for untracked files (which are detected via `git ls-files --error-unmatch` and rendered as an all-added new-file diff via `git diff --no-index -- /dev/null <file>`).
- **List mode** answers **200** with `{ isRepo, staged[], unstaged[], untracked[] }` - each entry `{ path, status, origPath? }` (`status` is the git porcelain-v2 single-letter code for that side; `origPath` set for renames). Non-git dir -> `isRepo:false` + empty arrays.
- **Per-file mode** answers **200** with `{ isRepo, patch, binary?, path, staged }`. A binary or oversized file returns `binary:true` + empty `patch` (no megabyte dumps - 32 MiB / 15 s bounds, like A3). Non-git dir or invalid path -> `isRepo:false`/empty `patch`. None of these is an error.

---

### `GET /api/git/bakeoffs/diff?wfid=<wfid>&bakeoffId=<id>&attemptId=<id>`

Read-only candidate patch for **AGENT -> BAKE-OFF**. The source workflow cwd,
durable manifest, bake-off id, and attempt id must all agree before the
worktree is read; the Git layer then reasserts that the target is under the
source repo's Arco-managed bake-off root and is still a registered linked
worktree. The patch compares the recorded common base against the attempt's
current branch/worktree, includes tracked and untracked project files, excludes
`.arco`, and is capped at 8 MiB.

- Missing query fields -> **400**.
- Unknown manifest or attempt -> **404**.
- Success -> **200** `{ patch, from, to:'WORKTREE', branch, cleaned }`.
- Unexpected Git/filesystem failure -> **500** `{ error }`.

All mutations (start, promote, cleanup) use the WebSocket primitive; there is no
HTTP mutation endpoint for a model or shell agent to guess.

---

### `GET /api/git/compare?wfid=<wfid>[&path=<cwd>]`

Workbench Expansion I2. Powers the FILES -> REMOTE view: how the cwd's current branch sits against its upstream (`@{u}`). Backed by `server/src/gitWorking.ts` (`getUpstreamComparison`) + `server/src/http/gitCompareRoutes.ts`. **Read-only** - `git rev-parse` / `git log` / `git diff --shortstat` via `execFile` argv arrays; never mutates.

- `wfid` - required; validated against `[A-Za-z0-9._-]+`. Resolves the workflow's live cwd when `path` is omitted.
- `path` - explicit cwd; wins over the resolved wfid cwd.
- Always answers **200** with `UpstreamComparisonResponse` `{ isRepo, branch?, upstream?, detached?, hasUpstream?, ahead?[], behind?[], aheadDiffstat?, behindDiffstat? }`:
  - `ahead` = local-only commits (`@{u}..HEAD`, **to push**), `behind` = remote-only commits (`HEAD..@{u}`, **to pull**). Each commit `{ hash, subject, author, ts }` (ts = author date, epoch ms); newest first.
  - `aheadDiffstat` / `behindDiffstat` = `{ files, insertions, deletions }` from `git diff --shortstat` on the symmetric range.
  - Non-fatal cases (all 200): non-git -> `isRepo:false`; detached HEAD -> `detached:true`; no upstream configured -> `hasUpstream:false` (+ `branch`); in sync -> `ahead:[] behind:[]`.

### `GET /api/git/compare/diff?wfid=<wfid>&direction=ahead|behind[&path=<cwd>]`

Workbench Expansion I2. The per-direction unified diff for the comparison, so the REMOTE tab can render it through the A3 `DiffView` unchanged. `direction=ahead` -> `upstream...HEAD` (local-only changes a push would send); `direction=behind` -> `HEAD...upstream` (remote-only changes a pull would bring); any other value defaults to `ahead`. Read-only. Answers **200** with a `WorkingFileDiffResponse` `{ isRepo, patch, binary?, path, staged }` (`path` echoes the direction, `staged` is always `false`). Non-git / detached / no-upstream -> empty `patch` (not an error).

### `POST /api/git/fetch`

Workbench Expansion I2. Operator-triggered `git fetch` - the one write in the REMOTE tab. **Updates remote-tracking refs only; never merges, rebases, or moves `HEAD`** (the mutating push/pull lands in I3). Backed by `server/src/gitWorking.ts` (`fetchRemote`).

Request body (JSON): `{ wfid?, path?, remote? }`.

- `wfid` - optional; validated when present. Resolves the cwd when `path` is omitted.
- `path` - explicit cwd; wins over the resolved wfid cwd. One of the two must yield a cwd.
- `remote` - optional remote name. Default = the upstream's remote (parsed from `@{u}`), else `origin`. **Validated against `/^[A-Za-z0-9._/-]+$/` and rejected if it leads with `-`** so it can't smuggle a git flag.
- `git fetch` runs with a 60 s (still bounded) timeout - longer than the 15 s diff timeout, since it's a network op.
- Always answers **200** with `FetchRemoteResponse` `{ ok, remote, fetched, error? }`. A fetch failure (offline, auth, unknown remote) is `{ ok:false, error }` at **200**, not a 500 - it's a non-fatal operator-visible condition.

---

### `GET /api/git/worktrees?wfid=<wfid>[&path=<abs>]`

Enumerate a repo's linked worktrees so the FilesTab LIVE/CHANGES/SOURCE/REMOTE picker can point at the tree a worker (or cluster member) is actually editing - cluster members do their edits inside an Arco task worktree (`~/.arco/worktrees/...`) or one they created, both OUTSIDE the shared cwd (where `git status` reads clean). Backed by `server/src/project/taskWorktree.ts` (`listWorktrees`) + `server/src/http/gitWorktreeRoutes.ts` (wired via `tryHandleGitWorktreeRoutes`). **Read-only.**

- `wfid` - required; validated against `[A-Za-z0-9._-]+` (`400` on missing/invalid). Resolves the bound cwd when `path` is omitted.
- `path` - explicit cwd; wins over the resolved wfid cwd.
- **200** with `WorktreeListResponse` `{ isRepo, worktrees[] }` - each `WorktreeInfo` `{ path, branch: string|null, head, isMain }` (main tree first). Non-git / no-cwd -> `{ isRepo:false, worktrees:[] }` (structured body, not a 500, mirroring `gitDiffRoutes`); `500` only on an unexpected error.

---

### `POST /api/git/op/<family>`

Workbench Expansion I3. Direct local git operations - operator-clicked actions that **INTENTIONALLY mutate the real index / working tree / refs** (the opposite of A2 checkpoints, which never touch the real index). Backed by `server/src/gitOps.ts` (argv-only, every user value validated by `server/src/gitSafe.ts`, `--` before every pathspec) + `server/src/http/gitOpRoutes.ts`. One POST per op family; wired AFTER `/api/git/status|checkout|diff|compare|fetch` so the `/api/git/op/` prefix can't shadow them.

Common request fields: `{ wfid?, path?,... }` - `wfid` validated when present (resolves the cwd); `path` is an explicit cwd that wins over the resolved wfid cwd; one must yield a cwd. The cwd is checked to be a git repo first. Every op answers **200** with a structured `GitOpResult` body - expected git failures are `{ ok:false, op, stderr }` (not a 500), and a refused push is `{ ok:false, needsConfirm:true, reason }`. On a workflow-scoped call the op + outcome is broadcast as a `git_op_result` event and persisted to `events.jsonl`.

| Family | Extra body fields | git argv | Notes |
|---|---|---|---|
| `stage` | `action:'files'\|'all'`, `paths[]` | `add -- <paths>` / `add -A` | each path -> `isSafePath`; whole call rejected if any fails |
| `unstage` | `action:'files'\|'all'`, `paths[]` | `reset -q HEAD -- <paths>` / `reset -q HEAD` | each path -> `isSafePath` |
| `commit` | `message`, `amend?` | `commit -m <message> [--amend]` | empty message rejected; **no trailer injected - verbatim** |
| `fetch` | `remote?` | `fetch [-- <remote>]` | remote -> `isSafeRemote` |
| `pull` | `remote?`, `branch?` | `pull [<remote> [<branch>]]` | remote/branch -> `isSafeRemote`/`isSafeRef` |
| `push` | `remote?`, `branch?`, `force?`, `setUpstream?`, `confirm?` | `push [--force-with-lease] [--set-upstream] [<remote> [<branch>]]` | **protected-branch OR force requires `confirm:true`** -> else `needsConfirm`, git NOT run; force uses `--force-with-lease` |
| `stash` | `action:'save'\|'pop'\|'list'`, `message?`, `ref?` | `stash push [-m <msg>]` / `stash pop [<ref>]` / `stash list` | ref -> `isSafeRef`; list returns `stashes[]` |
| `branch` | `action:'create'\|'delete'`, `name`, `checkout?`, `force?` | `switch -c <name>` / `branch -- <name>` / `branch -d\|-D -- <name>` | name -> `isSafeRef` |
| `tag` | `action:'create'\|'delete'`, `name`, `message?` | `tag [-a -m <msg>] -- <name>` / `tag -d -- <name>` | name -> `isSafeRef` |

`GitOpResult` shape: `{ ok, op, stderr?, needsConfirm?, reason?, changes?, stashes?, commitHash? }`. `changes` is a fresh working-tree snapshot (staged/unstaged/untracked) returned after a mutating op so the UI refreshes without a second round-trip.

The protected-branch regex (`PROTECTED_BRANCH_RE = /^(main|master|release\/.*|prod|production)$/i`) lives in `shared/src/protocol/gitOps.ts` so the server push guard and the client confirm dialog share ONE definition.

---

### `GET /api/search/content?wfid=<wfid>&q=<query>[&path=<cwd>][&max=N]`

Workbench Expansion A5. Content search over a workflow cwd via ripgrep. Backed by the reusable engine `server/src/contentSearch.ts` `searchContent` (decoupled from HTTP so F3/Recall reuses it) + `server/src/http/searchRoutes.ts` (the route). Read-only - runs `rg --json` via `execFile` with an argv array; the query is passed as `-e <pattern>` so a `-`-leading query can't smuggle an rg flag.

- `wfid` - required; validated. Resolves the workflow's live cwd when `path` is omitted.
- `q` - search query (matched case-insensitively by default; treated as an rg/Rust regex, which plain substrings satisfy). Empty `q` returns an empty (but `available:true`) result.
- `max` - optional cap on returned hits (default 200).
- Honors `SKIP_DIRS` (`node_modules`, `.git`, `.arco`, `dist`, `build`, ...) and `.gitignore`.
- Always answers **200** with `{ available, hits: [{ file, line, column, text }], capped }`. `available:false` when `rg` isn't on PATH (the UI shows a "ripgrep not installed" hint - never a 500). `capped:true` when more matches exist than `max`. Paths are cwd-relative; `line`/`column` are 1-based.

> **Dependency:** `rg` (ripgrep) must be on PATH for content search. It's already a soft dependency elsewhere (the Native Grep tool, `server/src/capabilities.ts`).

---

### `GET /api/recall/index[?project=<p>][&provider=<name>]`

Workbench Expansion F1. The **machine-global, cross-cwd Recall index** - every workflow ever run, each with a non-blank title. Route: `server/src/http/recallRoutes.ts`; backed by the SQLite store `server/src/recall/index.ts` (`getRecallIndex.query`). Read-only deterministic projection of `meta.json` + `events.jsonl` - **no LLM**.

- `project` - optional; filters to one project (a cwd basename).
- `provider` - optional; one of `claude` / `codex` / `ollama` / `llamacpp` / `lmstudio`. An unrecognized value is ignored (no filter), not rejected - note the allowlist (`recallRoutes.ts` `PROVIDERS`) includes `cursor`; filtering by it currently returns everything.
- Always answers **200** with `{ entries: RecallEntry[] }`, sorted `lastActiveAt` desc. An index read error degrades to `{ entries: [] }` (never a 500) so the client renders an empty Recall view, not an error.
- `RecallEntry` (`shared/src/protocol/recall.ts`): `{ wfid, cwd, project, provider, title, createdAt, lastActiveAt, turnCount, summaryRef|null, tags[] }`. `summaryRef` populated once a summary exists; `tags`/`pinned`/links set via the F4 mutation routes below.

The title is resolved via the F1 fallback chain (never blank): Claude `ai-title` -> first operator message (trimmed) -> `<provider> · <project> · <date>`. See `docs/RECALL.md`.

---

### `GET /api/recall/search?q[&project][&provider][&from][&to][&transcripts=1]`

Workbench Expansion F3. **Keyword search over the Recall index** - titles / summaries / tags via SQLite FTS5, plus optional transcript full-text via ripgrep. Route: `server/src/http/recallRoutes.ts`; engine `server/src/recall/search.ts`. **Deterministic - no LLM** (no AI ranking or summarization).

- `q` - keyword query. Sanitized into a safe FTS5 MATCH expression (tokenized, prefix-matched), so operator-syntax chars never throw. **Empty `q` -> the recent list** (lastActiveAt desc, honoring filters) so the view is never blank.
- `project` / `provider` - same filters as `/index`.
- `from` / `to` - optional inclusive **epoch-ms** bounds on `lastActiveAt`.
- `transcripts=1` - operator toggle (**default OFF**). When set, the query also runs as a ripgrep full-text pass over each candidate workflow's `events.jsonl` (reusing A5's `contentSearch` engine). Heavier; bigger scan, no extra DB bytes.
- Always answers **200** with `{ hits: RecallSearchHit[], transcriptsAvailable?: boolean }`, ranked by FTS5 bm25 relevance. A search error degrades to `{ hits: [] }` (never a 500). `transcriptsAvailable: false` means `rg` isn't on PATH - the client disables the transcript toggle rather than silently dropping the dimension.
- `RecallSearchHit` (`shared/src/protocol/recall.ts`): `{ wfid, title, project, provider, cwd, lastActiveAt, summaryRef|null, snippet, matchedIn }` where `matchedIn` is `'title' | 'summary' | 'tags' | 'transcript'`. `snippet` carries FTS5 `snippet` bracketing on the FTS side, or the matched transcript line on the ripgrep side.

See `docs/RECALL.md`.

---

### `GET /api/recall/summary?wfid=<wfid>`

Workbench Expansion F2. Serves a conversation's saved `summary.md` from `~/.arco/recall/<wfid>/` (outside any cwd `/api/workflows/artifact` serves, so it needs its own route). `wfid` is validated against `[a-zA-Z0-9-]{1,64}` before being joined into a path (`400` on a bad wfid). Returns `{ wfid, summary }` (200), `{ error }` 404 if no summary yet, 500 on read error.

### `GET /api/recall/backlinks?type=<kb|task>&id=<id>[&cwd=<cwd>]`

Workbench Expansion F4. Conversations linking to a KB article / task. Backed by `getRecallIndex.backlinks`. Always answers **200** with `{ entries: RecallEntry[] }`; a bad `type`/`id` or a read error degrades to `{ entries: [] }`.

### `POST /api/recall/tags`

Workbench Expansion F4. Set the tag set for one conversation. Body: `{ wfid, tags: string[] }`. `400` on a bad wfid, `404` if the conversation isn't in the index. Returns `{ entry: RecallEntry }`.

### `POST /api/recall/pin`

Workbench Expansion F4. Operator-driven **pin-as-memory** - manually mark one of your own conversations important (sorts to top + a "pinned only" filter). NOT the fenced self-writing memory: no LLM, fully reversible. Body: `{ wfid, pinned: boolean }`. `400`/`404` as above. Returns `{ entry: RecallEntry }`.

### `POST` / `DELETE /api/recall/link`

Workbench Expansion F4. Add (POST) / remove (DELETE) a link between a conversation and a KB article / task. Body: `{ wfid, link: { type: 'kb'|'task', id } }`. `400` on a bad wfid or malformed link, `404` if not in the index. Returns `{ entry: RecallEntry }`.

---

### `GET /api/usage-stats?path=<cwd>[&from=<epochMs>][&to=<epochMs>]`

Workbench Expansion D3. **Per-provider / per-day token-volume + cache-hit-ratio trends** for every workflow under one cwd. Route: `server/src/http/usageStatsRoutes.ts`; the aggregation is a **separately-exported pure function** `aggregateUsage(events, opts)` (smoke unit-tests it without HTTP/fs) plus an fs-scanning `aggregateUsageForCwd(cwd, opts)`. **Read-only, deterministic, no new capture, no LLM** - it only sums the `primary_turn_token_usage` events already in each workflow's `events.jsonl`; it never writes or mutates anything.

**Framing is quota-pressure / token-volume insight ONLY** - "which tab/model is eating my rolling window". There is deliberately **no USD / cost field anywhere** in the response (the operator is on subscriptions).

- `path` - the cwd to aggregate under (scans `<cwd>/.arco/workflows/*/events.jsonl`). Required; missing -> 400.
- `from` / `to` - optional inclusive **epoch-ms** bounds on each turn's `turnStartedAt`.
- **Bucketing** is per `(provider, local-day)`. The day key is `YYYY-MM-DD` in the **server-local timezone** (formatted from `turnStartedAt` via the local calendar) - matches the operator's "what did I do today" model when Arco runs on their machine.
- **Cache-hit ratio uses the provider-correct denominator** (see `shared/src/protocol/usage.ts`):
  - **Claude/Anthropic** - `input`/`cacheRead`/`cacheCreate` are **disjoint** -> `promptTokens = input + cacheRead + cacheCreate`, `cacheHitRatio = cacheRead / (input + cacheRead + cacheCreate)`.
  - **Codex/OpenAI** - `input` **is** the full prompt and `cacheRead` is a **subset** -> `promptTokens = input`, `cacheHitRatio = cacheRead / input`.
  - **Ollama / llama.cpp / others** - no cache layer (`cacheRead` 0) -> ratio `0`. So a Claude turn and a Codex turn with identical raw numbers yield **different** ratios.
- Reads each `events.jsonl` **line-by-line** (a `readline` stream, not wholesale) so a long-lived workflow's large log doesn't balloon memory across a many-workflow scan. A malformed JSON line, or an event missing a finite numeric field, is **skipped** (never throws).
- Always answers **200** with `UsageStatsResponse` (`shared/src/protocol/usageStats.ts`): `{ days: string[], perProvider: Partial<Record<ProviderName, { byDay: UsageDayBucket[], totals: UsageTotals }>>, grandTotals: UsageTotals, from: number|null, to: number|null, workflowsScanned: number, turnsAggregated: number }`. An aggregation error degrades to an empty body (never a 500). `days` is the ascending union of every provider's active days (the shared sparkline x-axis). `from`/`to` echo the query, or the observed min/max `turnStartedAt` when omitted; `null` when no turns matched.

The UI is the right-panel **USAGE** tab (`client/src/components/RightPanel/UsageTab.tsx`), hand-rolled inline SVG sparklines/bars - see `docs/CLIENT.md`.

---

### `GET /api/endpoints/discover`

Workbench Expansion D2. **Operator-triggered** auto-discovery of OpenAI-compatible / Ollama model endpoints. Route: `server/src/http/endpointDiscoveryRoutes.ts`; prober `server/src/providers/endpointDiscovery.ts`. Probes a **bounded** candidate set - localhost + online, private-range Tailscale peers (from `execFile('tailscale', ['status','--json'])`, argv-only) crossed with a fixed 12-port list (`11434` + `8000-8010`). **Private ranges only** (loopback / RFC1918 / tailnet CGNAT `100.64/10`); a public IP is never probed (the SSRF-equivalent fence). Bounded concurrency (8), 700 ms per-probe timeout, 8 s overall deadline, 60 s result cache + per-host dead-host cooldown.

- Always **200** with `{ endpoints: DiscoveredEndpoint[], tailscaleAvailable: boolean, cached: boolean }`; a genuine throw -> 500 with an empty list. `tailscale` absent (ENOENT) -> `tailscaleAvailable:false`, still probes localhost.
- `DiscoveredEndpoint` (`shared/src/protocol/endpointDiscovery.ts`): `{ baseUrl, host, port, api: 'ollama'|'openai', modelCount, sampleModels, source: 'localhost'|'tailscale', peerName? }`.
- **Suggestions only** - the settings UI lists results; the operator clicks one to fill `settings.ollama.baseUrl` and still hits Save. The route never mutates settings. No background daemon (no `setInterval`).

See `docs/PROVIDERS.md` (endpoint auto-discovery).

---

### `GET /api/diagnostics`

Operations A1. **Operator-triggered**, **read-only** grouped status checks ("what's working on this machine?"). Route: `server/src/http/diagnosticsRoutes.ts`; the pure check registry is `server/src/diagnostics/checks.ts` (single source of probe logic). The System modal's Diagnostics tab calls this on open + Refresh - no background daemon.

- Always **200** with a `DiagnosticsReport`; a genuine throw -> **500** with an empty report (`groups: []`). `runDiagnostics` itself never throws - each probe is `safeProbe`-wrapped (a thrown probe becomes an `error` result carrying the message) and time-bounded, and all probes run concurrently (`Promise.all`) so one slow binary can't hang the call.
- `DiagnosticsReport` (`shared/src/protocol/opsDiagnostics.ts`): `{ groups: DiagnosticGroup[], generatedAt: number, arcoVersion: string, platform: string }` where `platform` is `${os}/${arch}` (e.g. `linux/x64`).
- `DiagnosticGroup`: `{ id, label, checks: DiagnosticCheck[] }`; `id` ∈ `core | providers | local-tools | workbench | storage` (fixed order = render order).
- `DiagnosticCheck`: `{ id, group, label, status, detail, hint? }`. `status` ∈ `ok | warn | error | skipped` - **warn** = degraded / optional dependency absent (ffmpeg or a language server missing); **error** = something that should work doesn't; **skipped** = not probed on this platform/config (e.g. per-cwd `.arco` from a global call).
- Probes reuse existing helpers (`capabilities`/`media/ffmpeg`/`github`/`ollama`/`llamacppManager`/`cookbook/hardware`/`claude-native/auth`); the one write is a throwaway temp-file `events.jsonl` round-trip under `tmpdir` - never a real workflow log.

See `docs/DIAGNOSTICS.md`.

---

### `GET /api/diagnostics/support-bundle`

Operations A2. **Operator-triggered**, **read-only**. Returns a paste-ready,
**redacted** snapshot of this machine - the A1 diagnostics report plus Arco
version, git rev, platform, and runtime - for an issue or another agent. Backs
the System modal's **⧉ COPY SUPPORT BUNDLE** button. Builder + redaction:
`server/src/diagnostics/supportBundle.ts`. Matched **before** the bare
`/api/diagnostics` handler.

- Always **200** with a `SupportBundleResponse`; a genuine throw -> **500** with an
  empty bundle. `buildSupportBundle` does not throw on a probe-level failure
  (`runDiagnostics` is itself safe; a metadata probe failure degrades to
  `unknown`).
- `SupportBundleResponse` (`shared/src/protocol/opsDiagnostics.ts`): `{ json: SupportBundle, text: string }`. The client copies `text`; `json` is the typed object.
- `SupportBundle`: `{ generatedAt: number, arcoVersion: string, gitRev: string, platform: string, runtime: { node, serviceMode }, diagnostics: DiagnosticsReport, notes? }`. An **explicit safe-field allowlist** - never raw settings / env / token objects. `gitRev` is `git rev-parse --short HEAD` (execFile, argv array, no shell, 4s timeout; missing git -> `unknown`). `runtime.serviceMode` is best-effort (`dev (tsx watch)` under tsx, else `unknown`; service mode proper is Part B).
- **Redaction (Appendix D - allowlist, not denylist):** the embedded `diagnostics` report has every free-text `detail`/`hint` path-redacted (home dir -> `~`, other absolute paths -> `<path>/<basename>`), and a defense-in-depth `scrubSecrets` pass over the serialized bundle replaces any token-shaped string (`gh[pousr]_...`, `sk-...`, `sk-ant-...`, `Bearer ...`, JWT-ish, long hex/base64 runs) with `<redacted>`. The bundle contains **no** tokens, env secrets, auth material, or private paths.

See `docs/DIAGNOSTICS.md` bundle.

---

### `GET /api/diagnostics/model-health`

Operations A3. **Operator-triggered**, **read-only**. A richer, structured local
**model-operator** readout - three subsystems (Ollama / llama.cpp / Cookbook),
each with a roll-up `DiagnosticStatus` plus concrete fields. Backs the System
modal's **Models** tab. Builder: `server/src/diagnostics/modelHealth.ts`
(reuses the existing `probeOllama` / `llamacppManager` / `probeHardware` /
`scoreFit` probes - **never spawns a model**). Matched **before** the bare
`/api/diagnostics` handler.

- Always **200** with a `ModelHealthReport`; a genuine throw -> **500** with a
  degraded fallback report (every subsystem present, `warn` roll-up).
  `buildModelHealthReport` does not throw - each sub-report builder is wrapped
  by `safe` so one subsystem's failure degrades to a `warn` sub-report.
- `ModelHealthReport` (`shared/src/protocol/opsDiagnostics.ts`): `{ ollama: OllamaHealth, llamacpp: LlamacppHealth, cookbook: CookbookHealth, generatedAt: number, platform: string }`.
- `OllamaHealth`: `{ status, baseUrl, reachable, modelCount, models[], version?, detail, hint? }` - resolved base URL + installed models + capability hints.
- `LlamacppHealth`: `{ status, binaryPath, modelCount, models[], managerState, loadedAlias?, port?, pid?, loadedAt?, lastUsedAt?, lastLaunchArgs?, lastStderrTail?, portReachable?, error?, diagnosis?, detail, hint? }`. `lastLaunchArgs` is additive in-process metadata retained by the manager on its existing spawn path; `lastStderrTail` is a tail of `~/.arco/llamacpp.log`. `diagnosis` (**DD13**, type `LlamacppServeDiagnosis` from `shared/src/protocol/llamacppDiagnose.ts`; built by `server/src/providers/llamacppServeDiagnose.ts`) is present only when the last launch **failed** (`managerState === 'failed'`) and the stderr tail matched a known cause - it carries the cause + plain-text suggestions + structured one-click `LlamacppServeFix` ops (`set-ctx-size` / `set-ngl` / `add-extra-arg`) the ModelHealthPanel renders against the catalog editor's `ctxSize` / `ngl` / `extraArgs` fields (surfaced under the panel's `model-health.llamacpp-*` keys).
- `CookbookHealth`: `{ status, hardware: HardwareProfile, downloadedModelCount, downloadedModels[], fitWarnings: ModelFitWarning[], detail, hint? }`. `fitWarnings` are registered loadouts scored against the detected hardware with the same pure `scoreFit` the Cookbook catalog uses (verdict `NO`/`TIGHT`).
- **Status framing:** a missing/unreachable subsystem is `warn`/`skipped` (not error); a fit mismatch / stale config is a `warn` with a hint; `error` is reserved for a real llama.cpp last-launch failure (`managerState === 'failed'`).

See `docs/DIAGNOSTICS.md` model health panel.

---

### `GET /api/services`

Operations L1 (Part L - Local Services). **Operator-triggered**, **read-only** enumeration of local listening TCP sockets mapped to their process / cwd / framework ("what local web/dev services am I running right now, and where?"). Route: `server/src/http/servicesRoutes.ts`; engine: `server/src/services/discover.ts`. The L2 Services tab calls this on mount + Refresh - no background daemon. **Bare path only** - `/api/services/:pid` (L2 kill) is intentionally not handled here.

- Always **200** with a `ServicesResponse`; a genuine throw -> **500** with an empty list. `discoverServices` itself never throws - a missing `lsof` binary degrades to an empty list carrying an explanatory `detail`, and a single unreadable/exited process degrades to partial info (unknown cmdline/cwd, name from lsof's COMMAND column).
- **Mechanism (cross-platform - Linux AND macOS):** `lsof -nP -iTCP -sTCP:LISTEN` lists sockets (NOT Linux-only `ss`), then per pid `/proc/<pid>/cmdline` + `/proc/<pid>/cwd` on Linux with a `ps -p <pid> -o comm=,args=` + `lsof -a -p <pid> -d cwd -Fn` fallback (macOS / no `/proc`). All via `execFile` (argv array, no shell) with 5 s timeouts + bounded `maxBuffer`. READ-ONLY (kill is L2).
- `ServicesResponse` (`shared/src/protocol/services.ts`): `{ services: LocalService[], generatedAt: number, detail?: string }`. `services` is sorted by **port asc, then processName, then pid**, deduped by `(pid, host, port)`; ports `< 1024` are skipped. `detail` is present only when discovery couldn't run fully.
- `LocalService`: `{ pid: number|null, processName, cmdline, cwd: string|null, appName, host, port, url, framework: string|null, frameworkEmoji: string|null, friendlyName, likelyWeb }`. `url` is always `http://localhost:<port>/`. Framework detection + friendly-name heuristics are ported verbatim from an earlier LocalWebManager prototype.

See `docs/LOCAL_SERVICES.md`.

---

### `DELETE /api/services/:pid`

Operations L2 (Part L - Local Services). The **one mutating** services action: send `SIGTERM` (a graceful terminate) to a discovered service's process. Route: `server/src/http/servicesRoutes.ts` (`killService`). Operator-confirmed in the UI (two-step inline confirm). Guarded hard to bound blast radius:

- `:pid` is parsed as a positive integer. Non-integer / `pid <= 1` -> **400** (`{ ok: false, error }`).
- `pid === process.pid` -> **400** - refuses to kill the Arco server itself (the tab lists Arco's own listeners).
- Re-scans via `discoverServices` and confirms the pid currently owns a listening socket; if not -> **404** (`no listening service with that pid`). This bounds the kill to **what the tab actually shows** - a stale/forged pid never reaches the signal.
- The kill itself is the Node `process.kill(pid, 'SIGTERM')` primitive - **never** a shelled-out `kill` (no subprocess, no shell). **SIGTERM only - no SIGKILL escalation.**

Responses: **200** `{ ok: true, pid, signal: 'SIGTERM' }` on success; **400** (bad pid / self-kill); **404** (`ESRCH` / no listening socket - already gone or never there); **403** (`EPERM` - not permitted to signal that process); **500** (re-scan or signal failed). The handler never throws.

See `docs/LOCAL_SERVICES.md`.

---

### `POST /api/files/write`

Workbench Expansion A6. The only operator-driven write path that bypasses an agent turn - backs the `FileViewerModal` Edit/Lock toggle's **Save**. Route: `server/src/http/fileWriteRoutes.ts`; the path-guarded core is `writeFileWithinCwd` (exported so the smoke calls it directly).

Request body (JSON):

```json
{ "cwd": "<absolute cwd>", "wfid": "<workflowId>", "path": "<file path>", "content": "<new contents>" }
```

- `cwd` - explicit workflow cwd; when omitted, resolved from `wfid` (validated) via `workflowCwds`. One of the two must yield a cwd or the request 400s.
- `path` - relative-to-cwd or absolute. **Resolved against `cwd` and re-checked with `resolveWithinCwd` - the exact same path-escape guard the Native `Write`/`Edit` tools use.** Any path that escapes the cwd (relative `../`, an absolute path outside, or a traversal like `foo/../../x`) is **rejected with 400 and nothing is written.** This is load-bearing: a fat-fingered or agent-suggested path must never write outside the project.
- `content` - the full new file contents (whole-file replace, not a patch). Parent dirs inside cwd are created as needed; an existing directory at the target is refused.
- Response: `200 { ok: true, path: "<cwd-relative>", bytes: N }` on success; `400 { ok: false, error }` on a rejected escape / bad input; `500 { ok: false, error }` on an unexpected fs error.

---

## Project trust

### `GET /api/project-trust[?cwd=<absolute>]` · `POST /api/project-trust`

The standing operator surface for the DD7 trust gate. Route: `server/src/http/projectTrustRoutes.ts`; store: `server/src/projectTrust.ts`. **HTTP rather than WS because trust is user-scope, not workflow-scope** - the global `SettingsPanel` has no `workflowId` to send `set_project_trust` with. The workflow-scoped WS message stays for the composer banner's buttons.

Why it exists: the turn-time gate raises **one** `project_trust_prompt` per cwd per server lifetime, rendered only in the composer of whichever tab hit the gate first. In a cluster that's some member tab - the parent tab has no CONFIG tab - so a missed banner previously left the repo suppressed with no way back short of hand-editing `~/.arco/trust.json`.

- **GET** -> `{ defaultProjectTrust: 'ask'|'always'|'never', entries: [{ path, decision, at }] }`, `entries` sorted by path. With `?cwd=`, adds `cwd: { path, status, matchedPath?, resources }` - `status` is the resolved decision (nearest-ancestor wins, `matchedPath` names the ancestor that supplied it) and `resources` is the gated surfaces the repo actually ships (`AGENTS.md`, `.arco/settings.json`, `.arco/skills`). An empty `resources` means the gate is a no-op there.
- **POST** `{ cwd, decision: 'always' | 'never' | 'clear' }` -> the same snapshot for that cwd. `always`/`never` record via `writeTrustDecision` (atomic tmp+rename, canonical-path key); **`clear`** removes the entry via `removeTrustDecision` and **re-arms** the one-shot prompt (`clearPromptPending`) so the next turn asks again rather than staying silently suppressed. Bad/missing `cwd` or an unknown decision -> **400**; other methods -> **405**.
- **Writes fan out to every live workflow the decision covers** (`isAncestorOrSelf` over each workflow's cwd) as a `project_trust_set` broadcast - that's the events.jsonl visibility leg, and it clears any stale composer banner across all cluster members sharing the repo.
- Takes effect on the **next turn** (the gate re-reads `trust.json` per turn) - no restart.

Client surfaces, all on `client/src/hooks/useProjectTrust.ts`: the global **PROJECT TRUST** section in `SettingsPanel` (list / flip / forget / add-a-path + the `defaultProjectTrust` fallback picker), the per-tab **PROJECT TRUST** row in the CONFIG tab, and the cluster header **TRUST** chip (`ClusterRightPanel/ProjectTrustChip.tsx`, self-hiding when the cwd ships nothing gated).

---

## ARCHIVE explorer (`/api/explorer/*`)

The read-only HTTP surface behind the standalone chromeless file-explorer window. Route: `server/src/http/explorerRoutes.ts`. All GET listing/scan endpoints are **`$HOME`-jailed** with a post-resolution `realpath` check (`realpathWithinHome`, exported from `server/src/explorerArtifacts.ts`) and answer **200-always** - degrading to an empty list on error, never a 5xx. **Read-only v1** - no explorer endpoint writes.

### `POST /api/explorer/open`

**The FALLBACK launch path**. The client opens ARCHIVE with a same-browser
`window.open` popup by default - that inherits the workspace window's correct per-monitor DPI
and opens on the operator's machine. This endpoint is only hit if that popup is refused; it
spawns a Chromium-family browser in `--app=` mode at `<origin>/?app=explorer` (`<origin>` from
the request `Origin`/`Host`). Binary resolution is POSIX-portable (`server/src/explorerLaunch.ts`):
`brave-origin-beta` -> `brave` -> `chromium` -> `google-chrome` on PATH, then a macOS `open -na <app>`
fallback; the service/desktop env is inherited with a `DISPLAY=:0` fallback for a display-less
systemd unit. (A separately-spawned `--app=` process latches onto one fixed scale factor and does
not re-scale per monitor - the reason it's the fallback, not the default.)

**Fail-soft - never 5xxs.** Always **200** with an `ExplorerLaunchResult`: `{ ok: true, binary, url }` on a successful spawn; `{ ok: false, code: 'no-browser', error }` when no browser is found; `{ ok: false, code: 'spawn-failed', error }` when the spawn exits non-zero within a 500 ms probe window. On either `ok:false` the client drops to a plain new tab.

### `GET /api/explorer/artifacts[?project=<abs cwd>]`

The server-side artifacts join - "what have agents produced for me?" Globs `<cwd>/.arco/workflows/*/artifacts/**` across `~/.arco/known-cwds.json` (or a single `project`), **skipping empty dirs and `raw-tools/`**, joining each hit with the workflow's `meta.json` -> tab title + provider (8-char UUID prefix fallback). Engine: `server/src/explorerArtifacts.ts` (`collectArtifacts`).

- Always **200** with `{ entries }` (newest-first); a scan error degrades to `{ entries: [], error }`.
- `ArtifactEntry`: `{ path, name, size, mtime, workflowId, tabTitle, provider, project, cwd }` - `path` is realpath-resolved and `⊆ $HOME`.

### `GET /api/explorer/docs[?project=<abs cwd>]`

Project-tree **documents** - the docs written FOR a project in its real tree (`Reports/*.md`, root `*.md`, `docs/*.md`), the half the `.arco` artifacts join can't see. This is what makes ARTIFACTS a project-artifact tool rather than a `.arco`-only view. Portable pruned walk (`server/src/explorerDocs.ts` `collectDocs`) over the doc-extension allowlist (`md`/`markdown`/`mdx`/`txt`/`rst`/`adoc`/`org`/`pdf`/`csv`), pruning the usual build/VCS dirs plus **all** of `.arco` (the artifacts join owns it - the client merges both). `$HOME`-jailed, depth-capped (8).

- `project` -> one project (up to 1000 docs). Omitted -> global across `~/.arco/known-cwds.json`, **bounded per-project** (150 each, 600 overall) so a home load over dozens of projects stays responsive (~0.7 s observed).
- Always **200** with `{ entries }` (newest-first); a scan error degrades to `{ entries: [], error }`.
- `DocEntry`: `{ path, name, size, mtime, project, cwd, rel }` - `rel` is the path relative to the project root (surfaces the subdir, e.g. `Codex/Reports/...`). The client merges these with `/artifacts` into one newest-first list per project.

### `GET /api/explorer/recents[?limit=100]`

The AGENT WRITES ledger read - the attributed global record of agent-produced files. Reads `~/.arco/recent-files.jsonl` newest-first (engine: `server/src/recentFilesLedger.ts` `readRecent`). `limit` clamps to `[1, 1000]` (default 100).

- Always **200** with `{ records }`; a read error degrades to `{ records: [], error }`.
- `LedgerRecord`: `{ ts, path, op: 'created'|'modified', workflowId, tabTitle, provider, tool, project? }`. Written server-side at the persisting broadcast chokepoints (`send` + `broadcastWorkflow`) plus `POST /api/files/write`; coverage is per-provider event shape (v1 = Claude Native Write/Edit/NotebookEdit, Review artifact, media-op/stems results, manual write). Filtering (DOCS/IMAGES/ALL, per-project) is client-side.

### `GET /api/explorer/changed[?within=48h][&project=<abs>]`

The exhaustive, unattributed changed-within scan - the catch-all for Bash-created / generated files the ledger never saw. Portable Node `fs` walk (no `fd`) over the default working dir (or one `project`), pruning `node_modules`/`.git`/`dist`/`.venv`/`__pycache__`/... and `.arco` internals **except** `.arco/workflows/*/artifacts/`, depth-capped (8) and count-capped (500, newest-first). Engine: `server/src/explorerChanged.ts` (`scanChanged`). `within` accepts `<n>h|d|m` (default/garbage -> 48h, floored at 1m).

- Always **200** with `{ entries }` (newest-first, ≤500); a scan error degrades to `{ entries: [], error }`.
- `ChangedEntry`: `{ path, name, size, mtime, project }` - `project` is the top-level dir under the base root (or the explicit project's basename).

### `GET /api/explorer/plans`

The PLANS lens - the plans library. Every plan in every project in `~/.arco/known-cwds.json` (dead / outside-`$HOME` cwds skipped; projects with no plans omitted). Engine: `server/src/explorerPlans.ts`. `cwd` is the known-cwds spelling (not its realpath) so it round-trips into the `/api/plans` routes, which key on the workflow's cwd string.

- Always **200** with `{ projects: PlanLibraryProject[] }`, most recently touched project first; an error degrades to `{ projects: [], error }`.
- `PlanLibraryProject`: `{ cwd, name, plans: PlanLibraryEntry[] }`; `PlanLibraryEntry` = `PlanSummary` + `{ refCount, attached, clusters: { clusterId, name }[] }` - `attached` is true when a workflow span is open or a cluster binds the plan.
- Read-only. The lens edits through the ordinary `/api/plans` routes.

---

## Local model lifecycle

Operator-facing console for Ollama VRAM. Backs the CONFIG-tab MODEL LIFECYCLE section, which polls only while open. Routes: `server/src/http/router.ts`; engine: `server/src/providers/ollama.ts` (`aggregateOllamaPs` / `unloadOllamaModel`).

### `GET /api/ollama-live`

Live snapshot of the local Ollama daemon. Probes `/api/ps` and `/api/version` on the daemon (`getOllamaBase` - `settings.ollama.baseUrl` -> `OLLAMA_URL_BASE` -> `http://localhost:11434`) in parallel with a 2-second timeout. `OllamaLiveStatus` (`shared/src/protocol/usage.ts`); always 200.

**Response:**
```ts
{
  up: boolean,
  version?: string,                 // from /api/version (omitted on probe failure)
  loadedModels: Array<{
    name: string,
    expiresAt: string | null,       // ISO timestamp; when the model unloads from VRAM
    sizeVram: number | null,
  }>,
  fetchedAt: number,                // epoch ms
  error?: string,
}
```

Polled by the client every 15s, but **only** while `enabledProviders.ollama !== false` AND `authStatus.ollama.loggedIn === true`. Either gate fails: client clears the field and stops polling - disabled or unreachable Ollama doesn't burn requests. Drives the `OLLAMA [LIVE/READY/DOWN]` pill in `UsageBar` (LIVE = a model is resident in VRAM; READY = daemon up, idle; DOWN = unreachable) and the "Ollama daemon: vX.Y.Z" line in the settings modal's CLI VERSIONS section.

### `GET /api/ollama-ps`

On-demand poll that fans `/api/ps` across the configured backends (`settings.ollama.backends[]`, or the degenerate single backend) and aggregates the loaded-model rows. Fail-soft per backend - a down/unreachable host shows `reachable:false` + an `error` rather than failing the whole aggregation (the router connect-timeout applies). No request body.

Response - `OllamaPsAggregate` (`shared/src/protocol/usage.ts`):

```ts
{
  backends: [
    {
      baseUrl: string,
      label: string,
      reachable: boolean,
      cooling: boolean,                  // true when the router has this backend in a cooldown right now
      loadedModels: [
        {
          name: string,
          expiresAt: string | null,      // raw RFC3339 eviction timestamp; null = forever-loaded (keep_alive:-1)
          secondsUntilExpiry: number | null,  // computed server-side from expiresAt at fetch time; <=0 = overdue
          sizeVram: number | null,       // bytes (size_vram), null if omitted
          size: number | null            // total loaded bytes (size); can exceed sizeVram when partly on system RAM
        }
      ],
      error?: string
    }
  ],
  fetchedAt: number
}
```

On an unexpected throw -> **500** `{ error }`.

### `GET /api/ollama/vram`

Hardware-synergy VRAM budget readout: the **local** board's GPU VRAM (nvidia-smi via the Cookbook hardware probe, `server/src/cookbook/hardware.ts`) vs what the **local** Ollama daemon (`getOllamaBase`) currently has resident (`/api/ps` `size_vram`). Local-only by design - VRAM is per-board, so `used` reflects the single local daemon, not the configured Ollama fleet. Read-only, fail-soft: no CUDA GPU (macOS / no nvidia-smi) ⇒ `available:false` + a `note`; a down daemon ⇒ `daemonUp:false`. No request body. Powers the CONFIG-tab **VRAM BUDGET** section.

Response - `OllamaVramReport` (`shared/src/protocol/usage.ts`):

```ts
{
  available: boolean,        // a CUDA GPU was detected (totalVramBytes > 0)
  note?: string,             // why degraded when available:false
  backend: 'cuda' | 'metal' | 'cpu',
  gpus: [{ name: string, vramBytes: number }],
  totalVramBytes: number,
  daemonUp: boolean,
  loaded: [{ name: string, sizeVramBytes: number | null }],
  usedVramBytes: number,     // sum of loaded size_vram
  availableVramBytes: number,// max(0, total - used)
  fetchedAt: number
}
```

On an unexpected throw -> **500** `{ error }`.

### `POST /api/ollama/fit`

Hardware-synergy auto context-sizer: a predictive (what-if) estimate of the largest `num_ctx` the **primary** model can use on the local GPU, optionally reserving headroom for a **local** utility/summarizer model. Builds a `ModelSpec` from `/api/show` (`details.parameter_size`, `quantization_level`, `model_info[*.context_length]`) + `/api/tags` (on-disk size), then runs the Cookbook fit math (`server/src/cookbook/fit.ts`). A utility pinned to a **remote** baseUrl costs zero local VRAM (`utilityRemote:true` ⇒ `reservedForUtilityBytes:0`). Estimates are coarse (KV-cache heuristics). Read-only - applying the result writes `num_ctx` through the normal `updatePrimaryConfig` path so the prefix-cache invalidation is logged. Powers the **SET TO FIT** button + the coexistence warning.

Request body (JSON):

```json
{ "primary": "qwen3.6-coder:latest", "utility": "qwen2.5:3b", "utilityRemote": false }
```

- `primary` - **required**; missing/empty -> **400** `{ error: "primary model required" }`.
- `utility` - optional; the configured utility/summarizer model to reserve headroom for.
- `utilityRemote` - optional; `true` when the utility targets a remote baseUrl (no local VRAM cost).

Response - `OllamaFitReport` (`shared/src/protocol/usage.ts`): `{ ok, available, note?, totalVramBytes, reservedForUtilityBytes, primary: { found, params?, quant?, contextMax?, currentNumCtx?, maxNumCtx?, estVramAtMaxBytes? } | null, utility: { found, footprintBytes?, remote } | null, coexist, fetchedAt }`.

On an unexpected throw -> **500** `{ error }`.

### `POST /api/local-models/unload`

Header **FREE VRAM** action. No request fields; targets come only from server
configuration. Unloads all configured loopback Ollama models (`keep_alive:0`),
Strata (`/v1/unload`), DeepSeek/Xolotl (guarded service stop), managed llama.cpp and LM Studio LLM instances (native
`/api/v1/models/unload`). Remote endpoints and LM Studio embeddings are skipped.
Hidden/disabled picker providers are still inspected for resident models.

Refuses while any Arco local primary/reviewer is spawning or running; a
process-wide guard prevents new local turns during unloading. Strata also refuses
external in-flight requests. No active turn is cancelled. Files and memory limits
are unchanged. Each provider reports independently; an unavailable daemon does
not prevent unloading the others. Results are announced in local workflows,
excluding Incognito, and in the server log.

Responses: **200** `{ results: [{ provider, state, model?, detail? }] }`, with
`state` one of `unloaded | idle | unavailable | skipped | failed`; **409**
`{ blocked: true, error, results: [] }`; **500** `{ error, results: [] }`.

The capabilities payload additionally includes optional `strataVersion` (live
or prepared build metadata), `xolotlRevision` (checkout HEAD),
`latestVersions.xolotl` (upstream HEAD), and `latestVersions.strata` (upstream
engine package version, distinct from the 0.2 app tag) for the engine comparison (boot + four-hour poll).

### `GET /api/deepseek` / `POST /api/deepseek`

Ordinary operator cookie/origin gates apply. GET is read-only and returns
`{ runtime: 'Xolotl', baseUrl, managed, profiles: [{ id, model, label, config,
capabilities, serviceState, loaded }], live }`. Both prepared profiles appear
when stopped; `live` is the native `/v1/status` or null. Service active is
distinct from engine loaded. Unavailable/invalid registration returns 409 with
an actionable error; no model is loaded by discovery.

POST JSON: `{ action: 'load', profile: 'exact' | 'light' }` or
`{ action: 'unload' }`. The server permits only the prepared named profiles,
uses their guarded launcher and shared local-operation lock, and refuses active
local turns/reviewers or external runtime requests. Loading never stops miners.
An HTTP disconnect during load cancels readiness and triggers guarded cleanup/
recovery. Unload stops the managed service; FREE VRAM includes the same action.
Success 200 returns the refreshed snapshot plus `notices`; refusals 409 return
`{ error, notices }`. Malformed input 400, oversize input 413, other methods 405.
Operations emit ordinary persisted notices in open saved DeepSeek workflows and
server operational logs. See [DEEPSEEK.md](DEEPSEEK.md) for guards/recovery.

### `POST /api/ollama-unload`

The `keep_alive:0` unload trick (open-webui's `/api/unload`) - frees a model's VRAM on demand, targeting the **specific** backend it's loaded on (the console knows it from the aggregation row). Operator-initiated + non-destructive (reversible: the next turn reloads from disk).

Request body (JSON):

```json
{ "model": "qwen3.6-coder", "baseUrl": "http://127.0.0.1:11434", "label": "primary", "workflowId": "<wfid>" }
```

- `model` - **required**; missing/empty -> **400** `{ error: "model required" }`.
- `baseUrl` - optional; the specific backend to unload from. Omitted ⇒ the primary backend.
- `label` - optional display label for the log line (falls back to `baseUrl` or `"primary"`).
- `workflowId` - optional; when supplied, the unload (success **or** failure) is logged to that tab's `events.jsonl` via `broadcastWorkflow` so transcript review sees it - the same visibility channel used by other Ollama settings routes.

Responses: **200** `{ unloaded: true }`; **502** `{ error }` when the unload POST to the daemon failed; **400** (no model); **500** on an unexpected throw.

---

## Media ops (Workbench Expansion H6 + H7)

Route: `server/src/http/mediaOpsRoutes.ts`. The guarded FFmpeg wrapper is `server/src/media/ffmpeg.ts` (see `docs/MEDIA_STUDIO.md` + `docs/GOTCHAS.md ops FFmpeg wrapper`). The `/op` endpoint is unchanged across H6->H7->N3; the `MediaOpSpec` union grew to cover video ops (`vclip` / `vconvert` / `extract-audio`) and then the **N3 advanced ops** (`framegrab` / `gif` / `geometry` / `speed` / `gain` / `spectrogram` / `join` / `swap`). N3 also adds a read-only `POST /api/media/inspect` (ffprobe metadata, writes no file); **N4** adds `POST /api/media/stems` (Demucs source separation - a separate long-running runner, `server/src/media/demucs.ts`).

### `POST /api/media/op`

Run a guarded FFmpeg **audio or video** op on an on-disk file. The op spec is a **typed discriminated union** (`MediaOpSpec`) - never raw operator text. Args are built by switching on the op type; the only operator-influenced values are validated numbers (clip/extract/fade/resample/spans) or whitelisted enums (audio format/bitrate/channels, video container/codec, resolution preset) or validated `{w,h}` integers. Output is a **new file** next to the source (`<stem>.<op>.<ext>`, uniquified) - the source is **never** overwritten.

Request body (JSON):

```json
{ "cwd": "<absolute cwd>", "workflowId": "<wfid>", "path": "<input audio path>", "spec": { "op": "clip", "inSec": 10, "outSec": 20 } }
```

- `cwd` - explicit workflow cwd; when omitted, resolved from `workflowId` via `workflowCwds`. **Optional since N2:** a general-tool op on a scratch / absolute path carries none (the path must then be absolute). A *relative* path with no cwd is `code: 'bad-path'`.
- `path` - relative-to-cwd or absolute. **Resolved + gated by the N2 access fence** (`resolveMediaInput`): allowed inside the cwd, always allowed inside Arco's `media-scratch`, and - only when `mediaUnconfined !== false` (Settings -> Media, default open) - allowed at an arbitrary absolute path. Otherwise rejected (`code: 'bad-path'`, nothing run). See `docs/MEDIA_STUDIO.md` + `docs/GOTCHAS.md access fence`.
- `output` *(N2, optional)* - `{ dir?, basename? }`. `dir` (absolute or cwd-relative) chooses where the new file lands, gated by the **same fence** as `path` and required to exist (`code: 'output-dir-missing'`); absent ⇒ alongside the input. `basename` chooses the filename - its **stem** is kept but the op's target extension is **forced** (a convert->mp3 named `take.wav` saves as `take.mp3`); absent ⇒ the derived non-clobbering name. The output is always uniquified; the source is never overwritten.
- `spec` - **audio:** `{op:'clip',inSec,outSec}`, `{op:'extract',inSec,outSec}`, `{op:'convert',format,bitrate?}`, `{op:'normalize'}`, `{op:'fade',inMs?,outMs?}`, `{op:'channels',mode:'mono'|'stereo'}`, `{op:'resample',hz}`. `format` ∈ wav/mp3/ogg/flac/m4a/aac; `bitrate` ∈ 96k-320k; `hz` ∈ the bounded sample-rate set. **Video:** `{op:'vclip',inSec,outSec,reencode?}` (stream-copy by default, re-encode when `reencode`), `{op:'vconvert',format,resolution?,vcodec?}`, `{op:'extract-audio',format,inSec?,outSec?}`. `vconvert.format` ∈ mp4/webm/mov/mkv (container + default codecs); `vcodec` ∈ libx264/libx265/libvpx-vp9; `resolution` is a bounded preset (`source`/`480p`/`720p`/`1080p`, each -> a **fixed** `scale` filter the server controls) or a validated `{w,h}` integer pair (each ≤ 7680, composed into `scale=w:h`) - **never** raw operator text into `-vf`/`-c:v`; `extract-audio.format` ∈ the audio whitelist. **Advanced:** `{op:'framegrab',atSec,format}` (png/jpeg still), `{op:'gif',inSec,outSec,fps?,width?,format?}` (gif/webp; gif builds a palette), `{op:'geometry',xform}` (`xform` = crop `{w,h,x,y}` / rotate `{degrees:90|180|270}` / flip `{axis:'h'|'v'}` / resize `{resolution}`), `{op:'speed',factor,video}` (0.25-4×, pitch-preserved; `video` adds `setpts`), `{op:'gain',db}` (−60...+30), `{op:'spectrogram',width?,height?}` (-> png), `{op:'join',extraInputs[],video}` (concat; **each extra path gated by the same fence** as `path`, resolved before any reaches argv), `{op:'swap',action}` (`{kind:'mute'}` or `{kind:'replace',audioPath}` - `audioPath` gated like an input). Pixels/fps/factor/db are validated against shared bounds (≤7680 / 1-50 / 0.25-4 / ±). `video` on `speed`/`join` is a **panel-set boolean** picking the audio-vs-video filtergraph, never free text. Numerics validated finite/≥0/ordered (in < out). Bad spec -> `code: 'bad-spec'`.
- **Cancel:** if the request socket closes (operator hit Cancel / nav away), the server aborts -> SIGKILLs the ffmpeg child + unlinks the partial output (`code: 'cancelled'`).
- **Response:** always `200` with `MediaOpResult` for an operator-visible condition - `{ ok: true, outputPath, relPath? }` on success (`relPath` only when the output is **inside the cwd**; a scratch / arbitrary-path output returns just the absolute `outputPath`), or `{ ok: false, error, code }` where `code` ∈ `ffmpeg-missing | bad-spec | bad-path | input-missing | ffmpeg-failed | cancelled | no-cwd | output-dir-missing`. A missing ffmpeg returns `code: 'ffmpeg-missing'` with a pointer to `docs/OPERATIONS.md` - never a 500. Only a truly unexpected server bug is a 500. A success/failure (not a cancel) broadcasts `media_op_result` -> persisted to `events.jsonl`.

### `POST /api/media/scratch?name=<basename>`

Stage an **imported** (picker / drag-dropped browser) media file on disk so ffmpeg can act on it (it reads files, not object URLs). The raw file bytes are the **request body**; `?name=` is the desired basename (sanitized - traversal / separators / leading-dash / NUL rejected with `code: 'bad-name'`). The bytes stream into a fresh `~/.arco/media-scratch/<uuid>/` dir (the write can't escape regardless of `?name=`), bounded by a per-upload cap (4 GiB -> `code: 'too-large'`) and reaped on a 24h TTL + a 16 GiB total cap. **Always allowed** (no cwd, no fence - the operator put the file here themselves). Response: `{ ok: true, path, basename, bytes }` - feed `path` straight back as a `MediaOpRequest.path` (the op resolver always permits scratch paths). On error, `{ ok: false, code, error }` with `code` ∈ `bad-name | too-large | write-failed`.

### `GET /api/media/raw?path=<input>&cwd=<cwd>&workflowId=<wfid>`

Read-only byte server (deferred from H1/H5). Streams an on-disk media file so an on-disk audio file can render a waveform / seek. **Since N2** `path` is gated by the **same tiered access fence** as the op route (`resolveMediaInput`: cwd | scratch | unconfined; out-of-fence -> `403`), so a scratch-staged or (when unconfined) arbitrary-path file can be previewed; `cwd` is optional (an absolute path needs none). Sets `Content-Type` by extension and supports **HTTP Range** (`206` partial content with `Content-Range`/`Accept-Ranges`; an unsatisfiable range -> `416`) for `<audio>`/`<video>` seeking + wavesurfer's chunked fetch. Missing `path` -> `400`; missing file / non-file -> `404`.

### `POST /api/media/inspect`

Read-only **ffprobe** metadata. Writes no file, so it is its own endpoint rather than a `MediaOpSpec` (the op union is render ops that produce a file). Request body: `{ cwd?, workflowId?, path }` - `path` is gated by the **same tiered access fence** as `/op` (`resolveMediaInput`: cwd | scratch | unconfined). Runs `ffprobe -print_format json -show_format -show_streams` and projects to a curated `MediaInspectResult`: `{ ok: true, format?: { name?, duration?, size?, bitrate? }, streams?: [{ index, type, codec?, width?, height?, fps?, sampleRate?, channels?, bitrate? }] }`. Always `200`; on an operator-visible condition `{ ok: false, error, code }` with `code` ∈ `ffprobe-missing | bad-path | input-missing | probe-failed`. Numbers ffprobe reports as strings are coerced; `fps` is parsed from `avg_frame_rate`. No broadcast (read-only, no audit event).

### `POST /api/media/stems`

**Demucs** stem separation - a separate long-running, GPU-accelerated runner (`server/src/media/demucs.ts`), not a `MediaOpSpec` (it emits multiple files). Request body: `{ cwd?, workflowId?, path, model?, twoStems?, format?, output?: { dir? } }`. `path` is gated by the **same N2 fence** as `/op`; `model` ∈ `STEM_MODELS` (default `htdemucs`), `twoStems` ∈ vocals/drums/bass/other (present ⇒ a `<stem>` + `no_<stem>` split; absent ⇒ the full set), `format` ∈ mp3/wav/flac (default **mp3** - wav/flac need `torchcodec` on some boxes; see `docs/OPERATIONS.md`). `output.dir` is the destination **parent** (gated + must exist); a **fresh uniquified `<track>.stems[-N]/`** dir is created inside it (never clobbers a prior run or the source). Args are built from whitelisted enums + resolved abs paths only (`-o <dir> -n <model> --filename {stem}.{ext} [--mp3|--flac] [--two-stems <name>] <track>`, track last). **Cancel:** socket close -> SIGKILL the demucs child + `fs.rm` the whole fresh dir (no partials, `code: 'cancelled'`). **Response:** always `200` with `MediaStemsResult` - `{ ok: true, model, dir, relDir?, stems: [{ name, path, relPath? }] }` (stems flattened out of demucs's forced `<model>/` subdir; `relPath`/`relDir` only for in-cwd output), or `{ ok: false, error, code }` with `code` ∈ `demucs-missing | bad-spec | bad-path | input-missing | output-dir-missing | demucs-failed | cancelled`. A missing demucs is `code: 'demucs-missing'` with an install pointer, never a 500. Success/failure (not cancel) broadcasts `media_stems_result` -> `events.jsonl`.

---

## Image write (Workbench Expansion H2 part 1)

Route: `server/src/http/imageWriteRoutes.ts`. The server-side foundation the H2 image editor SAVES through (the editor-UI port is a separate later phase). **Pure fs - no subprocess, no shell.** See `docs/MEDIA_STUDIO.md write endpoint`.

### `POST /api/image/write`

Write an edited raster image to disk. The image editor encodes its canvas to a base64 data URL and POSTs it; the server decodes, confines the target path to the workflow cwd, enforces an image extension, and writes - refusing to clobber an existing file unless `overwrite:true`.

Request body (JSON):

```json
{ "cwd": "<absolute cwd>", "workflowId": "<wfid>", "path": "edited.png", "dataUrl": "data:image/png;base64,<payload>", "overwrite": false }
```

- `cwd` - explicit workflow cwd; when omitted, resolved from `workflowId` via `workflowCwds`. One must yield a cwd (else `code: 'no-cwd'`).
- `path` - the relative (or absolute-within-cwd) **target** filename. **Resolved + re-checked with `resolveWithinCwd`** - a `../`/absolute-outside/traversal path is rejected (`code: 'path-escape'`, nothing written). Must carry an image extension (`.png`/`.jpg`/`.jpeg`/`.webp`, else `code: 'bad-ext'`). A new subfolder's parent dirs are created (confined).
- `dataUrl` - `data:image/<png|jpeg|webp>;base64,<payload>`. Parsed defensively: a non-image mime / malformed URL / empty decode -> `code: 'bad-image'`. A decoded payload over **64 MiB** is rejected (`code: 'too-large'`) via a cheap base64-length pre-check - no oversize Buffer is allocated.
- `overwrite` - when the resolved target **already exists**, the write only proceeds if this is explicitly `true`; otherwise `code: 'exists'` and **nothing is written** (original bytes unchanged). A brand-new filename writes unconditionally.
- **Response:** always `200` with `ImageWriteResult` for an operator-visible condition - `{ ok: true, relPath, bytes }` on success, or `{ ok: false, error, code }` where `code` ∈ `no-cwd | bad-path | path-escape | bad-image | bad-ext | too-large | exists | write-failed`. Only a truly unexpected server bug is a 500. (An on-disk checkpoint of the change is covered by the A2 checkpoint path once the editor wires it.)

---

## Clusters

Cluster state changes go through the WebSocket (see [`PROTOCOL.md`](PROTOCOL.md)); the HTTP surface covers create/read/delete and the peer-substrate REST endpoints consumed by the CLI MCP child (`server/src/mcp/clusterMcpServer.ts`). Backed by `server/src/clusterStore.ts`.

### `GET /api/clusters`

List durable clusters on this server (`loadAllClustersFromDisk`) as
`{ clusters: Array<{ clusterId, name?, cwd, memberCount, createdAt /* ISO */, open: boolean, cwdExists: boolean }> }`,
newest first. `open` = in the server-authoritative workspace (a tab exists in
some browser); `cwdExists` = the project folder is still a directory. The
`+NEW -> CLUSTER` CLOSED CLUSTERS surface lists `!open` rows to reopen, dims
`cwdExists:false` rows, and bulk-deletes those via `DELETE /api/clusters/:id`.
It does not read or restore snapshots.

### `POST /api/clusters`

Create a cluster. Requires at least two member workflows sharing a `cwd`. Each member's provider must be cluster-eligible - `claude` / `codex` / `ollama` / `llamacpp` / `cursor` (`CLUSTER_MEMBER_PROVIDERS`); the route pre-validates via `assertAllMembersClaudeOrCodex` (a stale name - it delegates to `isClusterMemberProvider`) and rejects any other provider with `400 { error: 'member_not_supported:<wfid>' }`. The store-level `createCluster` additionally enforces `cwd`, member count (≥2), and no nested/cross-cluster membership (`member_already_in_cluster`).

**Body:**
```ts
{ cwd: string, memberWorkflowIds: string[] }
```

**Response (200):**
```ts
{ clusterId: string, members: string[], cwd: string, createdAt: string /* ISO */ }
```

**Errors:** missing `cwd` / fewer than two ids -> `400 { error: 'cwd and memberWorkflowIds (≥2) are required' }` before the store runs; store codes `invalid_cwd`, `too_few_members`, `member_already_in_cluster` -> `400 { error: <code>, message }`; anything else -> `500 { error: 'create_failed' | <code>, message }`.

### `GET /api/clusters/:id`

Read current cluster state. Returns the stored record plus a `mailboxDepth` map of per-member pending message counts (no drain - operators use this to decide whether to nudge).

**Response:**
```ts
{
  clusterId: string,
  cwd: string,
  members: string[],
  createdAt: string,                 // ISO
  mailboxDepth: Record<string, number>,
  //... cluster-plan and role fields as present
}
```

404 with `{ error: 'not_found' }` when the cluster doesn't exist.

### `DELETE /api/clusters/:id`

Delete a cluster. Fires the same `handleClusterDelete` path as the WS-side delete (MCP-config cleanup + `cluster_deleted` broadcast). Returns `{ deleted: clusterId }`.

### `GET /api/clusters/:id/peer/list?workflowId=<wfid>`

List peer members visible from `workflowId`. Thin wrapper over `clusterPeerOps.peerList`. Used by the CLI MCP child to answer `peer_list` tool calls.

### `POST /api/clusters/:id/peer/send`

Send a peer message. Body: `{ workflowId, to, content }`. Delegates to `clusterPeerOps.peerSend`; enforces the 16 KB content budget (32 KB for operator transcript-sends) and 60-second dedupe window. Returns `{ ok: true, msgId }` or a structured error (`{ error: 'budget_exceeded' | 'duplicate_send' | 'unknown_peer' |... }`).

### `POST /api/clusters/:id/peer/read`

Drain the calling member's mailbox. Body: `{ workflowId }`. Fires `peer_message_received` events for each drained message. Returns the drained messages array.

### `POST /api/clusters/:id/peer/plan-read`

Return the full canonical cluster plan. Body: `{ workflowId }` (must be a member). Read-only - the per-turn injected copy may be a deterministic outline for plans that overflow the string-form fold budget, so members need a pull channel to the full body. Returns `{ title, body, updatedAt, byteLength }`; `400 { error: 'no_plan' }` when no plan is attached.

### `POST /api/clusters/:id/peer/plan-tick`

Toggle a checkbox in the shared cluster plan. Body: `{ workflowId, lineIndex? | taskText? }`. Exactly one of `lineIndex` or `taskText` must be provided (server returns `invalid_matcher` otherwise). Error codes: `task_not_found`, `ambiguous_task`, `not_a_checkbox_line`, `out_of_range`. On success: `{ toggledLine, before, after }`.

### `POST /api/clusters/:id/peer/plan-write`

Replace the entire cluster plan body. Body: `{ workflowId, body }`. Enforces the 32 KB cap (`plan_too_large` on overflow). Broadcasts `cluster_plan_changed`. Returns `{ bodyLength, updatedAt }`.

### `GET /api/clusters/:id/peer/task-list?workflowId=<wfid>`

List the shared cluster task ledger as seen by `workflowId` (must be a cluster member, else `400`). Thin wrapper over `clusterPeerOps.peerTaskList`. Returns the tasks array directly. On failure returns `{ error: <code>, message }`.

### `GET /api/clusters/:id/peer/task-show?workflowId=<wfid>&id=<taskId>`

Show one task's detail record: task fields, parent/child tasks, durable comments, and run records. Thin wrapper over `clusterPeerOps.peerTaskShow`. Returns `TaskDetails`, or `{ error: <code>, message }`. When the task's title / notes / comments link plan reference docs (`ref:slug`), `TaskDetails.referenceDocs = { instruction, refs: [{ planId, slug, title?, path, bytes?, exists }] }` (`server/src/planRefContext.ts`); absent otherwise.

### `POST /api/clusters/:id/peer/task-create`

Create a non-terminal task in the cluster cwd. Body: `{ workflowId, title, body?, notes?, assignee?, priority?, parentIds?, links?, reviewRequired?, goalMode?, goalMaxTurns? }`. Delegates to `clusterPeerOps.peerTaskCreate`, emits `task_ledger_event` op `create`, and broadcasts a fresh snapshot. Returns the created task object, or `{ error: <code>, message }` on failure.

### `POST /api/clusters/:id/peer/task-claim`

Claim a ledger task. Body: `{ workflowId, id }`. Delegates to `clusterPeerOps.peerTaskClaim` and broadcasts the claim. Returns the claimed task object, or `{ error: <code>, message }` on failure.

### `POST /api/clusters/:id/peer/task-heartbeat`

Record worker activity for a task. Body: `{ workflowId, id, note? }`. Delegates to `clusterPeerOps.peerTaskHeartbeat`, emits `task_ledger_event` op `heartbeat` with a run payload (and comment payload when `note` is present), materializes the run for `cluster_task_show`, and broadcasts a fresh snapshot. Returns `{ run, comment? }`, or `{ error: <code>, message }` on failure.

### `POST /api/clusters/:id/peer/task-update`

Update a ledger task's status/notes/sign-off. Body: `{ workflowId, id, status?, notes?, signoff? }`. `signoff` ( advisory director sign-off) is `{ state: 'met'|'not_met'|'partial', summary? } | null` - validated + author-stamped by `peerTaskUpdate`; **advisory only, never moves the task to a terminal status** (`done` stays operator-gated). An invalid `signoff.state` -> `400`. Delegates to `clusterPeerOps.peerTaskUpdate` and broadcasts the update. Returns the updated task object, or `{ error: <code>, message }` on failure.

### `POST /api/clusters/:id/peer/task-link`

Add a dependency link. Body: `{ workflowId, parentId, childId }`, meaning `childId` depends on `parentId`. Delegates to `clusterPeerOps.peerTaskLink`; rejects missing tasks, self-links, and cycles. Returns the updated child task object, or `{ error: <code>, message }`.

### `POST /api/clusters/:id/peer/task-unlink`

Remove a dependency link. Body: `{ workflowId, parentId, childId }`. Delegates to `clusterPeerOps.peerTaskUnlink`. Returns the updated child task object, or `{ error: <code>, message }`.

### `POST /api/clusters/:id/peer/task-comment`

Append a durable comment to a task. Body: `{ workflowId, id, body }`. Delegates to `clusterPeerOps.peerTaskComment`, emits a `task_ledger_event` payload with the comment, and broadcasts a fresh snapshot. Returns the comment object, or `{ error: <code>, message }`.

### `POST /api/clusters/:id/peer/task-block`

Block a task. Body: `{ workflowId, id, reason }`. Delegates to `clusterPeerOps.peerTaskBlock`, moves the task to `blocked`, stores `blockedReason`, appends a `BLOCKED` comment, and broadcasts a fresh snapshot. Returns the updated task object, or `{ error: <code>, message }`.

### `POST /api/clusters/:id/peer/task-complete`

Submit a completion report. Body: `{ workflowId, id, summary }`. Delegates to `clusterPeerOps.peerTaskComplete`, moves the task to `review`, appends a `COMPLETION REPORT` comment, and broadcasts a fresh snapshot. It never marks `done`; terminal statuses remain operator-only. Returns the updated task object, or `{ error: <code>, message }`.

---

## Cluster presets

Saved cluster configurations (provider/model/role sets). Persist to `~/.arco/cluster-presets.json`. Backed by `server/src/clusterPresets.ts`.

### `GET /api/cluster-presets`

Lists all saved presets. Returns `{ presets: ClusterPreset[] }`.

### `POST /api/cluster-presets`

Create or update a preset. Body: `{ name, clusterNameTemplate?, members: ClusterPresetMember[] }`. Returns `{ preset }`. Validates member shapes server-side (`PresetValidationError` -> 400).

### `DELETE /api/cluster-presets/:id`

Remove a preset by `id`. Returns **204** (no body) on success, or `{ error: 'preset not found' }` (404).

---

## Portable cluster snapshots

Large snapshot artifacts use HTTP so multi-megabyte histories never ride the
control WebSocket.

- `GET /api/cluster-snapshots` - local snapshot summaries.
- `GET /api/cluster-snapshots/:id/export` - download a verified
  `.arcocluster` bundle.
- `POST /api/cluster-snapshots/import` - verify and import a raw bundle; returns
  `{ snapshot }` with a newly minted local id.
- `GET /api/cluster-snapshots/cloud` - proxy the configured tailnet hub's vault list.
- `POST /api/cluster-snapshots/:id/cloud` - bundle + AES-GCM encrypt locally,
  then upload the opaque envelope. A same-name cloud row returns **409**
  `{ code: "duplicate_name", existing }`; repeat with
  `?replaceSnapshotId=<existing.id>` only after operator confirmation to update
  that exact row.
- `POST /api/cluster-snapshots/cloud/:id` - download, decrypt, verify, and import.
- `DELETE /api/cluster-snapshots/cloud/:id` - remove one cloud blob.
- `GET /api/cluster-snapshots/vault/status|key` - report availability or
  generate/read the local shareable vault key.
- `POST /api/cluster-snapshots/vault/key` - install `{ key }` copied from another computer.

The management hub backs this with tailnet-only
`GET|POST /api/cluster-vault` and `GET|DELETE /api/cluster-vault/:id`.
Ciphertext is capped at 1 GiB, SHA-256 checked on upload, and stored under
`~/.arco/hub/cluster-vault/`.

---

## Templates (recipes)

Workbench Expansion - single-tab project/session templates ("recipes"). The single-tab analogue of cluster presets. CRUD against `~/.arco/templates.json`; backed by `server/src/templates/store.ts`. The persisted model is validated against the live catalog at APPLY time on the client (survives model renames), not on save.

### `GET /api/templates`

Lists all saved templates. Returns `{ templates }`.

### `POST /api/templates`

Create or update a template. Body: `{ name, config, seedPrompt?, plan? }`. `config` is validated field-by-field by `saveTemplate` (`TemplateValidationError` -> its `status`). Returns `{ template }`.

### `DELETE /api/templates/:id`

Remove a template by `id`. Returns **204** (no body) on success, or `{ error: 'template not found' }` (404).

---

## Cluster mailbox (2026-05-11)

Operator-only inspect + cancel surface for the cluster MAILBOX sub-tab's expand -> modal flow. Implementation: `server/src/http/clusterRoutes.ts` (matched before the bare `/api/clusters/:id` handlers) + `server/src/clusterMailbox.ts` (`peek`, `discard`). Other methods -> `405 { error: 'method_not_allowed' }`; an fs failure -> `500 { error: 'mailbox_op_failed', message }`.

### `GET /api/clusters/:id/mailbox/:wfid`

Peek the pending messages addressed to a cluster member. Non-destructive - drain is the model's path via `peer_read`. Server validates that `:id` is an existing cluster and `:wfid` is one of its members; 404 with `{ error: 'unknown_cluster_or_member' }` otherwise.

```json
[
  {
    "msgId": "1715456789123-a1b2c3d4",
    "fromWorkflowId": "<full sender wfid>",
    "fromDisplayName": "Seedbank Director",
    "toWorkflowId": "<full recipient wfid>",
    "content": "<message body - up to 32 KB if operator-driven, 16 KB if model-driven>",
    "createdAt": "2026-05-11T14:30:00.000Z",
    "delivered": false
  },...
]
```

Returns `[]` when nothing is pending. Order is chronological by `createdAt` (the msgId's millisecond prefix matches, so the filesystem lexicographic sort is sufficient - no stat calls).

### `DELETE /api/clusters/:id/mailbox/:wfid/:msgId`

Discard a single pending message before the recipient drains it. The recipient never sees the message; no event is emitted to `events.jsonl` because the message was never delivered. Cluster state refresh is automatic - server fires `notifyClusterStateForWorkflow(wfid)` after the unlink so every subscriber's depth chip drops to the new value without a refetch.

- `200 { "ok": true, "msgId": "..." }` - file existed and was removed.
- `404 { "error": "unknown_message" }` - no pending message with that msgId (already drained, already cancelled, or never existed).
- `404 { "error": "unknown_cluster_or_member" }` - `:id` / `:wfid` validation failed.
- `500 { "error": "mailbox_op_failed", "message": "..." }` - unexpected filesystem error.

Once a message is delivered (drained via `peer_read`) the file no longer exists; the durable record lives in the recipient's `events.jsonl` as `peer_message_received`. This endpoint only mutates the transient mailbox file layer - there is no "cancel a delivered message" surface.

---

## Plans

Backed by `server/src/planStore.ts`.

### `GET /api/plans?path=<cwd>`

Lists plans for a cwd.

**Response:**
```ts
{
  plans: Array<{
    id: string,
    title: string,
    createdAt: number,
    updatedAt: number,
    attachments?: Array<{
      workflowId: string,
      workflowName: string,    // snapshot of WorkflowConfig.name at attach time
      attachedAt: number,
      detachedAt: number | null,  // null = currently attached; timestamp = past span
    }>,
    completedAt?: number | null, // null/undefined = active; timestamp = archived
  }>,
}
```

Sorted by `updatedAt` desc. Active and completed plans share the list; the client splits them. `attachments` carries every span (open + closed) so the Plan tab can show "active in <name>" badges plus a collapsed "previously attached" history per plan.

### `GET /api/plans/body?path=<cwd>&planId=<id>`

Returns the full plan body (PlanFull = PlanSummary + body):

```ts
{ plan: { id, title, body: string, createdAt, updatedAt, attachments?, completedAt? } }
```

`400` without `path`+`planId`; `404 { error: 'plan not found' }` if missing.

### `POST /api/plans?path=<cwd>`

Create a new plan. Body:

```ts
{ title: string, body: string, attach?: boolean, workflowId?: string }
```

Server mints `planId`. Returns `{ plan: PlanFull }` with `attachments: []` and `completedAt: null`.

When `attach: true` and `workflowId` names an active workflow in the same cwd, the server immediately runs the normal attach path: persists `meta.planId`, records the attachment span, acquires the plan watcher, and broadcasts `plan_attached` so the open PLAN tab updates. This is the supported shell-agent path; do not hand-edit `.arco/workflows/<workflowId>/meta.json` to attach a plan because the running server will not see the websocket state transition.

```bash
curl -sS "http://localhost:3001/api/plans?path=$PWD" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Build Plan","body":"# Build Plan\n\n- [ ] First task","attach":true,"workflowId":"<workflow-id>"}'
```

### `POST /api/plans/attach?path=<cwd>&planId=<id>&workflowId=<workflowId>`

Attach an existing plan to an active workflow in the same cwd. This mirrors the PLAN tab click / `plan_attach` websocket path and returns `{ ok: true, plan: PlanSummary }`.

### `POST /api/plans/move?path=<sourceCwd>&planId=<id>`

Move a plan from `path` (source cwd) to another cwd. Body: `{ targetCwd }` (required, else `400`). Backed by `movePlan`; suppresses the source-cwd reconcile broadcast (the move owns it). Returns `{ plan }` on success, or `{ error }` (`400`).

### `PATCH /api/plans?path=<cwd>&planId=<id>`

Partial update. Body:

```ts
{ title?: string, body?: string, completedAt?: number | null }
```

- `title` / `body` - straightforward edits; bumps `updatedAt`.
- `completedAt: <timestamp>` - **mark complete**. Auto-detaches the plan from every workflow currently attached (closes attachment spans, broadcasts `plan_detached`, clears `meta.planId`, releases the watcher refs).
- `completedAt: null` - **reopen**. Just clears the timestamp; does NOT auto-attach.

Server-side dedup: when `body` is included, the plans-watcher is told to skip its next reconcile so it doesn't double-broadcast `plan_attached` (the PATCH handler already broadcasts directly). Skip flag is no-op when only `completedAt` changes (no `.md` write happens).

Returns `{ plan: PlanFull }`.

### `DELETE /api/plans?path=<cwd>&planId=<id>`

Hard delete. Detaches every workflow currently attached (broadcasts `plan_detached` to each), then removes the plan entry from `index.json` and unlinks the body file. Watcher's delete-reconcile is skipped to avoid double-broadcast.

Returns `{ deleted: true }` (200) or `{ error: 'plan not found' }` (404). Also removes the plan's `<planId>.refs/` directory; `/move` carries it to the target cwd.

### Plan reference docs - `/api/plans/refs`

Long-form docs attached to one plan, stored as `<cwd>/.arco/plans/<planId>.refs/<slug>.md` (`server/src/planStore.ts`). Directory-listed - no index entry - so a file an agent writes directly is a ref. `slug` matches `^[a-z0-9][a-z0-9-]{0,63}$`; title = the doc's first `# H1`, else the slug. Caps: 256 KB per ref (over-cap writes are **refused**, not truncated), 64 refs per plan. Plan bodies link a ref as `[label](ref:slug)` or `[[ref:slug]]`. Agent-callable (cookie-exempt); the `plan_ref_write` / `plan_ref_list` / `plan_ref_read` MCP tools wrap these.

- `GET /api/plans/refs?path=<cwd>&planId=<id>` -> `{ refs: PlanRefSummary[] }` (`{ slug, title, bytes, updatedAt }`, slug-sorted).
- `GET /api/plans/refs/body?path=<cwd>&planId=<id>&slug=<slug>` -> `{ ref: PlanRefFull }` or `404`.
- `PUT /api/plans/refs?path=<cwd>&planId=<id>&slug=<slug>` body `{ body: string }` -> `{ ref, created }`. `404` if the plan doesn't exist, `400` for a bad slug / over-cap body / count cap.
- `DELETE /api/plans/refs?path=<cwd>&planId=<id>&slug=<slug>` -> `{ deleted: true }` or `404`.

PUT and DELETE bump the plan's `updatedAt` and re-broadcast `plan_attached` to attached workflows and `cluster_state` to bound clusters, so open Plan tabs refetch their refs list. Direct file writes don't (the plans watcher ignores the `.refs` dir); the UI also refetches on window focus.

---

## Knowledge base

Workbench Expansion - per-cwd knowledge-article CRUD (REST, mirroring the Plans surface). Backed by `server/src/http/knowledgeRoutes.ts` + `server/src/knowledge/store.ts`. **The fence:** these are the ONLY knowledge write paths and every one is operator-driven (UI buttons); no agent reaches them. All routes require `?path=<cwd>` (`400` otherwise).

### `GET /api/knowledge?path=<cwd>[&q=<text>]`

List + budget summary. Optional `q` filters. Returns `{ articles, alwaysIncludeBytes, budget }` (`budget` is the `KNOWLEDGE_INJECT_BUDGET` constant).

### `GET /api/knowledge/body?path=<cwd>&id=<id>`

One full article. `id` required (`400`), `404` if not found. Returns `{ article }`.

### `POST /api/knowledge?path=<cwd>`

Create. Body: `{ title, body, tags?, alwaysInclude? }`. Returns `{ article }`.

### `PATCH /api/knowledge?path=<cwd>&id=<id>`

Update (any subset). `id` required (`400`), `404` if not found. Body is a partial article. Returns `{ article }`.

### `DELETE /api/knowledge?path=<cwd>&id=<id>`

Delete. `id` required (`400`). Returns `{ ok: true }` (200) or `{ error: 'article not found' }` (404).

---

## Capabilities and toolbox

### `GET /api/capabilities`

Returns the cached `Capabilities` snapshot (`shared/src/protocol/models.ts`):

```ts
{
  efforts: EffortLevel[],            // Claude CLI efforts
  models: ModelName[],               // Claude CLI models
  cliVersion: string,                // `claude --version`
  codexVersion?: string,
  cursorVersion?: string,            // date-stamped, not npm - display-only, no latestVersions.cursor / self-update
  // Latest published upstream versions (npm for the npm-installed CLIs,
  // GitHub Releases for Ollama / llama.cpp). Best-effort: a failed probe leaves
  // the key undefined and the UI shows the installed version with no outdated mark.
  latestVersions?: { claude?, codex?, ollama?, llamacpp? },
}
```

Cached at boot; re-probed every 4h or on demand. The CONFIG tab's red-dot indicator fires when a `capabilities_changed` WS event has unacknowledged changes. Header CLI cards compare `cliVersion.<p>` to `latestVersions.<p>` and paint outdated cards in warning color with a click-to-install tooltip.

### `GET /api/cli-snapshot?name=<snapshot filename>`

Returns one stored CLI snapshot file from `cliSnapshotDir` as `{ contents, bytes }` - the "what changed" diff source behind a `capabilities_changed` entry. `name` must be a bare filename (no `/`, `\`, `..` -> `400`); missing -> `404 { error }`.

### `GET /api/toolbox?provider=<name>&transport=<name>&cwd=<path>[&account=<profileId>][&force=1]`

Discovers the active provider runtime's native skill catalog. Claude CLI is
probed through its zero-cost `system/init` stream metadata, then its filesystem
skills are joined back in for descriptions and source labels. Codex is queried
through app-server `plugin/list` (the plugin-readiness barrier) followed by
`skills/list`, scoped to the workflow cwd and optional Codex account's
`CODEX_HOME`. Results are cached for 30 seconds unless `force=1`.

Claude Native and providers without a native skill runtime return
`supported: false` plus a reason; they never receive misleading Claude Code or
Codex entries. Returns:

```ts
{
  provider: 'claude' | 'codex' | null,
  transport: string | null,
  supported: boolean,
  reason?: string,
  entries: Array<{
    name: string,
    displayName?: string,
    description: string,
    provider: 'claude' | 'codex',
    source: 'plugin' | 'user' | 'project' | 'builtin' | 'system' | 'admin',
    invocation: string,
    pluginName?: string,
    path?: string,
    enabled?: boolean,
  }>,
}
```

The composer fetches this endpoint lazily when `/SKILLS` opens. A pick prepends
the server-supplied native invocation: Claude Code uses `/name` (plugin skills
remain namespaced, e.g. `/frontend-design:frontend-design`); Codex uses `$name`.
The provider runtime also retains its normal implicit description matching.

---

## Skills (Arco-managed)

Distinct from `/api/toolbox`: these are **Arco-managed**, provider-agnostic
skills authored by the operator from the SettingsPanel SKILLS section. They live
under `<cwd>/.arco/skills/` (project) and `~/.arco/skills/` (global). The
catalog (name + description) is injected into every primary turn's system prompt
as an XML manifest. `+SKILL` offers **APPLY ONCE** (full body in the next user
turn) and **PIN TO TAB** (durable reference; current full body is re-read and
injected as a standing system instruction every turn until unpinned).
Backed by `server/src/skills.ts`.

Each skill is a directory containing `SKILL.md` with YAML frontmatter:

```
---
name: <operator-facing name>
description: <one-line summary>
---
<body - the playbook the agent follows>
```

The directory name is the **slug** - a stable identifier (`^[a-z0-9][a-z0-9-]{0,63}$`) used by all path-based endpoints. On create, the server slugifies the name and dedupes against existing entries (`-2`, `-3`, ...).

### `GET /api/skills?cwd=<absolute path>`

Lists all skills visible to a project + the global pool.

**Response:**
```ts
{
  project: SkillSummary[],   // empty when cwd is missing
  global: SkillSummary[],
}

interface SkillSummary {
  slug: string;
  name: string;
  description: string;
  scope: 'project' | 'global';
  path: string;              // absolute path to SKILL.md
  useCount?: number;         // - read-only usage telemetry from the skill-usage sidecar; absent ⇒ never used
  lastUsed?: number;         // - epoch ms of last use
  operatorOnly?: boolean;    // DD8 - `operator-only: true` frontmatter; withheld from the model manifest, operator-pickable only
}
```

`cwd` is optional (omit it to list global only). Skills with malformed frontmatter (no `name:`) are silently skipped, matching the toolbox scanner. `useCount` / `lastUsed` are attached from the `skill-usage.json` sidecar in `listSkills` only - they are never folded into the model-facing manifest. `operatorOnly` marks a skill the model is never told exists: it is omitted from the manifest entirely but still listed here and pickable by the operator (who inlines its full body into a turn via the `+SKILL` composer picker).

### `GET /api/skills/body?cwd=<absolute path>&scope=<project|global>&slug=<slug>`

Returns the full skill including `body`. 400 on invalid scope/slug; 404 if missing.

**Response:**
```ts
{ skill: SkillSummary & { body: string } }
```

### `POST /api/skills?cwd=<absolute path>`

Create or update a skill. Body:

```ts
{
  scope: 'project' | 'global',
  slug?: string,           // omit to create; required to update
  name: string,            // ≤80
  description: string,     // ≤240
  body: string,            // ≤64KB
}
```

`cwd` query is required for `scope: 'project'`. Returns `{ skill: SkillSummary }`. Path-traversal attempts (slug containing `..`, slashes, or non-`[a-z0-9-]` chars) 400 immediately; the resolved file path is also re-validated against the scope root after resolution as a second-line defence against platform path quirks.

### `DELETE /api/skills?cwd=<absolute path>&scope=<project|global>&slug=<slug>`

Removes the skill's directory recursively. 404 if missing. Same validation rules as the GET-body endpoint.

### `POST /api/skills/audit`

H35 - **operator-triggered, read-only, diagnostic** skill security audit. A skill's `SKILL.md` body is folded into the model's context, so a hostile or careless skill is a prompt-injection / supply-chain vector. The editor's **AUDIT** button POSTs a body and gets back the findings; the operator decides. There is deliberately **NO** install gate / `should_allow_install` verdict - a server-authoritative quality judgment is the border-A pattern this avoids. Backed by `server/src/skillAudit.ts` (`auditSkillContent` - pure, synchronous, no fs / no model call). Matched **before** the bare `/api/skills` routes so the longer prefix wins.

**Body:** `{ body?: string }` (the SKILL.md body to scan; a non-string / absent body scans the empty string).

**Response (200):** `AuditReport` - `{ findings: AuditFinding[] }`, where `AuditFinding` is `{ severity: 'info' | 'warn', kind: string, detail: string }`. The scan flags invisible / directional unicode (zero-width, bidi-override "Trojan Source", BOM, the Unicode TAG block, ...) and coarse threat-pattern signatures (`pipe-to-shell`, `base64-to-shell`, `prompt-injection`, `role-override`, `secret-exfiltration`, `recursive-delete`, `remote-eval`). A clean body returns a single `info`/`clean` finding ("review the body yourself"). Malformed JSON -> `400 { error }`.

---

## Handoff prompts (operator-editable)

Operator overrides for the prompts the Handoff primitive uses. Three modes - `original-worker` (the reflection prompt the primary reads when handing off via `--resume`), `fresh-summarizer` (the framing prepended to a rendered transcript when an ephemeral summarizer worker writes the artifact), and `ollama-compaction` (the local-model compaction framing). Override files `handoff.prompt.md` / `handoff.summarizer.prompt.md` / `ollama.compaction.prompt.md` under `<cwd>/.arco/` (project) or `~/.arco/` (global). Project beats global beats default. Variables substituted at render time: `{{cwd}}`, `{{wfid}}`, `{{handoffPath}}`, `{{seedPrefix}}` (the literal `[HANDOFF U+2014` Review's `current-session` scope detects). Backed by `server/src/handoffPrompts.ts`.

### `GET /api/handoff-prompts[?cwd=<absolute path>]`

Returns the full editor state in one call: the default templates, every override body that exists on disk, and which scope is winning per mode.

**Response:**
```ts
// keyed by each of the three modes: 'original-worker' | 'fresh-summarizer' | 'ollama-compaction'
{
  defaults:  Record<Mode, string>,
  project:   Record<Mode, string | null>,
  global:    Record<Mode, string | null>,
  effective: Record<Mode, { source: 'project' | 'global' | 'default', sourcePath: string | null }>,
}
```

`cwd` is optional. With it omitted, `project` is `null` for both modes (no project file resolves).

### `POST /api/handoff-prompts[?cwd=<absolute path>]`

Writes a single override. Body:

```ts
{
  scope: 'project' | 'global',
  mode: 'original-worker' | 'fresh-summarizer' | 'ollama-compaction',
  body: string,           // ≤64KB
}
```

`cwd` query is required for `scope: 'project'`. Validation runs server-side and returns advisory `warnings: string[]` alongside `saved: true` - the save is never blocked, but missing `{{handoffPath}}` or `[HANDOFF_COMPLETE]` (original-worker only) trigger banner-level warnings.

### `DELETE /api/handoff-prompts?scope=<project|global>&mode=<original-worker|fresh-summarizer|ollama-compaction>[&cwd=<absolute path>]`

Removes a single override (revert to the next-tier fallback). Returns `{ deleted: boolean }`. 404 (within `deleted: false`) is non-fatal - it just means there was nothing to revert.

---

### `GET /api/docs?file=<repo-relative path>`

Reads source files from the Arco repo's `PROJECT_ROOT` for the in-app DocViewer (clickable file refs in the User Manual / contextual help popovers). Whitelist by extension (`.md,.ts,.tsx,.js,.jsx,.json,.css,.html,.sh,.yml,.yaml,.toml`). Path is `resolve`d against `PROJECT_ROOT` and re-checked to stay inside it (lexical - a symlink inside the repo is not realpath-checked).

**Response (200):**
```ts
{ path: string, content: string }
```

**Errors:**
- `400 invalid file` - empty, contains `..`, or starts with `/`
- `400 extension not allowed: <.ext>` - extension not on the whitelist
- `400 path escape` - resolved path landed outside `PROJECT_ROOT`
- `404 ENOENT` - file doesn't exist

Loadable surface is intentionally bounded to the Arco repo (not arbitrary filesystem reads): no auth, but no leak of secrets either since `.env` / credential files are gated by extension, and workflow-cwd files have their own dedicated endpoint (`/api/file-content`).

---

## Settings

### `GET /api/settings[?cwd=<path>]`

Returns `ArcoSettings` (operator preferences):

```ts
{
  enabledProviders: Record<ProviderName, boolean>,
  workflowDefaults?: WorkflowDefaults, // primaryProvider, primaryModel, primaryEffort, providerAccountRef, ...
  themeId?: string,
  fontPackOverride?: FontPackId,     // optional typography override; substitutes display/body/code fonts on every theme
  operatorName?: string,             // replaces "OPERATOR" label in chat
  defaultWorkingDirectory?: string,  // abs path; cwd-browser root (Settings + WorkflowCreator). Unset -> ~/Projects -> $HOME. Not confined to $HOME.
  acknowledgedCliVersions?: { claude?: string; codex?: string },
  //... full shape: ArcoSettings in shared/src/protocol/settings.ts
}
```

optional `?cwd=<path>` layers `<cwd>/.arco/settings.json` on top of the global cascade (defaults -> `~/.arco/settings.json` -> project). Deep-merge for nested objects; arrays replace. See `docs/OPERATIONS.md cascade` for full semantics. The server broadcasts `settings_updated` over WS on file changes - clients should re-fetch with their active cwd to pick up project-scoped edits live.

### `POST /api/settings`

Body is a partial `ArcoSettings`. Server merges and atomically writes `~/.arco/settings.json` (the **global** layer only; project-level settings are hand-edited). Returns the new full settings. `themeId` and `fontPackOverride` are validated against `VALID_THEME_IDS` / `VALID_FONT_PACK_IDS` respectively; unknown values 400. Pass `fontPackOverride: null` to clear an override and revert to theme defaults.

**Ollama multi-backend is settings-file-only - no dedicated endpoint.** `settings.ollama.backends[]` and `settings.ollama.modelHostMap` are sanitized by `sanitizeOllamaConfig` on read (drop disabled/malformed/duplicate backends; cap 16 backends, 64 map entries) and pass through this POST like any other settings field. The decision: operators edit `~/.arco/settings.json` (or a project `.arco/settings.json`) directly, the same way the legacy single `baseUrl` and `fallbackChains` work - a runtime backend-editor UI/endpoint is deferred (the smaller correct scope for v1; the cooldown state is in-memory and auto-expires, so there's nothing operator-facing to mutate beyond the static list). The existing **DISCOVER ENDPOINTS** flow still fills a single `baseUrl`; multi-backend lists are hand-authored.

### `GET /api/catalog` / `POST /api/catalog`

Read/write the model catalog markdown (`~/.arco/models.md`). GET -> `{ contents, bytes }` (`contents: ''` when absent). POST body `{ contents: string }` -> `{ ok: true, bytes }`; only the type and a size cap are enforced (no alias/content validation), `400` otherwise. Edited from SettingsPanel. Vestigial: nothing server-side consumes `models.md` any more (`buildCatalogInjection` in `catalog.ts` was the pre-Lite orchestrator's routing brain and has no caller); live model pickers come from the per-provider catalog endpoints below.

---

## Auth

### `GET /api/auth-status`

Returns the per-provider auth snapshot:

```ts
{
  claude: AuthStatus,
  codex: AuthStatus,
  ollama: AuthStatus,
  llamacpp: AuthStatus,
  deepseek: AuthStatus,             // prepared Exact/Light availability; live residency from /api/deepseek
  strata: AuthStatus,               // standalone Strata; context + image modalities from /models
  lmstudio: AuthStatus,             // local runtime; loggedIn = LM Studio server reachable
  cursor: AuthStatus,               // Cursor (ACP) - loggedIn = ~/.config/cursor/auth.json carries a session token
  github: AuthStatus,
}

interface AuthStatus {
  loggedIn: boolean,
  email?: string,
  subscriptionType?: string,        // 'local' for ollama / llamacpp / lmstudio
  orgName?: string,
  apiProvider?: string,             // e.g. 'subscription' | 'api-key'; lmstudio reports `lmstudio:<baseUrl>`
  installedModelLabels?: Record<string, string>, // optional local profile display names
  installedModels?: string[],       // ollama / llamacpp / lmstudio (from /v1/models or /api/tags)
  error?: string,
}
```

`strata` has no login. Its base cascade is `settings.strata.baseUrl` ->
`STRATA_URL_BASE` -> `http://127.0.0.1:8081/v1`; `POST /api/settings` patches
`{ strata: { baseUrl } }`, and `{ strata: {} }` resets it. Auth status includes
`installedModelCapabilities[id].numCtx`, `vision`, `tools`, and `thinking`.

`lmstudio` has no login - `getLmstudioAuthStatus` probes `${baseUrl}/v1/models` (base from the `settings.lmstudio.baseUrl` -> `LMSTUDIO_URL_BASE` -> `localhost:1234/v1` cascade) and reports `loggedIn` = reachable, `installedModels` from the probe. `settings.lmstudio.baseUrl` is patched through `POST /api/settings` like any other settings field (no dedicated endpoint, same as the Ollama `backends[]` note above).


Polled every 2 minutes by the client.

### `POST /api/auth-login?provider=<name>`

Triggers the appropriate login flow. Optional `account=<profileId>` is passed through to `triggerAuthLogin` (provider-account profiles). The `provider` query is normalized to one of `github` / `ollama` / `codex` / `cursor`, defaulting any other value (including `lmstudio`) to `claude`. Retired provider identifiers return 400 with an explicit unsupported message. Provider-specific behavior (`triggerAuthLogin`):

- **Claude** - spawns `claude auth login --claudeai` detached; returns immediately (`started: true`) and the operator completes browser OAuth.
- **Codex** - opens a terminal with `codex login`. An optional `account` query selects a Codex account profile.
- **Cursor** - opens a terminal with `cursor-agent login`. An expired long-lived ACP process is retired when its exact sign-in response is observed; the operator resends after completing OAuth and Arco starts a fresh process.
- **GitHub** - opens a terminal with `gh auth login`.
- **Ollama** - no auth; returns `started: false` + a `manual` hint ("run `ollama serve` ..."). (Reachability is reported by `/api/auth-status`, not here.)

When a terminal can't be found, or the systemd service has no desktop display env, the flow returns `started: false` with a `manual` string telling the operator the exact command to run by hand.

**Response:** always `200` with `{ started: boolean, manual?: string }` - `started: true` = the OAuth flow launched (spawned / a terminal opened); `started: false` carries the `manual` fallback. (A truly unexpected throw is a `500 { error }`.)

### `POST /api/check-updates?provider=<claude|codex>`

Runs the selected CLI updater, probes capabilities again, and broadcasts the refreshed snapshot as `capabilities_updated`. `provider` defaults to `claude`; unrecognized non-retired values also select Claude. Retired provider identifiers return `400` with an unsupported-provider error. Claude uses its built-in updater; Codex uses npm installation with a platform-installability check and a repair retry when the post-update probe cannot run the CLI.

**Response:** `{ provider, updated, previousVersion, currentVersion, capabilities, output, notice?, error? }`. `notice` explains a selected installable version when the registry's latest release is not ready for the current platform. A CLI that remains unavailable after the update returns `updated: false` and an error.

## Claude Native auth

OAuth bootstrap for the in-process Claude Native transport. Tokens persist to `~/.arco/auth.json`; refresh races serialized via `proper-lockfile`. Local callback server binds port `53692`; when binding fails (the operator's remote-only setup, or the port is otherwise held), the bootstrap falls back to manual paste - see `docs/GOTCHAS.md Native transport` for the EADDRINUSE rule.

### `GET /api/auth/claude-native`

Status of the persisted OAuth tokens.

**Response:**
```ts
{ loggedIn: false }
// or
{ loggedIn: true, expiresAt: number, scopes?: string[] }
```

### `POST /api/auth/claude-native/login`

Start the PKCE bootstrap. Server returns the URL the operator should open in a browser.

**Response** - `BootstrapStartResult` (`claude-native/oauth.ts`):
```ts
{
  authorizationUrl: string,        // open in a browser
  state: string,
  manualFallback: boolean,         // true when the local callback can't bind; operator pastes the redirect URL into /callback
  manualReason?: string,
}
```

### `POST /api/auth/claude-native/callback`

Complete the OAuth bootstrap. In the paste-fallback flow the operator submits the full redirect URL here; in the local-callback flow this is wired automatically.

**Body:**
```ts
{ url: string }     // the full redirect URL, query string included
```

**Response:** `{ ok: true }` on success; `{ error: <message> }` with HTTP 400 on validation failure.

### `POST /api/auth/claude-native/logout`

Clears the persisted tokens. **Response:** `{ ok: true }`.

### `POST /api/auth/claude-native/probe`

Empirical model probe - sends a minimal `messages.create` request through the live OAuth tokens with the standard wire fingerprint. Used to discover which model IDs are addressable, what the API echoes back as `Message.model`, and how beta headers (e.g. `context-1m-*`) behave per model. No catalog assumptions; the API is the source of truth.

**Body:**
```ts
{
  model: string,                   // required - e.g. 'claude-opus-4-7'
  beta?: string[],                 // appended to the standard betas (claude-code-20250219, oauth-2025-04-20)
  maxTokens?: number,              // defaults to a small value
  prompt?: string,                 // defaults to a tiny canned prompt
}
```

**Response (success):**
```ts
{
  ok: true,
  status: number,
  requestedModel: string,
  echoedModel?: string,            // model field echoed back by the API
  stopReason?: string,
  usage?: Record<string, number>,
  betaHeader: string,
  durationMs: number,
}
```

**Response (error):**
```ts
{
  ok: false,
  status: number,
  durationMs: number,
  error?: string,
  anthropicError?: unknown,        // Anthropic's structured error envelope when present
}
```

### `GET /api/claude-native/catalog[?force=1]`

Anthropic's `/v1/models` response, distilled to the picker shape (camelCase model entry + `supportedEfforts[]` + capability flags) and cached for one hour. Refreshes lazily on the next request after expiry; failures degrade to the last good snapshot. `?force=1` bypasses the cache (CONFIG-tab "REFRESH" button).

**Response:**
```ts
// ClaudeCatalogSnapshot (shared/src/protocol/models.ts)
{
  fetchedAt: number,
  models: Array<{
    id: string,
    displayName: string,
    createdAt: string,
    contextWindow: number,          // max_input_tokens
    maxOutputTokens: number,        // max_tokens
    supportedEfforts: EffortLevel[],
    supportsAdaptiveThinking: boolean,
    supportsBudgetThinking: boolean,
    supportsClearThinking: boolean,  // clear_thinking_20251015
    supportsClearToolUses: boolean,  // clear_tool_uses_20250919
    supportsCompact: boolean,        // compact_20260112
  }>,
  fresh: boolean,
}
```

The Native worker calls `getCachedModelCapabilities(modelId)` per request and skips the context-management betas when the cached entry returns `null` (cold-start, fetch failure, unrecognized model id) - see `docs/GOTCHAS.md Native transport` for the gating contract.

### `GET /api/codex/catalog[?force=1][&account=<profileId>]`

Codex model catalog, fetched via a short-lived `codex app-server` process and the JSON-RPC `model/list` method. Same lazy-1h-cache semantics as the Claude endpoint - refreshes on the next request after expiry, failures degrade to the last good snapshot. Each refresh costs one `codex app-server` spawn (~600ms initialize + RPC + close); the existing OAuth/auth state under `~/.codex/` is reused.

**`?account=<profileId>`** scopes the fetch to a Codex account profile's `CODEX_HOME` (via `resolveProviderAccount('codex', account)` + `ensureCodexAccountHome`), so entitlement-gated model availability (e.g. GPT-5.6 Sol on a higher-tier WORK plan) reflects the actual account. Omitted -> the ambient `~/.codex`; an unknown id resolves to the first configured account. The 1h cache + prefetch are keyed per `CODEX_HOME`.

**Response:**
```ts
{
  fetchedAt: number,
  models: Array<{
    id: string,
    displayName: string,
    description: string,
    hidden: boolean,
    isDefault: boolean,
    supportedReasoningEfforts: CodexReasoningEffort[],  // ascending; 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'|'ultra'
    defaultReasoningEffort: CodexReasoningEffort,
    supportsImageInput: boolean,
    supportsPersonality: boolean,
    additionalSpeedTiers: string[],   // 'fast' / 'priority' / etc
    contextWindow?: number,           // from the account's $CODEX_HOME/models_cache.json (model/list omits these)
    maxContextWindow?: number,        // MAX context policy source
    effectiveContextWindowPercent?: number,
  }>,
  fresh: boolean,
}
```

Used two ways: (1) the picker reads it for the live model list (vs the compile-time `CODEX_MODELS`), and (2) `getCachedCodexModelCapabilities(modelId)` is consulted by `mapEffort` (`codex-appserver/worker.ts`) and `mapEffortToReasoning` (`codex.ts`) to downgrade to the highest *supported* effort for the active model - preventing silent 400s when an operator picks an effort the model doesn't advertise.

### `GET /api/cursor/catalog[?force=1]`

Live Cursor model roster, enumerated by a short-lived `cursor-agent models` spawn (~155 rows, parsed once per hour; `?force=1` bypasses the cache; degrade-to-stale on failure). **500 on error** - like the other catalog endpoints, not fail-soft. Backed by `server/src/providers/cursor/catalog.ts` (`getCursorCatalog`).

**Response** - `CursorCatalogSnapshot` (`shared/src/protocol/models.ts`):
`{ fetchedAt, models: Array<{ id, displayName, isDefault }>, fresh }`.

Cursor bakes reasoning effort into the model id (`-low`/`-high`/`-xhigh`/`-max`), so there is no separate effort field - the model picker derives family × effort from these ids. `isDefault` marks the `auto` row.

---

## Usage

### `GET /api/usage[?force=1]`

Probes Claude's 5-hour and weekly usage from the OAuth API at `https://api.anthropic.com/api/oauth/usage` (token from Claude Native's OAuth store, else `~/.claude/.credentials.json`; never written back). Cached at 2-minute TTL; `?force=1` bypasses the cache. Always 200.

**Response** - `UsageInfo` (`shared/src/protocol/usage.ts`):
```ts
{
  session: { utilization: number, resetsAt: string | null } | null,   // 5-hour window
  weekly:  { utilization: number, resetsAt: string | null } | null,
  subscriptionType: string | null,
  fetchedAt: number,
  error?: string,
}
```

Drives the Claude usage bars exposed via the `CLAUDE [LIVE]` pill's hover popover in `UsageBar`.

### `POST /api/debug/throttle?provider=<claude|codex|ollama>[&resets=<epochMs>][&clear=1]`

Test and acceptance helper for provider quota indicators. The provider value marks that provider throttled until `resets` (default: 30 minutes from the request); `clear=1` clears the throttle. Returns `{ ok: true, providers }` with the current quota snapshot, or `400` for an unsupported provider. This endpoint changes in-memory quota state only and does not call a provider.

### `GET /api/codex-usage[?force=1&account=<id>&source=camoufox]`

Reads ChatGPT subscription quota with the installed Codex app-server's documented `account/rateLimits/read`. A short-lived process uses the selected Codex profile; no model turn is started. The default is the first configured account, or the default CLI account when no profiles exist. `account` selects a configured profile. The response includes source, account label, fetched time, all reported quota windows, and errors. A previous snapshot may be marked stale only after the same account and unchanged credential file are confirmed. Missing CLI, unsupported versions, signed-out and API-key-only accounts report unavailable rather than zero. This is subscription quota, not token activity or API billing.

`source=camoufox` explicitly selects the legacy independent browser profile. It uses a three-minute cache and `force=1` bypasses that cache. It is never an automatic fallback. See [Codex usage](OPERATIONS.md#codex-usage) for prerequisites and login. The response is `CodexUsageInfo` in `shared/src/protocol/usage.ts`; the endpoint returns HTTP 200 with `available: false` and an error on a failed check.

### `POST /api/codex-usage-login`

Checks the configured Python and browser prerequisites, then launches a headed Camoufox login window for the independent browser profile. It does not select or modify a Codex CLI account. Returns `started: false` on a prerequisite or spawn failure. The browser profile is preserved.

### `GET /api/cursor-usage[?force=1]`

Month-to-date Cursor usage snapshot backing the Usage tab's `CursorUsageCard`. **Fail-soft: always 200** - `getCursorUsage` never throws. Reads the cursor.com session JWT **fresh each poll** from `$ARCO_CURSOR_AUTH` ?? `~/.config/cursor/auth.json` (never cached); 3-minute result cache, `?force=1` bypasses. On missing/stale auth or an upstream error it returns `{ available:false, source, needsLogin? }` instead of an error status. Backed by `server/src/cursorUsage.ts`.

**Response** - `CursorUsageInfo` (`shared/src/protocol/usage.ts`):
`{ available, fetchedAt, source: 'dashboard'|'disabled'|'unavailable'|'error', dashboardUrl, periodStart?, periodEnd?, summary?, chargedCents?, inputTokens?, outputTokens?, cacheReadTokens?, totalTokens?, eventCount?, kindCounts?, hardCapped?, included?: CursorIncludedUsage, rows?: CursorUsageEventRow[], needsLogin?, error? }`.

`included` (the "Included in Pro" allocation gauge - `totalPercentUsed` drives the bar; `apiPercentUsed` drives the separate "Other Models" bar in the header hover) is populated internally from the **upstream Cursor endpoint `GET https://cursor.com/api/usage-summary`** (`fetchIncludedUsage`, the only source with the used/limit denominator); it returns `null` on drift so the rest of the snapshot still renders. **There is no Arco `/api/usage-summary` route.** ACP has no per-turn tokens, so this dashboard poll is the authoritative Cursor token source.

### `GET /api/llamacpp-live`

Live snapshot of the `llama-server` singleton managed by `llamacppManager`. Same polling discipline as Ollama (only while `enabledProviders.llamacpp` is enabled).

**Response:**
```ts
{
  up: boolean,
  loadedModel: string | null,         // active alias from the catalog, null when idle
  port?: number,
  pid?: number,
  version?: string,
  fetchedAt: number,
  error?: string,
}
```

### `POST /api/llamacpp-unload`

Operator-facing manual unload - frees VRAM without waiting for the idle timer. Useful when switching GPU workloads. Returns `{ unloaded: true }`.

### `POST /api/llamacpp-load?alias=<name>`

Preload a registered alias into VRAM explicitly, before any workflow turn. `llamacppManager.ensureLoaded` blocks until the server passes its `/health` check. Returns `{ alias, port, pid }`. Hides the 20-30 s cold-start behind an operator click instead of making the first prompt pay for it.

### `GET /api/llamacpp/catalog`

Read the operator-managed llama.cpp model registry (`~/.arco/llamacpp.json`). Returns `{ models: LlamacppModelDef[] }`.

### `POST /api/llamacpp/catalog`

Wholesale replace the catalog. Body must match `{ models: LlamacppModelDef[] }` (top-level shape validated server-side -> else `400`; individual entry fields are permissive - invalid entries are silently skipped on read). Re-reads and returns the persisted catalog after write.

---

## Cookbook (Workbench Expansion G2)

Read-only, fit-scored local-model catalog. All HTTP-fetch only (no shelling out, no path use); the only exec path is G1's cached `nvidia-smi` probe, reused unchanged. Every endpoint answers **HTTP 200 with a structured body** - a down/slow upstream source degrades to a flag + a note, never a 500. No download / pull / disk write / registration here (that is G4).

### `GET /api/cookbook/catalog?q=&quant=&task=&sim=`

Search the **Hugging Face Hub** (GGUF repos - the live, keyless Hub API) plus the **curated, bundled Ollama library** (`server/src/cookbook/ollamaLibrary.ts` - not a live endpoint; see `docs/COOKBOOK.md`), score every quant variant against the detected hardware (or a simulated rig when `sim` is set), and return the SCORE-sorted fit table.

**Query params** (all optional, whitelisted server-side):
- `q` - free-text search (≤120 chars). Empty -> the trending-that-fits feed.
- `quant` - quant family filter (`/^[A-Za-z0-9_]{1,16}$/`, e.g. `Q4`, `Q5_K_M`). Family-prefix match.
- `task` - HF pipeline-tag facet (`/^[a-z0-9-]{1,40}$/`, e.g. `text-generation`).
- `sim` - one of `ram` / `gpu1` / `gpu2` / `gpu4` / `gpu8`; scores against that simulated rig instead of the detected box.

**Response** (`CatalogResponse`):
```jsonc
{
  "rows": [ { "repo": "Qwen/Qwen2.5-Coder-32B-Instruct-GGUF", "name": "...",
              "params": 32, "quant": "Q4_K_M", "sizeBytes": 19900000000,
              "source": "hf", "task": "text-generation", "moe": false,
              "spec": { "params": 32, "quant": "Q4_K_M", "arch": "qwen", "sizeBytes":... },
              "fit": { "estVramBytes":..., "maxContextThatFits":..., "throughputTps":...,
                       "mode": "gpu", "verdict": "GOOD", "score": 71 } } ],
  "hardware": { /* HardwareProfile the rows were scored against */ },
  "trending": [ /* CatalogRow[]; present only when q is empty - fitting rows, capped 12 */ ],
  "sources": { "hf": true, "ollama": true },  // hf=false if the live Hub fetch failed; ollama is the bundled manifest, always true
  "note": "Hugging Face Hub is unreachable; showing the curated Ollama library only."  // present only when HF is down
}
```
Rows are sorted by `fit.score` desc (stable: score -> params -> repo -> quant).

### `GET /api/cookbook/hardware`

Returns the cached G1 `HardwareProfile` (`probeHardware`) for the table header strip. On a probe error, degrades to an empty CPU profile body (still 200).

### `POST /api/cookbook/hardware/rescan`

Clears the G1 hardware cache and re-probes (`rescanHardware`); returns the fresh `HardwareProfile`. The RESCAN button. No request body.

---

## Per-tab sandbox

Per-tab SQLite FTS5 index for `ctx_execute` / `ctx_search` / `ctx_fetch` tools (Claude Native only). Enabled when `WorkflowConfig.efficiencySandbox === 'on'`. Backed by `server/src/sandboxStore.ts`.

### `GET /api/workflows/:wfId/sandbox/stats`

Returns usage statistics for the tab's sandbox DB.

```ts
{ chunkCount: number, totalBytes: number, dbPath: string, recent: Array<{ id, language, capturedAt }> }
```

`404 { error: 'unknown_workflow' }` when the workflow has no live cwd; `500 { error: 'sandbox_op_failed' }` on a DB error.

### `POST /api/workflows/:wfId/sandbox/clear`

Truncate the chunks table. Fires `sandbox_db_cleared` on the workflow channel so the Files-tab sub-section updates without a refetch. Returns `{ ok: true, dbPath }`.

### `POST /api/workflows/:wfId/sandbox/_test_insert`

Dev/smoke-harness only - synthetic chunk insert so scenario scripts can populate the DB without running a real `ctx_execute`. `404` when `NODE_ENV=production`. Not for operator use.

---

## Codebase memory

### `POST /api/workflows/:wfId/codebase-memory/reindex`

Operator-driven "Re-index now" - spawns `codebase-memory-mcp reindex --path <indexPath> --skip-config` (the flag stops it auto-editing other agents' configs). Returns 503 (not 500) when the binary isn't on PATH so the client toast can point at `docs/OPERATIONS.md`. On success it updates `config.codebaseMemory` (`indexPath`, `lastIndexedAt`, `fileCount`), mirrors it into `meta.json`, and broadcasts `codebase_memory_state`.

**Body:**
```ts
{ indexPath?: string }    // defaults to config.codebaseMemory.indexPath, then the workflow's cwd
```

**Response (200):**
```ts
{ indexPath: string, lastIndexedAt: number, fileCount?: number }   // fileCount only when the binary prints JSON
```

`404 { error: 'unknown_workflow' }`; `503 { error: 'binary_not_installed' }`; `500 { error: 'reindex_failed', code, stderr }` on a non-zero exit.

---

---

## Server lifecycle

### `POST /api/shutdown`

Graceful shutdown:

1. Broadcasts `{ type: 'shutdown', reason: 'server_stopping' }` to every connected WS.
2. Flushes `events.jsonl` for every workflow.
3. Kills the dev tree (SIGKILL on tsx + concurrently + vite).
4. Process exits.

Returns `200 { shuttingDown: true }` immediately; teardown (close WSS + HTTP, flush, kill dev tree, exit) runs 1.5 s later so the response and shutdown frames flush first.

### `POST /api/restart`

Same flow as shutdown but with `reason: 'server_restarting'` and a respawn:

1. Broadcasts shutdown notification; responds `200 { restarting: true }`.
2. After a 50 ms delay (so the response flushes), closes WSS + HTTP and flushes events.
3. In systemd service mode (`INVOCATION_ID` / `SYSTEMD_EXEC_PID` set), queues `systemctl --user --no-block restart <ARCO_SYSTEMD_UNIT|arco.service>`; if systemd hasn't stopped the process within 10 s it exits `1` so the unit's `Restart=on-failure` takes over.
4. In dev mode, spawns a detached respawn script at `$TMPDIR/arco-respawn-<pid>.sh` (log: `$TMPDIR/arco-respawn.log`) that waits 1 s and runs `npm run dev`, then kills the dev tree.

The client keeps the tab open during `server_restarting` and reconnects on the new process.

### `GET /api/clients`

Returns the count of currently connected WS sessions. Used by the launcher to decide whether to open a new browser tab (if any client is already connected, it skips `xdg-open`).

```ts
{ count: number }
```

## GitHub proxy

`/api/github/*` is a thin proxy over the operator's `gh` CLI auth token. The token is fetched per request via `gh auth token` (no caching - `gh` handles refresh). All routes return whatever the GitHub REST API returns; Arco doesn't transform.

| Path | Method | Purpose |
|---|---|---|
| `/api/github/user` | GET | Authenticated user |
| `/api/github/context?path=<cwd>` | GET | Resolve local cwd -> `{ owner, name, branch }` from git remote; 404 when not a GitHub repo |
| `/api/github/repos` | GET | List repos for the user |
| `/api/github/repos/:owner/:repo` | GET | Repo metadata |
| `/api/github/repos/:owner/:repo/branches` | GET | Branches |
| `/api/github/repos/:owner/:repo/tags` | GET | Tags |
| `/api/github/repos/:owner/:repo/releases` | GET | Releases |
| `/api/github/repos/:owner/:repo/commits` | GET | Commits (list) |
| `/api/github/repos/:owner/:repo/commits/:sha` | GET | A single commit's changed files (with patches) - I4 |
| `/api/github/repos/:owner/:repo/contributors` | GET | Contributors |
| `/api/github/repos/:owner/:repo/languages` | GET | Languages |
| `/api/github/repos/:owner/:repo/commit-count` | GET | Total commit count |
| `/api/github/repos/:owner/:repo/readme` | GET | Decoded README |
| `/api/github/repos/:owner/:repo/tree` | GET | File tree |
| `/api/github/repos/:owner/:repo/contents` | GET | File contents |
| `/api/github/repos/:owner/:repo/pulls` | GET / POST | List PRs / **create a PR** - I4 |
| `/api/github/repos/:owner/:repo/pulls/:n` | GET | PR detail |
| `/api/github/repos/:owner/:repo/pulls/:n/files` | GET | PR files |
| `/api/github/repos/:owner/:repo/pulls/:n/comments` | GET | PR review comments |
| `/api/github/repos/:owner/:repo/pulls/:n/checks` | GET | PR CI checks |
| `/api/github/repos/:owner/:repo/pulls/:n/merge` | POST | Merge PR |
| `/api/github/repos/:owner/:repo/issues` | GET | List issues |
| `/api/github/repos/:owner/:repo/issues/:n` | GET | Issue detail |
| `/api/github/repos/:owner/:repo/issues/:n/comments` | GET / POST | Issue comments / new comment |
| `/api/github/repos/:owner/:repo/issues/:n/close` | POST | Close issue |
| `/api/github/repos/:owner/:repo/issues/:n/reopen` | POST | Reopen issue |
| `/api/github/repos/:owner/:repo/runs` | GET | Workflow runs |
| `/api/github/repos/:owner/:repo/runs/:id` | GET | Run detail |
| `/api/github/repos/:owner/:repo/runs/:id/jobs` | GET | Run jobs |
| `/api/github/repos/:owner/:repo/runs/:id/rerun` | POST | Rerun |

If `gh auth status` reports unauthenticated, every route returns 401 with `{ error: "GitHub CLI not authenticated" }`. Run `gh auth login` (or use the in-UI flow at `POST /api/auth-login?provider=github`).

### `POST /api/github/repos/:owner/:repo/pulls` - create a pull request

Operator-initiated PR creation (the "New PR" form in the GitHub panel's PR tab).
Title / body / base / head ride the **JSON body** through the REST helper - they
are never interpolated into a `gh pr create` shell/argv string, dodging
flag-injection from a title that begins with `-`.

Request body:

```jsonc
{
  "title": "Add the thing",   // required, trimmed
  "base":  "main",            // required - branch to merge INTO
  "head":  "feature-branch",  // required - branch the changes are ON
  "body":  "why this PR"      // optional
}
```

Responses:
- **200** `GhPullShort` - `{ number, title, html_url, head, base, ... }`; the client refreshes the list and navigates to the new PR.
- **400** `{ error }` - validation failure (empty title/base/head). Distinct from the GitHub/network failure path.
- **502** `{ error }` - GitHub or `gh`-token error (e.g. head branch not pushed, PR already exists).

This route does **not** broadcast to `events.jsonl` - consistent with the other
GitHub write endpoints (merge / comment), which are direct HTTP ops.

### `GET /api/github/repos/:owner/:repo/commits/:sha` - single-commit files

Returns the commit's changed files as `GhPullFile[]` (`{ filename, status,
additions, deletions, patch?, previous_filename?, blob_url? }`), with the unified
hunks inline in `patch` (absent for binary/oversized files). Used by the
commit-detail diff view. Keyed on `rest.length === 2` so it does **not** shadow
the commits-LIST route (`/commits`, `rest.length === 1`).

---

## Preview proxy

### `ANY /api/preview/<wfid>/<rest>`

Per-workflow proxy onto the dev server bound for `<wfid>` via `set_preview_port`. Forwards every request (including `WS upgrade` for HMR) to `127.0.0.1:<port>` with the original `<rest>` as the upstream path.

- Returns `503 Preview backend not configured` if the workflow has no port bound.
- Returns `502` on upstream connection error.
- Strips hop-by-hop headers (RFC 7230: `connection`, `keep-alive`, `transfer-encoding`, etc.) before forwarding both directions.
- Sets `cache-control: no-store, must-revalidate` and `connection: close` on the response, drops `etag` - together these stop Firefox from caching transient empty-MIME failures (e.g. when a port isn't bound yet) and from misaligning module response boundaries on parallel keep-alive fetches.
- Two entry paths handle the same target:
  1. **Explicit prefix** - URLs starting with `/api/preview/<wfid>/` (matched by `PREFIX_RE`).
  2. **Referer fallback** - any unmatched request whose Referer points back to a `/api/preview/<wfid>/` page. Allowed only at the last-chance fallback in `server/src/http/router.ts`, after every Arco route (a stale iframe Referer hijacking a legitimate Arco API request from another tab would be a real bug - the explicit-prefix-first ordering is what prevents it).
- The Vite dev server at port 5173 has a companion `^/.*` proxy entry in `client/vite.config.ts` that detects sub-resources from the iframe (Vite emits absolute paths like `/src/main.ts` and `/@vite/client` that would otherwise hit Arco's own client tree) and rewrites them with the explicit prefix before forwarding to the server. The bypass uses a TTL "bless map" so transitive imports - sub-modules whose Referer is the importing module rather than the iframe URL - also resolve to the right wfid.

WebSocket upgrades on the same prefix proxy to the dev server's WS too - keeps Vite/HMR working across the tunnel.

### `GET /api/preview/probe?port=<n>`

Liveness probe against `http://127.0.0.1:<port>/`. Returns `{ alive: boolean }`. "Alive" means anything responding to a HEAD or GET (any HTTP status counts; we're testing whether something is bound, not whether it's healthy). Used by the PREVIEW tab when the operator clicks a RECENT history pill - if the upstream is dead the client surfaces a "service no longer running" modal instead of binding to a corpse.

- 800ms timeout (`AbortSignal.timeout(800)`).
- Returns `400` for non-numeric or out-of-range port.

### `GET /api/preview/listening`

System-wide enumeration of TCP listeners. Returns `{ entries: Array<{ port: number, pid: number, command: string }> }`. Linux-only (walks `/proc/net/tcp{,6}` for LISTEN sockets and reverse-resolves owner PIDs by scanning every `/proc/<pid>/fd/`); macOS / non-Linux returns an empty array. Used to populate the "service no longer running" picker so the operator can rebind to whatever IS currently listening on the box.

- Excludes `process.pid` (the running Arco server) so the proxy itself doesn't surface as a candidate. Workflow-spawned dev servers DO show up - they listen on their own internal PIDs even though they're descendants of Arco.
- `command` is from `/proc/<pid>/comm` (kernel-truncated 15-char process name - `node`, `bun`, `python3`, etc.). Not a framework label; just a "what's this?" hint.

---

## Git operations

Powers the `⎇ GIT` composer button (`client/src/components/GitDialog.tsx`). Two endpoints; live status read + branch checkout. Implementation in `server/src/git.ts`.

### `GET /api/git/status?path=<cwd>`

Returns a `GitStatus` snapshot for the working tree at `<cwd>`. Used to populate the GitDialog (current branch, branch dropdown, ahead/behind counts, dirty/staged counts, GitHub-remote detection, default branch).

Query params:

- `path` (required) - absolute filesystem path. The dialog passes the workflow's `cwd`.

Response:

```ts
type GitStatus = {
  isRepo: boolean;
  currentBranch: string | null;          // null = detached HEAD
  upstream: string | null;               // e.g. 'origin/main'; null when no upstream tracked
  ahead: number;                         // commits ahead of upstream
  behind: number;                        // commits behind upstream
  dirtyCount: number;                    // unstaged + untracked, EXCLUDES staged-only
  stagedCount: number;
  toPushFiles: GitStatusFile[];          // files changed by local-only commits vs upstream
  toPullFiles: GitStatusFile[];          // files changed by remote-only commits vs local
  dirtyFiles: GitStatusFile[];           // unstaged + untracked local files
  stagedFiles: GitStatusFile[];          // index changes
  branches: GitBranchSummary[];          // current first, then alphabetical
  remotes: GitRemoteSummary[];
  hasGitHubRemote: boolean;              // any remote URL matches /github\.com/i
  defaultBranch: string | null;          // origin/HEAD -> fallback {main,master}
};

type GitStatusFile = {
  path: string;
  status: string;                        // git name-status / porcelain letter
  origPath?: string;                     // set for renames/copies
};

type GitBranchSummary = {
  name: string;
  hasUpstream: boolean;
  upstream: string | null;
  isCurrent: boolean;
};

type GitRemoteSummary = {
  name: string;
  url: string;
  isGitHub: boolean;
};
```

Discovery uses `git rev-parse`, `git status --porcelain=v2`, `git diff --name-status`, `git for-each-ref refs/heads/`, `git remote -v`, and `git symbolic-ref --short refs/remotes/origin/HEAD`. If the path isn't a git repo, returns `{ isRepo: false,... }` with the rest zeroed; the dialog renders an inert "not a repo" banner.

Errors: `400` on missing/invalid `path`; `200` with `isRepo: false` on non-repo paths (not an error).

### `POST /api/git/checkout`

Switches branches. Refuses on dirty trees and validates branch names. Dispatched by GitDialog **before** the agent prompt so the agent finds itself already on the target branch.

Request body:

```ts
{
  path: string,                          // absolute cwd
  branch: string,                        // target branch name
  create?: { fromBranch: string },       // if present, create new branch from base
}
```

Response:

```ts
{ ok: boolean; error?: string }
```

Behavior:

- **Branch name validation:** `/^[A-Za-z0-9._/-]+$/`. Anything else returns `{ ok: false, error: '...' }` with HTTP 400.
- **Dirty-tree refusal:** runs `git status --porcelain`; if non-empty, returns `{ ok: false, error: 'Working tree has uncommitted changes....' }`. Operator must commit or stash before switching. The refusal happens server-side before any branch state changes.
- **Plain switch:** runs `git checkout <branch>`.
- **Create + switch:** verifies the base branch exists (`git rev-parse --verify refs/heads/<base>`), verifies the target doesn't already exist (otherwise checkout would silently switch to the existing branch - surprising), then runs `git checkout -b <branch> <base>`.

---

## WebSocket

### `WS /ws`

The single WebSocket endpoint. All real-time interaction goes through here. See [`PROTOCOL.md`](PROTOCOL.md) for the full message catalog.

The handshake is a standard WebSocket upgrade - no custom subprotocols or auth headers (Arco assumes single-operator local-only usage).

---

## Cross-references

- WebSocket protocol: [`PROTOCOL.md`](PROTOCOL.md)
- Where these are called from on the client: [`CLIENT.md`](CLIENT.md)
- The handlers themselves: `server/src/index.ts` (search for `req.url ===` or `req.url?.startsWith`)
- File-system layout the endpoints read/write: [`PERSISTENCE.md`](PERSISTENCE.md)
- The auth flows: `server/src/auth.ts`
- The GitHub wrapper: `server/src/github.ts`


## Hands-free voice (`/api/voice/*`)

Operator cookie and origin checks apply; no agent-tool exemption. Responses
are `Cache-Control: no-store`. Audio is memory-only; Computer/worker messages
retain ordinary transcripts, and explicit diagnostic/tool-relay requests are
logged. Recognition is local; Edge output sends reply text to Microsoft and
falls back to local Kokoro. Effects use ordinary workflow messages.

| Method/path | Request | Response |
| --- | --- | --- |
| `GET /api/voice/conditions?owner=<ComputerId>` | - | `{rules,observationTurnsThisHour,warning?}`; full saved scripts plus only this owner's private scripts, no voice lease |
| `POST /api/voice/conditions?owner=<ComputerId>` | `{action:'capabilities'}`, `{action:'state',cluster_ids:string[]}`, `{action:'create',definition:ComputerConditionDefinition}`, `{action:'update',rule_id,expected_revision,definition:ComputerConditionDefinition}`, `{action:'list'}`, `{action:'pause'|'resume'|'cancel',rule_id}`, or `{action:'claim-announcement',rule_id,announcement_id}` | Capabilities/grammar, actual worker facts, or `{rule?,rules,announce?,observationTurnsThisHour,warning?}`. Strict schema, ≤12 KB HTTP body/8000-character declaration. Pinned scope ≤4 clusters/32 members; validated predicates, ordered actions, recurrence/dependencies and limits. Saved arming/updates durable before success. New scripts have nullable time/action/worker-turn budgets (omitted/null = no limit); positive integers set operator-requested limits. Cooldown defaults to 30s, accepts nonnegative whole seconds. Updates retain counts, handled mail and matching completed actions; unchanged TTL retains the deadline, an explicit numeric TTL change starts from the update, and null removes expiry. Revision checks fence stale edits. Unknown/input requests hold by default; optional semantic observations use Luna LOW, 24 batches/hour. No AUTO-PICKUP/legacy-rule coexistence. Script speech claim succeeds once. Private state remains memory-only; clear/removal fences late work. See [VOICE.md](VOICE.md) for the language |
| `GET /api/voice/activity?owner=<ComputerId>` | - | `ComputerActivitySnapshot`: per-owner policy, recent ledger, own agent inbox, pending count, 12/hour limit and warning; authenticated, no voice lease |
| `POST /api/voice/activity?owner=<ComputerId>` | `{action:'configure',enabled?:boolean,agent_updates?:'off'|'matches'|'workers'}` or `{action:'cancel-queued'}` or `{action:'status'}` | Same snapshot; ≤1 KB strict schema. Saved config durable before success; private config/inbox/counters memory-only. Master switch affects this owner's conditional scripts, mailbox automations and optional agent updates. Updates queue during the full busy/reset boundary, cap 12 turns/hour and batch 10 facts, 50 pending. Background turns have no operator tools. Disabling cancels waiting updates; started turns continue |
| `GET /api/voice/mail-rules?owner=<ComputerId>` | - | `{rules,warning?}`; saved rules plus this owner's memory-only private rules; normal cookie/origin gates, no voice lease |
| `POST /api/voice/mail-rules?owner=<ComputerId>` | `{action:'create',cluster_id,worker_ids:string[],final_id}`, `{action:'list'}`, `{action:'cancel'|'pause'|'resume',rule_id}` or `{action:'claim-announcement',rule_id}` | `{rule?,rules,announce?,warning?}`; strict schema, ≤4 KB. Exact distinct IDs in one cluster, 1-16 selected workers, separate final recipient, one active rule per cluster, ≤16 globally. Two-hour expiry/30s cooldown/8 nudges per worker. No AUTO-PICKUP coexistence. Claim deduplicates terminal speech. Saved arming waits for durable persistence; private rules memory-only. Errors refuse arming/stop future nudges |
| `GET /api/voice/watches?owner=<ComputerId>` | - | `{watches,warning?}`; saved watches plus only this owner's memory-only private watches; normal cookie/origin gates, no voice lease required |
| `POST /api/voice/watches?owner=<ComputerId>` | `{action:'create',target:<exact worker/cluster id>}` or `{action:'cancel',watch_id}` or `{action:'claim-announcement',watch_id}` | `{watch?,watches,announce?,warning?}`; ≤2 KB; exact active busy generations, whole queue boundary, no model polling; only one claim succeeds per terminal watch. Private targets/Computer itself rejected. Saved metadata atomic/durable; private owner watches memory-only. 400 on missing/idle/ambiguous target, cap or persistence failure |
| `GET /api/voice/status` | - | `{localSpeech,fastWake,interpreter:'codex',model:'gpt-6-luna',effort:'low',defaultVoice,voices}`; output voice catalog from `shared/src/voice.ts` |
| `POST /api/voice/session` | `{enabled:true,voice?}` | `{sessionId}`; requires installed local speech; optional listed output voice |
| `POST /api/voice/warmup?session=<id>` | `{}` | `{ready:true,fastWake,recognizer,voice}`; prepares local recognition, speech output and optional streaming wake detection before listening; wake failure falls back to full recognition |
| `POST /api/voice/preview` | `{voice?}` | MP3 of the fixed `VOICE_OUTPUT_SAMPLE`; one synthesis at a time, disconnect aborts it. No lease, recognizer, microphone or model call; does not substitute Kokoro on failure. |
| `GET /api/voice/ready-sound` | - | Bundled `voice/capture-ready.wav`: Soft double pulse, 230 ms, peak 0.065; authenticated, no microphone/model call or local sound installation |
| `POST /api/voice/heartbeat?session=<id>` | `{}` | `{ok:true}`; renews the 45-second lease |
| `DELETE /api/voice/session?session=<id>` | - | `{ok:true}`; aborts and kills session resources |
| `POST /api/voice/audio?session=<id>` | mono 16 kHz PCM16, ≤30 seconds | `{text,phrases}`; raw local Parakeet v3 text (Moonshine fallback on Windows/older installs) plus a restricted Vosk final phrase hypothesis (empty when unavailable) |
| `POST /api/voice/wake?session=<id>&utterance=<n>&firstSpeechAt=<seconds>` | mono 16 kHz PCM16, ≤0.5 seconds | `{detected}`; local Vosk streaming first-word candidate detection; monotonic positive utterance ID resets the stream, first-speech offset 0-0.5 seconds |
| `POST /api/voice/speak?session=<id>` | `{text,voice?}` (≤500 characters) | memory-only Edge MP3 or fallback Kokoro WAV; `X-Voice-Engine: edge|kokoro`. Changes only the output worker when the voice differs, retaining recognition/lease. |
| `POST /api/voice/interpret?session=<id>` | `{text,context:{targets,currentId,clusterId}}` | `{command,model,effort,usage}`; bounded fresh Codex subscription turn |
| `POST /api/voice/tool` | `{workflowId,tool,args}` (loopback only, from the `arco-voice` MCP child) | `{ok,result}` or `{ok:false,error}`; relayed to the browser owning the session as WS `voice_tool_call`, answered by `voice_tool_result`; 404 unless the workflow is a `voiceOperator` chat; logged as `[voice tool] ...` |
| `POST /api/voice/diag?session=<id>` | `{events:[...]}` (≤64 KB, ≤200 events) | `{ok:true}`; each event is written to the journal as `[voice <sid>] client {...}` |

The client streams 40 ms wake chunks. The wake endpoint accepts one in-flight chunk per session and scans at most
three seconds per utterance. Its result only acknowledges a candidate; full
transcription still verifies Computer as the first word before any action.
An unknown/expired lease is rejected. Two simultaneous sessions maximum;
interpretation allows one in-flight call and twelve starts per minute per
session. Roster limit 80 entries / 12K serialized characters; command text 8K.
No retries/effort escalation or API-key fallback. Incognito IDs are excluded
from interpretation. See [VOICE.md](VOICE.md).

For no-history Computer captures, `/api/voice/audio`, `/api/voice/wake` and
`/api/voice/diag` carry `X-Arco-Voice-Private: 1`. The route suppresses its
recognition/diagnostic logs for that request, including late responses. Private
Computer `/api/voice/tool` relays suppress argument/result logging based on the
workflow's Incognito flag. These headers control logging, not model routing;
Computer's strict memory-only workflows implement transcript non-persistence.

`voice` accepts the 24 English female `VOICE_OUTPUT_OPTIONS` IDs from
`shared/src/voice.ts`; absent/null uses the configured server default. Unknown IDs
are rejected before resource creation. The client freezes a choice for every
sentence of one reply, including prefetch; a new preference applies to the
next reply. An aborted request may demote only its own failed worker, never
a replacement selected by a later request. Tests: `npm run test:voice`.
