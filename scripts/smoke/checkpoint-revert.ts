// Workbench Expansion A4 — checkpoint revert smoke.
//
// Tests the revert MECHANISM directly (no LLM turn, no WS): drives
// createCheckpoint + revertToCheckpoint against a temp git repo and asserts the
// load-bearing invariants of a FAITHFUL, SAFE revert:
//
//   1. After reverting to checkpoint #1, file A matches its #1 content.
//   2. File B (created after #1) is GONE — a true revert removes files added
//      later, not just overwrites/adds.
//   3. The caller (handler) takes a safety snapshot first; here we mirror that
//      contract by snapshotting before reverting and asserting a pre-revert ref
//      exists, so the revert is itself undoable.
//   4. The user's HEAD / branch / real index are UNCHANGED by the revert.
//   5. Non-git shadow-store fallback: revert is just as faithful (files added
//      after ARE removed), per-file-capped files are never collateral, and
//      legacy pre-shadow tar checkpoints remain revertible with their
//      documented files-added-after limitation.
//
// Run: npm run smoke:checkpoint-revert  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import { createCheckpoint, revertToCheckpoint, checkpointStoreRoot } from '../../server/src/gitSnapshots.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function main() {
  const cleanups: string[] = [];
  const tarRoots: string[] = [];

  // ── Repo-backed faithful revert ──
  const repo = mkdtempSync(join(tmpdir(), 'archon-revert-git-'));
  cleanups.push(repo);
  const wfid = '22222222-3333-4444-5555-666666666666';

  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@archon.local');
  git(repo, 'config', 'user.name', 'archon-test');
  // Initial commit so HEAD exists and we have a branch to assert unchanged.
  writeFileSync(join(repo, 'A.txt'), 'v1\n');
  git(repo, 'add', 'A.txt');
  git(repo, 'commit', '-q', '-m', 'initial');

  const headBefore = git(repo, 'rev-parse', 'HEAD');
  const branchBefore = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  const indexTreeBefore = git(repo, 'write-tree');

  // Checkpoint #1 captures A=v1 (clean tree).
  await step('git: checkpoint #1 captures A=v1', async () => {
    const cp = await createCheckpoint({ cwd: repo, workflowId: wfid, seq: 1, label: 'before turn 1' });
    assert(cp !== null && cp.backend === 'git', 'checkpoint #1 should be git-backed');
  });

  // Mutate: change A, add a brand-new file B.
  writeFileSync(join(repo, 'A.txt'), 'v2\n');
  writeFileSync(join(repo, 'B.txt'), 'created after checkpoint 1\n');

  // Checkpoint #2 captures the mutated tree (A=v2, B present).
  await step('git: checkpoint #2 captures A=v2 + B', async () => {
    const cp = await createCheckpoint({ cwd: repo, workflowId: wfid, seq: 2, label: 'before turn 2' });
    assert(cp !== null && cp.backend === 'git', 'checkpoint #2 should be git-backed');
    assert(cp!.fileCount >= 2, `checkpoint #2 should hold A + B (>=2), got ${cp!.fileCount}`);
  });

  // Mirror the handler's safety-snapshot-first contract before reverting.
  let safetyRef = '';
  await step('git: safety snapshot taken before revert', async () => {
    const safety = await createCheckpoint({ cwd: repo, workflowId: wfid, seq: 999, label: 'pre-revert test' });
    assert(safety !== null, 'safety snapshot must succeed (revert would otherwise abort)');
    safetyRef = safety!.ref;
    const refs = git(repo, 'show-ref');
    assert(refs.includes(safetyRef), `safety ref ${safetyRef} should exist in show-ref\n${refs}`);
    // The safety snapshot must reflect the CURRENT (pre-revert) state: A=v2, B present.
    assertEq(git(repo, 'show', `${safetyRef}:A.txt`), 'v2', 'safety snapshot should capture A=v2');
    const lsTree = git(repo, 'ls-tree', '-r', '--name-only', safetyRef);
    assert(lsTree.split('\n').includes('B.txt'), 'safety snapshot should include B.txt');
  });

  await step('git: revert to checkpoint #1 succeeds', async () => {
    const res = await revertToCheckpoint({ cwd: repo, workflowId: wfid, seq: 1 });
    assert(res !== null, 'revert should not be null');
    assertEq(res!.backend, 'git', 'revert backend should be git');
    assert(res!.fileCount >= 1, `restored tree should contain A.txt (>=1), got ${res!.fileCount}`);
  });

  await step('git: (a) file A matches its #1 content', async () => {
    assertEq(readFileSync(join(repo, 'A.txt'), 'utf8').trim(), 'v1', 'A.txt should be restored to v1');
  });

  await step('git: (b) file B is GONE (true revert removes files added after)', async () => {
    assert(!existsSync(join(repo, 'B.txt')), 'B.txt must be removed by a faithful revert');
  });

  await step('git: (c) a pre-revert safety ref exists', async () => {
    const refs = git(repo, 'show-ref');
    assert(refs.includes(safetyRef), `safety ref ${safetyRef} should still exist after revert\n${refs}`);
  });

  await step('git: (d) user HEAD / branch / index UNCHANGED by the revert', async () => {
    assertEq(git(repo, 'rev-parse', 'HEAD'), headBefore, 'HEAD must be unchanged');
    assertEq(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), branchBefore, 'branch must be unchanged');
    assertEq(git(repo, 'write-tree'), indexTreeBefore, "user's real index tree must be unchanged");
  });

  await step('git: revert is itself undoable (revert to the safety snapshot)', async () => {
    // Safety snapshot was seq 999; reverting to it restores A=v2 + B.
    const res = await revertToCheckpoint({ cwd: repo, workflowId: wfid, seq: 999 });
    assert(res !== null, 'undo-revert should succeed');
    assertEq(readFileSync(join(repo, 'A.txt'), 'utf8').trim(), 'v2', 'undo-revert should restore A=v2');
    assert(existsSync(join(repo, 'B.txt')), 'undo-revert should bring B.txt back');
  });

  await step('git: reverting to a missing checkpoint returns null (no throw)', async () => {
    const res = await revertToCheckpoint({ cwd: repo, workflowId: wfid, seq: 12345 });
    assert(res === null, 'revert to a pruned/absent checkpoint should return null');
  });

  // ── Non-git shadow-store revert ──
  const plain = mkdtempSync(join(tmpdir(), 'archon-revert-plain-'));
  cleanups.push(plain);
  const plainWfid = '77777777-6666-5555-4444-333333333333';
  tarRoots.push(checkpointStoreRoot(plain));
  // Small per-file cap for the whole section so big.bin is out of scope.
  process.env.ARCHON_CHECKPOINT_FILE_CAP_BYTES = '1024';
  try {
    writeFileSync(join(plain, 'a.txt'), 'alpha-v1\n');
    writeFileSync(join(plain, 'big.bin'), Buffer.alloc(4096, 7)); // over the cap

    await step('shadow: checkpoint #1 (a.txt=alpha-v1; big.bin out of scope)', async () => {
      const cp = await createCheckpoint({ cwd: plain, workflowId: plainWfid, seq: 1 });
      assert(cp !== null && cp!.backend === 'shadow-git', 'should fall back to shadow-git for a non-git dir');
      assertEq(cp!.skippedLargeFiles, 1, 'big.bin should be counted as skipped');
    });

    // Mutate, then revert.
    writeFileSync(join(plain, 'a.txt'), 'alpha-v2\n');
    writeFileSync(join(plain, 'b.txt'), 'new file\n');

    await step('shadow: revert is FAITHFUL (restores content, deletes files added after)', async () => {
      const res = await revertToCheckpoint({ cwd: plain, workflowId: plainWfid, seq: 1 });
      assert(res !== null, 'shadow revert should not be null');
      assertEq(res!.backend, 'git', 'shadow revert reports git semantics');
      assertEq(readFileSync(join(plain, 'a.txt'), 'utf8').trim(), 'alpha-v1', 'a.txt should be restored to alpha-v1');
      // The old tar fallback could not do this — the shadow store can:
      assert(!existsSync(join(plain, 'b.txt')), 'files created after the checkpoint must be removed');
      assert(res!.limitation === undefined, 'faithful shadow revert should carry no limitation');
    });

    await step('shadow: capped files are NEVER collateral — big.bin untouched by revert', async () => {
      assert(existsSync(join(plain, 'big.bin')), 'big.bin must survive the revert');
      assertEq(readFileSync(join(plain, 'big.bin'))[0], 7, 'big.bin content must be untouched');
    });

    await step('shadow: a target-skipped file stays out of scope after it shrinks', async () => {
      writeFileSync(join(plain, 'a.txt'), 'alpha-v2\n');
      writeFileSync(join(plain, 'big.bin'), Buffer.alloc(32, 9)); // now below the cap
      const res = await revertToCheckpoint({ cwd: plain, workflowId: plainWfid, seq: 1 });
      assert(res !== null, 'revert should succeed after a target-skipped file shrinks');
      assertEq(readFileSync(join(plain, 'a.txt'), 'utf8').trim(), 'alpha-v1', 'in-scope content should restore');
      assertEq(readFileSync(join(plain, 'big.bin')).length, 32, 'formerly capped file should not be deleted');
      assertEq(readFileSync(join(plain, 'big.bin'))[0], 9, 'formerly capped file content should stay untouched');
    });

    await step('shadow: revert aborts before overwriting a currently capped path', async () => {
      writeFileSync(join(plain, 'risky.bin'), Buffer.alloc(32, 3));
      const cp = await createCheckpoint({ cwd: plain, workflowId: plainWfid, seq: 2 });
      assert(cp !== null, 'checkpoint with a small risky.bin should succeed');
      writeFileSync(join(plain, 'risky.bin'), Buffer.alloc(4096, 4)); // now above the cap
      const res = await revertToCheckpoint({ cwd: plain, workflowId: plainWfid, seq: 2 });
      assert(res === null, 'revert must abort when its target would overwrite a currently capped file');
      assertEq(readFileSync(join(plain, 'risky.bin')).length, 4096, 'currently capped file must remain intact');
      assertEq(readFileSync(join(plain, 'risky.bin'))[0], 4, 'currently capped bytes must remain untouched');
    });

    await step('legacy tar: pre-shadow checkpoints remain revertible + report the limitation', async () => {
      // Hand-craft a legacy tar in the store, as the pre-2026-08-19 fallback
      // would have written it, at a seq the shadow repo does not hold.
      const legacySrc = mkdtempSync(join(tmpdir(), 'archon-revert-legacy-'));
      cleanups.push(legacySrc);
      writeFileSync(join(legacySrc, 'a.txt'), 'legacy-v0\n');
      execFileSync('tar', ['-cf', join(checkpointStoreRoot(plain), `${plainWfid}.9.tar`), '-C', legacySrc, '.']);

      const res = await revertToCheckpoint({ cwd: plain, workflowId: plainWfid, seq: 9 });
      assert(res !== null, 'legacy tar revert should not be null');
      assertEq(res!.backend, 'tar', 'legacy revert backend should be tar');
      assertEq(readFileSync(join(plain, 'a.txt'), 'utf8').trim(), 'legacy-v0', 'a.txt should be restored from the tar');
      assert(typeof res!.limitation === 'string' && res!.limitation.length > 0,
        'tar revert should document the files-added-after limitation');
    });
  } finally {
    delete process.env.ARCHON_CHECKPOINT_FILE_CAP_BYTES;
  }

  // Cleanup
  for (const dir of cleanups) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  for (const root of tarRoots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  summary('A4 checkpoint revert');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
