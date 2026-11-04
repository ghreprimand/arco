import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  deleteCloudSnapshot,
  listCloudSnapshots,
  readCloudSnapshot,
  saveCloudSnapshot,
} from '../management/clusterVault.js';

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'arco-cluster-vault-'));
  process.env.ARCO_CLUSTER_VAULT_DIR = root;
  let passed = 0;
  const step = async (name: string, fn: () => Promise<void>) => {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  };
  try {
  const encrypted = Buffer.from('ARCOCV01 opaque encrypted test payload');
  let id = '';
  await step('opaque encrypted blob saves with metadata + checksum', async () => {
    const row = await saveCloudSnapshot({
      name: 'Portable cluster',
      createdAt: '2026-07-23T00:00:00.000Z',
      memberCount: 3,
      sourceDevice: 'linux-test',
      sourcePlatform: 'linux',
      bytes: encrypted.length,
      sha256: createHash('sha256').update(encrypted).digest('hex'),
    }, encrypted);
    id = row.id;
    assert.equal(row.name, 'Portable cluster');
  });
  await step('list exposes metadata but not plaintext contents', async () => {
    const rows = await listCloudSnapshots();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id);
    assert.equal(JSON.stringify(rows).includes(encrypted.toString()), false);
  });
  await step('download returns the byte-identical opaque envelope', async () => {
    assert.deepEqual(await readCloudSnapshot(id), encrypted);
  });
  await step('confirmed same-name replacement keeps one row and updates bytes', async () => {
    const replacement = Buffer.from('ARCOCV01 replacement encrypted test payload');
    const row = await saveCloudSnapshot({
      name: 'Portable cluster',
      createdAt: '2026-07-23T01:00:00.000Z',
      memberCount: 4,
      sourceDevice: 'mac-test',
      sourcePlatform: 'darwin',
      bytes: replacement.length,
      sha256: createHash('sha256').update(replacement).digest('hex'),
    }, replacement, id);
    assert.equal(row.id, id);
    assert.equal((await listCloudSnapshots()).length, 1);
    assert.deepEqual(await readCloudSnapshot(id), replacement);
  });
  await step('delete removes metadata and blob', async () => {
    assert.equal(await deleteCloudSnapshot(id), true);
    assert.deepEqual(await listCloudSnapshots(), []);
    assert.equal(await readCloudSnapshot(id), null);
  });
    console.log(`\ncluster vault: ${passed}/5 steps passed`);
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.ARCO_CLUSTER_VAULT_DIR;
  }
}

void main();
