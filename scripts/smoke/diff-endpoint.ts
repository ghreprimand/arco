// Workbench Expansion A3 — Diff endpoint smoke.
//
// Tests the MECHANISM directly (no WS, no LLM): calls computeDiff against a
// temp git repo and asserts the load-bearing behaviors:
//
//   1. Working-tree-vs-HEAD diff contains a known modification + a new file.
//   2. Ref-vs-ref diff between two shadow checkpoints (created via the A2
//      gitSnapshots store) shows the delta between them.
//   3. A non-git directory degrades gracefully (isRepo:false, empty patch) —
//      no throw, no 500-equivalent.
//   4. A missing/unknown ref degrades gracefully (missingRef set, empty patch).
//   5. A clean tree returns an empty patch (not an error).
//
// Run: npm run smoke:diff-endpoint  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import { computeDiff, WORKTREE } from '../../server/src/gitDiff.js';
import { createCheckpoint } from '../../server/src/gitSnapshots.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function main() {
  const cleanups: string[] = [];

  // ── Repo with a committed base, then a dirty working tree ──
  const repo = mkdtempSync(join(tmpdir(), 'archon-diff-git-'));
  cleanups.push(repo);
  const wfid = '11111111-2222-3333-4444-555555555555';

  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@archon.local');
  git(repo, 'config', 'user.name', 'archon-test');
  writeFileSync(join(repo, 'tracked.txt'), 'line one\nline two\nline three\n');
  git(repo, 'add', 'tracked.txt');
  git(repo, 'commit', '-q', '-m', 'initial');

  // Take checkpoint A (clean tree state == HEAD).
  let refA = '';
  await step('setup: first shadow checkpoint', async () => {
    const cp = await createCheckpoint({ cwd: repo, workflowId: wfid, seq: 1 });
    assert(cp !== null && cp.backend === 'git', 'checkpoint A should be git-backed');
    refA = cp!.ref;
  });

  // Dirty the tree: modify the tracked file + add a new file.
  writeFileSync(join(repo, 'tracked.txt'), 'line one\nLINE TWO MODIFIED\nline three\n');
  writeFileSync(join(repo, 'added.txt'), 'brand new file\n');
  git(repo, 'add', 'added.txt'); // stage so it shows in `git diff HEAD`

  // Take checkpoint B (dirty state).
  let refB = '';
  await step('setup: second shadow checkpoint after edits', async () => {
    const cp = await createCheckpoint({ cwd: repo, workflowId: wfid, seq: 2 });
    assert(cp !== null && cp.backend === 'git', 'checkpoint B should be git-backed');
    refB = cp!.ref;
  });

  await step('working-tree vs HEAD diff contains the modification + new file', async () => {
    const result = await computeDiff({ cwd: repo, to: WORKTREE });
    assert(result.isRepo, 'should detect a git repo');
    assert(!result.missingRef, `should not report a missing ref: ${result.missingRef}`);
    assert(result.patch.includes('tracked.txt'), 'patch should mention the modified file');
    assert(result.patch.includes('LINE TWO MODIFIED'), 'patch should contain the added line');
    assert(result.patch.includes('-line two'), 'patch should contain the removed line');
    assert(result.patch.includes('added.txt'), 'patch should mention the new staged file');
  });

  await step('ref-vs-ref diff between the two checkpoints shows the delta', async () => {
    const result = await computeDiff({ cwd: repo, from: refA, to: refB });
    assert(result.isRepo, 'should detect a git repo');
    assert(!result.missingRef, `should resolve both refs: ${result.missingRef}`);
    assert(result.patch.includes('LINE TWO MODIFIED'), 'ref diff should contain the modified line');
    assert(result.patch.includes('added.txt'), 'ref diff should include the new file');
    assertEq(result.from, refA, 'from echo should be refA');
    assertEq(result.to, refB, 'to echo should be refB');
  });

  await step('missing ref degrades gracefully', async () => {
    const result = await computeDiff({ cwd: repo, from: 'refs/archon/does/not/exist', to: refB });
    assert(result.isRepo, 'should still detect a git repo');
    assertEq(result.patch, '', 'patch should be empty for a missing ref');
    assert(!!result.missingRef, 'missingRef should be set');
  });

  await step('clean tree returns an empty patch (no error)', async () => {
    const clean = mkdtempSync(join(tmpdir(), 'archon-diff-clean-'));
    cleanups.push(clean);
    git(clean, 'init', '-q');
    git(clean, 'config', 'user.email', 'test@archon.local');
    git(clean, 'config', 'user.name', 'archon-test');
    writeFileSync(join(clean, 'f.txt'), 'content\n');
    git(clean, 'add', 'f.txt');
    git(clean, 'commit', '-q', '-m', 'init');
    const result = await computeDiff({ cwd: clean, to: WORKTREE });
    assert(result.isRepo, 'should detect a git repo');
    assertEq(result.patch, '', 'clean tree should produce an empty patch');
    assert(!result.missingRef, 'no missing ref on a clean tree');
  });

  await step('non-git directory degrades gracefully', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'archon-diff-plain-'));
    cleanups.push(plain);
    writeFileSync(join(plain, 'a.txt'), 'alpha\n');
    const result = await computeDiff({ cwd: plain, to: WORKTREE });
    assert(!result.isRepo, 'non-git dir should report isRepo:false');
    assertEq(result.patch, '', 'non-git dir should produce an empty patch');
  });

  for (const dir of cleanups) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  summary('A3 diff-endpoint');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
