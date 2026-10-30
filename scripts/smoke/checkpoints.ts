// Workbench Expansion A2 — Shadow-git checkpoint store smoke.
//
// Tests the MECHANISM directly (no LLM turn, no WS): calls createCheckpoint
// against a temp git repo and asserts the load-bearing invariants:
//
//   1. A new `refs/arco/<wfid>/<seq>` ref exists after a snapshot.
//   2. The user's index / HEAD / `git status --porcelain` are UNCHANGED
//      (the must-not-touch-real-index rule — see docs/GOTCHAS.md).
//   3. The snapshot tree actually captured the dirty working-tree changes
//      (modified tracked file content + the untracked file are both in the
//      commit's tree).
//   4. Non-git fallback: a shadow-git checkpoint lands in the bare repo under
//      ~/.arco/checkpoints/<cwd-hash>/git for a plain (non-repo) directory,
//      the cwd stays non-git, per-file/total size caps are honored, and
//      unchanged files dedupe at the object level across snapshots.
//
// Run: npm run smoke:checkpoints  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import { createCheckpoint, checkpointStoreRoot } from '../../server/src/gitSnapshots.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function main() {
  const cleanups: string[] = [];
  const tarRoots: string[] = [];

  // ── Repo-backed path ──
  const repo = mkdtempSync(join(tmpdir(), 'arco-ckpt-git-'));
  cleanups.push(repo);
  const wfid = '11111111-2222-3333-4444-555555555555';

  // Bootstrap a repo with an initial commit, then dirty the tree.
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@arco.local');
  git(repo, 'config', 'user.name', 'arco-test');
  writeFileSync(join(repo, 'tracked.txt'), 'original content\n');
  git(repo, 'add', 'tracked.txt');
  git(repo, 'commit', '-q', '-m', 'initial');

  // Dirty: modify a tracked file + add an untracked file. Also stage
  // SOMETHING so we can prove the user's index is preserved.
  writeFileSync(join(repo, 'tracked.txt'), 'MODIFIED content\n');
  writeFileSync(join(repo, 'untracked.txt'), 'brand new file\n');
  writeFileSync(join(repo, 'staged.txt'), 'staged content\n');
  git(repo, 'add', 'staged.txt'); // deliberately staged by the user

  // Record the user's pre-snapshot state.
  const headBefore = git(repo, 'rev-parse', 'HEAD');
  const statusBefore = git(repo, 'status', '--porcelain');
  // The user's index tree (write-tree against the REAL index reflects staged.txt).
  const indexTreeBefore = git(repo, 'write-tree');

  let gitRef = '';
  await step('git: createCheckpoint returns a git-backed result', async () => {
    const cp = await createCheckpoint({ cwd: repo, workflowId: wfid, seq: 7, label: 'before turn 7' });
    assert(cp !== null, 'checkpoint should not be null in a git repo');
    assertEq(cp!.backend, 'git', 'backend should be git');
    assert(cp!.ref === `refs/arco/${wfid}/7`, `ref should be refs/arco/<wfid>/7, got ${cp!.ref}`);
    assert(cp!.fileCount >= 3, `fileCount should include tracked+untracked+staged (>=3), got ${cp!.fileCount}`);
    gitRef = cp!.ref;
  });

  await step('git: show-ref lists the new refs/arco ref', async () => {
    const refs = git(repo, 'show-ref');
    assert(refs.includes(gitRef), `show-ref should list ${gitRef}\n${refs}`);
  });

  await step('git: user HEAD / index / status are UNCHANGED', async () => {
    assertEq(git(repo, 'rev-parse', 'HEAD'), headBefore, 'HEAD must be unchanged');
    assertEq(git(repo, 'status', '--porcelain'), statusBefore, 'git status porcelain must be unchanged');
    assertEq(git(repo, 'write-tree'), indexTreeBefore, "user's index tree must be unchanged");
    // Repo capture must not create Arco scratch state inside the worktree.
    assert(!existsSync(join(repo, '.arco')), 'snapshot scratch index must stay outside the worktree');
  });

  await step('git: snapshot tree contains the dirty working-tree content', async () => {
    // The modified tracked file: snapshot must reflect MODIFIED, not original.
    const tracked = git(repo, 'show', `${gitRef}:tracked.txt`);
    assertEq(tracked, 'MODIFIED content', 'snapshot should capture the modified tracked content');
    // The untracked file must be present in the snapshot tree.
    const lsTree = git(repo, 'ls-tree', '-r', '--name-only', gitRef);
    assert(lsTree.split('\n').includes('untracked.txt'), `snapshot tree should include untracked.txt\n${lsTree}`);
    const untracked = git(repo, 'show', `${gitRef}:untracked.txt`);
    assertEq(untracked, 'brand new file', 'snapshot should capture the untracked file content');
  });

  await step('git: snapshot commit is parentless (flat checkpoint series)', async () => {
    const parents = git(repo, 'rev-list', '--parents', '-n', '1', gitRef).split(/\s+/);
    assertEq(parents.length, 1, 'checkpoint commit should have no parent');
  });

  await step('git: simultaneous same-cwd snapshots use independent scratch indexes', async () => {
    const [a, b] = await Promise.all([
      createCheckpoint({ cwd: repo, workflowId: wfid, seq: 8 }),
      createCheckpoint({ cwd: repo, workflowId: wfid, seq: 9 }),
    ]);
    assert(a !== null && b !== null, 'both concurrent repo checkpoints should succeed');
    const refs = git(repo, 'show-ref');
    assert(refs.includes(`refs/arco/${wfid}/8`), 'concurrent ref 8 should exist');
    assert(refs.includes(`refs/arco/${wfid}/9`), 'concurrent ref 9 should exist');
    assert(!existsSync(join(repo, '.arco')), 'concurrent scratch indexes must stay outside the worktree');
  });

  // ── Non-git fallback path ──
  const plain = mkdtempSync(join(tmpdir(), 'arco-ckpt-plain-'));
  cleanups.push(plain);
  const plainWfid = '99999999-8888-7777-6666-555555555555';
  writeFileSync(join(plain, 'a.txt'), 'alpha\n');
  writeFileSync(join(plain, 'b.txt'), 'beta\n');

  const shadowDir = join(checkpointStoreRoot(plain), 'git');
  tarRoots.push(checkpointStoreRoot(plain));

  await step('non-git: createCheckpoint falls back to the shadow-git store', async () => {
    const cp = await createCheckpoint({ cwd: plain, workflowId: plainWfid, seq: 3 });
    assert(cp !== null, 'fallback checkpoint should not be null');
    assertEq(cp!.backend, 'shadow-git', 'backend should be shadow-git for a non-git dir');
    assertEq(cp!.ref, `refs/arco/${plainWfid}/3`, 'shadow ref should use the standard ref format');
    assert(cp!.fileCount >= 2, `fileCount should count a.txt + b.txt (>=2), got ${cp!.fileCount}`);
    // The ref lives in the SHADOW repo; the user's dir stays non-git.
    assert(!existsSync(join(plain, '.git')), 'cwd must stay non-git (no .git created)');
    const refs = execFileSync('git', ['--git-dir', shadowDir, 'show-ref'], { encoding: 'utf8' });
    assert(refs.includes(cp!.ref), `shadow repo should hold ${cp!.ref}\n${refs}`);
    // Snapshot tree contains the file content.
    const a = execFileSync('git', ['--git-dir', shadowDir, 'show', `${cp!.ref}:a.txt`], { encoding: 'utf8' }).trim();
    assertEq(a, 'alpha', 'shadow snapshot should capture a.txt content');
  });

  await step('non-git: files over the per-file cap are SKIPPED (and counted)', async () => {
    process.env.ARCO_CHECKPOINT_FILE_CAP_BYTES = '1024';
    try {
      writeFileSync(join(plain, 'big.bin'), Buffer.alloc(4096));
      const cp = await createCheckpoint({ cwd: plain, workflowId: plainWfid, seq: 4 });
      assert(cp !== null, 'snapshot with an over-cap file should still succeed');
      assertEq(cp!.skippedLargeFiles, 1, 'the over-cap file should be counted as skipped');
      const lsTree = execFileSync('git', ['--git-dir', shadowDir, 'ls-tree', '-r', '--name-only', cp!.ref], { encoding: 'utf8' });
      const names = lsTree.split('\n').filter(Boolean);
      assert(!names.includes('big.bin'), `big.bin must not be in the snapshot tree\n${lsTree}`);
      assert(names.includes('a.txt'), `small files must still be captured\n${lsTree}`);
      assert(
        existsSync(join(checkpointStoreRoot(plain), `${plainWfid}.4.skipped.json`)),
        'shadow snapshot should persist its skipped-path manifest',
      );
    } finally {
      delete process.env.ARCO_CHECKPOINT_FILE_CAP_BYTES;
    }
  });

  await step('non-git: snapshot is SKIPPED entirely over the included-total cap', async () => {
    process.env.ARCO_CHECKPOINT_TOTAL_CAP_BYTES = '1024';
    try {
      const cp = await createCheckpoint({ cwd: plain, workflowId: plainWfid, seq: 5 });
      assert(cp === null, 'over-total-cap snapshot should return null (skipped)');
    } finally {
      delete process.env.ARCO_CHECKPOINT_TOTAL_CAP_BYTES;
    }
  });

  await step('non-git: unchanged files dedupe at the object level across snapshots', async () => {
    // Snapshot #6 differs from #4 only by one small file; the shared blobs are
    // stored once (content-addressed), so both trees resolve a.txt to the SAME
    // object id.
    writeFileSync(join(plain, 'c.txt'), 'gamma\n');
    const cp = await createCheckpoint({ cwd: plain, workflowId: plainWfid, seq: 6 });
    assert(cp !== null, 'snapshot #6 should succeed');
    const objOf = (ref: string): string =>
      execFileSync('git', ['--git-dir', shadowDir, 'rev-parse', `${ref}:a.txt`], { encoding: 'utf8' }).trim();
    assertEq(objOf(`refs/arco/${plainWfid}/3`), objOf(`refs/arco/${plainWfid}/6`),
      'unchanged a.txt should resolve to the same blob in both snapshots');
  });

  await step('non-git: simultaneous snapshots use independent indexes and pathspec files', async () => {
    const [a, b] = await Promise.all([
      createCheckpoint({ cwd: plain, workflowId: plainWfid, seq: 7 }),
      createCheckpoint({ cwd: plain, workflowId: plainWfid, seq: 8 }),
    ]);
    assert(a !== null && b !== null, 'both concurrent shadow checkpoints should succeed');
    const refs = execFileSync('git', ['--git-dir', shadowDir, 'show-ref'], { encoding: 'utf8' });
    assert(refs.includes(`refs/arco/${plainWfid}/7`), 'concurrent shadow ref 7 should exist');
    assert(refs.includes(`refs/arco/${plainWfid}/8`), 'concurrent shadow ref 8 should exist');
    const scratch = readdirSync(shadowDir).filter((name) => name.startsWith('snap-') || name.startsWith('pathspec-'));
    assertEq(scratch.length, 0, `shadow scratch files should be cleaned up, found: ${scratch.join(', ')}`);
  });

  await step('non-git: concurrent first checkpoints initialize one shadow store', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'arco-ckpt-cold-'));
    cleanups.push(fresh);
    tarRoots.push(checkpointStoreRoot(fresh));
    writeFileSync(join(fresh, 'fixture.txt'), 'cold start\n');
    const [first, second] = await Promise.all([
      createCheckpoint({ cwd: fresh, workflowId: plainWfid, seq: 10 }),
      createCheckpoint({ cwd: fresh, workflowId: plainWfid, seq: 11 }),
    ]);
    assert(first !== null && second !== null, 'both first-use checkpoints should succeed');
    const refs = execFileSync('git', ['--git-dir', join(checkpointStoreRoot(fresh), 'git'), 'show-ref'], { encoding: 'utf8' });
    assert(refs.includes(`refs/arco/${plainWfid}/10`), 'first ref should exist');
    assert(refs.includes(`refs/arco/${plainWfid}/11`), 'second ref should exist');
  });

  // Cleanup
  for (const dir of cleanups) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  for (const root of tarRoots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  summary('A2 checkpoints');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
