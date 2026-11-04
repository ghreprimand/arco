import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLeftRight, surveyOtherWork } from './gitOtherWork.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, stdio: 'pipe' }).toString();

test('parseLeftRight reads behind then ahead', () => {
  assert.deepEqual(parseLeftRight('2\t5\n'), { behind: 2, ahead: 5 });
  assert.equal(parseLeftRight('nope'), null);
});

test('lists other worktrees and branches with ahead, behind and uncommitted counts, never the tab\'s own', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-other-')));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'one');
  git(repo, 'branch', 'side-branch');
  git(repo, 'checkout', '-qb', 'ahead-branch');
  writeFileSync(join(repo, 'b.txt'), 'two\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'two');
  git(repo, 'checkout', '-q', 'main');
  writeFileSync(join(repo, 'c.txt'), 'three\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'three');
  const wt = join(root, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature/x', wt, 'main');
  writeFileSync(join(wt, 'd.txt'), 'dirty\n');

  const res = await surveyOtherWork(repo);
  assert.equal(res.isRepo, true);
  assert.equal(res.defaultBranch, 'main');
  const byBranch = new Map(res.rows.map((r) => [r.branch, r]));
  assert.equal(byBranch.has('main'), false, 'the tab\'s own branch is not listed');
  const feature = byBranch.get('feature/x')!;
  assert.equal(realpathSync.native(feature.worktreePath!), realpathSync.native(wt));
  assert.equal(feature.dirtyCount, 1);
  assert.deepEqual([feature.ahead, feature.behind], [0, 0]);
  const ahead = byBranch.get('ahead-branch')!;
  assert.equal(ahead.worktreePath, null);
  assert.equal(ahead.dirtyCount, null);
  assert.deepEqual([ahead.ahead, ahead.behind], [1, 1]);
  assert.deepEqual([byBranch.get('side-branch')!.ahead, byBranch.get('side-branch')!.behind], [0, 1]);
  assert.equal(res.prStatus, 'unavailable', 'no remote, so pull requests are quietly absent');
  assert.ok(res.rows.every((r) => r.pr === null));

  const fromTree = await surveyOtherWork(wt);
  assert.ok(fromTree.rows.some((r) => r.branch === 'main' && r.isMain), 'from another worktree the main checkout is listed');
  assert.equal(fromTree.rows.some((r) => r.branch === 'feature/x'), false);
  assert.equal((await surveyOtherWork(root)).isRepo, false);
});
