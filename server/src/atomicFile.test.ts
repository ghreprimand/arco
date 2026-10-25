// Unit tests for the shared atomic-write primitive + read-modify-write lock.
//
// Run: npm run test:atomic-file
//   node --conditions development --import tsx --test server/src/atomicFile.test.ts
//
// Covers the three defects the per-store copies shared (see atomicFile.ts):
// concurrent writers, orphaned temps on failure, and durability.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import { atomicWriteFile, withFileLock } from './atomicFile.js';

async function tmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'arco-atomic-'));
}

async function leftoverTemps(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'));
}

test('writes contents and creates missing parent directories', async () => {
  const dir = await tmpDir();
  const target = path.join(dir, 'nested', 'deep', 'file.json');
  await atomicWriteFile(target, '{"a":1}\n');
  assert.equal(await fs.readFile(target, 'utf8'), '{"a":1}\n');
});

test('overwrites an existing file in place', async () => {
  const dir = await tmpDir();
  const target = path.join(dir, 'f.json');
  await atomicWriteFile(target, 'first');
  await atomicWriteFile(target, 'second');
  assert.equal(await fs.readFile(target, 'utf8'), 'second');
  assert.deepEqual(await leftoverTemps(dir), []);
});

test('two concurrent writers to one target both complete; no temp survives', async () => {
  // The defect this replaces: a `${pid}`-keyed temp name made these two collide.
  const dir = await tmpDir();
  const target = path.join(dir, 'race.json');
  const a = 'a'.repeat(4096);
  const b = 'b'.repeat(4096);
  await Promise.all([atomicWriteFile(target, a), atomicWriteFile(target, b)]);

  const got = await fs.readFile(target, 'utf8');
  // Last writer wins, but the content must be one whole write — never a blend.
  assert.ok(got === a || got === b, 'target holds one complete write');
  assert.deepEqual(await leftoverTemps(dir), [], 'no orphaned temp file');
});

test('many concurrent writers leave exactly one intact file', async () => {
  const dir = await tmpDir();
  const target = path.join(dir, 'many.json');
  const bodies = Array.from({ length: 25 }, (_, i) => JSON.stringify({ i }) + '\n');
  await Promise.all(bodies.map((b) => atomicWriteFile(target, b)));
  assert.ok(bodies.includes(await fs.readFile(target, 'utf8')));
  assert.deepEqual(await leftoverTemps(dir), []);
});

test('a failed write removes the temp and leaves the previous file intact', async () => {
  const dir = await tmpDir();
  const target = path.join(dir, 'keep.json');
  await atomicWriteFile(target, 'original');

  // A Buffer-typed contents value that throws on serialization is hard to
  // stage; instead make the rename impossible by pointing at a directory.
  const dirTarget = path.join(dir, 'as-a-dir');
  await fs.mkdir(dirTarget);
  await assert.rejects(() => atomicWriteFile(dirTarget, 'nope'));

  assert.equal(await fs.readFile(target, 'utf8'), 'original');
  assert.deepEqual(await leftoverTemps(dir), [], 'temp cleaned up on failure');
});

test('mode is applied to the renamed target', { skip: process.platform === 'win32' ? 'Windows has no POSIX permission bits' : false }, async () => {
  const dir = await tmpDir();
  const target = path.join(dir, 'secret.json');
  await atomicWriteFile(target, 'shh', { mode: 0o600 });
  const st = await fs.stat(target);
  assert.equal(st.mode & 0o777, 0o600);
});

test('advisory durability still writes correctly', async () => {
  const dir = await tmpDir();
  const target = path.join(dir, 'ledger.jsonl');
  await atomicWriteFile(target, 'line\n', { durability: 'advisory' });
  assert.equal(await fs.readFile(target, 'utf8'), 'line\n');
  assert.deepEqual(await leftoverTemps(dir), []);
});

test('accepts Buffer contents', async () => {
  const dir = await tmpDir();
  const target = path.join(dir, 'bin');
  await atomicWriteFile(target, Buffer.from([0, 1, 2, 255]));
  assert.deepEqual([...(await fs.readFile(target))], [0, 1, 2, 255]);
});

// --- withFileLock -----------------------------------------------------------

test('withFileLock serializes read-modify-write on one key', async () => {
  // The defect this replaces: both readers load 0, both write 1, one increment
  // is lost. Serialized, the counter must reach 50.
  const dir = await tmpDir();
  const target = path.join(dir, 'counter.json');
  await atomicWriteFile(target, JSON.stringify({ n: 0 }));

  const bump = () =>
    withFileLock(target, async () => {
      const cur = JSON.parse(await fs.readFile(target, 'utf8')) as { n: number };
      // Yield between read and write to widen the interleaving window.
      await new Promise((r) => setImmediate(r));
      await atomicWriteFile(target, JSON.stringify({ n: cur.n + 1 }));
    });

  await Promise.all(Array.from({ length: 50 }, bump));
  const final = JSON.parse(await fs.readFile(target, 'utf8')) as { n: number };
  assert.equal(final.n, 50, 'no lost updates');
});

test('withFileLock keys are independent', async () => {
  const order: string[] = [];
  await Promise.all([
    withFileLock('k1', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('slow-k1');
    }),
    withFileLock('k2', async () => {
      order.push('fast-k2');
    }),
  ]);
  assert.deepEqual(order, ['fast-k2', 'slow-k1'], 'k2 did not wait on k1');
});

test('a rejected critical section does not wedge the key', async () => {
  await assert.rejects(() =>
    withFileLock('wedge', async () => {
      throw new Error('boom');
    }),
  );
  const got = await withFileLock('wedge', async () => 'ran anyway');
  assert.equal(got, 'ran anyway');
});

test('withFileLock propagates the resolved value', async () => {
  assert.equal(await withFileLock('val', async () => 42), 42);
});

// --- the property the cluster mailbox depends on ----------------------------

// clusterMailbox.ts drains by listing `*.json` and parsing each file; a parse
// failure is treated as "stale" and the file is UNLINKED. So a reader must
// never observe a `.json` path in a partial state while a write is in flight,
// or an undelivered peer message is silently destroyed. That safety comes
// entirely from the temp file being renamed into place under a non-`.json`
// name — pin it here so nobody "simplifies" the writer back to fs.writeFile.
test('a concurrent .json listing never observes a partial file', async () => {
  const dir = await tmpDir();
  const target = path.join(dir, 'msg.json');
  // Big enough that the write is not a single instantaneous syscall.
  const body = JSON.stringify({ pad: 'x'.repeat(4 * 1024 * 1024) });

  let stop = false;
  let observations = 0;
  const watcher = (async () => {
    while (!stop) {
      for (const name of await fs.readdir(dir)) {
        if (!name.endsWith('.json')) continue; // temps are '.tmp' — skipped
        const raw = await fs.readFile(path.join(dir, name), 'utf8');
        observations++;
        // Would throw on a torn file, which is exactly the drain-time failure.
        JSON.parse(raw);
      }
      await new Promise((r) => setImmediate(r));
    }
  })();

  // Stop the watcher even when a write fails, so a failure is reported
  // instead of leaving the loop (and the test process) running forever.
  try {
    for (let i = 0; i < 5; i++) await atomicWriteFile(target, body);
  } finally {
    stop = true;
    await watcher;
  }

  assert.ok(observations > 0, 'the watcher actually saw the file');
});
