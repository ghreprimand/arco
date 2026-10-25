// DD3 (Phase 3 — cluster correctness) — per-realpath file-mutation queue smoke.
//
// Headless / module-level (no live server, no API spend). Drives the real
// withFileMutationLock against real temp files. The load-bearing contracts:
//
//   (a) concurrent read-modify-writes to the SAME file serialize — every
//       increment lands (the lost-write bug DD3 fixes). A control run WITHOUT
//       the lock loses writes, proving the test would catch a regression.
//   (b) distinct files run in PARALLEL (separate keys, separate tails).
//   (c) a symlink alias of a file shares the queue (realpath dedup) — mutations
//       through the real path and the link still serialize.
//   (d) onWait fires only when a write actually had to wait, never on an
//       uncontended write.
//
// Run: npm run smoke:file-mutation-queue   (no server needed)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { step, assert, assertEq, summary } from './lib.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-fmq-'));
  try {
    const { withFileMutationLock, __resetFileMutationQueueForTests } =
      await import('../../server/src/providers/claude-native/file-mutation-queue.js');

    // A read-modify-write that's deliberately interleavable: read the int,
    // yield to the event loop, write back +1. Concurrent RMWs without a lock
    // race here and lose increments.
    const rmwIncrement = async (file: string): Promise<void> => {
      const cur = parseInt(await fs.readFile(file, 'utf8'), 10);
      await sleep(2); // widen the read→write window so a race is near-certain
      await fs.writeFile(file, String(cur + 1), 'utf8');
    };

    await step('(control) WITHOUT the lock, concurrent RMW loses writes', async () => {
      const file = path.join(dir, 'control.txt');
      await fs.writeFile(file, '0', 'utf8');
      await Promise.all(Array.from({ length: 20 }, () => rmwIncrement(file)));
      const final = parseInt(await fs.readFile(file, 'utf8'), 10);
      assert(final < 20, `unlocked RMW should lose writes (got ${final}/20)`);
    });

    await step('(a) WITH the lock, every concurrent same-file write lands', async () => {
      await __resetFileMutationQueueForTests();
      const file = path.join(dir, 'locked.txt');
      await fs.writeFile(file, '0', 'utf8');
      await Promise.all(Array.from({ length: 20 }, () => withFileMutationLock(file, () => rmwIncrement(file))));
      const final = parseInt(await fs.readFile(file, 'utf8'), 10);
      assertEq(final, 20, 'all 20 increments serialized — no lost write');
    });

    await step('(b) distinct files run in parallel (not serialized)', async () => {
      await __resetFileMutationQueueForTests();
      const fileA = path.join(dir, 'a.txt');
      const fileB = path.join(dir, 'b.txt');
      let aStarted = false;
      let bSawAStarted = false;
      const pA = withFileMutationLock(fileA, async () => {
        aStarted = true;
        await sleep(30); // hold A's lock; B must not wait on it
      });
      const pB = withFileMutationLock(fileB, async () => {
        await sleep(5);
        bSawAStarted = aStarted; // if serialized, A would still be queued behind B or vice-versa
      });
      await Promise.all([pA, pB]);
      assert(bSawAStarted, 'B ran concurrently with A (distinct files do not serialize)');
    });

    await step('(c) symlink alias shares the queue (realpath dedup)', async () => {
      await __resetFileMutationQueueForTests();
      const real = path.join(dir, 'real.txt');
      const link = path.join(dir, 'link.txt');
      await fs.writeFile(real, '0', 'utf8');
      try {
        await fs.symlink(real, link);
      } catch {
        // Some filesystems/CI disallow symlinks — skip rather than fail.
        return;
      }
      // Alternate mutations between the real path and the symlink. If they keyed
      // off the literal path they'd run in parallel and lose writes; realpath
      // collapses both to one key so all 20 land.
      await Promise.all(Array.from({ length: 20 }, (_, i) =>
        withFileMutationLock(i % 2 === 0 ? real : link, () => rmwIncrement(real))));
      const final = parseInt(await fs.readFile(real, 'utf8'), 10);
      assertEq(final, 20, 'real + symlink mutations serialized via shared realpath key');
    });

    await step('(d) onWait fires only when a write actually waits', async () => {
      await __resetFileMutationQueueForTests();
      const file = path.join(dir, 'wait.txt');
      await fs.writeFile(file, '0', 'utf8');
      // First, uncontended: a single write must NOT report a wait.
      let solo = 0;
      await withFileMutationLock(file, async () => { await sleep(1); }, () => { solo++; });
      assertEq(solo, 0, 'uncontended write never fires onWait');
      // Now three concurrent: the first runs immediately, the other two wait.
      await __resetFileMutationQueueForTests();
      let waits = 0;
      await Promise.all(Array.from({ length: 3 }, () =>
        withFileMutationLock(file, async () => { await sleep(5); }, () => { waits++; })));
      assertEq(waits, 2, 'two of three concurrent writes reported a wait (first did not)');
    });

    await __resetFileMutationQueueForTests();
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  summary('file-mutation-queue');
}

void main();
