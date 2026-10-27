# Git workbench

The Git/GitHub workbench brings the daily local-and-remote git loop into Arco
so the operator doesn't have to leave the workbench to see what changed, what
will push/pull, or what a PR contains. Every surface reuses the A3
source-agnostic diff renderer (`client/src/components/diff/DiffView.tsx`), it
takes a unified-diff `patch` string and renders inline/split, regardless of
where the diff came from.

The sections below describe the available Git workbench features.

---

## I1, Local working-tree diff view

**What it shows.** A "Source Control"-style view of the working tree: every
changed file, grouped into three categories, each opening its own diff.

- **STAGED**, changes in the index (`git diff --cached`, index vs `HEAD`).
- **CHANGES** (unstaged), changes in the working tree not yet staged
  (`git diff`, work tree vs index).
- **UNTRACKED**, new files git isn't tracking yet, rendered as an all-added
  new-file diff.

A file can appear in both STAGED and CHANGES at once (staged some hunks, edited
more), that's faithful to `git status`, which reports a status code per side.

**Where it lives.** FILES tab -> **SOURCE** sub-tab, beside the A3 **CHANGES**
sub-tab (which shows the whole working-tree-vs-`HEAD` patch in one scroll). The
top pane is the grouped file list; clicking a file renders its individual diff
in the bottom pane via the shared `DiffView`. Client component:
`client/src/components/diff/WorkingChangesPanel.tsx`.

**The endpoint.** `GET /api/git/diff` (see `docs/HTTP_API.md` for the full
param/response spec). Distinct from A3's `GET /api/workflows/diff`:

- **List mode** (`?wfid[&path]`, no `file`) -> `{ isRepo, staged[], unstaged[],
  untracked[] }`, parsed from `git status --porcelain=v2 -z --untracked-files=all`.
- **Per-file mode** (`?wfid[&path]&file=<repo-rel>&staged`) -> `{ isRepo, patch,
  binary?, path, staged }`. Untracked files are detected via
  `git ls-files --error-unmatch` and synthesized with
  `git diff --no-index -- /dev/null <file>` (portable; git ships its own
  `/dev/null` handling cross-platform).

**Server logic.** `server/src/gitWorking.ts` (`getWorkingChanges` +
`getFileDiff`), wired through `server/src/http/gitDiffRoutes.ts`. Kept in its
own module rather than `server/src/git.ts` to keep both under the file-size
budget.

**Safety / invariants.**

- All git invocations use `execFile` with an argv array, never shell-string
  interpolation. Every path is passed after `--` and validated (`-`-leading or
  NUL-containing paths are rejected) so a path can't smuggle a git flag.
- Read-only: the module never touches the index, HEAD, or history.
- Graceful degradation: a non-git cwd returns `isRepo:false` + empty result
  (never a 500); binary or oversized files return `binary:true` + empty patch
  (bounded by a 32 MiB buffer / 15 s timeout, mirroring `gitDiff.ts`).
- The endpoint always answers **200** with a structured body in every
  non-fatal case (non-git dir, invalid path, clean tree).

**Smoke.** `npm run smoke:git-diff` (`scripts/smoke/git-diff.ts`), dirties a
temp repo three ways (staged edit, unstaged edit, untracked file), asserts the
grouping and the per-file diff payloads, plus the flag-smuggling and non-git
degradation cases. No LLM, no WebSocket, it imports `gitWorking.ts` directly.

## I2, Local <-> remote comparison ("what will I push / pull")

The **REMOTE** sub-tab (FILES tab, beside SOURCE) answers the operator's
specific ask: before a push or pull, *see exactly what will move*, no blind
`git push`. It compares the cwd's current branch against its upstream
(`@{u}`) and shows a **^N to push / vM to pull** summary, an expandable
commit list each direction, and the per-direction diff in the shared
`DiffView`. A **FETCH** button refreshes remote-tracking refs first.

**The I2 boundary, read-only except fetch.** This phase *shows* state and
*fetches*. `git fetch` updates remote-tracking refs only, it never merges,
rebases, or moves `HEAD`. The mutating push / pull / merge operations land in
**I3** (a separate, deliberately-segregated code path). Do not route push/pull
through this module.

**The two endpoints** (full spec in `docs/HTTP_API.md`):

- `GET /api/git/compare?wfid[&path]` -> `UpstreamComparisonResponse`:
  `{ isRepo, branch?, upstream?, detached?, hasUpstream?, ahead[], behind[],
  aheadDiffstat?, behindDiffstat? }`. `ahead` = local-only commits
  (`@{u}..HEAD`, to push), `behind` = remote-only commits (`HEAD..@{u}`, to
  pull). Each commit carries `{ hash, subject, author, ts }`. Diffstats come
  from `git diff --shortstat` on the symmetric range.
- `GET /api/git/compare/diff?wfid&direction=ahead|behind[&path]` -> a
  `WorkingFileDiffResponse` patch for that direction (`upstream...HEAD` /
  `HEAD...upstream`), so the client renders it in the A3 `DiffView` unchanged.
- `POST /api/git/fetch` (body `{ wfid?, path?, remote? }`) -> `FetchRemoteResponse`
  `{ ok, remote, fetched, error? }`. Default remote = the upstream's remote,
  else `origin`.

**Server logic.** `server/src/gitWorking.ts` (`fetchRemote`,
`getUpstreamComparison`, `getComparisonDiff`), wired through
`server/src/http/gitCompareRoutes.ts`. Client component:
`client/src/components/diff/CompareRemotePanel.tsx`.

**Safety / invariants.**

- All git via `execFile` argv arrays, never shell interpolation. The `remote`
  is validated against `/^[A-Za-z0-9._/-]+$/` and rejected if it leads with
  `-`, so it can't smuggle a flag (e.g. `--upload-pack=...`).
- `@{u}` range tokens (`upstream..HEAD`, `upstream...HEAD`, etc.) are single
  argv tokens built from branch/upstream names that git itself produced via
  `rev-parse --abbrev-ref`, and re-validated (`isSafeRef`: no whitespace, NUL,
  `..` doubling, or metachars) before interpolation.
- `git fetch` has a longer but still-bounded timeout (60 s vs the 15 s diff
  timeout) since it's a network op.
- Graceful degradation, always **200**: non-git -> `isRepo:false`; detached
  HEAD -> `detached:true`; no upstream -> `hasUpstream:false`; in sync ->
  `ahead:[] behind:[]`. A fetch failure (offline, auth, unknown remote) returns
  `{ ok:false, error }` at 200, **not** a 500.

**Smoke.** `npm run smoke:git-compare` (`scripts/smoke/git-compare.ts`), builds
a bare remote + a clone, diverges them (a local-only commit ahead, a remote-only
commit pushed by a second clone behind), then asserts the ahead/behind commit
lists, the per-direction diffs, the in-sync / no-upstream / non-git degradations,
and that `fetchRemote` works offline against the local bare remote while
rejecting unsafe/unknown remotes. No LLM, no WebSocket.

## I3, Direct local git operations

**What it is.** Operator-clicked git actions, no agent turn / prompt-dispatch:
**stage/unstage** (per-file + all), **commit**, **fetch/pull/push**, **stash**
save/pop/list, and **branch & tag** create/delete. Buttons live in the Changes
(Source Control) view (`WorkingChangesPanel` + `GitOpsBar`).

**⚠ Contrast with A2 checkpoints (the load-bearing distinction).** I3 ops
**INTENTIONALLY mutate the operator's real index / working tree / refs**, that
is the point. This is the OPPOSITE of A2 checkpoints (`gitSnapshots.ts`), which
NEVER touch the real index/HEAD (they write shadow refs under `refs/arco/`).
The two code paths are kept strictly separate: **`server/src/gitOps.ts` never
imports `gitSnapshots.ts` and vice versa.** Every operation requires an explicit
user action, uses deterministic validation, is logged to `events.jsonl` as a
`git_op_result` event, and can be reversed with the Git reflog, unstage, stash
pop, or branch recreation.

**The validator contract (the whole point of the phase).** Every git invocation
goes through `execFile('git', argv, {cwd})`, **never a shell string, never
string interpolation into a command.** Every operator-supplied value that
reaches git's argv is validated by the shared validators in
`server/src/gitSafe.ts` BEFORE use (a whole call is rejected if any one value
fails), and `--` ALWAYS precedes pathspecs:

| Validator (`gitSafe.ts`) | Guards | Rejects |
|---|---|---|
| `isSafePath` | stage/unstage file paths | leading `-` (flag smuggling), NUL |
| `isSafeRef` | branch / tag / stash refs | leading `-`, whitespace/NUL, `~^:?*[\`, `..` |
| `isSafeRemote` | remote names (origin etc.) | leading `-`, anything outside `[A-Za-z0-9._/-]` |

These are the SAME definitions I1/I2 use, moved into `gitSafe.ts` and
re-exported from `gitWorking.ts` / `gitDiff.ts` so there is ONE copy. The
commit message is passed as a single `-m <message>` argv token (free text, never
shell-bound, never validator-rejected) and **no `Co-Authored-By` (or any) trailer
is ever injected, the operator's message is committed verbatim.**

**Protected-branch / force-push confirm.** A push to a protected branch
(`PROTECTED_BRANCH_RE = /^(main|master|release\/.*|prod|production)$/i`, extracted
to `shared/src/protocol/gitOps.ts` so server + GitDialog share ONE regex) **and
ANY force push** require an explicit `confirm:true` from the caller. Without it,
`push()` returns `{ ok:false, needsConfirm:true, reason }` and **git is never
invoked**. When confirmed, force uses `--force-with-lease` (never a bare
`--force`). The client shows a `window.confirm` before sending `confirm:true`.

**Per-op argv (every user value guarded; `--` before every pathspec):**

| Op | git argv | guarded value | `--` before path? |
|---|---|---|---|
| `stageFiles` | `add -- <paths>` | each path -> `isSafePath` | yes |
| `stageAll` | `add -A` |, | n/a |
| `unstageFiles` | `reset -q HEAD -- <paths>` | each path -> `isSafePath` | yes |
| `unstageAll` | `reset -q HEAD` |, | n/a |
| `commit` | `commit -m <msg> [--amend]` | none (msg is free text) | n/a |
| `fetch` | `fetch [-- <remote>]` | remote -> `isSafeRemote` | yes (remote) |
| `pull` | `pull [<remote> [<branch>]]` | remote/branch -> `isSafeRemote`/`isSafeRef` | n/a (refspecs) |
| `push` | `push [--force-with-lease] [--set-upstream] [<remote> [<branch>]]` | remote/branch + confirm guard | n/a (refspecs) |
| `stashSave` | `stash push [-m <msg>]` | none (msg free text) | n/a |
| `stashPop` | `stash pop [<ref>]` | ref -> `isSafeRef` | n/a (ref) |
| `stashList` | `stash list --format=...` |, | n/a |
| `createBranch` | `switch -c <name>` / `branch -- <name>` | name -> `isSafeRef` | yes (non-checkout) |
| `deleteBranch` | `branch -d\|-D -- <name>` | name -> `isSafeRef` | yes |
| `createTag` | `tag [-a -m <msg>] -- <name>` | name -> `isSafeRef`; msg free text | yes |
| `deleteTag` | `tag -d -- <name>` | name -> `isSafeRef` | yes |

(`git switch -c` does NOT accept a `--` separator, the name rides directly,
guarded by `isSafeRef`'s leading-dash rejection.)

**Server logic.** `server/src/gitOps.ts` (argv-only functions, each returns a
structured `GitOpResult`, never throws for an expected git failure, re-reads
working-tree status after a mutation), wired through
`server/src/http/gitOpRoutes.ts` (`POST /api/git/op/<family>`, see
`docs/HTTP_API.md`). Each route runs the op, broadcasts a `git_op_result` event
(persisted to `events.jsonl` via `broadcastWorkflow`), and answers 200 with the
`GitOpResult` body. Client: `client/src/components/diff/GitOpsBar.tsx` +
per-file stage/unstage buttons in `WorkingChangesPanel.tsx`.

**Smoke.** `npm run smoke:git-ops` (`scripts/smoke/git-ops.ts`), a temp repo;
asserts stage->commit->unstage, stash save/list/pop round-trip, branch/tag
create+delete, and the ADVERSARIAL guards: a `-rf`/`--output=`/`../escape` path
is rejected (git never invoked with it), a metachar/leading-dash branch/tag name
is rejected, a force push / push to `main` without `confirm:true` returns
`needsConfirm` (and git is NOT run), and an empty commit message is rejected.
Also drives the real route to assert the `git_op_result` broadcast + its
`events.jsonl` line. No LLM, no dev server.

## I4, Remote diffs in the renderer + in-app PR authoring

The last Part-I phase wires the existing GitHub surface into the A3 diff
renderer and adds operator-driven PR creation. Three parts:

### 1. PR file diffs via the A3 renderer

`PullView.tsx`'s `FilesView` no longer hand-rolls a plain `<pre>` with per-line
coloring, it renders through the shared `DiffView` via the new
`GhFilesDiff` component (`client/src/components/GitHubPanel/GhFilesDiff.tsx`),
with UNIFIED / SPLIT toggle, word-level highlighting, and collapse-per-file for
free.

**The GitHub bare-patch gotcha (load-bearing).** GitHub's `files[].patch` is
**bare hunks**, it starts straight at `@@ ... @@` with **no** `diff --git a/... b/...`,
no `--- a/...`, no `+++ b/...` header. `react-diff-view`'s `parseDiff` needs those
headers to associate a filename and an add/delete/rename type, so feeding it the
raw patch yields a file with no path. The pure helper
`ghDiff.ts -> ghFileToUnifiedDiff` reconstructs a minimal git-style header per
file before parsing:

```
diff --git a/<old> b/<new>
--- a/<old>      (-> /dev/null when status === 'added')
+++ b/<new>      (-> /dev/null when status === 'removed')
<patch>
```

where `<old> = previous_filename ?? filename` (renames carry `previous_filename`)
and `<new> = filename`. `ghFilesToUnifiedDiff` concatenates the per-file results
into one string fed to `DiffView`'s `patch` prop. Files with **no `patch`**
(binary / oversized) are **excluded** from the renderer (`ghFilesWithoutPatch`)
and shown as a small "binary or too large, no inline diff" row with a link to
GitHub. The helpers are pure (no React) so they're reused by the commit-detail
view and unit-tested in the smoke.

### 2. Commit detail with diffs

`RepoView.tsx`'s `CommitsList` rows are now buttons (was an `<a>` to GitHub).
Clicking one navigates the panel state machine to a new `commit` view kind ->
`CommitView.tsx`, which fetches the new commit-detail endpoint
(`GET /api/github/repos/:owner/:repo/commits/:sha` -> `GhPullFile[]`) and renders
the files through the **same** `GhFilesDiff` / `ghDiff.ts` path. The commit
header (message / author / date / html_url) rides the view state from the list
row we clicked, so the detail view needs no second metadata fetch.

### 3. In-app PR creation

The `pulls` tab gains a `+ NEW PR` toggle (`PullsPane` -> `NewPrForm` in
`RepoView.tsx`): title (required), base (required, merge *into*), head
(required, branch *from*), body (optional, multiline). `base` pre-fills with
the repo default branch and `head` with the current ref when available. The
explicit `CREATE PR` submit **is** The operator confirmation for this outward
action, there is no auto-create and no agent path. On success the panel
navigates straight to the new PR; on failure the `{error}` shows inline.

**REST-body safety note (load-bearing).** PR creation goes through
`github.createPullRequest` -> the pure `buildCreatePrRequest(owner, name, input)`
-> the `gh<T>(path, { method: 'POST', body })` REST helper. The operator's
title / body / base / head ride the **JSON `body`**, they are **never**
interpolated into a `gh pr create` shell or argv string. This mirrors
`mergePull` / `commentIssue` and dodges flag-injection from a title that begins
with `-` (it lands verbatim in the JSON body, never read as an argv flag).
`buildCreatePrRequest` validates that title / base / head are non-empty
(trimmed) and throws a `PrValidationError` otherwise; the route maps that to a
**400** (distinct from a gh/network failure, which is the existing **502**
catch). PR creation does **not** broadcast to `events.jsonl`, consistent with
the other GitHub write endpoints (merge / comment), which are direct HTTP ops.

**Server.** `server/src/github.ts` += `buildCreatePrRequest` (pure),
`PrValidationError`, `createPullRequest`, `commitFiles`. `GhPullFile` grew
`previous_filename?` (rename old path) and `blob_url?` (fallback link).
`server/src/http/githubRoutes.ts` += `POST .../pulls` (create) and
`GET .../commits/:sha` (commit files). The new commit-detail route is keyed on
`rest.length === 2` so it does **not** shadow the commits-LIST route
(`rest.length === 1`).

**Smoke.** `npm run smoke:github-pr` (`scripts/smoke/github-pr.ts`), PURE unit
test, **no live `gh`, no network, no real PR** (creating a PR is an outward side
effect, never done from a test). Covers `buildCreatePrRequest` (correct
`{path, method, body}`, leading-dash title preserved in body, trimming, empty
title/base/head rejected) and the diff-reconstruction helpers (synthetic git
headers, `/dev/null` for add/remove, `previous_filename` for renames,
binary/no-patch files excluded).

## I5, Worktree bake-off

The **AGENT -> BAKE-OFF** tab races one implementation prompt through 2-5
provider/model configurations. Unlike the existing COMPARE primitive (bounded,
read-only answer panes), every bake-off leg is a normal visible Arco workflow
with tools, transcript, and its own git worktree. All legs start from the exact
same source `HEAD`.

1. The operator enters a name/prompt, chooses each leg with the shared
   **RUN AS** picker, and clicks **START BAKE-OFF**.
2. `gitBakeoff.ts` refuses a non-git, unborn, or project-dirty source checkout,
   creates branches `arco/bakeoff/<id8>/attempt-N`, and checks them out under
   `~/.arco/bakeoffs/<cwd-hash>/worktrees/<bakeoffId>/<attemptId>`.
3. `bakeoffHandlers.ts` creates background workflow tabs and concurrently sends
   the same prompt plus fixed isolation rules. Sticky Ultracode and Goal Run
   are disabled on attempt tabs so one bounded fan-out cannot multiply.
4. The operator opens any attempt tab for its transcript or clicks **DIFF** in
   BAKE-OFF. `GET /api/git/bakeoffs/diff` feeds the shared `DiffView`.
5. The operator explicitly clicks **PROMOTE**. Arco stages candidate project
   files, creates a candidate commit when needed, and performs a
   no-fast-forward merge into the source checkout.
6. **CLEAN LOSERS / CLEAN ALL** closes the selected attempt tabs and removes
   only their managed worktrees. Their branches are deliberately preserved.

There is no automatic ranking, winner, merge, push, or cleanup. Promotion
refuses while the attempt is busy, when the source checkout is dirty, or when
source `HEAD` moved from the recorded base. A merge conflict is aborted
automatically. `.arco` is excluded from diffs/staging; if a disobedient agent
already committed `.arco` state, promotion refuses the branch. Managed-root
and git-worktree-registration checks fence both diff reads and force-removal.

Manifests live outside the repo at
`~/.arco/bakeoffs/<cwd-hash>/manifests/<bakeoffId>.json`. Attempt workflow
meta records the source cwd, but project-trust inheritance is honored only
after the server proves the cwd is one of Arco's registered managed
worktrees. Smoke: `npm run smoke:bakeoff` (disposable repo; seven steps covering
isolation, tracked/untracked diff, metadata refusal, promotion, source drift,
branch-preserving cleanup, and the start/list/state/cleanup protocol lifecycle).
