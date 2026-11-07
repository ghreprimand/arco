import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCloudSnapshots, readCloudSnapshot, saveCloudSnapshot, deleteCloudSnapshot } from './clusterVault.js';

test('failed metadata publication preserves the previous cloud snapshot', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'arco-vault-test-'));
  const previous = process.env.ARCO_CLUSTER_VAULT_DIR;
  process.env.ARCO_CLUSTER_VAULT_DIR = root;
  const originalRename = fs.rename;
  const oldBlob = Buffer.alloc(32, 1);
  const newBlob = Buffer.alloc(32, 2);
  const input = (blob: Buffer) => ({ name: 'fixture', createdAt: '2026-01-01', memberCount: 2, sourceDevice: 'fixture', sourcePlatform: 'fixture', bytes: blob.length, sha256: createHash('sha256').update(blob).digest('hex') });
  try {
    const old = await saveCloudSnapshot(input(oldBlob), oldBlob);
    fs.rename = async (from, to) => {
      if (String(to).endsWith('.json')) throw Object.assign(new Error('fixture publication failure'), { code: 'EIO' });
      return originalRename(from, to);
    };
    await assert.rejects(saveCloudSnapshot(input(newBlob), newBlob, old.id), /fixture publication failure/);
    fs.rename = originalRename;
    assert.deepEqual(await readCloudSnapshot(old.id), oldBlob);
    assert.equal((await listCloudSnapshots())[0].sha256, input(oldBlob).sha256);
  } finally {
    fs.rename = originalRename;
    if (previous === undefined) delete process.env.ARCO_CLUSTER_VAULT_DIR; else process.env.ARCO_CLUSTER_VAULT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

const metadata = (blob: Buffer, name = 'fixture') => ({ name, createdAt: '2026-01-01', memberCount: 2, sourceDevice: 'fixture', sourcePlatform: 'fixture', bytes: blob.length, sha256: createHash('sha256').update(blob).digest('hex') });
async function vault(fn: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(join(tmpdir(), 'arco-vault-compat-')), prior = process.env.ARCO_CLUSTER_VAULT_DIR;
  process.env.ARCO_CLUSTER_VAULT_DIR = root;
  try { await fn(root); } finally {
    if (prior === undefined) delete process.env.ARCO_CLUSTER_VAULT_DIR; else process.env.ARCO_CLUSTER_VAULT_DIR = prior;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('B193: legacy blob/metadata pairs remain readable and replacement is recoverable', async (t) => {
  await vault(async (root) => {
    const id = 'legacy-fixture', old = Buffer.alloc(64, 1), next = Buffer.alloc(64, 2);
    const row = { ...metadata(old), id, uploadedAt: '2026-01-01' };
    await fs.writeFile(join(root, `${id}.bin`), old);
    await fs.writeFile(join(root, `${id}.json`), JSON.stringify(row));
    assert.deepEqual(await readCloudSnapshot(id), old);
    const original = fs.rename;
    const fault = t.mock.method(fs, 'rename', async (...args: any[]) => {
      if (String(args[1]).endsWith('.json')) throw Object.assign(new Error('fixture metadata failure'), { code: 'EIO' });
      return Reflect.apply(original, fs, args);
    });
    await assert.rejects(saveCloudSnapshot(metadata(next), next, id), /fixture metadata failure/);
    assert.deepEqual(await readCloudSnapshot(id), old);
    assert.deepEqual(JSON.parse(await fs.readFile(join(root, `${id}.json`), 'utf8')), row);
    fault.mock.restore();
    await saveCloudSnapshot(metadata(next), next, id);
    assert.deepEqual(await readCloudSnapshot(id), next);
    assert.equal(await deleteCloudSnapshot(id), true);
    assert.deepEqual(await fs.readdir(root), []);
  });
});

test('B193: simultaneous same-name creates cannot publish two snapshots', async () => {
  await vault(async () => {
    const blobs = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
    const results = await Promise.allSettled(blobs.map((blob) => saveCloudSnapshot(metadata(blob), blob)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rows = await listCloudSnapshots(); assert.equal(rows.length, 1);
    const blob = await readCloudSnapshot(rows[0].id); assert.ok(blob);
    assert.equal(createHash('sha256').update(blob).digest('hex'), rows[0].sha256);
  });
});

test('B193: same-name replacements serialize and publish a matching readable pair', async () => {
  await vault(async () => {
    const original = Buffer.alloc(32, 1);
    const row = await saveCloudSnapshot(metadata(original), original);
    const versions = [Buffer.alloc(32, 2), Buffer.alloc(32, 3)];
    await Promise.all(versions.map((blob) => saveCloudSnapshot(metadata(blob), blob, row.id)));
    const current = (await listCloudSnapshots())[0], blob = await readCloudSnapshot(row.id); assert.ok(blob);
    assert.equal(createHash('sha256').update(blob).digest('hex'), current.sha256);
  });
});

test('B193: a committed metadata rename followed by an error cannot leave a broken active pair', async (t) => {
  await vault(async () => {
    const old = Buffer.alloc(32, 1), next = Buffer.alloc(32, 2);
    const row = await saveCloudSnapshot(metadata(old), old);
    const original = fs.rename;
    t.mock.method(fs, 'rename', async (...args: any[]) => {
      const value = await Reflect.apply(original, fs, args);
      if (String(args[1]).endsWith('.json')) throw Object.assign(new Error('fixture ambiguous metadata result'), { code: 'EIO' });
      return value;
    });
    await assert.rejects(saveCloudSnapshot(metadata(next), next, row.id), /ambiguous metadata/);
    const current = (await listCloudSnapshots())[0], readable = await readCloudSnapshot(row.id);
    assert.ok(readable, 'the active metadata must still name a complete blob');
    assert.equal(createHash('sha256').update(readable).digest('hex'), current.sha256);
  });
});
