import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addKeep, keepCovering, readKeep, removeKeep } from './keepStore.js';
import { linkFile } from './testSupport/links.js';

// UNKEEP (removeKeep): removes one mark or all marks, never through a link and
// never over a list it cannot read.
async function conversation(): Promise<{ root: string; dir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'arco-unkeep-'));
  const dir = path.join(root, '.arco', 'workflows', 'wf-unkeep');
  await mkdir(path.join(dir, 'artifacts', 'renders'), { recursive: true });
  await writeFile(path.join(dir, 'artifacts', 'renders', 'a.bin'), 'a');
  await writeFile(path.join(dir, 'artifacts', 'b.txt'), 'b');
  return { root, dir };
}

test('UNKEEP removes exactly one mark, or all of them', async () => {
  const { root, dir } = await conversation();
  try {
    await addKeep(dir, 'artifacts/renders', 'operator');
    await addKeep(dir, 'artifacts/b.txt', 'size-warning');
    await addKeep(dir, '.', 'operator');
    const items = (await readKeep(dir) as { items: Parameters<typeof keepCovering>[0] }).items;
    assert.equal(keepCovering(items, 'artifacts/renders/a.bin'), 'artifacts/renders');
    assert.equal(keepCovering(items, 'artifacts/b.txt'), 'artifacts/b.txt');
    assert.equal(keepCovering(items, 'artifacts/other.txt'), '.');
    assert.deepEqual((await removeKeep(dir, 'artifacts/renders')).map((k) => k.path), ['artifacts/b.txt', '.']);
    // Removing a path that is not marked changes nothing.
    assert.deepEqual((await removeKeep(dir, 'artifacts/renders/a.bin')).map((k) => k.path), ['artifacts/b.txt', '.']);
    assert.deepEqual(await removeKeep(dir, { all: true }), []);
    assert.deepEqual(await readKeep(dir), { ok: true, items: [] });
    // Files are never touched.
    assert.equal(await readFile(path.join(dir, 'artifacts', 'renders', 'a.bin'), 'utf8'), 'a');
    // No KEEP file at all: nothing to remove.
    await rm(path.join(dir, 'keep.json'));
    assert.deepEqual(await removeKeep(dir, { all: true }), []);
    await assert.rejects(removeKeep(dir, '../outside'), /Invalid KEEP path/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('UNKEEP refuses an unreadable list and a linked KEEP file', async (t) => {
  const { root, dir } = await conversation();
  try {
    await writeFile(path.join(dir, 'keep.json'), '{not json');
    await assert.rejects(removeKeep(dir, { all: true }), /cannot be read/);
    assert.equal(await readFile(path.join(dir, 'keep.json'), 'utf8'), '{not json');
    await rm(path.join(dir, 'keep.json'));
    const outside = path.join(root, 'outside.json');
    await writeFile(outside, JSON.stringify({ version: 1, items: [{ path: '.', reason: 'operator', at: 1 }] }));
    if (!(await linkFile(outside, path.join(dir, 'keep.json')))) { t.skip('file links need extra rights on this system'); return; }
    await assert.rejects(removeKeep(dir, { all: true }), /link/);
    assert.match(await readFile(outside, 'utf8'), /"operator"/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
