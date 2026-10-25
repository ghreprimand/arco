// Workbench Expansion I3 — Direct local git operations (argv-only mutators).
//
// Each function performs an operator-clicked git action that INTENTIONALLY
// mutates the user's real index / working tree / refs: stage/unstage, commit,
// fetch/pull/push, stash save/pop/list, branch & tag create/delete. The route
// layer (http/gitOpRoutes.ts) calls these, broadcasts a git_op_result event
// (events.jsonl), and re-reads status so the UI refreshes.
//
// ⚠ Contrast with A2 checkpoints (server/src/gitSnapshots.ts): checkpoints NEVER
// touch the real index/HEAD — they write shadow refs under refs/archon/. I3 is
// the OPPOSITE — it mutates real git state. The two code paths are kept STRICTLY
// separate: this module never imports gitSnapshots.ts and vice versa. See
// docs/GOTCHAS.md § "A2 checkpoints vs I3 real mutation" and CLAUDE.md's
// four-question test (each op is operator-initiated, deterministic, logged, and
// reversible via reflog / unstage / stash pop / branch recreate).
//
// THE SECURITY CONTRACT (the whole point of the phase):
//   - EVERY git invocation goes through execFile('git', argv, {cwd}) — never a
//     shell string, never string interpolation into a command.
//   - EVERY operator-supplied value that reaches git's argv is validated by the
//     shared validators in gitSafe.ts (isSafePath / isSafeRef / isSafeRemote)
//     BEFORE use. A whole call is rejected if any one value fails.
//   - `--` ALWAYS precedes pathspecs (git add/reset/checkout -- <path>) so a
//     path can never be re-parsed as a flag (defense-in-depth over isSafePath).
//   - A commit message is passed as a SINGLE -m argv token (execFile makes that
//     safe with no shell); its content is NOT validated/rejected (free text)
//     and NO trailer (Co-Authored-By etc.) is ever injected — the operator's
//     message is committed verbatim (per the global no-trailer directive).
//   - A push to a protected branch, and ANY force push, REQUIRE confirm:true
//     from the caller; without it the op returns { ok:false, needsConfirm:true }
//     and git is NOT invoked.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitOpResult, GitStashEntry, GitOpChangesSnapshot } from '@archon/shared';
import { isProtectedBranch } from '@archon/shared';
import { isSafePath, isSafeRef, isSafeRemote } from './gitSafe.js';
import { getWorkingChanges } from './gitWorking.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 15_000;
// Network ops (fetch/pull/push) are slower than a local mutation but still
// bounded so an offline / hung remote can't wedge the request forever.
const GIT_NET_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

// argv-only git runner. Mirrors gitWorking.runGit: never throws for an expected
// git failure (returns { code, stderr }); the caller maps that to ok:false.
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
      encoding: 'utf8',
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    const code = typeof e.code === 'number' ? e.code : 1;
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '', code };
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  if (!cwd) return false;
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return inside.code === 0 && inside.stdout.trim() === 'true';
}

// Re-read the working tree after a mutation, normalised to the snapshot shape
// the GitOpResult carries (so the client refreshes without a second fetch).
async function snapshot(cwd: string): Promise<GitOpChangesSnapshot> {
  const c = await getWorkingChanges(cwd);
  return {
    isRepo: c.isRepo,
    staged: c.staged,
    unstaged: c.unstaged,
    untracked: c.untracked,
  };
}

function fail(op: string, stderr: string): GitOpResult {
  return { ok: false, op, stderr: stderr.trim() || `${op} failed` };
}

// ── Stage / unstage ───────────────────────────────────────────────────────

// Validate a path list up front; reject the WHOLE call if any path fails so a
// single malformed entry can't slip a flag through alongside good paths.
function allPathsSafe(paths: string[]): boolean {
  return paths.length > 0 && paths.every(isSafePath);
}

export async function stageFiles(cwd: string, paths: string[]): Promise<GitOpResult> {
  const op = 'stage';
  if (!allPathsSafe(paths)) return fail(op, 'invalid or empty path list');
  // `git add -- <paths>`: `--` terminates options so a path can't be a flag.
  const out = await runGit(cwd, ['add', '--', ...paths]);
  if (out.code !== 0) return fail(op, out.stderr);
  return { ok: true, op, changes: await snapshot(cwd) };
}

export async function stageAll(cwd: string): Promise<GitOpResult> {
  const op = 'stage';
  // `git add -A`: stage every change (incl. deletions). No operator path here.
  const out = await runGit(cwd, ['add', '-A']);
  if (out.code !== 0) return fail(op, out.stderr);
  return { ok: true, op, changes: await snapshot(cwd) };
}

export async function unstageFiles(cwd: string, paths: string[]): Promise<GitOpResult> {
  const op = 'unstage';
  if (!allPathsSafe(paths)) return fail(op, 'invalid or empty path list');
  // `git reset -q HEAD -- <paths>`: unstage just these paths. `--` before paths.
  const out = await runGit(cwd, ['reset', '-q', 'HEAD', '--', ...paths]);
  if (out.code !== 0) return fail(op, out.stderr);
  return { ok: true, op, changes: await snapshot(cwd) };
}

export async function unstageAll(cwd: string): Promise<GitOpResult> {
  const op = 'unstage';
  // `git reset -q HEAD`: unstage everything. No pathspec, no operator value.
  const out = await runGit(cwd, ['reset', '-q', 'HEAD']);
  if (out.code !== 0) return fail(op, out.stderr);
  return { ok: true, op, changes: await snapshot(cwd) };
}

// ── Commit ──────────────────────────────────────────────────────────────────

export async function commit(
  cwd: string,
  message: string,
  opts: { amend?: boolean } = {},
): Promise<GitOpResult> {
  const op = 'commit';
  // Reject an empty/whitespace message with a friendly error (no shell, but an
  // empty -m yields an unhelpful git error otherwise).
  if (!message || !message.trim()) return fail(op, 'commit message is required');
  // `-m <message>` as ONE argv token: execFile makes this safe with no shell;
  // multi-line is fine as a single token. We inject NO trailer — the operator's
  // message is committed verbatim (global no-Co-Authored-By directive).
  const args = ['commit', '-m', message];
  if (opts.amend) args.push('--amend');
  const out = await runGit(cwd, args);
  if (out.code !== 0) return fail(op, out.stderr);
  // Read back the new short hash for the Activity marker.
  const head = await runGit(cwd, ['rev-parse', '--short', 'HEAD']);
  const commitHash = head.code === 0 ? head.stdout.trim() : undefined;
  return { ok: true, op, ...(commitHash ? { commitHash } : {}), changes: await snapshot(cwd) };
}

// ── Fetch / pull / push ──────────────────────────────────────────────────────

export async function fetch(cwd: string, remote?: string): Promise<GitOpResult> {
  const op = 'fetch';
  const args = ['fetch'];
  if (remote) {
    if (!isSafeRemote(remote)) return fail(op, 'invalid remote name');
    args.push('--', remote);
  }
  const out = await runGit(cwd, args, GIT_NET_TIMEOUT_MS);
  if (out.code !== 0) return fail(op, out.stderr);
  // Fetch updates remote-tracking refs only — no working-tree change to snapshot.
  return { ok: true, op };
}

export async function pull(cwd: string, remote?: string, branch?: string): Promise<GitOpResult> {
  const op = 'pull';
  if (remote && !isSafeRemote(remote)) return fail(op, 'invalid remote name');
  if (branch && !isSafeRef(branch)) return fail(op, 'invalid branch name');
  const args = ['pull'];
  if (remote) {
    args.push(remote);
    // A branch refspec is only meaningful alongside a remote.
    if (branch) args.push(branch);
  }
  const out = await runGit(cwd, args, GIT_NET_TIMEOUT_MS);
  if (out.code !== 0) return fail(op, out.stderr);
  // A pull can change the working tree (fast-forward / merge) — re-read it.
  return { ok: true, op, changes: await snapshot(cwd) };
}

export interface PushOpts {
  remote?: string;
  branch?: string;
  force?: boolean;
  setUpstream?: boolean;
  // Operator's explicit go-ahead for a protected-branch or force push. Without
  // it those pushes are refused (needsConfirm) and git is NOT invoked.
  confirm?: boolean;
}

export async function push(cwd: string, opts: PushOpts = {}): Promise<GitOpResult> {
  const op = 'push';
  const { remote, branch, force, setUpstream, confirm } = opts;
  if (remote && !isSafeRemote(remote)) return fail(op, 'invalid remote name');
  if (branch && !isSafeRef(branch)) return fail(op, 'invalid branch name');

  // Determine the target branch for the protected-branch check: the explicit
  // branch arg, else the current branch.
  let targetBranch = branch ?? '';
  if (!targetBranch) {
    const cur = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (cur.code === 0) targetBranch = cur.stdout.trim();
  }
  const protectedTarget = isProtectedBranch(targetBranch);

  // THE GUARD: a force push OR a push to a protected branch requires an explicit
  // confirm:true. Without it we return needsConfirm and DO NOT invoke git.
  if ((force || protectedTarget) && !confirm) {
    const reason = force
      ? `force push to ${targetBranch || 'current branch'} requires confirmation`
      : `push to protected branch ${targetBranch} requires confirmation`;
    return { ok: false, op, needsConfirm: true, reason };
  }

  const args = ['push'];
  // Force uses --force-with-lease (never bare --force): refuses to clobber a
  // remote that advanced since we last fetched. Only reachable with confirm.
  if (force) args.push('--force-with-lease');
  if (setUpstream) args.push('--set-upstream');
  if (remote) {
    args.push(remote);
    if (branch) args.push(branch);
  }
  const out = await runGit(cwd, args, GIT_NET_TIMEOUT_MS);
  if (out.code !== 0) return fail(op, out.stderr);
  return { ok: true, op };
}

// ── Stash ─────────────────────────────────────────────────────────────────

export async function stashSave(cwd: string, message?: string): Promise<GitOpResult> {
  const op = 'stash';
  const args = ['stash', 'push'];
  // -m <message> as a single argv token (free text, no shell, no validation).
  if (message && message.trim()) args.push('-m', message);
  const out = await runGit(cwd, args);
  if (out.code !== 0) return fail(op, out.stderr);
  return { ok: true, op, changes: await snapshot(cwd) };
}

export async function stashPop(cwd: string, ref?: string): Promise<GitOpResult> {
  const op = 'stash';
  if (ref && !isSafeRef(ref)) return fail(op, 'invalid stash ref');
  const args = ['stash', 'pop'];
  // `stash@{N}` is a ref, not a pathspec — pass it as a plain token after the
  // subcommand (no `--`: it's a ref selector, and isSafeRef already guarded it).
  if (ref) args.push(ref);
  const out = await runGit(cwd, args);
  if (out.code !== 0) return fail(op, out.stderr);
  return { ok: true, op, changes: await snapshot(cwd) };
}

export async function stashList(cwd: string): Promise<GitOpResult> {
  const op = 'stash';
  // Parse `stash@{N}: <message>` lines. --format keeps it stable.
  const out = await runGit(cwd, ['stash', 'list', '--format=%gd%x00%gs']);
  if (out.code !== 0) return fail(op, out.stderr);
  const stashes: GitStashEntry[] = [];
  for (const line of out.stdout.split('\n')) {
    if (!line) continue;
    const [ref, message] = line.split('\0');
    if (!ref) continue;
    stashes.push({ ref, message: message ?? '' });
  }
  return { ok: true, op, stashes };
}

// ── Branch / tag ─────────────────────────────────────────────────────────────

export async function createBranch(
  cwd: string,
  name: string,
  opts: { checkout?: boolean } = {},
): Promise<GitOpResult> {
  const op = 'branch';
  if (!isSafeRef(name)) return fail(op, 'invalid branch name');
  // `git switch -c <name>` checks out the new branch; `git branch -- <name>`
  // just creates it. `git switch -c` does NOT accept a `--` separator (it would
  // be read as the start of a pathspec), so the name rides directly there —
  // isSafeRef already rejects a leading dash. `git branch` does accept `--`,
  // so the non-checkout path uses it for defense-in-depth.
  const args = opts.checkout ? ['switch', '-c', name] : ['branch', '--', name];
  const out = await runGit(cwd, args);
  if (out.code !== 0) return fail(op, out.stderr);
  return { ok: true, op, changes: await snapshot(cwd) };
}

export async function deleteBranch(
  cwd: string,
  name: string,
  opts: { force?: boolean } = {},
): Promise<GitOpResult> {
  const op = 'branch';
  if (!isSafeRef(name)) return fail(op, 'invalid branch name');
  // -d (safe, refuses unmerged) or -D (force). The route makes the destructive
  // intent explicit; isSafeRef + the `--` before the name prevent flag smuggling.
  const args = ['branch', opts.force ? '-D' : '-d', '--', name];
  const out = await runGit(cwd, args);
  if (out.code !== 0) return fail(op, out.stderr);
  return { ok: true, op };
}

export async function createTag(
  cwd: string,
  name: string,
  opts: { message?: string } = {},
): Promise<GitOpResult> {
  const op = 'tag';
  if (!isSafeRef(name)) return fail(op, 'invalid tag name');
  const args = ['tag'];
  // -a -m <msg> makes an annotated tag; the message is a single free-text token.
  if (opts.message && opts.message.trim()) args.push('-a', '-m', opts.message);
  // `--` before the tag name (name is the only non-option positional).
  args.push('--', name);
  const out = await runGit(cwd, args);
  if (out.code !== 0) return fail(op, out.stderr);
  return { ok: true, op };
}

export async function deleteTag(cwd: string, name: string): Promise<GitOpResult> {
  const op = 'tag';
  if (!isSafeRef(name)) return fail(op, 'invalid tag name');
  // `git tag -d -- <name>`: `--` before the name (defense-in-depth over isSafeRef).
  const out = await runGit(cwd, ['tag', '-d', '--', name]);
  if (out.code !== 0) return fail(op, out.stderr);
  return { ok: true, op };
}
