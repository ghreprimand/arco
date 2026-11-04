import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, truncate } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { holdsKept, isKept, normalizeKeepPath, readKeep } from './keepStore.js';
import { checkArtifactSizes } from './storageWarnings.js';
import { emptyScratch, StorageActionError } from './storageActions.js';
import { buildWorkerSafetyFooter } from './workers/limits.js';

// P7.4 (docs/STORAGE_PLAN.md): the KEEP file reader, artifact size warnings
// and EMPTY SCRATCH. Kept items are never warned about or deleted; plans are
// never touched.

async function conversation(fn: (cwd: string, dir: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-artifacts-'));
  const dir = path.join(cwd, '.arco', 'workflows', 'conv-1');
  await mkdir(path.join(dir, 'artifacts'), { recursive: true });
  try { await fn(cwd, dir); } finally { await rm(cwd, { recursive: true, force: true }); }
}
async function sized(file: string, bytes: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, ''); await truncate(file, bytes);
}
const keepFile = (dir: string, items: unknown[]) => writeFile(path.join(dir, 'keep.json'), JSON.stringify({ version: 1, items }));

test('KEEP paths stay inside the conversation and cover what is below them', async () => {
  assert.equal(normalizeKeepPath('artifacts\\disk.qcow2'), 'artifacts/disk.qcow2');
  assert.equal(normalizeKeepPath('./artifacts//a/'), 'artifacts/a');
  assert.equal(normalizeKeepPath('.'), '.');
  assert.equal(normalizeKeepPath('../outside'), null);
  assert.equal(normalizeKeepPath('/etc/passwd'), null);
  assert.equal(normalizeKeepPath('C:/x'), null);
  const items = [{ path: 'artifacts/vm', reason: 'operator' as const, at: 1 }];
  assert.equal(isKept(items, 'artifacts/vm/disk.img'), true);
  assert.equal(isKept(items, 'artifacts/vmx'), false);
  assert.equal(holdsKept(items, 'artifacts'), true);
  assert.equal(isKept([{ path: '.', reason: 'operator', at: 1 }], 'scratch/x'), true);
  await conversation(async (_cwd, dir) => {
    assert.deepEqual(await readKeep(dir), { ok: true, items: [] });
    await writeFile(path.join(dir, 'keep.json'), '{ broken');
    assert.deepEqual(await readKeep(dir), { ok: false });
    await keepFile(dir, [{ path: '../x', reason: 'operator', at: 1 }]);
    assert.deepEqual(await readKeep(dir), { ok: false });
    await keepFile(dir, [{ path: 'artifacts/a', reason: 'size-warning', at: 5 }]);
    assert.deepEqual(await readKeep(dir), { ok: true, items: [{ path: 'artifacts/a', reason: 'size-warning', at: 5 }] });
  });
});

test('large artifacts warn once; a kept item never warns; a growing total warns again', async () => {
  process.env.ARCO_ARTIFACT_WARN_FILE_BYTES = '1000';
  process.env.ARCO_ARTIFACT_WARN_CONVERSATION_BYTES = '5000';
  try {
    await conversation(async (_cwd, dir) => {
      await sized(path.join(dir, 'artifacts', 'small.txt'), 10);
      assert.deepEqual(await checkArtifactSizes(dir), []);
      await sized(path.join(dir, 'artifacts', 'vm', 'disk.qcow2'), 1500);
      await sized(path.join(dir, 'artifacts', 'kept.img'), 2000);
      await keepFile(dir, [{ path: 'artifacts/kept.img', reason: 'size-warning', at: 1 }]);
      assert.deepEqual(await checkArtifactSizes(dir), [{ path: 'artifacts/vm/disk.qcow2', bytes: 1500, kind: 'file' }]);
      assert.deepEqual(await checkArtifactSizes(dir), []);
      await sized(path.join(dir, 'artifacts', 'more.bin'), 900);
      await sized(path.join(dir, 'artifacts', 'other.bin'), 900);
      // 1500 + 2000 + 900 + 900 + 10 = 5310: over the conversation threshold.
      const total = await checkArtifactSizes(dir);
      assert.deepEqual(total, [{ path: 'artifacts', bytes: 5310, kind: 'conversation' }]);
      await sized(path.join(dir, 'artifacts', 'again.bin'), 900);
      assert.deepEqual(await checkArtifactSizes(dir), []);
      await sized(path.join(dir, 'artifacts', 'big2.bin'), 4800);
      const grown = await checkArtifactSizes(dir);
      assert.deepEqual(grown.map((i) => i.kind).sort(), ['conversation', 'file']);
    });
  } finally {
    delete process.env.ARCO_ARTIFACT_WARN_FILE_BYTES; delete process.env.ARCO_ARTIFACT_WARN_CONVERSATION_BYTES;
  }
});

test('EMPTY SCRATCH removes only unkept scratch files, never follows links, and records the action', async () => {
  await conversation(async (cwd, dir) => {
    const outside = path.join(cwd, 'outside.txt');
    await writeFile(outside, 'keep me');
    await mkdir(path.join(cwd, '.arco', 'plans'), { recursive: true });
    await writeFile(path.join(cwd, '.arco', 'plans', 'p.md'), '# Plan\n');
    await sized(path.join(dir, 'scratch', 'build', 'out.o'), 100);
    await sized(path.join(dir, 'scratch', 'dl.iso'), 200);
    await sized(path.join(dir, 'scratch', 'keepdir', 'a.bin'), 50);
    await sized(path.join(dir, 'scratch', 'keepdir', 'b.bin'), 60);
    await sized(path.join(dir, 'artifacts', 'report.md'), 5);
    if (process.platform !== 'win32') await symlink(outside, path.join(dir, 'scratch', 'link'));
    await keepFile(dir, [{ path: 'scratch/keepdir/a.bin', reason: 'operator', at: 1 }]);
    await assert.rejects(emptyScratch(cwd, 'conv-1', { busy: true }), (e: unknown) => e instanceof StorageActionError && e.code === 'busy');
    const result = await emptyScratch(cwd, 'conv-1', { busy: false });
    assert.equal(result.removedBytes, 100 + 200 + 60 + (process.platform !== 'win32' ? (outside.length) : 0));
    assert.equal(result.keptItems, 1);
    assert.deepEqual(await readdir(path.join(dir, 'scratch')), ['keepdir']);
    assert.deepEqual(await readdir(path.join(dir, 'scratch', 'keepdir')), ['a.bin']);
    assert.equal(await readFile(outside, 'utf8'), 'keep me');
    assert.ok(existsSync(path.join(dir, 'artifacts', 'report.md')));
    assert.equal(await readFile(path.join(cwd, '.arco', 'plans', 'p.md'), 'utf8'), '# Plan\n');
    const log = (await readFile(path.join(cwd, '.arco', 'storage-actions.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.length, 1); assert.equal(log[0].action, 'empty_scratch'); assert.equal(log[0].workflowId, 'conv-1');
    // An unreadable KEEP list stops the action.
    await writeFile(path.join(dir, 'keep.json'), 'nope');
    await assert.rejects(emptyScratch(cwd, 'conv-1', { busy: false }), (e: unknown) => e instanceof StorageActionError && e.code === 'keep_unreadable');
    assert.deepEqual(await readdir(path.join(dir, 'scratch', 'keepdir')), ['a.bin']);
    await assert.rejects(emptyScratch(cwd, '../x', { busy: false }), (e: unknown) => e instanceof StorageActionError && e.code === 'invalid');
  });
});

test('the agent guidance names the conversation scratch folder', () => {
  const footer = buildWorkerSafetyFooter('/proj', 'conv-1');
  assert.match(footer, new RegExp(`${path.join('/proj', '.arco', 'workflows', 'conv-1', 'scratch').replace(/\\/g, '\\\\')}/`));
  assert.match(footer, /EMPTY SCRATCH/);
  assert.doesNotMatch(buildWorkerSafetyFooter(), /scratch/);
});
