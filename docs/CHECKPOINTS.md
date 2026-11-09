# Shadow-git checkpoints

Legacy tar checkpoints are staged and checked before restoring any project file. Links, path escapes, special files and linked destination folders are refused. Archives are limited to 512 MB and 10,000 entries. Ordinary files still restore, while files created after the checkpoint remain. New Git-tree checkpoints use the existing restore path. On POSIX systems, legacy restores retain archived file and directory permission bits. New directories stay private during extraction; their final modes are applied after their contents are restored.

Automatic working-tree snapshots taken **before and after file-mutating operator turns**, so the
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
   `.gitignore`s can't abort it), skipping the top-level `.arco`, every `.git` at any depth, and nested Git repositories or worktrees as whole folders.

   **Size caps (load-bearing scope rule).** Regular files over the **32 MiB per-file cap** are SKIPPED and
   counted (`skippedLargeFiles` on the broadcast), agents mutate configs/scripts/text; multi-GB models and
   videos are inert ballast no per-turn snapshot scheme can afford to copy. A **1 GiB included-total cap**
   backstops many-small-file trees; over it the snapshot is skipped entirely (logged, returns null).
   Overrides: `ARCO_CHECKPOINT_FILE_CAP_BYTES` / `ARCO_CHECKPOINT_TOTAL_CAP_BYTES` (`0` disables
   either). Caps apply only to this fallback, never to real repos. Every ref has a small
   `<wfid>.<seq>.skipped.json` sidecar recording the exact out-of-scope paths: a target-skipped file remains
   untouched even if it later shrinks, and revert aborts before writing when a currently over-cap path
   overlaps the target tree. The safety snapshot cannot recover those bytes, so abort is the only safe path.

   **Explicit nested scope.** Shadow checkpoints do not include nested Git repositories or worktrees. The captured file count comes from the stored Git tree. The checkpoint, preview and revert result name up to three omitted folders and count any remainder. The version-1 skipped-path manifest now also records optional `nestedRepositories`, including an empty array when scope is known; `paths` includes these directory exclusions so older readers preserve them too. Excluded folders stay untouched even if their Git marker later disappears. A revert refuses when an included target path has since become part of a nested repository.

   Older manifests without this scope field remain readable. Folders not represented in their target tree are preserved instead of risking deletion of formerly excluded nested files, and the preview/result explains the limitation. If a checkpoint file would replace a preserved folder or its ancestor, preview and revert refuse before changing any project file. New files inside folders represented by the target still follow ordinary revert semantics. No old checkpoint is rewritten or deleted.

   **Traversal budgets.** Non-Git discovery visits at most 20,000 entries or 5,000 milliseconds and yields between directories. Set positive `ARCO_CHECKPOINT_SCAN_ENTRIES` and `ARCO_CHECKPOINT_SCAN_MS` values to adjust those limits; invalid or nonpositive values use the defaults. Hitting either limit refuses the whole snapshot, so no partial ref is published. The tab shows one skip notice naming these controls and `ARCO_CHECKPOINT_TOTAL_CAP_BYTES`. A comparison or shadow revert that exceeds a budget stops before changing project files. Git-backed snapshots keep their existing Git-ignore behavior and do not use these traversal limits.

   Git-based snapshots replaced tar archives to avoid copying the full working
tree each turn. They use content-addressed storage and preserve deletions during
revert.
   The shadow repo is content-addressed (an unchanged file costs nothing after its first snapshot) and
   reverts with real git tree semantics. Legacy `<wfid>.<seq>.tar` files in the same store stay readable by
   revert; nothing creates new tars.
3. **GC**, caps retained checkpoints at **50 per workflow**; prunes the lowest seqs (`update-ref -d` on the
   `refs/arco/<wfid>/` prefix, same in the shadow repo, followed by a best-effort `gc --auto`). A completed turn can use two retained refs, so turn diffs may be pruned sooner than one-checkpoint-per-turn history.

Returns `{ ref, fileCount, ts, backend, skippedLargeFiles? }`, or `null` if it skipped/failed (never throws
into the turn).

## Hook (`server/src/ws/turnEngine.ts`)

The snapshot fires in `handleUserMessage`, immediately before `runPrimaryTurn(...)`, **only for operator
turns**, *not* in `seedWorker.ts` (the plan's original guess), because `runPrimaryTurn` is the shared turn
primitive also used by reviewers, handoff seeds, `exportContext`, and Task children, none of which should
checkpoint the operator's working tree. It is:

- **Skipped when `armPlanMode` is true** (plan-mode turns are read-only until `ExitPlanMode`), for chat and isolated scratch sessions, and for an explicit Ollama allowlist containing only known read-only tools. Unknown or dynamic tools are treated as potentially mutating.
- **Bounded pre-capture**: wait up to two seconds before starting the provider. A timeout or failure lets the turn proceed and omits its changed-files line; a late capture is never used as a baseline.
- Followed by a `checkpoint_created { workflowId, checkpointSeq, ref, label, ts, fileCount, skippedLargeFiles? }`
  broadcast (`shared/src/protocol/checkpoints.ts`). `checkpointSeq` is the **guard seq** (the turn the
  checkpoint protects, from `currentSeq()`); the event gets its own next events.jsonl `seq`. `skippedLargeFiles` appears on shadow-store snapshots that excluded per-file-capped
  files, so the marker is honest about what a revert covers.

## Invariants (do not regress)

- **Never touch the user's real index/HEAD/working tree.** Only `GIT_INDEX_FILE`-scoped index ops and
  `refs/arco/*` ref writes. No `reset`/`checkout`/`stash`/`add` against the real index. Ever.
- **Never expose checkpoints to the LLM**, no tool, no system-prompt mention. Pure operator infra.
- **Snapshot before the turn, bounded to two seconds**. Failure or timeout never prevents the turn; its change summary is omitted. Capture the end snapshot before draining the next queued turn so the diff range cannot absorb that follow-up.
- **Worktrees share the store.** `createCheckpoint` works unchanged with a linked `git worktree` cwd (K5
  task worktrees): `--absolute-git-dir` resolves the per-worktree gitdir while the **object store is shared**
  with the main repo, so checkpoints taken in sibling worktrees dedupe at the git-object level. Don't
  special-case worktree cwds. See [Task ledger: Worktrees](TASK_LEDGER.md#worktrees-per-task-k5).

## Smoke

`scripts/smoke/checkpoints.ts` (`npm run smoke:checkpoints`) tests the mechanism directly (no LLM/WS): dirty
a temp repo, snapshot, assert a new `refs/arco/...` exists, the user's HEAD/index/`git status` are
unchanged, the snapshot tree contains the dirty content, the commit is parentless; and on the non-git
shadow fallback, the ref lands in the shadow repo while the cwd stays non-git, per-file-capped files are
skipped and counted, an over-total-cap snapshot is skipped entirely, and unchanged files dedupe at the
object level across snapshots. Both repo and shadow paths also run simultaneous same-cwd captures to pin
the unique-scratch-file rule.

## Revert, `revertToCheckpoint` + the `revert_to_checkpoint` handler

A4 surfaces checkpoint markers on the HISTORY timeline (and a compact list in ACTIVITY) and adds one-click
revert. Flow (`server/src/ws/workflowHandlers.ts handleRevertToCheckpoint`):

Before the safety snapshot, the handler reserves the actual restore scope against managed work in
this server. It resolves filesystem aliases and checks segment-aware parent/child overlaps, including
declared additional directories. An idle requesting workflow cannot restore over another workflow's
turn, reset, or auxiliary worker. New busy claims and worker starts cannot enter a reserved scope;
background checkpoint captures also retain ownership until they finish. An overlapping restore is
refused while the reservation is held. The reservation lasts through both safety capture and restore,
and is released on success or failure. Independent linked worktrees remain usable.

The scope includes the configured directory and the effective work tree selected by the backend's
explicit `--git-dir` invocation. With ordinary Git configuration, a configured subdirectory is the
backend's work tree; ordinary Git-root discovery alone does not describe that invocation. Git
`core.worktree` and environment overrides can select a wider tree, which is reserved too. The existing
snapshot and restore layout is preserved.

Protection is local to managed busy claims, WorkerManager workers, and checkpoint captures in one
server process. It does not coordinate external terminals, integrated terminal shells, other Arco
processes, or unrelated file, Git, and media endpoints. Stop those writers before restoring. Arbitrary
provider writes outside the configured and declared additional directories are not tracked. This
reservation does not replace isolation through a separate worktree.

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
     new index file"). The snapshot path uses the same kind of `$TMPDIR` scratch index (see above).
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
4. Emit `checkpoint_reverted { restoredSeq, fileCount, safetySnapshotRef, safetySnapshotSeq, backend, limitation?, changes?, restoredRef?, ts }`.
   `changes` is counted from the same scratch index just before `read-tree -u`: `write-tree` gives the
   live tree the restore covers, and `diff-tree --name-status` against the checkpoint tree counts files
   changed back (`M`/`T`), created since and removed (`D`), deleted since and restored (`A`), and the
   rest of the checkpoint as unchanged. Legacy tar restores carry no counts.

**Guard seq and event seq.** The guard seq travels in its own field (`checkpointSeq`, `restoredSeq`,
`safetySnapshotSeq`); `seq` is always the event's own number, assigned by `persistAndStampSeq`, which drops
any `seq` in the payload. Releases before 0.1.5 sent the guard seq as `seq`: on the wire it was replaced,
but on disk it was kept, so each checkpoint record repeated a number and a revert record went back to an
older one (see PERSISTENCE.md "Effective sequence numbers"). For those events the client recovers the guard
seq from the **ref** (`refs/arco/<wfid>/<seq>` or `<wfid>.<seq>.tar`, `client/src/utils/historyEvents.ts
guardSeqFromRef`). The revert handler rebuilds the ref from the seq the client sends, so the round-trip is
consistent.

**Other invariants:** revert is rejected while conflicting managed work is in flight, including a busy
requester (`wf.busy`). execFile argv only; wfid/seq validated like A2/A3.

## Preview and result

The confirm dialog (`CheckpointActions.tsx`) asks `GET /api/workflows/checkpoint-preview` what the
revert would change (`previewCheckpointRevert`: the same scratch-index seed and count as the revert,
without `read-tree -u`) and shows the counts, the first affected paths, or "Nothing would change" when
the folder already matches. It states that only files are restored (the conversation, task board and
other cluster members stay as they are; REWIND CONVERSATION is the conversation's counterpart) and, in
a cluster, that the checkpoint covers the whole folder including other members' edits. After the
revert, a result line under the buttons and the `REVERTED` HISTORY row show `checkpoint_reverted.changes`;
VIEW CHANGES on either opens the `safetySnapshotRef` to `restoredRef` diff.

## Turn changes in chat

After a restore, `checkpoint_reverted` carries `restoredSeq` (the restored checkpoint's seq, which the event envelope would otherwise replace); the turn line shows `Undone`, `UNDO THIS TURN` is disabled and the diff title reads `DIFF: UNDONE TURN CHANGES`.

After a settled turn, an end checkpoint is compared with its pre-turn checkpoint using bounded `git diff --numstat`. A non-empty result is persisted in the workflow event log and appears under the reply as `Changed N files`; the line opens the captured ref-to-ref diff. `UNDO THIS TURN` uses the existing checkpoint revert and confirmation, including its safety snapshot. The confirmation makes clear that restoring a checkpoint also reverts later changes in that working tree.

If another managed writer overlapped the same folder at any point, the line says other agents were working there and offers VIEW DIFF only, not undo. Capture is skipped when the pre-turn snapshot cannot finish in two seconds. Isolated cluster members use a separate scratch directory and do not produce this project-checkpoint line. The end capture must settle before the next queued turn starts. A missing or failed capture or oversized diff produces no summary, rather than a misleading partial one. Large files excluded from shadow checkpoints are noted. Git checkpoints follow Git ignore rules, so ignored files are outside the captured diff. Git and non-git folders use their respective checkpoint stores; both use immutable refs for the viewer.

Overlap tracking observes writers managed by this server, including separate workers of the same workflow. It cannot detect unrelated external processes, terminals, or another Arco process. Those writers must be stopped when exact attribution or restore matters. On a shared folder the diff covers the folder during the turn, not an isolation boundary for unmanaged changes. Additional directories outside the checkpointed working tree are not captured. Normal managed concurrency is not blocked.

## Downstream

A3 (diff viewer) reads `git diff <refA> <refB>` between shadow refs for per-turn diffs. "View diff vs now"
 uses the same renderer with `from=<checkpoint ref>`, `to=WORKTREE`; in Git and non-Git folders alike it
 diffs the checkpoint tree against a tree written from the revert seed (`diffCheckpointToNow`), so the
 diff shows exactly what a revert would change. Non-Git shadow stores also support comparisons between
 captured refs.

## Smoke

`scripts/smoke/checkpoint-revert.ts` (`npm run smoke:checkpoint-revert`): in a temp git repo, checkpoint A,
mutate + add B, safety-snapshot, revert to #1; asserts A restored, **B gone**, safety ref exists, user
HEAD/branch/index unchanged, revert is undoable (revert to the safety snapshot brings B back), missing
checkpoint returns null. Plus the non-git shadow-store revert (faithful: files-added-after removed, capped
files untouched across size changes; unsafe overwrite aborts) and the legacy tar reader with its documented
limitation.

## Related links

- [Feature reference](FEATURES.md)
- [Documentation style](STYLE.md)
