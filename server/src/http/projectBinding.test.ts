import test, { after } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const home = mkdtempSync(join(tmpdir(), 'arco-selected-worktree-'));
installIsolatedTestHome(home);
after(() => rmSync(home, { recursive: true, force: true }));
function git(cwd: string, ...args: string[]) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function init(cwd: string) {
  mkdirSync(cwd);
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'ghreprimand');
  git(cwd, 'config', 'user.email', '203024559+ghreprimand@users.noreply.github.com');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(cwd, 'seed.txt'), 'seed');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'Initial fixture');
}
async function request(handler: Function, url: string, body?: unknown) {
  const req = Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), { method: body ? 'POST' : 'GET', url, headers: {} });
  let status = 0, result: any;
  const res = { writeHead(code: number) { status = code; }, end(raw: string) { result = JSON.parse(raw); } };
  assert.equal(await handler(req, res), true);
  return { status, result };
}

test('LA07: selected linked worktree diff, stage and commit use only that tree', async () => {
  const { workflowCwds } = await import('../server/state.js');
  const { tryHandleGitDiffRoutes } = await import('./gitDiffRoutes.js');
  const { tryHandleGitOpRoutes } = await import('./gitOpRoutes.js');
  const a = join(home, 'project-a'), b = join(home, 'selected tree'); init(a);
  git(a, 'worktree', 'add', '-b', 'selected', b);
  const oldHead = git(a, 'rev-parse', 'HEAD');
  writeFileSync(join(a, 'only-a.txt'), 'A'); writeFileSync(join(b, 'only-b.txt'), 'B');
  workflowCwds.set('selected-tree-fixture', a);
  try {
    const response = await request(tryHandleGitDiffRoutes, `/api/git/diff?wfid=selected-tree-fixture&path=${encodeURIComponent(b)}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.result.untracked.map((x: any) => x.path), ['only-b.txt']);
    const staged = await request(tryHandleGitOpRoutes, '/api/git/op/stage', { wfid: 'selected-tree-fixture', path: b, action: 'all' });
    assert.equal(staged.result.ok, true);
    assert.equal(git(a, 'diff', '--cached', '--name-only'), '');
    assert.equal(git(b, 'diff', '--cached', '--name-only'), 'only-b.txt');
    const committed = await request(tryHandleGitOpRoutes, '/api/git/op/commit', { wfid: 'selected-tree-fixture', path: b, message: 'Selected fixture change' });
    assert.equal(committed.result.ok, true);
    assert.equal(git(a, 'rev-parse', 'HEAD'), oldHead);
    assert.notEqual(git(b, 'rev-parse', 'HEAD'), oldHead);
  } finally { workflowCwds.delete('selected-tree-fixture'); }
});

test('LA07: unrelated and stale selections are refused without staging the bound tree', async () => {
  const { workflowCwds } = await import('../server/state.js');
  const { requireProjectBinding } = await import('./projectBinding.js');
  const { tryHandleGitOpRoutes } = await import('./gitOpRoutes.js');
  const a = join(home, 'bound'), other = join(home, 'unrelated'), stale = join(home, 'stale'); init(a); init(other);
  git(a, 'worktree', 'add', '-b', 'stale-branch', stale);
  rmSync(stale, { recursive: true, force: true });
  writeFileSync(join(a, 'keep.txt'), 'keep');
  workflowCwds.set('refuse-tree-fixture', a);
  try {
    for (const target of [other, stale]) {
      const response = await request(tryHandleGitOpRoutes, '/api/git/op/stage', { wfid: 'refuse-tree-fixture', path: target, action: 'all' });
      assert.equal(response.status, 403);
      assert.match(JSON.stringify(response.result), /selected worktree/i);
      assert.equal(git(a, 'diff', '--cached', '--name-only'), '');
      assert.equal(git(other, 'diff', '--cached', '--name-only'), '');
    }
    init(stale); // A directory at an old registered pathname is not the original worktree.
    await assert.rejects(requireProjectBinding(stale, 'refuse-tree-fixture'), /selected worktree/i);
    rmSync(stale, { recursive: true, force: true });
    symlinkSync(realpathSync(a), stale, 'junction');
    await assert.rejects(requireProjectBinding(stale, 'refuse-tree-fixture'), /selected worktree/i);
    assert.equal(await requireProjectBinding(a, 'refuse-tree-fixture'), realpathSync(a));
    assert.equal(await requireProjectBinding(undefined, 'refuse-tree-fixture'), realpathSync(a));
  } finally { workflowCwds.delete('refuse-tree-fixture'); }
});

test('LA07: the registered managed task worktree remains selectable', async () => {
  const { workflowCwds } = await import('../server/state.js');
  const { worktreesRoot } = await import('../project/taskWorktree.js');
  const { requireProjectBinding } = await import('./projectBinding.js');
  const a = join(home, 'managed-owner'); init(a);
  const managedRoot = worktreesRoot(a);
  mkdirSync(managedRoot, { recursive: true });
  const selected = join(managedRoot, 'fixture-task');
  git(a, 'worktree', 'add', '-b', 'managed', selected);
  workflowCwds.set('managed-tree-fixture', a);
  try { assert.equal(await requireProjectBinding(selected, 'managed-tree-fixture'), realpathSync(selected)); }
  finally { workflowCwds.delete('managed-tree-fixture'); }
});

for (const useGit of [false, true]) test(`LA14: search scopes folders in ${useGit ? 'Git' : 'non-Git'} projects`, async () => {
  const { workflowCwds } = await import('../server/state.js');
  const { tryHandleSearchRoutes } = await import('./searchRoutes.js');
  const { tryHandleGitDiffRoutes } = await import('./gitDiffRoutes.js');
  const root = join(home, `search-${useGit}`), outside = join(home, `outside-${useGit}`);
  if (useGit) init(root); else mkdirSync(root);
  mkdirSync(outside);
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'root.txt'), 'scopefixture');
  writeFileSync(join(root, 'nested', 'match.txt'), 'scopefixture');
  writeFileSync(join(outside, 'private.txt'), 'scopefixture');
  symlinkSync(realpathSync(outside), join(root, 'escape'), 'junction');
  symlinkSync(realpathSync(join(root, 'nested')), join(root, 'inside'), 'junction');
  const id = `search-scope-${useGit}`;
  workflowCwds.set(id, root);
  const search = (scope: string) => request(tryHandleSearchRoutes, `/api/search/content?wfid=${id}&q=scopefixture&path=${encodeURIComponent(scope)}`);
  try {
    for (const scope of [join(root, 'nested'), join(root, 'inside')]) {
      const response = await search(scope);
      assert.equal(response.status, 200);
      assert.equal(response.result.available, true);
      assert.deepEqual(response.result.hits.map((hit: any) => hit.file), ['match.txt']);
    }
    for (const scope of [outside, join(root, 'escape')]) assert.equal((await search(scope)).status, 403);
    if (useGit) {
      assert.equal((await request(tryHandleGitDiffRoutes, `/api/git/diff?wfid=${id}&path=${encodeURIComponent(join(root, 'nested'))}`)).status, 403);
      const tree = join(home, 'search-linked');
      git(root, 'worktree', 'add', '-b', 'search-linked', tree);
      mkdirSync(join(tree, 'nested'));
      writeFileSync(join(tree, 'nested', 'linked.txt'), 'scopefixture');
      const response = await search(join(tree, 'nested'));
      assert.equal(response.status, 200);
      assert.deepEqual(response.result.hits.map((hit: any) => hit.file), ['linked.txt']);
      symlinkSync(realpathSync(outside), join(tree, 'escape'), 'junction');
      assert.equal((await search(join(tree, 'escape'))).status, 403);
      symlinkSync(realpathSync(root), join(tree, 'other-tree'), 'junction');
      assert.equal((await search(join(tree, 'other-tree', 'nested'))).status, 403);
      assert.equal((await search(join(root, '.git'))).status, 403);
    }
  } finally { workflowCwds.delete(id); }
});

// Emulate Windows' JS realpath retaining an 8.3 parent spelling while Git and
// the native resolver return its expanded spelling. The alias is a real folder
// link on POSIX, so the same registration and common-directory checks run.
test('LA07: short parent spelling admits only the registered worktree, not a replaced leaf', async t => {
  const { workflowCwds } = await import('../server/state.js');
  const { requireProjectBinding } = await import('./projectBinding.js');
  const parent = join(home, 'expanded-parent'), alias = join(home, 'short-parent');
  mkdirSync(parent);
  const a = join(parent, 'owner'), b = join(parent, 'linked'); init(a);
  git(a, 'worktree', 'add', '-b', 'alias-linked', b);
  symlinkSync(realpathSync(parent), alias, 'junction');
  const original = fs.realpathSync;
  const expanded = original(parent);
  const retainingAlias = Object.assign((target: any, ...args: any[]) => {
    const result = Reflect.apply(original, fs, [target, ...args]);
    return typeof result === 'string' && String(target).startsWith(alias + sep)
      ? alias + result.slice(expanded.length) : target === alias ? alias : result;
  }, { native: original.native });
  t.mock.method(fs, 'realpathSync', retainingAlias as typeof original);
  syncBuiltinESMExports();
  workflowCwds.set('short-parent-fixture', a);
  try {
    const selected = join(alias, 'linked');
    assert.equal(await requireProjectBinding(selected, 'short-parent-fixture'), selected);
    rmSync(b, { recursive: true, force: true });
    symlinkSync(a, b, 'junction');
    await assert.rejects(requireProjectBinding(selected, 'short-parent-fixture'), /selected worktree/i);
  } finally {
    workflowCwds.delete('short-parent-fixture');
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});
