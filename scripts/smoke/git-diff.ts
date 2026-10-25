// Workbench Expansion I1 — Working-tree changes smoke.
//
// Tests the MECHANISM directly (no WS, no LLM): calls getWorkingChanges +
// getFileDiff against a temp git repo dirtied three ways and asserts:
//
//   1. A staged edit lands in `staged`, an unstaged edit in `unstaged`, and a
//      new file in `untracked` — grouped correctly.
//   2. getFileDiff returns a sensible unified-diff payload for each:
//        - staged edit (git diff --cached) shows the staged change,
//        - unstaged edit (git diff) shows the working-tree change,
//        - untracked file shows an all-added new-file diff.
//   3. A non-git directory degrades gracefully (isRepo:false, empty groups) —
//      no throw, no 500-equivalent.
//
// Run: npm run smoke:git-diff  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import { getWorkingChanges, getFileDiff } from '../../server/src/gitWorking.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function main() {
  const cleanups: string[] = [];

  // ── Repo with a committed base, then dirtied three ways ──
  const repo = mkdtempSync(join(tmpdir(), 'archon-gitworking-'));
  cleanups.push(repo);

  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@archon.local');
  git(repo, 'config', 'user.name', 'archon-test');
  writeFileSync(join(repo, 'staged.txt'), 'staged base line\n');
  writeFileSync(join(repo, 'unstaged.txt'), 'unstaged base line\n');
  git(repo, 'add', 'staged.txt', 'unstaged.txt');
  git(repo, 'commit', '-q', '-m', 'initial');

  // (1) Staged edit: modify staged.txt and `git add` it.
  writeFileSync(join(repo, 'staged.txt'), 'STAGED MODIFIED LINE\n');
  git(repo, 'add', 'staged.txt');
  // (2) Unstaged edit: modify unstaged.txt but DON'T add it.
  writeFileSync(join(repo, 'unstaged.txt'), 'UNSTAGED MODIFIED LINE\n');
  // (3) Untracked file: a brand-new file git isn't tracking.
  writeFileSync(join(repo, 'brand-new.txt'), 'fresh untracked content\n');

  await step('getWorkingChanges groups staged / unstaged / untracked', async () => {
    const result = await getWorkingChanges(repo);
    assert(result.isRepo, 'should detect a git repo');

    const stagedPaths = result.staged.map((f) => f.path);
    const unstagedPaths = result.unstaged.map((f) => f.path);
    const untrackedPaths = result.untracked.map((f) => f.path);

    assert(stagedPaths.includes('staged.txt'), `staged should contain staged.txt (got ${JSON.stringify(stagedPaths)})`);
    assert(unstagedPaths.includes('unstaged.txt'), `unstaged should contain unstaged.txt (got ${JSON.stringify(unstagedPaths)})`);
    assert(untrackedPaths.includes('brand-new.txt'), `untracked should contain brand-new.txt (got ${JSON.stringify(untrackedPaths)})`);

    // Cross-checks: no leakage between groups.
    assert(!stagedPaths.includes('unstaged.txt'), 'unstaged.txt must not appear in staged');
    assert(!unstagedPaths.includes('staged.txt'), 'staged.txt must not appear in unstaged');
    assert(!untrackedPaths.includes('staged.txt'), 'staged.txt must not appear in untracked');

    const untrackedEntry = result.untracked.find((f) => f.path === 'brand-new.txt');
    assertEq(untrackedEntry?.status, '?', 'untracked status code should be "?"');
  });

  await step('getFileDiff (staged) returns the staged change', async () => {
    const d = await getFileDiff(repo, { path: 'staged.txt', staged: true });
    assert(d.isRepo, 'should detect a git repo');
    assert(!d.binary, 'staged.txt is text, not binary');
    assert(d.patch.includes('staged.txt'), 'patch should mention the file');
    assert(d.patch.includes('STAGED MODIFIED LINE'), 'staged patch should contain the staged line');
    assert(d.patch.includes('-staged base line'), 'staged patch should show the removed base line');
  });

  await step('getFileDiff (unstaged) returns the working-tree change', async () => {
    const d = await getFileDiff(repo, { path: 'unstaged.txt', staged: false });
    assert(d.isRepo, 'should detect a git repo');
    assert(!d.binary, 'unstaged.txt is text, not binary');
    assert(d.patch.includes('unstaged.txt'), 'patch should mention the file');
    assert(d.patch.includes('UNSTAGED MODIFIED LINE'), 'unstaged patch should contain the working-tree line');
    assert(d.patch.includes('-unstaged base line'), 'unstaged patch should show the removed base line');
  });

  await step('getFileDiff (untracked) returns an all-added new-file diff', async () => {
    // Untracked has no index entry; staged flag is irrelevant — the module
    // detects it and synthesizes the diff. Pass staged:false as the client does.
    const d = await getFileDiff(repo, { path: 'brand-new.txt', staged: false });
    assert(d.isRepo, 'should detect a git repo');
    assert(!d.binary, 'brand-new.txt is text, not binary');
    assert(d.patch.includes('brand-new.txt'), 'patch should mention the new file');
    assert(d.patch.includes('+fresh untracked content'), 'patch should show the new content as added');
    assert(/new file|---\s*\/dev\/null|--- a\/dev\/null/.test(d.patch), `patch should read as a new file (got: ${d.patch.slice(0, 200)})`);
  });

  await step('getFileDiff rejects a flag-smuggling path gracefully', async () => {
    const d = await getFileDiff(repo, { path: '--output=/tmp/pwned', staged: false });
    assert(d.isRepo, 'should still detect a git repo');
    assertEq(d.patch, '', 'a dash-leading path yields an empty patch, not a flag injection');
  });

  await step('non-git directory degrades gracefully', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'archon-gitworking-plain-'));
    cleanups.push(plain);
    writeFileSync(join(plain, 'a.txt'), 'alpha\n');
    const changes = await getWorkingChanges(plain);
    assertEq(changes.isRepo, false, 'non-git dir should report isRepo:false');
    assertEq(changes.staged.length, 0, 'no staged entries');
    assertEq(changes.unstaged.length, 0, 'no unstaged entries');
    assertEq(changes.untracked.length, 0, 'no untracked entries');
    const diff = await getFileDiff(plain, { path: 'a.txt', staged: false });
    assertEq(diff.isRepo, false, 'getFileDiff on non-git dir reports isRepo:false');
    assertEq(diff.patch, '', 'getFileDiff on non-git dir produces an empty patch');
  });

  for (const dir of cleanups) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  summary('I1 git-diff');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
