# Shadow-git checkpoints

Automatic, invisible working-tree snapshots taken **before every file-mutating operator turn**, so the
operator can undo what an agent did independent of their own git history. The model never sees them.

## Mechanism (`server/src/gitSnapshots.ts`)

`createCheckpoint({ cwd, workflowId, seq, label })`:

1. **Git repo (normal path)**, snapshots without touching the user's index/HEAD/staging by using a
   **separate index file**:
   - A unique `GIT_INDEX_FILE=$TMPDIR/arco-snapshot-<cwd-hash>-<pid>-<uuid>.index` for every operation
     (the isolation is load-bearing; uniqueness prevents concurrent workflows in one cwd contending on the
     same index lock, and keeping it outside the worktree prevents one capture staging another's scratch).
   - `read-tree HEAD` into the snap index (skipped on an unborn HEAD), then `add -A`, then `write-tree`.
   - `commit-tree` wraps the tree in a **parentless** commit (checkpoints are a flat series, not a branch).
   - `update-ref refs/arco/<workflowId>/<seq>` stores it. The user's `git status`, index, branch, and
     HEAD are **byte-identical** afterward.
   - All calls use `execFile` arg arrays, **no shell-string interpolation**.
2. **Non-git cwd (fallback)**, a **shadow bare repo** at `~/.arco/checkpoints/<cwd-hash>/git`, driven
   with `--git-dir`/`--work-tree` (the dotfiles pattern) so nothing ever lands in the user's directory, it
   stays non-git from their point of view. Refs use the same `refs/arco/<wfid>/<seq>` format. Staging is
   an explicit file list from our own walk (`--pathspec-from-file`, NUL-separated, `add -f` so nested
   `.gitignore`s can't abort it), skipping the top-level `.arco` and every `.git` at any depth.

   **Size caps (load-bearing scope rule).** Regular files over the **32 MiB per-file cap** are SKIPPED and
   counted (`skippedLargeFiles` on the broadcast), agents mutate configs/scripts/text; multi-GB models and
   videos are inert ballast no per-turn snapshot scheme can afford to copy. A **1 GiB included-total cap**
   backstops many-small-file trees; over it the snapshot is skipped entirely (logged, returns null).
   Overrides: `ARCO_CHECKPOINT_FILE_CAP_BYTES` / `ARCO_CHECKPOINT_TOTAL_CAP_BYTES` (`0` disables
   either). Caps apply only to this fallback, never to real repos. Every ref has a small
   `<wfid>.<seq>.skipped.json` sidecar recording the exact out-of-scope paths: a target-skipped file remains
   untouched even if it later shrinks, and revert aborts before writing when a currently over-cap path
   overlaps the target tree. The safety snapshot cannot recover those bytes, so abort is the only safe path.

   Git-based snapshots replaced tar archives to avoid copying the full working
tree each turn. They use content-addressed storage and preserve deletions during
revert.
   The shadow repo is content-addressed (an unchanged file costs nothing after its first snapshot) and
   reverts with real git tree semantics. Legacy `<wfid>.<seq>.tar` files in the same store stay readable by
   revert; nothing creates new tars.
3. **GC**, caps retained checkpoints at **50 per workflow**; prunes the lowest seqs (`update-ref -d` on the
   `refs/arco/<wfid>/` prefix, same in the shadow repo, followed by a best-effort `gc --auto`).

Returns `{ ref, fileCount, ts, backend, skippedLargeFiles? }`, or `null` if it skipped/failed (never throws
into the turn).

## Hook (`server/src/ws/turnEngine.ts`)

The snapshot fires in `handleUserMessage`, immediately before `runPrimaryTurn(...)`, **only for operator
turns**, *not* in `seedWorker.ts` (the plan's original guess), because `runPrimaryTurn` is the shared turn
primitive also used by reviewers, handoff seeds, `exportContext`, and Task children, none of which should
checkpoint the operator's working tree. It is:

- **Skipped when `armPlanMode` is true** (plan-mode turns are read-only until `ExitPlanMode`).
- **Fire-and-forget** (`void createCheckpoint(...).catch(...)`), a slow or failed snapshot never blocks or
  fails the turn.
- Followed by a `checkpoint_created { workflowId, seq, ref, label, ts, fileCount, skippedLargeFiles? }`
  broadcast (`shared/src/protocol/checkpoints.ts`). The `seq` payload is the **guard seq** (the turn the
  checkpoint protects, from `currentSeq()`); the broadcast itself is separately stamped a fresh
  events.jsonl seq. `skippedLargeFiles` appears on shadow-store snapshots that excluded per-file-capped
  files, so the marker is honest about what a revert covers.

## Invariants (do not regress)

- **Never touch the user's real index/HEAD/working tree.** Only `GIT_INDEX_FILE`-scoped index ops and
  `refs/arco/*` ref writes. No `reset`/`checkout`/`stash`/`add` against the real index. Ever.
- **Never expose checkpoints to the LLM**, no tool, no system-prompt mention. Pure operator infra.
- **Snapshot before the turn, fire-and-forget**, correctness of the turn must not depend on the snapshot.
- **Worktrees share the store.** `createCheckpoint` works unchanged with a linked `git worktree` cwd (§K5
  task worktrees): `--absolute-git-dir` resolves the per-worktree gitdir while the **object store is shared**
  with the main repo, so checkpoints taken in sibling worktrees dedupe at the git-object level. Don't
  special-case worktree cwds. See `docs/TASK_LEDGER.md § Worktrees`.

## Smoke

`scripts/smoke/checkpoints.ts` (`npm run smoke:checkpoints`) tests the mechanism directly (no LLM/WS): dirty
a temp repo, snapshot, assert a new `refs/arco/...` exists, the user's HEAD/index/`git status` are
unchanged, the snapshot tree contains the dirty content, the commit is parentless; and on the non-git
shadow fallback, the ref lands in the shadow repo while the cwd stays non-git, per-file-capped files are
skipped and counted, an over-total-cap snapshot is skipped entirely, and unchanged files dedupe at the
object level across snapshots. Both repo and shadow paths also run simultaneous same-cwd captures to pin
the unique-scratch-file rule.

## Revert (A4), `revertToCheckpoint` + the `revert_to_checkpoint` handler

A4 surfaces checkpoint markers on the HISTORY timeline (and a compact list in ACTIVITY) and adds one-click
revert. Flow (`server/src/ws/workflowHandlers.ts handleRevertToCheckpoint`):

1. **Safety snapshot FIRST.** Always take a fresh `createCheckpoint` of the live working tree (label
   `pre-revert <iso-ts>`, anchored to the workflow head seq) so the revert is itself undoable. **If the
   safety snapshot returns null the revert is ABORTED**, we never restore without a way back. The safety
   snapshot is also broadcast as a normal `checkpoint_created` so it shows up on the timeline.
2. **Faithful restore** (`gitSnapshots.revertToCheckpoint`). Git mechanism, never touching the user's
   index/HEAD/branch:
   - Resolve the checkpoint's tree (`rev-parse <ref>^{tree}`); null if pruned.
   - Use a **scratch index file OUTSIDE the working tree** (`$TMPDIR/arco-revert-...index`). This is
     load-bearing: `read-tree -u --reset` sweeps working-tree files (and now-empty dirs) absent from the
     target tree, so a scratch index under `cwd/.arco` would get deleted mid-operation ("unable to write
     new index file"). The snapshot path keeps its index under `.arco` because it never runs `-u`.
   - Seed the scratch index from the LIVE tree: `read-tree HEAD` (if HEAD exists), then a plain `add -A`,
     then `rm --cached -r --ignore-unmatch -- .arco` to drop our state dir from the seed. **Do not
     "simplify" this back to `add -A -- ':!.arco' ':!.git'`**, an exclude-only pathspec makes git treat
     matched-but-ignored dirs as explicitly requested, and with a global `**/.arco/` ignore rule the add
     REFUSES ("ignored by one of your .gitignore files"), failing every revert in a repo containing
     `.arco` (found 2026-08-19). Both seed steps must succeed: a seeded `.arco` would be swept from the
     working tree by `read-tree -u --reset` (it's absent from every checkpoint tree).
   - `read-tree -u --reset <tree>` against the scratch index updates the working tree to match the
     checkpoint tree AND **deletes files the scratch index tracked but the target tree lacks**, that's
     what makes "files created after the checkpoint are removed" a TRUE revert.
   - Discard the scratch index. **Documented index/HEAD semantics:** the user's real index and HEAD are
     byte-identical before/after; the restored tree shows up as ordinary uncommitted working-tree changes
     vs their unchanged HEAD (exactly what an operator wants to review/commit/undo).
3. **Shadow-store revert** (non-git cwd): the same faithful mechanism against the per-cwd shadow repo,
   scratch index outside the working tree, seeded from the current capped walk minus paths recorded in the
   target ref's skipped-path sidecar. A target-skipped file therefore remains untouched if it later shrinks.
   If a currently over-cap path overlaps something the target tree would restore, revert aborts before any
   write because the safety snapshot cannot preserve its current bytes. Otherwise `read-tree -u --reset`
   restores in-scope content and removes files created afterward; `backend` reports `git`. If the requested
   seq isn't in the shadow repo, the
   **legacy tar reader** takes over (pre-2026-08-19 checkpoints): extract over the cwd
   (additive/overwrite), with the documented limitation that files created after the checkpoint are NOT
   removed, surfaced on `checkpoint_reverted.limitation` and in the UI. Nothing creates new tars.
4. Emit `checkpoint_reverted { seq, fileCount, safetySnapshotRef, safetySnapshotSeq, backend, limitation?, ts }`.

**Guard-seq wire caveat.** `persistAndStampSeq` does `{ ...message, seq: <eventSeq> }`, which **overwrites**
the guard-seq `seq` field on `checkpoint_created` / `checkpoint_reverted`. The client therefore recovers the
guard seq from the **ref** (`refs/arco/<wfid>/<seq>` or `<wfid>.<seq>.tar`), not from `msg.seq`, see
`client/src/utils/historyEvents.ts guardSeqFromRef`. The revert handler rebuilds the ref from the seq the
client sends, so the round-trip is consistent.

**Other invariants:** revert is rejected while a turn is in flight (`wf.busy`), restoring under the agent's
feet would race the turn. The confirm dialog (`CheckpointActions.tsx`) shows the file count + the
safety-snapshot note before sending. execFile argv only; wfid/seq validated like A2/A3.

## Downstream

A3 (diff viewer) reads `git diff <refA> <refB>` between shadow refs for per-turn diffs. "View diff vs now"
(A4) is the same renderer with `from=<checkpoint ref>`, `to=WORKTREE`.

## Smoke (A4)

`scripts/smoke/checkpoint-revert.ts` (`npm run smoke:checkpoint-revert`): in a temp git repo, checkpoint A,
mutate + add B, safety-snapshot, revert to #1; asserts A restored, **B gone**, safety ref exists, user
HEAD/branch/index unchanged, revert is undoable (revert to the safety snapshot brings B back), missing
checkpoint returns null. Plus the non-git shadow-store revert (faithful: files-added-after removed, capped
files untouched across size changes; unsafe overwrite aborts) and the legacy tar reader with its documented
limitation.
