import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptVaultBlob, encryptVaultBlob } from './clusterVaultCrypto.js';
import { readClusterBundle, writeClusterBundle } from './clusterSnapshotBundle.js';

const files = [
  { relPath: 'manifest.json', bytes: Buffer.from('{"schemaVersion":1}') },
  { relPath: 'members/wf-1/meta.json', bytes: Buffer.from('{"workflowId":"wf-1"}') },
  { relPath: 'members/wf-1/events.jsonl', bytes: Buffer.from('{"type":"primary_text"}\n') },
];

test('portable cluster bundle round-trips regular files with integrity', () => {
  const decoded = readClusterBundle(writeClusterBundle(files));
  assert.deepEqual(decoded.map((f) => f.relPath), files.map((f) => f.relPath));
  assert.deepEqual(decoded.map((f) => f.bytes.toString()), files.map((f) => f.bytes.toString()));
});

test('bundle rejects traversal paths', () => {
  assert.throws(
    () => writeClusterBundle([{ relPath: '../escape', bytes: Buffer.from('x') }]),
    /unsafe/i,
  );
});

test('vault envelope decrypts only with the matching key', () => {
  const key = Buffer.alloc(32, 7);
  const other = Buffer.alloc(32, 8);
  const plain = writeClusterBundle(files);
  const encrypted = encryptVaultBlob(plain, key);
  assert.deepEqual(decryptVaultBlob(encrypted, key), plain);
  assert.throws(() => decryptVaultBlob(encrypted, other), /different vault key/i);
});

