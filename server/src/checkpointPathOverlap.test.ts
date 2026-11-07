import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

test('B08: slash-normalized skipped descendants survive Windows separator semantics', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'arco-snapshot-overlap-'));
  installIsolatedTestHome(root);
  const cap = process.env.ARCO_CHECKPOINT_FILE_CAP_BYTES;
  const separator = path.sep;
  try {
    process.env.ARCO_CHECKPOINT_FILE_CAP_BYTES = '128';
    const cwd = path.join(root, 'project');
    await fs.mkdir(path.join(cwd, 'assets'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'keep.txt'), 'included');
    const skipped = path.join(cwd, 'assets', 'model');
    await fs.writeFile(skipped, Buffer.alloc(256, 7));
    const snapshots = await import('./gitSnapshots.js');
    const workflowId = randomUUID();
    const checkpoint = await snapshots.createCheckpoint({ cwd, workflowId, seq: 1 });
    assert.equal(checkpoint?.skippedLargeFiles, 1);
    await fs.unlink(skipped);
    await fs.mkdir(skipped);
    const descendant = path.join(skipped, 'config.txt');
    await fs.writeFile(descendant, 'retain excluded descendant');
    Object.defineProperty(path, 'sep', { value: '\\', configurable: true });
    assert.ok(await snapshots.revertToCheckpoint({ cwd, workflowId, seq: 1 }));
    assert.equal(await fs.readFile(descendant, 'utf8'), 'retain excluded descendant');
  } finally {
    Object.defineProperty(path, 'sep', { value: separator, configurable: true });
    if (cap === undefined) delete process.env.ARCO_CHECKPOINT_FILE_CAP_BYTES;
    else process.env.ARCO_CHECKPOINT_FILE_CAP_BYTES = cap;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('B08: Windows separator semantics refuse restoring over a currently capped parent', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'arco-snapshot-current-overlap-'));
  installIsolatedTestHome(root);
  const cap = process.env.ARCO_CHECKPOINT_FILE_CAP_BYTES;
  const separator = path.sep;
  try {
    process.env.ARCO_CHECKPOINT_FILE_CAP_BYTES = '128';
    const cwd = path.join(root, 'project');
    const parent = path.join(cwd, 'assets', 'model');
    await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(path.join(parent, 'config.txt'), 'included');
    const snapshots = await import('./gitSnapshots.js');
    const workflowId = randomUUID();
    assert.ok(await snapshots.createCheckpoint({ cwd, workflowId, seq: 1 }));
    await fs.rm(parent, { recursive: true });
    await fs.writeFile(parent, Buffer.alloc(256, 7));
    Object.defineProperty(path, 'sep', { value: '\\', configurable: true });
    const preview = await snapshots.previewCheckpointRevert({ cwd, workflowId, seq: 1 });
    assert.equal(preview.ok, false, 'a current capped parent must block restoration of its old descendant');
    assert.equal((await fs.readFile(parent)).length, 256);
  } finally {
    Object.defineProperty(path, 'sep', { value: separator, configurable: true });
    if (cap === undefined) delete process.env.ARCO_CHECKPOINT_FILE_CAP_BYTES;
    else process.env.ARCO_CHECKPOINT_FILE_CAP_BYTES = cap;
    await fs.rm(root, { recursive: true, force: true });
  }
});
