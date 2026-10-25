// Git worktrees per ledger task — ARCHON_OPS_PLAN.md §K5 (absorbed E4).
//
// An OPTIONAL isolated `git worktree` pinned to a task, so parallel work on one
// repo doesn't collide. The worktree lives under a MANAGED path outside the
// user's tree (`~/.archon/worktrees/<cwd-hash>/<taskId>`), checked out on a
// dedicated `archon/task/<taskId>` branch off the current HEAD. The shadow-git
// checkpoint store (gitSnapshots.ts) works inside it unchanged — a linked
// worktree shares the main repo's object store, so checkpoints taken in sibling
// worktrees DEDUPE at the git-object level (the plan's "single shared blob store
// dedupes across worktrees"). See docs/CHECKPOINTS.md + docs/TASK_LEDGER.md.
//
// LOAD-BEARING INVARIANTS (mirrors gitSnapshots.ts):
//   - Worktrees live ONLY under the managed root, NEVER inside the user's tree.
//     `removeTaskWorktree` asserts the path is under the root before any
//     destructive `git worktree remove --force` — we never `rm -rf` a path the
//     operator might own.
//   - Removal NEVER deletes the branch — committed work on it is preserved.
//   - All git calls use execFile argv arrays — never shell:true, never string
//     interpolation into a shell.
//   - This module never touches the user's index/HEAD/staging in the MAIN tree:
//     `git worktree add` operates on the new worktree, not the current checkout.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { TaskWorktree, WorktreeInfo } from '@archon/shared';
import { archonHome } from '../archonHome.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

// Structured error so the WS handler can return a clean message rather than a
// 500/opaque throw. `kind` lets callers branch (e.g. 'not-a-repo' is a normal
// operator condition, not a bug).
export class TaskWorktreeError extends Error {
  constructor(
    public kind: 'not-a-repo' | 'no-commit' | 'git-failed' | 'bad-path',
    message: string,
  ) {
    super(message);
    this.name = 'TaskWorktreeError';
  }
}

async function git(
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

function cwdHash(cwd: string): string {
  return createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

// Managed root for a cwd's task worktrees. Always under ~/.archon — outside the
// user's tree by construction (the removal-safety invariant depends on this).
export function worktreesRoot(cwd: string): string {
  return path.join(archonHome(), 'worktrees', cwdHash(cwd));
}

function worktreePath(cwd: string, taskId: string): string {
  return path.join(worktreesRoot(cwd), taskId);
}

function branchFor(taskId: string): string {
  // Branch names must dodge a few git ref rules; a UUID taskId is already safe.
  return `archon/task/${taskId}`;
}

async function assertGitRepoWithCommit(cwd: string): Promise<string> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    throw new TaskWorktreeError(
      'not-a-repo',
      'Worktrees need a git repository. This project folder is not a git repo.',
    );
  }
  const head = await git(cwd, ['rev-parse', '--verify', 'HEAD']);
  if (head.code !== 0 || !head.stdout.trim()) {
    throw new TaskWorktreeError(
      'no-commit',
      'Worktrees need at least one commit. Make an initial commit first.',
    );
  }
  return head.stdout.trim();
}

// Is `path` already a registered worktree for this repo? (porcelain list).
async function worktreeExists(cwd: string, wtPath: string): Promise<boolean> {
  const out = await git(cwd, ['worktree', 'list', '--porcelain']);
  if (out.code !== 0) return false;
  const want = path.resolve(wtPath);
  for (const line of out.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (path.resolve(line.slice('worktree '.length).trim()) === want) return true;
    }
  }
  return false;
}

// Create (or return the existing) isolated worktree for a task. Idempotent: if
// the managed path is already a live worktree, we resolve its head and return
// the descriptor unchanged rather than erroring.
export async function createTaskWorktree(cwd: string, taskId: string): Promise<TaskWorktree> {
  const baseRef = await assertGitRepoWithCommit(cwd);
  const wtPath = worktreePath(cwd, taskId);
  const branch = branchFor(taskId);

  // Idempotent: already provisioned → return the current descriptor.
  if (await worktreeExists(cwd, wtPath)) {
    return { path: wtPath, branch, baseRef, createdAt: Date.now() };
  }

  await fs.mkdir(worktreesRoot(cwd), { recursive: true });

  // If the branch already exists (e.g. a prior worktree was removed but its
  // branch kept), check it out into the new worktree; otherwise create it off
  // HEAD. Either way the working checkout in the MAIN tree is untouched.
  const branchExists = (await git(cwd, ['rev-parse', '--verify', '--quiet', branch])).code === 0;
  const addArgs = branchExists
    ? ['worktree', 'add', wtPath, branch]
    : ['worktree', 'add', '-b', branch, wtPath, 'HEAD'];

  const add = await git(cwd, addArgs);
  if (add.code !== 0) {
    throw new TaskWorktreeError('git-failed', `git worktree add failed: ${add.stderr.trim()}`);
  }
  return { path: wtPath, branch, baseRef, createdAt: Date.now() };
}

// Tear down a task's worktree. Removes the checkout + prunes the admin entry,
// but LEAVES the branch so committed work survives. No-op-safe: if the path is
// already gone, we still prune so a stale admin entry can't linger.
export async function removeTaskWorktree(cwd: string, taskId: string): Promise<void> {
  const wtPath = worktreePath(cwd, taskId);
  const root = worktreesRoot(cwd);

  // SAFETY: never `remove --force` a path that isn't under our managed root.
  const resolved = path.resolve(wtPath);
  if (resolved !== path.resolve(root) && !resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new TaskWorktreeError('bad-path', `refusing to remove a worktree outside the managed root: ${resolved}`);
  }

  // `git worktree remove --force` handles a dirty worktree; if the dir was
  // deleted out from under git, this errors — we fall through to prune.
  await git(cwd, ['worktree', 'remove', '--force', wtPath]).catch(() => undefined);
  await git(cwd, ['worktree', 'prune']).catch(() => undefined);
}

// List EVERY linked worktree of the repo (porcelain), not just our managed
// ones — a worker may have run `git worktree add` itself. Powers the FilesTab
// worktree picker so the diff views can watch the tree a worker is editing.
// The main tree (first porcelain record) is flagged `isMain`. Returns [] for a
// non-repo; callers distinguish that via a separate isRepo probe if needed.
export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const out = await git(cwd, ['worktree', 'list', '--porcelain']);
  if (out.code !== 0) return [];
  const infos: WorktreeInfo[] = [];
  let cur: WorktreeInfo | null = null;
  const flush = () => { if (cur) { infos.push(cur); cur = null; } };
  for (const line of out.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      cur = { path: line.slice('worktree '.length).trim(), branch: null, head: '', isMain: infos.length === 0 };
    } else if (cur && line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim();
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
    // `detached` / `bare` lines leave branch null — the intended representation.
  }
  flush();
  return infos;
}

// List the managed task worktrees for a cwd (porcelain), filtered to those
// under our root. Used by diagnostics / reconciliation; the ledger task's own
// `worktree` field is the authoritative per-task pointer.
export async function listTaskWorktrees(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['worktree', 'list', '--porcelain']);
  if (out.code !== 0) return [];
  const root = path.resolve(worktreesRoot(cwd));
  const paths: string[] = [];
  for (const line of out.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const p = path.resolve(line.slice('worktree '.length).trim());
    if (p === root || p.startsWith(root + path.sep)) paths.push(p);
  }
  return paths;
}
