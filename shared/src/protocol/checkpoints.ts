// ── Shadow-git checkpoints (Workbench Expansion A2) ──
//
// Auto-snapshots of the working tree taken BEFORE every file-mutating
// operator turn, stored in a hidden git ref (`refs/arco/<wfid>/<seq>`) — in
// the project repo, or for non-git workspaces in a shadow bare repo under
// `~/.arco/checkpoints/<cwd-hash>/git`. Pure operator infrastructure — the
// model never sees these, there is no tool, and nothing about them lands in
// any system prompt. Undo-the-agent independent of the user's real history.

// Server → client. Emitted once per checkpoint the server creates. Persisted
// to events.jsonl via the standard broadcast path so HISTORY/Activity (A4)
// can render checkpoint markers on reconnect without re-reading git.
export interface CheckpointCreatedMessage {
  type: 'checkpoint_created';
  workflowId: string;
  // The workflow event seq this checkpoint was taken against (the turn it
  // guards). Doubles as the unique suffix of the git ref / tar filename, so
  // a given turn maps deterministically to one checkpoint.
  seq: number;
  // Git ref (`refs/arco/<wfid>/<seq>`) — same format on both backends. Old
  // events may carry a legacy tar name (`<wfid>.<seq>.tar`) from the pre-shadow
  // non-git fallback; guardSeqFromRef parses both.
  ref: string;
  // Short operator-facing label, e.g. "before turn 42".
  label: string;
  // Epoch ms the snapshot was taken.
  ts: number;
  // Number of tracked + untracked files captured in the snapshot tree.
  fileCount: number;
  // Non-git-cwd (shadow-store) snapshots only: files excluded for exceeding
  // the per-file size cap (models/videos — out of checkpoint scope), so the
  // marker is honest about what a revert covers. Absent when nothing was
  // skipped or on repo-backed checkpoints.
  skippedLargeFiles?: number;
}

// ── Diff endpoint (Workbench Expansion A3) ──
//
// HTTP (not WS): GET /api/workflows/diff?wfid&path&from&to returns this shape.
// `from`/`to` are git revisions — a shadow checkpoint ref
// (`refs/arco/<wfid>/<seq>`), HEAD, a sha, or the literal WORKTREE sentinel
// for a pre-commit working-tree comparison. The DiffView renderer is
// source-agnostic and consumes only `patch`; the rest is for the UI header /
// empty-state messaging.

// Literal `to` value meaning "the live working tree" rather than a committed
// ref. Default when `to` is omitted (working tree vs HEAD / pre-commit).
export const WORKTREE_REV = 'WORKTREE';

export interface DiffResponse {
  // Unified-diff text. Empty string is a valid result (clean tree / identical
  // refs) — not an error.
  patch: string;
  // Whether the cwd was a git working tree at all.
  isRepo: boolean;
  // Set when a requested revision could not be resolved (e.g. a pruned
  // checkpoint). `patch` is empty in that case.
  missingRef?: string;
  // Echo of what was actually compared, for the UI header.
  from: string;
  to: string;
}

// ── Working-tree changes view (Workbench Expansion I1) ──
//
// HTTP (not WS): GET /api/git/diff lists the working tree's changed files
// grouped staged / unstaged / untracked, and (with ?path-of-the-file) returns
// the per-file unified diff. Distinct from the A3 /api/workflows/diff endpoint
// (which produces a single whole-tree or ref-vs-ref patch). Both feed the same
// source-agnostic DiffView; this one is the "Source Control"-style file list.

// One changed file in the working tree. `path` is repo-relative, POSIX-style
// (git's porcelain output). `staged` records whether the change is in the
// index; the per-file diff endpoint uses it to pick `git diff` vs
// `git diff --cached`.
export interface WorkingChangeEntry {
  path: string;
  // Single-letter git status code for the relevant side: M(odified),
  // A(dded), D(eleted), R(enamed), C(opied), or '?' for untracked. For
  // renames `origPath` carries the old path.
  status: string;
  origPath?: string;
}

// Grouped working-tree status. Empty arrays + isRepo:false for a non-git dir.
export interface WorkingChangesResponse {
  isRepo: boolean;
  staged: WorkingChangeEntry[];
  unstaged: WorkingChangeEntry[];
  untracked: WorkingChangeEntry[];
}

// One entry from `git worktree list`. Powers the FilesTab worktree picker so
// the LIVE / CHANGES / SOURCE / REMOTE views can watch the tree a worker is
// actually editing (an Arco task worktree under ~/.arco/worktrees, or one
// a worker created itself) instead of only the shared cluster checkout — those
// edits never touch the main tree, so it looks "clean" while work is happening.
export interface WorktreeInfo {
  path: string;         // absolute checkout path
  branch: string | null; // short branch name, or null when detached
  head: string;         // resolved HEAD sha (may be '' for a fresh worktree)
  isMain: boolean;      // the repo's primary working tree (the first entry)
}

// Response for GET /api/git/worktrees. Empty list + isRepo:false for a non-git
// dir. The main tree is always first when present.
export interface WorktreeListResponse {
  isRepo: boolean;
  worktrees: WorktreeInfo[];
}

// Per-file diff result for the working-changes view. Mirrors DiffResponse's
// shape (so DiffView consumes `patch` unchanged) plus a `binary` flag for the
// graceful-degradation case (binary / oversized file → no patch, a hint).
export interface WorkingFileDiffResponse {
  isRepo: boolean;
  patch: string;
  // Set when the file is binary or too large to render — `patch` is empty and
  // the UI shows a hint rather than dumping bytes.
  binary?: boolean;
  // Echo of what was requested, for the UI header / keying.
  path: string;
  staged: boolean;
}

// ── Revert (Workbench Expansion A4) ──
//
// Client → server. Operator clicked "Revert to here" on a checkpoint marker.
// The server FIRST takes a safety snapshot of the current working tree (so the
// revert is itself undoable), then restores the working tree to the chosen
// checkpoint — faithfully, i.e. files created after the checkpoint are removed.
// The user's HEAD / branch / real index are never moved. `seq` identifies the
// checkpoint (the server rebuilds the ref itself; the client never supplies a
// raw git ref). If the safety snapshot fails the revert is aborted.
export interface RevertToCheckpointMessage {
  type: 'revert_to_checkpoint';
  workflowId: string;
  // The checkpoint's guard seq (the `seq` carried on its checkpoint_created).
  seq: number;
}

// Server → client. Emitted after a successful revert. Persisted to events.jsonl
// via the standard broadcast path so HISTORY/Activity render a "reverted to
// checkpoint" marker on reconnect. Failure is surfaced as a plain `error`
// message instead (no checkpoint_reverted is emitted).
export interface CheckpointRevertedMessage {
  type: 'checkpoint_reverted';
  workflowId: string;
  // The checkpoint that was restored (its guard seq).
  seq: number;
  // Number of files in the restored tree.
  fileCount: number;
  // The safety snapshot taken BEFORE the revert — ref (git) or tar name.
  // Reverting to THIS undoes the revert. Always present on success.
  safetySnapshotRef: string;
  // The guard seq of that safety snapshot (so the UI can offer "undo revert").
  safetySnapshotSeq: number;
  // Which store backed the restore.
  backend: 'git' | 'tar';
  // Set on a legacy tar restore when full faithfulness wasn't achievable.
  limitation?: string;
  // Epoch ms.
  ts: number;
}

// ── Local ↔ remote comparison (Workbench Expansion I2) ──
//
// HTTP (not WS): GET /api/git/compare reports how the current branch sits
// against its upstream (`@{u}`) — the commits local-only ("to push") and
// remote-only ("to pull"), plus a diffstat each direction. POST /api/git/fetch
// runs `git fetch <remote>` (updating remote-tracking refs only; it never
// merges/rebases/moves HEAD). I2 SHOWS state and fetches; the mutating
// push/pull/merge lands in I3. Both feed the same source-agnostic DiffView.

// One commit in an ahead/behind list. Short hash + subject + author + epoch ms.
export interface CompareCommit {
  hash: string;
  subject: string;
  author: string;
  // Author date, epoch ms.
  ts: number;
}

// Result of `git diff --stat` for one direction — the bottom summary line of
// `git diff --stat` ("N files changed, …"), kept compact for the UI.
export interface CompareDiffstat {
  // Files changed in this direction.
  files: number;
  insertions: number;
  deletions: number;
}

// Current-branch vs upstream comparison. Non-fatal cases are all clean,
// structured results — never a throw / 500:
//   - non-git dir          → { isRepo:false }
//   - detached HEAD         → { isRepo:true, detached:true }
//   - no upstream configured → { isRepo:true, hasUpstream:false, branch }
//   - in sync               → { …, ahead:[], behind:[] }
export interface UpstreamComparisonResponse {
  isRepo: boolean;
  // The current branch (rev-parse --abbrev-ref HEAD), when on a branch.
  branch?: string;
  // The upstream ref (e.g. "origin/main"), when one is configured.
  upstream?: string;
  // True on a detached HEAD — no branch, so no upstream comparison.
  detached?: boolean;
  // False when the branch has no @{u} configured. Present only on a branch.
  hasUpstream?: boolean;
  // Local-only commits (`@{u}..HEAD`) — what a push would send. Newest first.
  ahead?: CompareCommit[];
  // Remote-only commits (`HEAD..@{u}`) — what a pull would bring. Newest first.
  behind?: CompareCommit[];
  // Diffstat for the local-only changes (`git diff --stat @{u}...HEAD`).
  aheadDiffstat?: CompareDiffstat;
  // Diffstat for the remote-only changes (`git diff --stat HEAD...@{u}`).
  behindDiffstat?: CompareDiffstat;
}

// Result of POST /api/git/fetch. `ok:false` (with `error`) for the offline /
// auth-failure case is returned at HTTP 200, not a 500 — fetch failure is a
// non-fatal operator-visible condition, not a server bug.
export interface FetchRemoteResponse {
  ok: boolean;
  // The remote that was fetched (resolved default when the caller omitted it).
  remote: string;
  // True when `git fetch` exited 0 (refs may or may not have moved).
  fetched: boolean;
  // git's stderr on failure (offline, auth, unknown remote), trimmed.
  error?: string;
}
