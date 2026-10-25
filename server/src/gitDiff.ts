// Workbench Expansion A3 — Diff computation.
//
// Produces unified-diff text for the in-app DiffView. Two sources, one
// output shape:
//
//   1. Shadow-ref diffs (A2): `git diff <refA> <refB>` between two
//      `refs/archon/<wfid>/<seq>` checkpoint commits — the per-turn diff is
//      checkpoint N vs N-1.
//   2. Working-tree diffs (pre-commit): `git diff` (optionally vs HEAD) for
//      "what has the agent changed since the last commit".
//
// The route layer (http/diffRoutes.ts) decides which source applies from the
// from/to query params; this module just runs the right git invocation. The
// renderer (client DiffView) is source-agnostic and never imports this.
//
// Invariants (mirrored from gitSnapshots.ts): always execFile with an argv
// array — never shell-string interpolation; validate the workflow id; never
// touch the user's index/HEAD; degrade gracefully on non-git dirs and missing
// refs rather than throwing.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// Workbench Expansion I3 — isSafeRev moved to gitSafe.ts (shared with gitOps.ts);
// re-exported here so existing imports keep resolving.
import { isSafeRev } from './gitSafe.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 15_000;
// Diffs of a multi-file turn can be large; the working tree of a big repo
// even more so. 32 MiB is generous and still bounded.
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

export interface DiffResult {
  // Unified-diff text. Empty string when there is no difference (clean tree /
  // identical refs) — that is a valid, non-error result.
  patch: string;
  // Whether the cwd was a git repo at all. The route surfaces this so the UI
  // can show "not a git working tree" instead of an empty diff.
  isRepo: boolean;
  // Set when a requested ref could not be resolved (e.g. a checkpoint that was
  // pruned). The patch is empty in that case; the UI shows the reason.
  missingRef?: string;
  // Echo of what was compared, for the UI header.
  from: string;
  to: string;
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    const code = typeof e.code === 'number' ? e.code : 1;
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '', code };
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return inside.code === 0 && inside.stdout.trim() === 'true';
}

// isSafeRev now lives in gitSafe.ts (imported above). Refs may be a shadow
// checkpoint ref (refs/archon/<wfid>/<seq>) or an ordinary git revision.

async function refExists(cwd: string, rev: string): Promise<boolean> {
  const out = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return out.code === 0 && out.stdout.trim().length > 0;
}

// Cap on how many untracked files we synthesize a diff for. A pre-commit
// untracked set is normally tiny; this just stops a stray data dir (thousands
// of generated files) from ballooning the patch + git invocations. Hit only in
// pathological cases — the header's DIRTY count still reflects the true total.
const MAX_UNTRACKED_DIFFS = 1000;

// `git diff` (and therefore computeDiff's working-tree case) never shows
// untracked files — they have no index entry. But the GIT popup's DIRTY count
// *does* include them (git.ts counts `?` lines), so a tree whose only changes
// are new files reads as "DIRTY 3 / No changes since HEAD" — contradictory.
// This synthesizes an all-added diff for each untracked file so the preview
// matches the count: exactly the pattern getFileDiff (gitWorking.ts) uses.
async function untrackedAdditions(cwd: string): Promise<string> {
  // --others = untracked, --exclude-standard = honor .gitignore/.git/info/exclude
  // (so we never show ignored junk). -z keeps paths intact (spaces, unicode).
  // ls-files expands untracked directories into their individual files.
  const listed = await runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (listed.code !== 0) return '';
  const paths = listed.stdout.split('\0').filter(Boolean);
  if (paths.length === 0) return '';

  const chunks: string[] = [];
  for (const path of paths.slice(0, MAX_UNTRACKED_DIFFS)) {
    // `git diff --no-index -- /dev/null <path>`: portable (git ships its own
    // /dev/null handling on Windows), exits 1 when there's a difference
    // (expected for a non-empty new file), and emits a clean `+`-only unified
    // patch with a "new file" header. Binary files render as the standard
    // "Binary files … differ" line. `--` keeps a `-`-leading path a path.
    const nd = await runGit(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', path]);
    // --no-index exits 1 on differences; only a >1 code is a real failure.
    if (nd.code > 1) continue;
    if (nd.stdout) chunks.push(nd.stdout);
  }
  return chunks.join('');
}

// Join a tracked-changes patch with synthesized untracked-additions, keeping a
// single newline boundary so DiffView parses both file groups cleanly.
function joinPatches(tracked: string, untracked: string): string {
  if (!untracked) return tracked;
  if (!tracked) return untracked;
  return tracked.endsWith('\n') ? tracked + untracked : tracked + '\n' + untracked;
}

export interface ComputeDiffArgs {
  cwd: string;
  // `from`/`to` semantics:
  //   - both omitted, or to === 'WORKTREE': working tree vs HEAD (pre-commit).
  //   - from set, to set: `git diff <from> <to>` (e.g. two shadow refs).
  //   - from set, to === 'WORKTREE': working tree vs <from>.
  from?: string;
  to?: string;
}

// Sentinel meaning "the live working tree" (not a committed ref). Lets the
// route distinguish pre-commit diffs from ref-vs-ref diffs without a separate
// flag.
export const WORKTREE = 'WORKTREE';

// Compute a unified diff. Never throws for the expected failure modes
// (non-git dir, missing ref); returns a structured DiffResult instead so the
// route can answer 200 with an explanatory body.
export async function computeDiff(args: ComputeDiffArgs): Promise<DiffResult> {
  const { cwd } = args;
  const from = args.from?.trim() || '';
  const to = args.to?.trim() || WORKTREE;

  const base: DiffResult = { patch: '', isRepo: false, from: from || 'HEAD', to };

  if (!cwd) return base;
  if (!(await isGitRepo(cwd))) return base;
  base.isRepo = true;

  // Validate any caller-supplied revs before they reach git's argv.
  for (const rev of [from, to === WORKTREE ? '' : to].filter(Boolean)) {
    if (!isSafeRev(rev)) {
      return { ...base, missingRef: rev };
    }
  }

  // Working-tree comparisons (to === WORKTREE).
  if (to === WORKTREE) {
    const baseRev = from || 'HEAD';
    // On a repo with no commits yet, HEAD doesn't resolve — fall back to an
    // empty-tree diff so a brand-new repo still shows its additions.
    if (baseRev === 'HEAD' && !(await refExists(cwd, 'HEAD'))) {
      // git diff against the empty tree object shows every tracked+staged file
      // as an addition. Untracked files don't appear in `git diff`, so we append
      // synthesized new-file diffs (untrackedAdditions) — on a brand-new repo
      // that's the whole story.
      const empty = await runGit(cwd, ['diff', '--no-color', '4b825dc642cb6eb9a060e54bf8d69288fbee4904']);
      const untracked = await untrackedAdditions(cwd);
      return { ...base, patch: joinPatches(empty.stdout, untracked), from: '(empty)', to };
    }
    if (from && !(await refExists(cwd, from))) {
      return { ...base, missingRef: from };
    }
    // `git diff <rev>` compares the working tree (incl. staged) against <rev>,
    // but omits untracked files — append them as new-file diffs so the preview
    // matches the GIT popup's DIRTY count (which counts untracked too).
    const wt = await runGit(cwd, ['diff', '--no-color', baseRev]);
    const untracked = await untrackedAdditions(cwd);
    return { ...base, patch: joinPatches(wt.stdout, untracked), from: baseRev, to };
  }

  // Ref-vs-ref comparison (two committed revisions, e.g. shadow checkpoints).
  for (const rev of [from, to]) {
    if (!(await refExists(cwd, rev))) {
      return { ...base, missingRef: rev };
    }
  }
  const diff = await runGit(cwd, ['diff', '--no-color', from, to]);
  return { ...base, patch: diff.stdout, from, to };
}
