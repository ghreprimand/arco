// Managed git worktrees + deterministic winner promotion for bake-offs.
//
// Safety boundaries:
//   - every checkout lives below ~/.arco/bakeoffs/<cwd-hash>/worktrees;
//   - removal asserts that managed-root relationship before `--force`;
//   - branches are preserved when worktrees are removed;
//   - source checkout must be clean and still at the recorded base before a
//     winner can merge;
//   - merge conflicts are automatically aborted, restoring the source tree;
//   - no shell strings: all git invocations use execFile argv arrays.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BakeoffAttempt, BakeoffAttemptSpec, BakeoffState } from '@arco/shared';
import { arcoHome } from './arcoHome.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const MAX_PATCH_BYTES = 8 * 1024 * 1024;

export class GitBakeoffError extends Error {
  constructor(
    public kind:
      | 'not-a-repo'
      | 'no-commit'
      | 'dirty-source'
      | 'base-drift'
      | 'attempt-busy'
      | 'nothing-to-promote'
      | 'unsafe-commits'
      | 'merge-conflict'
      | 'bad-path'
      | 'git-failed',
    message: string,
  ) {
    super(message);
    this.name = 'GitBakeoffError';
  }
}

async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

function cwdHash(cwd: string): string {
  return createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

export function bakeoffWorktreesRoot(cwd: string): string {
  return path.join(arcoHome(), 'bakeoffs', cwdHash(cwd), 'worktrees');
}

function attemptPath(cwd: string, bakeoffId: string, attemptId: string): string {
  return path.join(bakeoffWorktreesRoot(cwd), bakeoffId, attemptId);
}

function branchFor(bakeoffId: string, index: number): string {
  return `arco/bakeoff/${bakeoffId.slice(0, 8)}/attempt-${index + 1}`;
}

async function requireCleanRepo(cwd: string): Promise<{ baseRef: string; baseBranch: string | null }> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    throw new GitBakeoffError('not-a-repo', 'Bake-offs require a git repository.');
  }
  const head = await git(cwd, ['rev-parse', '--verify', 'HEAD']);
  if (head.code !== 0 || !head.stdout.trim()) {
    throw new GitBakeoffError('no-commit', 'Bake-offs require at least one commit.');
  }
  const status = await git(cwd, [
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--',
    '.',
    ':(exclude).arco',
    ':(exclude).arco/**',
  ]);
  if (status.code !== 0) throw new GitBakeoffError('git-failed', status.stderr.trim() || 'git status failed');
  if (status.stdout.trim()) {
    throw new GitBakeoffError(
      'dirty-source',
      'The source checkout must be clean before a bake-off so every attempt starts from the same reproducible base.',
    );
  }
  const branch = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return { baseRef: head.stdout.trim(), baseBranch: branch.code === 0 ? branch.stdout.trim() : null };
}

async function isRegisteredWorktree(cwd: string, target: string): Promise<boolean> {
  const out = await git(cwd, ['worktree', 'list', '--porcelain']);
  if (out.code !== 0) return false;
  const wanted = path.resolve(target);
  return out.stdout.split('\n').some((line) =>
    line.startsWith('worktree ') && path.resolve(line.slice('worktree '.length).trim()) === wanted);
}

// Proof used by DD7 before inheriting a source checkout's trust decision.
// A client-supplied config field alone is never enough: the target must be
// both under Arco's managed bake-off root for that source AND registered by
// git as one of the source repo's linked worktrees.
export async function isManagedBakeoffWorktree(sourceCwd: string, targetCwd: string): Promise<boolean> {
  const root = path.resolve(bakeoffWorktreesRoot(sourceCwd));
  const target = path.resolve(targetCwd);
  if (target === root || !target.startsWith(root + path.sep)) return false;
  return isRegisteredWorktree(sourceCwd, target);
}

export async function createBakeoffAttempts(args: {
  cwd: string;
  bakeoffId: string;
  specs: BakeoffAttemptSpec[];
}): Promise<{ baseRef: string; baseBranch: string | null; attempts: BakeoffAttempt[] }> {
  const { baseRef, baseBranch } = await requireCleanRepo(args.cwd);
  const attempts: BakeoffAttempt[] = args.specs.map((spec, index) => {
    const id = createHash('sha256')
      .update(`${args.bakeoffId}:${index}:${spec.provider}:${spec.model}`)
      .digest('hex')
      .slice(0, 12);
    return {
      id,
      index,
      label: `Attempt ${index + 1}`,
      ...spec,
      worktreePath: attemptPath(args.cwd, args.bakeoffId, id),
      branch: branchFor(args.bakeoffId, index),
      status: 'creating',
    };
  });

  await fs.mkdir(path.join(bakeoffWorktreesRoot(args.cwd), args.bakeoffId), { recursive: true });
  const created: BakeoffAttempt[] = [];
  try {
    for (const attempt of attempts) {
      const add = await git(args.cwd, [
        'worktree',
        'add',
        '-b',
        attempt.branch,
        attempt.worktreePath,
        baseRef,
      ]);
      if (add.code !== 0) {
        throw new GitBakeoffError('git-failed', `git worktree add failed: ${add.stderr.trim()}`);
      }
      created.push(attempt);
    }
  } catch (err) {
    for (const attempt of created.reverse()) {
      await git(args.cwd, ['worktree', 'remove', '--force', attempt.worktreePath]).catch(() => undefined);
      await git(args.cwd, ['branch', '-D', '--', attempt.branch]).catch(() => undefined);
    }
    await git(args.cwd, ['worktree', 'prune']).catch(() => undefined);
    throw err;
  }
  return { baseRef, baseBranch, attempts };
}

function assertManagedAttemptPath(cwd: string, target: string): void {
  const root = path.resolve(bakeoffWorktreesRoot(cwd));
  const resolved = path.resolve(target);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new GitBakeoffError('bad-path', `refusing to mutate a path outside the bake-off root: ${resolved}`);
  }
}

export async function removeBakeoffAttempt(cwd: string, attempt: BakeoffAttempt): Promise<void> {
  assertManagedAttemptPath(cwd, attempt.worktreePath);
  if (await isRegisteredWorktree(cwd, attempt.worktreePath)) {
    const removed = await git(cwd, ['worktree', 'remove', '--force', attempt.worktreePath]);
    if (removed.code !== 0) {
      throw new GitBakeoffError('git-failed', removed.stderr.trim() || 'git worktree remove failed');
    }
  }
  await git(cwd, ['worktree', 'prune']).catch(() => undefined);
}

async function untrackedProjectFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (out.code !== 0) return [];
  return out.stdout
    .split('\0')
    .filter(Boolean)
    .filter((file) => file !== '.arco' && !file.startsWith('.arco/'))
    .slice(0, 200);
}

export async function bakeoffAttemptDiff(state: BakeoffState, attempt: BakeoffAttempt): Promise<string> {
  assertManagedAttemptPath(state.sourceCwd, attempt.worktreePath);
  if (!(await isRegisteredWorktree(state.sourceCwd, attempt.worktreePath))) return '';
  const tracked = await git(attempt.worktreePath, [
    'diff',
    '--no-color',
    state.baseRef,
    '--',
    '.',
    ':(exclude).arco',
    ':(exclude).arco/**',
  ]);
  if (tracked.code !== 0) {
    throw new GitBakeoffError('git-failed', tracked.stderr.trim() || 'git diff failed');
  }
  const chunks = [tracked.stdout];
  for (const file of await untrackedProjectFiles(attempt.worktreePath)) {
    const diff = await git(attempt.worktreePath, ['diff', '--no-color', '--no-index', '--', '/dev/null', file]);
    if (diff.code <= 1 && diff.stdout) chunks.push(diff.stdout);
    if (chunks.reduce((sum, part) => sum + Buffer.byteLength(part), 0) > MAX_PATCH_BYTES) break;
  }
  const patch = chunks.join(tracked.stdout && chunks.length > 1 && !tracked.stdout.endsWith('\n') ? '\n' : '');
  return Buffer.byteLength(patch) > MAX_PATCH_BYTES
    ? patch.slice(0, MAX_PATCH_BYTES) + '\n[diff truncated by Arco]\n'
    : patch;
}

export async function promoteBakeoffAttempt(
  state: BakeoffState,
  attempt: BakeoffAttempt,
): Promise<{ mergeCommit: string }> {
  assertManagedAttemptPath(state.sourceCwd, attempt.worktreePath);
  const current = await requireCleanRepo(state.sourceCwd);
  if (current.baseRef !== state.baseRef) {
    throw new GitBakeoffError(
      'base-drift',
      'The source checkout moved after this bake-off started. Review or rebase the attempt manually; Arco will not merge against a different base.',
    );
  }
  if (!(await isRegisteredWorktree(state.sourceCwd, attempt.worktreePath))) {
    throw new GitBakeoffError('bad-path', 'The selected attempt worktree no longer exists.');
  }

  // A provider may ignore the no-commit instruction. Existing candidate
  // commits are acceptable, but never merge Arco's own journals/config back
  // into the source checkout. Inspect before staging so a refusal leaves the
  // candidate branch untouched.
  const committedPaths = await git(attempt.worktreePath, [
    'diff',
    '--name-only',
    '-z',
    state.baseRef,
    attempt.branch,
  ]);
  if (committedPaths.code !== 0) {
    throw new GitBakeoffError('git-failed', committedPaths.stderr.trim() || 'could not inspect candidate commits');
  }
  if (committedPaths.stdout.split('\0').some((file) => file === '.arco' || file.startsWith('.arco/'))) {
    throw new GitBakeoffError(
      'unsafe-commits',
      'The selected branch contains committed .arco metadata. Arco will not merge it; clean the candidate branch manually or choose another attempt.',
    );
  }

  // Agents are explicitly told not to commit. Stage project files only so
  // workflow journals under .arco never enter the winner commit.
  const add = await git(attempt.worktreePath, ['add', '-A']);
  if (add.code !== 0) throw new GitBakeoffError('git-failed', add.stderr.trim() || 'git add failed');
  // `git add -A -- . :(exclude)…` still errors when .arco is ignored
  // because `.` is an explicit pathspec. Stage normally (ignored files stay
  // ignored), then unstage any tracked .arco entries defensively.
  const unstageMetadata = await git(attempt.worktreePath, ['reset', '-q', 'HEAD', '--', '.arco']);
  if (unstageMetadata.code !== 0) {
    throw new GitBakeoffError('git-failed', unstageMetadata.stderr.trim() || 'could not exclude .arco metadata');
  }

  const staged = await git(attempt.worktreePath, ['diff', '--cached', '--quiet']);
  if (staged.code === 1) {
    const subject = `bakeoff: promote ${state.name} (${attempt.label})`.slice(0, 120);
    const commit = await git(attempt.worktreePath, ['commit', '-m', subject]);
    if (commit.code !== 0) {
      throw new GitBakeoffError('git-failed', commit.stderr.trim() || 'git commit failed');
    }
  } else if (staged.code > 1) {
    throw new GitBakeoffError('git-failed', staged.stderr.trim() || 'git diff --cached failed');
  }

  const count = await git(attempt.worktreePath, ['rev-list', '--count', `${state.baseRef}..${attempt.branch}`]);
  if (count.code !== 0 || Number(count.stdout.trim()) < 1) {
    throw new GitBakeoffError('nothing-to-promote', 'The selected attempt has no project changes to merge.');
  }

  const merge = await git(state.sourceCwd, [
    'merge',
    '--no-ff',
    '-m',
    `Merge bake-off winner: ${state.name} (${attempt.label})`.slice(0, 160),
    attempt.branch,
  ]);
  if (merge.code !== 0) {
    await git(state.sourceCwd, ['merge', '--abort']).catch(() => undefined);
    throw new GitBakeoffError(
      'merge-conflict',
      `Winner merge conflicted and was aborted; the source checkout was restored. ${merge.stderr.trim()}`,
    );
  }
  const head = await git(state.sourceCwd, ['rev-parse', 'HEAD']);
  if (head.code !== 0 || !head.stdout.trim()) {
    throw new GitBakeoffError('git-failed', head.stderr.trim() || 'could not resolve merge commit');
  }
  return { mergeCommit: head.stdout.trim() };
}
