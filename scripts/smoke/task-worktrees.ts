// ARCHON_OPS_PLAN.md §K5 — git worktrees per ledger task smoke.
//
// Tests the MECHANISM directly (no WS, no server, no LLM): drives
// project/taskWorktree.ts against a temp git repo and asserts the load-bearing
// invariants:
//
//   1. createTaskWorktree spins a worktree under the MANAGED root (outside the
//      user's tree), on an `archon/task/<id>` branch off HEAD; the dir exists,
//      `git worktree list` registers it, the branch exists.
//   2. Idempotent: a second create returns the same path without error.
//   3. The shadow-git checkpoint store works INSIDE the worktree (the plan's
//      "checkpoints/diffs work within it") — createCheckpoint returns a
//      git-backed result whose objects share the main repo's store.
//   4. The MAIN tree is untouched: HEAD, current branch, and `git status` are
//      unchanged after create.
//   5. The ledger projection round-trips the `worktree` field (save → load).
//   6. removeTaskWorktree tears the checkout down + prunes it but KEEPS the
//      branch (committed work preserved).
//   7. Operator-condition errors: not-a-repo and no-commit throw a typed
//      TaskWorktreeError rather than an opaque failure.
//
// Run: npm run smoke:task-worktrees  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import {
  createTaskWorktree,
  removeTaskWorktree,
  listTaskWorktrees,
  worktreesRoot,
  TaskWorktreeError,
} from '../../server/src/project/taskWorktree.js';
import { newTask, applyUpdate, save, load } from '../../server/src/project/taskLedger.js';
import { createCheckpoint } from '../../server/src/gitSnapshots.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function main() {
  const cleanups: string[] = [];
  const wtRoots: string[] = [];

  const repo = mkdtempSync(join(tmpdir(), 'archon-wt-git-'));
  cleanups.push(repo);
  wtRoots.push(worktreesRoot(repo));
  const taskId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const wfid = '11111111-2222-3333-4444-555555555555';

  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@archon.local');
  git(repo, 'config', 'user.name', 'archon-test');
  // Force a deterministic main branch name so the assertion is stable across
  // git defaults (init.defaultBranch may be main or master).
  git(repo, 'checkout', '-q', '-B', 'main');
  writeFileSync(join(repo, 'tracked.txt'), 'original\n');
  git(repo, 'add', 'tracked.txt');
  git(repo, 'commit', '-q', '-m', 'initial');

  const headBefore = git(repo, 'rev-parse', 'HEAD');
  const branchBefore = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  const statusBefore = git(repo, 'status', '--porcelain');

  let wtPath = '';
  const expectedBranch = `archon/task/${taskId}`;

  await step('create: worktree lands under the managed root, on its own branch', async () => {
    const wt = await createTaskWorktree(repo, taskId);
    wtPath = wt.path;
    const root = worktreesRoot(repo);
    assert(wt.path === root || wt.path.startsWith(root + sep), `worktree path should be under ${root}, got ${wt.path}`);
    assertEq(wt.branch, expectedBranch, 'branch should be archon/task/<taskId>');
    assertEq(wt.baseRef, headBefore, 'baseRef should be the HEAD it branched from');
    assert(existsSync(wtPath), `worktree dir should exist at ${wtPath}`);
    assert(existsSync(join(wtPath, 'tracked.txt')), 'worktree should contain the checked-out tree');
    const list = git(repo, 'worktree', 'list', '--porcelain');
    assert(list.includes(wtPath), `git worktree list should register ${wtPath}\n${list}`);
    const branches = git(repo, 'branch', '--list', expectedBranch);
    assert(branches.includes(expectedBranch), `branch ${expectedBranch} should exist`);
  });

  await step('create: idempotent — second call returns the same path', async () => {
    const again = await createTaskWorktree(repo, taskId);
    assertEq(again.path, wtPath, 'second create should return the same worktree path');
    // Still exactly one managed worktree for this cwd.
    const managed = await listTaskWorktrees(repo);
    assertEq(managed.length, 1, 'there should be exactly one managed worktree');
  });

  await step('checkpoint: shadow-git checkpoints work INSIDE the worktree', async () => {
    writeFileSync(join(wtPath, 'work.txt'), 'work in the isolated worktree\n');
    const cp = await createCheckpoint({ cwd: wtPath, workflowId: wfid, seq: 1, label: 'in worktree' });
    assert(cp !== null, 'checkpoint inside a worktree should not be null');
    assertEq(cp!.backend, 'git', 'checkpoint inside a worktree should be git-backed (shared object store)');
  });

  await step('main tree: HEAD / branch / status UNCHANGED after worktree create', async () => {
    assertEq(git(repo, 'rev-parse', 'HEAD'), headBefore, 'main HEAD must be unchanged');
    assertEq(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), branchBefore, 'main branch must be unchanged');
    assertEq(git(repo, 'status', '--porcelain'), statusBefore, 'main tree status must be unchanged');
  });

  await step('ledger: the worktree field round-trips through save → load', async () => {
    const wt = { path: wtPath, branch: expectedBranch, baseRef: headBefore, createdAt: 1 };
    const t = newTask({ title: 'isolate me' });
    const updated = applyUpdate([t], t.id, { worktree: wt });
    assert(updated !== null, 'applyUpdate should find the task');
    assert(updated!.updated.worktree?.path === wtPath, 'applyUpdate should set the worktree field');
    await save(repo, updated!.tasks);
    const loaded = await load(repo);
    const got = loaded.find((x) => x.id === t.id);
    assert(!!got?.worktree, 'loaded task should still carry the worktree field');
    assertEq(got!.worktree!.branch, expectedBranch, 'loaded worktree branch should match');
    // Clearing with null drops the field cleanly.
    const cleared = applyUpdate(updated!.tasks, t.id, { worktree: null });
    assert(cleared!.updated.worktree === undefined, 'worktree:null should clear the field');
  });

  await step('remove: tears down the checkout + prunes, but KEEPS the branch', async () => {
    await removeTaskWorktree(repo, taskId);
    assert(!existsSync(wtPath), 'worktree dir should be gone after remove');
    const managed = await listTaskWorktrees(repo);
    assertEq(managed.length, 0, 'no managed worktrees should remain');
    // The branch survives so committed work isn't lost.
    const branches = git(repo, 'branch', '--list', expectedBranch);
    assert(branches.includes(expectedBranch), `branch ${expectedBranch} should survive removal`);
  });

  await step('error: createTaskWorktree on a non-repo throws not-a-repo', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'archon-wt-plain-'));
    cleanups.push(plain);
    let caught: unknown;
    try { await createTaskWorktree(plain, taskId); } catch (e) { caught = e; }
    assert(caught instanceof TaskWorktreeError, 'should throw TaskWorktreeError');
    assertEq((caught as TaskWorktreeError).kind, 'not-a-repo', 'kind should be not-a-repo');
  });

  await step('error: createTaskWorktree with no commits throws no-commit', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'archon-wt-empty-'));
    cleanups.push(empty);
    wtRoots.push(worktreesRoot(empty));
    git(empty, 'init', '-q');
    let caught: unknown;
    try { await createTaskWorktree(empty, taskId); } catch (e) { caught = e; }
    assert(caught instanceof TaskWorktreeError, 'should throw TaskWorktreeError');
    assertEq((caught as TaskWorktreeError).kind, 'no-commit', 'kind should be no-commit');
  });

  for (const dir of cleanups) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  for (const root of wtRoots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  summary('K5 task worktrees');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
