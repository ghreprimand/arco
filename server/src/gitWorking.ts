// Workbench Expansion I1 — Working-tree changes (the "Source Control" view).
//
// Two read-only operations over a repo's working tree:
//
//   getWorkingChanges(cwd) — parse `git status --porcelain=v2 -z` into
//     {staged, unstaged, untracked} file lists for the grouped Changes view.
//   getFileDiff(cwd, {path, staged}) — a unified diff for one file:
//     `git diff --cached -- <path>` (staged) or `git diff -- <path>`
//     (unstaged), or the new-file content for an untracked file.
//
// Invariants (mirrored from gitDiff.ts): always execFile with an argv array —
// never shell-string interpolation; validate the file path so a `-`-leading
// or metachar path can't smuggle a git flag; always pass `--` so a path is
// never re-interpreted as an option; bounded buffer + timeout; degrade
// gracefully on non-git dirs / binary / large files rather than throwing. This
// module never touches the index/HEAD — it only reads.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// Workbench Expansion I3 — the argv-input validators moved to gitSafe.ts so
// gitOps.ts (real index/ref mutation) and this module (read-only) share ONE
// definition. Re-exported below so existing call sites keep working unchanged.
import { isSafePath, isSafeRemote, isSafeRef } from './gitSafe.js';
import type {
  WorkingChangeEntry,
  WorkingChangesResponse,
  WorkingFileDiffResponse,
  CompareCommit,
  CompareDiffstat,
  UpstreamComparisonResponse,
  FetchRemoteResponse,
} from '@archon/shared';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 15_000;
// `git fetch` is a network op — slower than a local diff, but still bounded so
// an offline / hung remote can't wedge the request forever.
const GIT_FETCH_TIMEOUT_MS = 60_000;
// Match gitDiff.ts: a single file's diff is far smaller than a whole-tree
// diff, but a generated/minified file can still be large; 32 MiB is bounded.
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

async function runGit(
  cwd: string,
  args: string[],
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
      // Binary output would otherwise be lossily decoded; we ask git not to
      // emit binary patches at all (see getFileDiff), so utf8 is safe here.
      encoding: 'utf8',
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    const code = typeof e.code === 'number' ? e.code : 1;
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '', code };
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  if (!cwd) return false;
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return inside.code === 0 && inside.stdout.trim() === 'true';
}

// isSafePath now lives in gitSafe.ts (imported above) — see that file for the
// flag-smuggling / NUL rationale.

// Parse `git status --porcelain=v2 -z`. Records are NUL-separated. Each entry
// begins with a type byte:
//   '1' <XY> ... <path>            — ordinary changed entry
//   '2' <XY> ... <path>\0<origPath> — renamed/copied (origPath in the NEXT
//                                      NUL-delimited token)
//   'u' <XY> ...                   — unmerged (conflict)
//   '?' <path>                     — untracked
//   '!' <path>                     — ignored (we never ask for these)
// XY are the staged (X) and unstaged (Y) status codes. '.' means unchanged on
// that side. See git-status(1) "Porcelain Format Version 2".
function parsePorcelainV2(raw: string): WorkingChangesResponse {
  const staged: WorkingChangeEntry[] = [];
  const unstaged: WorkingChangeEntry[] = [];
  const untracked: WorkingChangeEntry[] = [];

  // Split on NUL but keep walking with an index so a rename's orig-path token
  // (which is a *separate* NUL field) can be consumed in the same step.
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const kind = tok[0];

    if (kind === '?') {
      // "? <path>"
      untracked.push({ path: tok.slice(2), status: '?' });
      continue;
    }
    if (kind === '!') continue; // ignored — not requested, skip defensively.

    if (kind === '1' || kind === '2') {
      // Fields are space-separated; the path is everything after the 8th
      // (kind=1) field. For v2: <kind> <XY> <sub> <mH> <mI> <mW> <hH> <hI> [<X<score>>] <path>
      // We only need XY and the path; for renames the score field sits before
      // the path and origPath is the next NUL token.
      const sp = tok.indexOf(' ', 2);
      const xy = tok.slice(2, sp === -1 ? undefined : sp);
      const x = xy[0];
      const y = xy[1];
      // The path is the last space-delimited field of THIS token.
      const lastSp = tok.lastIndexOf(' ');
      const path = tok.slice(lastSp + 1);
      let origPath: string | undefined;
      if (kind === '2') {
        // Rename/copy: the original path is the immediately following NUL
        // token. Consume it.
        origPath = tokens[i + 1];
        i++;
      }
      if (x && x !== '.') {
        staged.push({ path, status: x, ...(origPath ? { origPath } : {}) });
      }
      if (y && y !== '.') {
        unstaged.push({ path, status: y, ...(origPath ? { origPath } : {}) });
      }
      continue;
    }
    if (kind === 'u') {
      // Unmerged (conflict): surface under unstaged so the operator sees it.
      const lastSp = tok.lastIndexOf(' ');
      const path = tok.slice(lastSp + 1);
      unstaged.push({ path, status: 'U' });
      continue;
    }
    // Unknown record kind — ignore rather than throw.
  }

  return { isRepo: true, staged, unstaged, untracked };
}

export async function getWorkingChanges(cwd: string): Promise<WorkingChangesResponse> {
  const empty: WorkingChangesResponse = { isRepo: false, staged: [], unstaged: [], untracked: [] };
  if (!(await isGitRepo(cwd))) return empty;

  // --porcelain=v2 -z: machine-stable, NUL-delimited, rename-aware.
  // --untracked-files=all so individual untracked files (not just dirs) show.
  const out = await runGit(cwd, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
    // Rename detection is on by default for porcelain v2; '2'-kind entries
    // carry the orig path in the next NUL token (handled in parsePorcelainV2).
    '--renames',
  ]);
  if (out.code !== 0) {
    // A repo we can't status (mid-operation, permissions) — report it as a
    // repo with no listable changes rather than a hard error.
    return { isRepo: true, staged: [], unstaged: [], untracked: [] };
  }
  return parsePorcelainV2(out.stdout);
}

export interface FileDiffArgs {
  path: string;
  // Diff the staged change (index vs HEAD) when true, the unstaged change
  // (working tree vs index) when false.
  staged: boolean;
}

// True when the diff text indicates git treated the file as binary. `git diff`
// prints "Binary files a/x and b/x differ" (we also pass --numstat-free text
// mode, so the GIT_BINARY_PLACEHOLDER never appears). Cheap heuristic; the
// authoritative bound is the maxBuffer ceiling above.
function looksBinary(patch: string): boolean {
  return /^Binary files .* differ$/m.test(patch);
}

export async function getFileDiff(cwd: string, args: FileDiffArgs): Promise<WorkingFileDiffResponse> {
  const path = args.path;
  const staged = !!args.staged;
  const base: WorkingFileDiffResponse = { isRepo: false, patch: '', path, staged };

  if (!(await isGitRepo(cwd))) return base;
  base.isRepo = true;

  if (!isSafePath(path)) {
    // An invalid path is an empty result, not a 500 — mirror the missing-ref
    // graceful path in gitDiff.ts.
    return base;
  }

  // Is the path tracked by git at all? `git ls-files --error-unmatch` exits
  // non-zero for an untracked path. Untracked files have no index entry, so
  // `git diff` shows nothing — we synthesize an all-added diff instead.
  const tracked = await runGit(cwd, ['ls-files', '--error-unmatch', '--', path]);
  const isUntracked = tracked.code !== 0;

  if (isUntracked) {
    // New file with no index entry: diff against the empty/absent side.
    // `git diff --no-index -- /dev/null <path>` is portable (git ships its own
    // /dev/null handling on Windows too), exits 1 when there's a difference
    // (expected), and yields a clean unified `+`-only patch DiffView parses.
    const nd = await runGit(cwd, [
      'diff', '--no-color', '--no-index', '--',
      '/dev/null', path,
    ]);
    // --no-index exits 1 on differences; treat only a >1 code as failure.
    if (nd.code > 1) return base;
    const patch = nd.stdout;
    if (looksBinary(patch)) return { ...base, patch: '', binary: true };
    return { ...base, patch };
  }

  // Tracked file: staged change = index vs HEAD, unstaged = work tree vs index.
  const diffArgs = staged
    ? ['diff', '--no-color', '--cached', '--', path]
    : ['diff', '--no-color', '--', path];
  const diff = await runGit(cwd, diffArgs);
  if (diff.code > 1) return base;
  const patch = diff.stdout;
  if (looksBinary(patch)) return { ...base, patch: '', binary: true };
  return { ...base, patch };
}

// ── Workbench Expansion I2 — local ↔ remote comparison + fetch ──
//
// fetchRemote(cwd, remote) — updates remote-tracking refs only (`git fetch`).
//   Does NOT merge/rebase/move HEAD (that's I3). Bounded by GIT_FETCH_TIMEOUT_MS.
// getUpstreamComparison(cwd) — ahead/behind commit LISTS + per-direction
//   diffstat for the current branch vs its `@{u}` upstream. Read-only.
//
// Both degrade to clean structured results on non-git / detached / no-upstream
// / offline rather than throwing.

// isSafeRemote / isSafeRef now live in gitSafe.ts (imported above) — see that
// file for the flag-smuggling / metachar rationale.

// Resolve the default remote to fetch: the current branch's upstream remote
// (`branch.<name>.remote`), else "origin". Returns null only on a non-git dir.
async function defaultRemote(cwd: string): Promise<string | null> {
  if (!(await isGitRepo(cwd))) return null;
  // `git rev-parse --abbrev-ref @{u}` → "origin/main"; the part before the
  // first '/' is the remote. Falls through to "origin" when no upstream.
  const up = await runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (up.code === 0) {
    const ref = up.stdout.trim();
    const slash = ref.indexOf('/');
    if (slash > 0) {
      const remote = ref.slice(0, slash);
      if (isSafeRemote(remote)) return remote;
    }
  }
  return 'origin';
}

export async function fetchRemote(cwd: string, remote?: string): Promise<FetchRemoteResponse> {
  const resolved = remote && remote.trim() ? remote.trim() : await defaultRemote(cwd);
  if (resolved === null) {
    return { ok: false, remote: remote ?? '', fetched: false, error: 'not a git repository' };
  }
  if (!isSafeRemote(resolved)) {
    return { ok: false, remote: resolved, fetched: false, error: 'invalid remote name' };
  }
  // `--` terminates option parsing so a remote that somehow began with a dash
  // (already rejected above) still couldn't be read as a flag.
  const out = await runGit(cwd, ['fetch', '--', resolved], GIT_FETCH_TIMEOUT_MS);
  if (out.code !== 0) {
    // Offline / auth / unknown-remote — a non-fatal operator-visible condition.
    return { ok: false, remote: resolved, fetched: false, error: (out.stderr || 'git fetch failed').trim() };
  }
  return { ok: true, remote: resolved, fetched: true };
}

// Parse `git log` output emitted with a NUL field sep + record sep so subjects
// containing any character survive intact. Format token: hash, author name,
// author epoch seconds, subject — joined by %x00, records by %x1e.
const LOG_FORMAT = '%h%x00%an%x00%at%x00%s';

function parseCommitLog(raw: string): CompareCommit[] {
  const out: CompareCommit[] = [];
  for (const rec of raw.split('\x1e')) {
    const r = rec.replace(/^\n/, '');
    if (!r) continue;
    const [hash, author, at, subject] = r.split('\x00');
    if (!hash) continue;
    out.push({
      hash,
      author: author ?? '',
      subject: subject ?? '',
      ts: (Number(at) || 0) * 1000,
    });
  }
  return out;
}

async function commitList(cwd: string, range: string): Promise<CompareCommit[]> {
  // range is a single argv token (e.g. "origin/main..HEAD") built from
  // validated ref names — never a shell string.
  const out = await runGit(cwd, ['log', `--pretty=format:${LOG_FORMAT}%x1e`, range]);
  if (out.code !== 0) return [];
  return parseCommitLog(out.stdout);
}

// Parse the trailing summary line of `git diff --shortstat`:
//   " 3 files changed, 12 insertions(+), 4 deletions(-)"
// Any of the three clauses may be absent (e.g. insertions-only).
function parseShortstat(raw: string): CompareDiffstat {
  const num = (re: RegExp): number => {
    const m = raw.match(re);
    return m ? Number(m[1]) || 0 : 0;
  };
  return {
    files: num(/(\d+) files? changed/),
    insertions: num(/(\d+) insertions?\(\+\)/),
    deletions: num(/(\d+) deletions?\(-\)/),
  };
}

async function diffstat(cwd: string, range: string): Promise<CompareDiffstat> {
  const out = await runGit(cwd, ['diff', '--shortstat', range]);
  if (out.code !== 0) return { files: 0, insertions: 0, deletions: 0 };
  return parseShortstat(out.stdout);
}

export async function getUpstreamComparison(cwd: string): Promise<UpstreamComparisonResponse> {
  if (!(await isGitRepo(cwd))) return { isRepo: false };

  // Current branch. On a detached HEAD this prints "HEAD".
  const branchOut = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchOut.code === 0 ? branchOut.stdout.trim() : '';
  if (!branch || branch === 'HEAD') {
    // Detached HEAD — no branch, so no upstream to compare against.
    return { isRepo: true, detached: true };
  }
  if (!isSafeRef(branch)) {
    // A ref name git produced that fails our paranoid guard — treat as
    // no-upstream rather than risk an unsafe range token.
    return { isRepo: true, branch, hasUpstream: false };
  }

  // Upstream ref (e.g. "origin/main"). Non-zero exit = no @{u} configured.
  const upOut = await runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upOut.code !== 0) {
    return { isRepo: true, branch, hasUpstream: false };
  }
  const upstream = upOut.stdout.trim();
  if (!isSafeRef(upstream)) {
    return { isRepo: true, branch, hasUpstream: false };
  }

  // Range tokens built from validated refs. `@{u}..HEAD` = local-only (ahead),
  // `HEAD..@{u}` = remote-only (behind). Use the explicit upstream name rather
  // than `@{u}` so the token stays plain ASCII.
  const aheadRange = `${upstream}..HEAD`;
  const behindRange = `HEAD..${upstream}`;
  // `...` (symmetric) for diffstat: changes since the merge base in each
  // direction, matching what a push (ahead) / pull (behind) would carry.
  const aheadStatRange = `${upstream}...HEAD`;
  const behindStatRange = `HEAD...${upstream}`;

  const [ahead, behind, aheadDiffstat, behindDiffstat] = await Promise.all([
    commitList(cwd, aheadRange),
    commitList(cwd, behindRange),
    diffstat(cwd, aheadStatRange),
    diffstat(cwd, behindStatRange),
  ]);

  return {
    isRepo: true,
    branch,
    upstream,
    hasUpstream: true,
    ahead,
    behind,
    aheadDiffstat,
    behindDiffstat,
  };
}

// Per-direction unified diff for the comparison view, reusing the
// WorkingFileDiffResponse shape so the client renders it through the same A3
// DiffView. direction 'ahead' = local-only changes a push would send
// (`upstream...HEAD`), 'behind' = remote-only changes a pull would bring
// (`HEAD...upstream`). Read-only; degrades like getUpstreamComparison.
export async function getComparisonDiff(
  cwd: string,
  direction: 'ahead' | 'behind',
): Promise<WorkingFileDiffResponse> {
  // staged is meaningless here; echo false so the shape is satisfied.
  const base: WorkingFileDiffResponse = { isRepo: false, patch: '', path: direction, staged: false };
  if (!(await isGitRepo(cwd))) return base;
  base.isRepo = true;

  const cmp = await getUpstreamComparison(cwd);
  if (!cmp.isRepo || cmp.detached || !cmp.hasUpstream || !cmp.upstream) {
    // No upstream / detached → empty patch, not an error.
    return base;
  }
  // upstream already passed isSafeRef in getUpstreamComparison; rebuild the
  // symmetric range token from it. ahead = upstream...HEAD, behind = HEAD...upstream.
  const range = direction === 'ahead'
    ? `${cmp.upstream}...HEAD`
    : `HEAD...${cmp.upstream}`;
  const diff = await runGit(cwd, ['diff', '--no-color', range]);
  if (diff.code > 1) return base;
  const patch = diff.stdout;
  if (looksBinary(patch)) return { ...base, patch: '', binary: true };
  return { ...base, patch };
}
