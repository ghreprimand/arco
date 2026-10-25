// Workbench Expansion I3 — Direct local git operations.
//
// HTTP (not WS): POST /api/git/op/<family> performs an operator-clicked git
// action that INTENTIONALLY mutates the real index / working tree / refs —
// stage/unstage, commit, fetch/pull/push, stash, branch/tag create/delete.
//
// ⚠ Contrast with A2 checkpoints (gitSnapshots.ts): checkpoints NEVER touch the
// real index/HEAD (they write shadow refs under refs/arco/). I3 is the
// OPPOSITE — it mutates the operator's real git state. The two code paths are
// kept strictly separate (gitOps.ts never imports gitSnapshots.ts and vice
// versa). Each I3 op is safe under the four-question test: an explicit operator
// click, bounded by deterministic argv with validated inputs, logged to
// events.jsonl (the git_op_result event below), and reversible (git reflog /
// unstage / stash pop / branch recreate).

// Protected-branch detection — extracted from client GitDialog so the server
// push guard and the client confirm dialog share ONE regex. A push that targets
// a protected branch (or ANY force push) requires an explicit confirm:true.
export const PROTECTED_BRANCH_RE = /^(main|master|release\/.*|prod|production)$/i;

export function isProtectedBranch(branch: string | null | undefined): boolean {
  if (!branch) return false;
  return PROTECTED_BRANCH_RE.test(branch);
}

// The op families addressed by /api/git/op/<family>.
export type GitOpFamily =
  | 'stage'
  | 'unstage'
  | 'commit'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'stash'
  | 'branch'
  | 'tag';

// Structured result of any I3 op. Never thrown — expected git failures come
// back as ok:false with stderr, mirroring runGit's contract. The op-specific
// fields (status / stashes / pushed) ride alongside.
export interface GitOpResult {
  ok: boolean;
  // Which op ran (e.g. "stage", "commit", "push"). Echoed for the UI + log.
  op: string;
  // git's stderr (or a friendly validator message) on failure, trimmed.
  stderr?: string;
  // Set (with ok:false) when a push/force was refused for lack of confirm:true.
  // The client then shows a confirm dialog and re-sends with confirm:true.
  needsConfirm?: boolean;
  // Human-readable reason for needsConfirm (e.g. "push to protected branch main").
  reason?: string;
  // Re-read working-tree status after a mutation so the UI refreshes without a
  // second round-trip. Absent for ops that don't change the working tree
  // (fetch, stashList, push) — the client refetches as needed.
  changes?: GitOpChangesSnapshot;
  // stashList returns the parsed stash entries here.
  stashes?: GitStashEntry[];
  // commit returns the new short hash here on success.
  commitHash?: string;
}

// A trimmed working-tree status snapshot (same shape as WorkingChangesResponse
// in checkpoints.ts, re-declared here to avoid a cross-domain import cycle —
// the server fills it from getWorkingChanges).
export interface GitOpChangesSnapshot {
  isRepo: boolean;
  staged: { path: string; status: string; origPath?: string }[];
  unstaged: { path: string; status: string; origPath?: string }[];
  untracked: { path: string; status: string; origPath?: string }[];
}

// One `git stash list` entry. ref is the stash@{N} selector; message is the
// stash subject.
export interface GitStashEntry {
  ref: string;
  message: string;
}

// Server → client. Broadcast after every I3 op (success OR expected failure)
// so Activity/HISTORY render a marker and any open Changes view refreshes.
// Persisted to events.jsonl via the standard broadcastWorkflow path.
export interface GitOpResultMessage {
  type: 'git_op_result';
  workflowId: string;
  // The op family (e.g. "commit").
  op: string;
  ok: boolean;
  // Short human summary for the Activity line (e.g. "staged 2 files",
  // "commit a1b2c3d", "push refused: protected branch").
  summary: string;
  // git's stderr on failure (trimmed), when present.
  stderr?: string;
  // Epoch ms.
  ts: number;
}
