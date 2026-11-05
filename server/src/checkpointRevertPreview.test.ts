import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCheckpoint, previewCheckpointRevert, revertToCheckpoint } from './gitSnapshots.js';
import { computeDiff, WORKTREE } from './gitDiff.js';
import type { CheckpointRestoreChanges } from '@arco/shared';

// REVERT TO HERE reports what it changes: the confirm dialog's preview and the
// counts on checkpoint_reverted come from the same comparison, in Git and
// non-Git folders, and VIEW DIFF VS NOW works without Git.

async function withHome<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'arco-revert-preview-'));
  const prior = process.env.ARCO_HOME;
  process.env.ARCO_HOME = join(root, 'home');
  try { return await fn(root); }
  finally {
    if (prior === undefined) delete process.env.ARCO_HOME; else process.env.ARCO_HOME = prior;
    await rm(root, { recursive: true, force: true });
  }
}

const strip = (c: CheckpointRestoreChanges) => ({ ...c, paths: c.paths.length });

for (const kind of ['non-Git', 'Git'] as const) {
  test(`${kind} folder: preview, diff to now and revert agree on what changes`, () => withHome(async (root) => {
    const cwd = join(root, 'project'); await mkdir(cwd);
    if (kind === 'Git') {
      execFileSync('git', ['init', '--quiet'], { cwd });
      await writeFile(join(cwd, '.gitignore'), 'ignored.log\n');
    }
    await writeFile(join(cwd, 'edited.txt'), 'one\n');
    await writeFile(join(cwd, 'deleted.txt'), 'keep me\n');
    await writeFile(join(cwd, 'same.txt'), 'same\n');
    const cp = await createCheckpoint({ cwd, workflowId: 'fixture', seq: 1 });
    assert.ok(cp);

    // Nothing changed yet: the preview says so.
    const idle = await previewCheckpointRevert({ cwd, workflowId: 'fixture', seq: 1 });
    assert.ok(idle.ok);
    assert.deepEqual(strip(idle.changes), { changed: 0, removed: 0, restored: 0, unchanged: cp.fileCount, paths: 0, pathsTruncated: false });

    await writeFile(join(cwd, 'edited.txt'), 'two\n');
    await writeFile(join(cwd, 'created.txt'), 'new\n');
    await rm(join(cwd, 'deleted.txt'));
    if (kind === 'Git') await writeFile(join(cwd, 'ignored.log'), 'ignored files are not part of a restore\n');

    const preview = await previewCheckpointRevert({ cwd, workflowId: 'fixture', seq: 1 });
    assert.ok(preview.ok);
    assert.deepEqual(strip(preview.changes), { changed: 1, removed: 1, restored: 1, unchanged: cp.fileCount - 2, paths: 3, pathsTruncated: false });
    assert.deepEqual(preview.changes.paths.map((p) => `${p.change}:${p.path}`).sort(), ['changed:edited.txt', 'removed:created.txt', 'restored:deleted.txt']);
    // The preview changes nothing, and never the project's own Git index.
    assert.equal(await readFile(join(cwd, 'edited.txt'), 'utf8'), 'two\n');
    if (kind === 'Git') assert.equal(execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8' }), '');

    const diff = await computeDiff({ cwd, from: cp.ref, to: WORKTREE });
    assert.equal(diff.isRepo, true);
    assert.match(diff.patch, /-one/); assert.match(diff.patch, /\+two/); assert.match(diff.patch, /created\.txt/);

    const result = await revertToCheckpoint({ cwd, workflowId: 'fixture', seq: 1 });
    assert.ok(result?.changes);
    assert.deepEqual(result.changes, preview.changes);
    assert.equal(await readFile(join(cwd, 'edited.txt'), 'utf8'), 'one\n');
    assert.equal(await readFile(join(cwd, 'deleted.txt'), 'utf8'), 'keep me\n');
    assert.equal(existsSync(join(cwd, 'created.txt')), false);
    if (kind === 'Git') assert.equal(existsSync(join(cwd, 'ignored.log')), true);

    const after = await previewCheckpointRevert({ cwd, workflowId: 'fixture', seq: 1 });
    assert.ok(after.ok);
    assert.equal(after.changes.changed + after.changes.removed + after.changes.restored, 0);
    assert.equal((await computeDiff({ cwd, from: cp.ref, to: WORKTREE })).patch, '');
  }));
}

test('a checkpoint that is not stored is reported, not compared', () => withHome(async (root) => {
  const cwd = join(root, 'project'); await mkdir(cwd);
  await writeFile(join(cwd, 'a.txt'), 'a\n');
  assert.ok(await createCheckpoint({ cwd, workflowId: 'fixture', seq: 1 }));
  const missing = await previewCheckpointRevert({ cwd, workflowId: 'fixture', seq: 9 });
  assert.equal(missing.ok, false);
  const diff = await computeDiff({ cwd, from: 'refs/arco/fixture/9', to: WORKTREE });
  assert.equal(diff.missingRef, 'refs/arco/fixture/9');
}));
