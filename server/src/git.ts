// Git status + branch operations for the GIT composer button. Read path
// (status) is safe by construction; write path (checkout, branch create)
// is bounded — refuses on dirty trees, validates branch names, never
// touches history. The actual commit/push/PR work happens in the agent
// (operator-driven), not here — this module only handles the structural
// decisions the operator makes in the popup before dispatching the prompt.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { getWorkingChanges } from './gitWorking.js';
import { isSafeRef } from './gitSafe.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 8_000;
const GIT_MAX_BUFFER = 1 * 1024 * 1024;

export interface GitBranchSummary {
  name: string;
  hasUpstream: boolean;
  upstream: string | null;       // e.g. "origin/windows-port"
  isCurrent: boolean;
}

export interface GitRemoteSummary {
  name: string;
  url: string;
  isGitHub: boolean;
}

export interface GitStatusFile {
  path: string;
  status: string;
  origPath?: string;
}

export interface GitStatus {
  isRepo: boolean;
  // null when in detached-HEAD state (mid-rebase, on a tag, etc).
  currentBranch: string | null;
  // null when there's no upstream tracking branch configured.
  upstream: string | null;
  ahead: number;
  behind: number;
  // Counts unstaged + untracked working-tree changes. Excludes staged-only.
  dirtyCount: number;
  stagedCount: number;
  // File-level summaries for the composer Git dialog. `toPushFiles` are files
  // changed by local-only commits vs upstream; `dirtyFiles` are unstaged +
  // untracked local files. Arco metadata is not filtered here — the client
  // separates `.arco/` so the operator can see why the repo is technically
  // dirty without mistaking it for project source.
  toPushFiles: GitStatusFile[];
  toPullFiles: GitStatusFile[];
  dirtyFiles: GitStatusFile[];
  stagedFiles: GitStatusFile[];
  branches: GitBranchSummary[];
  remotes: GitRemoteSummary[];
  // Convenience flag for the UI: true if any remote URL points to GitHub
  // (drives whether the OPEN PR action is available).
  hasGitHubRemote: boolean;
  // The default base branch on origin (usually "main" or "master").
  // Used as the default base for new branches and as the PR target.
  // Best-effort: read from `git symbolic-ref refs/remotes/origin/HEAD`,
  // falls back to first of {main, master} that exists locally.
  defaultBranch: string | null;
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
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

function parseNameStatus(raw: string): GitStatusFile[] {
  const out: GitStatusFile[] = [];
  const toks = raw.split('\0');
  for (let i = 0; i < toks.length; i++) {
    const status = toks[i];
    if (!status) continue;
    const code = status[0] ?? '';
    if (code === 'R' || code === 'C') {
      const origPath = toks[++i] ?? '';
      const path = toks[++i] ?? '';
      if (path) out.push({ path, status: code, ...(origPath ? { origPath } : {}) });
      continue;
    }
    const path = toks[++i] ?? '';
    if (path) out.push({ path, status: code || status });
  }
  return out;
}

async function changedFilesForRange(cwd: string, range: string): Promise<GitStatusFile[]> {
  const out = await runGit(cwd, ['diff', '--name-status', '-M', '-z', range]);
  if (out.code !== 0) return [];
  return parseNameStatus(out.stdout);
}

export async function getGitStatus(cwd: string): Promise<GitStatus> {
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return {
      isRepo: false,
      currentBranch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      dirtyCount: 0,
      stagedCount: 0,
      toPushFiles: [],
      toPullFiles: [],
      dirtyFiles: [],
      stagedFiles: [],
      branches: [],
      remotes: [],
      hasGitHubRemote: false,
      defaultBranch: null,
    };
  }

  // Current branch. `--abbrev-ref HEAD` returns "HEAD" when detached;
  // surface that as null so the UI can show "(detached)" instead of a
  // branch the operator didn't pick.
  const head = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headName = head.stdout.trim();
  const currentBranch = headName === 'HEAD' || headName === '' ? null : headName;

  // Upstream tracking branch for the current branch (e.g. origin/main).
  // Errors when there's no upstream — we don't treat that as fatal.
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let toPushFiles: GitStatusFile[] = [];
  let toPullFiles: GitStatusFile[] = [];
  if (currentBranch) {
    const ups = await runGit(cwd, ['rev-parse', '--abbrev-ref', '@{upstream}']);
    if (ups.code === 0) {
      upstream = ups.stdout.trim() || null;
      if (upstream) {
        // Two-sided count: left = upstream, right = HEAD.
        const counts = await runGit(cwd, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]);
        if (counts.code === 0) {
          const [b, a] = counts.stdout.trim().split(/\s+/).map((n) => Number(n) || 0);
          behind = b;
          ahead = a;
        }
        if (isSafeRef(upstream)) {
          [toPushFiles, toPullFiles] = await Promise.all([
            changedFilesForRange(cwd, `${upstream}...HEAD`),
            changedFilesForRange(cwd, `HEAD...${upstream}`),
          ]);
        }
      }
    }
  }

  // Dirty / staged file lists via the same porcelain-v2 parser the Source
  // Control panel uses. Keep dirtyCount's old meaning: unstaged + untracked,
  // excluding staged-only entries.
  const changes = await getWorkingChanges(cwd);
  const stagedFiles = changes.isRepo ? changes.staged : [];
  const dirtyFiles = changes.isRepo ? [...changes.unstaged, ...changes.untracked] : [];
  const stagedCount = stagedFiles.length;
  const dirtyCount = dirtyFiles.length;

  // Local branches with their upstream (if any). One git call, parsed
  // line-by-line. Format: "<name>\t<upstream-or-empty>".
  const branchesOut = await runGit(cwd, [
    'for-each-ref',
    '--format=%(refname:short)\t%(upstream:short)',
    'refs/heads/',
  ]);
  const branches: GitBranchSummary[] = [];
  if (branchesOut.code === 0) {
    for (const line of branchesOut.stdout.split('\n')) {
      if (!line) continue;
      const [name, ups] = line.split('\t');
      if (!name) continue;
      branches.push({
        name,
        hasUpstream: Boolean(ups && ups.trim()),
        upstream: ups && ups.trim() ? ups.trim() : null,
        isCurrent: name === currentBranch,
      });
    }
  }
  // Stable order: current branch first, then alpha. Matches how operators
  // scan a branch list in their head — "where am I, then everything else."
  branches.sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;
    return a.name.localeCompare(b.name);
  });

  // Remotes with URL — used to detect GitHub for the OPEN PR action.
  const remotesOut = await runGit(cwd, ['remote', '-v']);
  const remoteMap = new Map<string, string>();
  if (remotesOut.code === 0) {
    for (const line of remotesOut.stdout.split('\n')) {
      const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (m && m[3] === 'fetch') remoteMap.set(m[1], m[2]);
    }
  }
  const remotes: GitRemoteSummary[] = Array.from(remoteMap.entries()).map(([name, url]) => ({
    name,
    url,
    isGitHub: /github\.com/i.test(url),
  }));
  const hasGitHubRemote = remotes.some((r) => r.isGitHub);

  // Default base branch. Try origin/HEAD symbolic ref first (set by
  // `git clone` and `git remote set-head`). Falls back to the first of
  // main/master that exists locally. May still be null on weird repos.
  let defaultBranch: string | null = null;
  const sym = await runGit(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (sym.code === 0) {
    const out = sym.stdout.trim();
    if (out.startsWith('origin/')) defaultBranch = out.slice('origin/'.length);
  }
  if (!defaultBranch) {
    for (const candidate of ['main', 'master']) {
      if (branches.some((b) => b.name === candidate)) {
        defaultBranch = candidate;
        break;
      }
    }
  }

  return {
    isRepo: true,
    currentBranch,
    upstream,
    ahead,
    behind,
    dirtyCount,
    stagedCount,
    toPushFiles,
    toPullFiles,
    dirtyFiles,
    stagedFiles,
    branches,
    remotes,
    hasGitHubRemote,
    defaultBranch,
  };
}

// ---------------------------------------------------------------------------
// Read-only helpers for the composer's `@`-context-refs (WORKBENCH_EXPANSION
// _PLAN.md §D1). Same execFile-argv-only discipline as everything above — no
// shell strings, no operator text interpolated into a command. Each returns a
// discriminated result so the expander can turn a failure into a readable
// notice instead of throwing into the turn loop.
// ---------------------------------------------------------------------------
export type GitTextResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

// `git diff` (unstaged working-tree changes) or `git diff --cached` (staged).
// Returns the raw diff text; an empty diff is `ok: true` with an empty string
// (the caller renders a "no changes" notice). A non-repo or git error becomes
// `ok: false`.
export async function gitDiff(cwd: string, staged: boolean): Promise<GitTextResult> {
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return { ok: false, error: 'not a git repository' };
  }
  const args = staged ? ['diff', '--cached'] : ['diff'];
  const res = await runGit(cwd, args);
  if (res.code !== 0) {
    return { ok: false, error: res.stderr.trim() || 'git diff failed' };
  }
  return { ok: true, text: res.stdout };
}

// Last N commits as "<short-hash> <subject>" lines, newest first. N is
// validated + capped by the caller (contextRefs.ts), but we defensively clamp
// here too — `n` flows straight into the argv so it must be a bounded integer.
export async function gitLog(cwd: string, n: number): Promise<GitTextResult> {
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, error: 'commit count must be a positive integer' };
  }
  const capped = Math.min(n, 50);
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return { ok: false, error: 'not a git repository' };
  }
  // `--format=%h %s` → short hash + subject. `-n <capped>` bounds the count.
  // `String(capped)` is a pure integer so there's no injection surface, but
  // we pass it as its own argv element regardless (never concatenated).
  const res = await runGit(cwd, ['log', `-n`, String(capped), '--format=%h %s']);
  if (res.code !== 0) {
    return { ok: false, error: res.stderr.trim() || 'git log failed' };
  }
  return { ok: true, text: res.stdout.trimEnd() };
}

// Refuses to switch when the working tree is dirty — moving uncommitted
// changes across branches is a footgun (file shows up "modified" on the
// new branch with no clear context). Operator commits or stashes first.
export interface CheckoutResult {
  ok: boolean;
  error?: string;
}

const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/;

export async function checkoutBranch(
  cwd: string,
  branch: string,
  create?: { fromBranch: string },
): Promise<CheckoutResult> {
  if (!branch || !BRANCH_NAME_RE.test(branch)) {
    return { ok: false, error: 'Invalid branch name. Use letters, numbers, dots, dashes, underscores, slashes.' };
  }
  if (create && !BRANCH_NAME_RE.test(create.fromBranch)) {
    return { ok: false, error: 'Invalid base-branch name.' };
  }

  // Refuse on dirty tree — both for create and switch. The agent can
  // commit changes first via the COMMIT button if needed.
  const porc = await runGit(cwd, ['status', '--porcelain']);
  if (porc.code === 0 && porc.stdout.trim().length > 0) {
    return { ok: false, error: 'Working tree has uncommitted changes. Commit or stash before switching branches.' };
  }

  if (create) {
    // Verify base exists. `git rev-parse --verify` exits 0 if so.
    const baseExists = await runGit(cwd, ['rev-parse', '--verify', `refs/heads/${create.fromBranch}`]);
    if (baseExists.code !== 0) {
      return { ok: false, error: `Base branch "${create.fromBranch}" not found locally.` };
    }
    // Verify new branch doesn't already exist (would silently checkout
    // existing branch otherwise — surprising).
    const exists = await runGit(cwd, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    if (exists.code === 0) {
      return { ok: false, error: `Branch "${branch}" already exists. Pick a different name or check out the existing one.` };
    }
    const result = await runGit(cwd, ['checkout', '-b', branch, create.fromBranch]);
    if (result.code !== 0) {
      return { ok: false, error: result.stderr.trim() || 'git checkout -b failed.' };
    }
    return { ok: true };
  }

  // Plain switch.
  const result = await runGit(cwd, ['checkout', branch]);
  if (result.code !== 0) {
    return { ok: false, error: result.stderr.trim() || 'git checkout failed.' };
  }
  return { ok: true };
}
