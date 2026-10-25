// Unit tests for H44 — PID-reuse guard.
//
// Two layers: (1) the pure reap decision shouldReap (fail-toward-kill unless we
// can prove the pid was recycled), and (2) readStartTime/isAlive/reapProc against
// THIS test process — a live pid whose start time is stable across reads must
// reapProc to 'reused' when we pretend a different start time was recorded, and a
// dead pid must reap to 'gone'. We never SIGKILL the live test pid (different
// recorded start time short-circuits before the kill).
//
// Run with: node --import tsx --test src/workers/pidReuse.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReap, readStartTime, isAlive } from './processStartTime.js';
import { reapProc } from './pidRegistry.js';

test('shouldReap: matching start times → kill', () => {
  assert.equal(shouldReap('123', '123'), true);
});

test('shouldReap: differing start times → DO NOT kill (pid recycled)', () => {
  assert.equal(shouldReap('123', '456'), false);
});

test('shouldReap: unknown on either side → fail toward kill', () => {
  assert.equal(shouldReap(null, '456'), true);
  assert.equal(shouldReap('123', null), true);
  assert.equal(shouldReap(null, null), true);
});

test('readStartTime: live pid yields a stable, non-null token (POSIX)', () => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return;
  const a = readStartTime(process.pid);
  const b = readStartTime(process.pid);
  assert.ok(a !== null, 'own start time is readable');
  assert.equal(a, b, 'start time is stable across reads');
});

test('readStartTime: bogus pid → null', () => {
  assert.equal(readStartTime(-1), null);
  assert.equal(readStartTime(0), null);
});

test('isAlive: self is alive, an absurd pid is not', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(2_000_000_000), false);
});

test('reapProc: a "recycled" live pid is NOT killed (start time mismatch)', () => {
  // Record a deliberately wrong start time for our own live pid → reapProc must
  // classify it as 'reused' and short-circuit before forceKillPid. (If the guard
  // were broken this test process would be SIGKILLed and the run would fail.)
  const outcome = reapProc({ pid: process.pid, startTime: 'definitely-not-our-start-time' });
  assert.equal(outcome, 'reused');
  assert.ok(isAlive(process.pid), 'we are still alive');
});

test('reapProc: a dead pid → gone (nothing to kill)', () => {
  const outcome = reapProc({ pid: 2_000_000_000, startTime: null });
  assert.equal(outcome, 'gone');
});
