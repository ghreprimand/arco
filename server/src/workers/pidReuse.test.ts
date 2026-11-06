// Unit tests for H44 — PID-reuse guard.
//
// Two layers: (1) the pure reap decision shouldReap (fail closed unless both start times
// are known and equal), and (2) readStartTime/isAlive/reapProc against
// the test process and a disposable child. The test process must yield two
// stable start-time reads; the child must survive a deliberately mismatched
// recorded token. A dead pid must reap to 'gone'.
//
// Run with: node --import tsx --test src/workers/pidReuse.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { shouldReap, readStartTime, readStartTimes, isAlive, WINDOWS_START_TIME_TIMEOUT_MS } from './processStartTime.js';
import { reapProc } from './pidRegistry.js';

const supported = ['linux', 'darwin', 'win32'].includes(process.platform);

test('shouldReap: matching start times → kill', () => {
  assert.equal(shouldReap('123', '123'), true);
});

test('shouldReap: differing start times → DO NOT kill (pid recycled)', () => {
  assert.equal(shouldReap('123', '456'), false);
});

test('shouldReap: unknown on either side never authorizes a kill', () => {
  assert.equal(shouldReap(null, '456'), false);
  assert.equal(shouldReap('123', null), false);
  assert.equal(shouldReap(null, null), false);
});

test('a timed-out or unrecorded identity never sends a kill', async () => {
  let kills = 0;
  const deps = {isAlive: () => true, readStartTimes: async (pids: number[]) => new Map(pids.map(p => [p, null as string | null])), kill: () => {kills++; return true;}};
  const timeout = {...deps, readStartTimes: (pids: number[]) => readStartTimes(pids, {platform: 'win32', query: async () => { throw Object.assign(new Error('fixture timeout'), {code:'ETIMEDOUT'}); }})};
  const same = async (pids: number[]) => new Map(pids.map(p => [p, 'same' as string | null]));
  assert.equal(await reapProc({pid:123,startTime:'recorded'}, timeout), 'unverified');
  assert.equal(await reapProc({pid:123,startTime:'recorded'}, deps), 'unverified');
  assert.equal(await reapProc({pid:123,startTime:null}, {...deps,readStartTimes:async()=>{throw new Error('must not query without a recorded identity');}}), 'unverified');
  assert.equal(kills, 0);
  assert.equal(await reapProc({pid:123,startTime:'same'}, {...deps,readStartTimes:same,kill:()=>false}), 'unverified');
  assert.equal(await reapProc({pid:123,startTime:'other'}, {...deps,readStartTimes:same}), 'reused');
  assert.equal(kills, 0);
  assert.equal(await reapProc({pid:123,startTime:'same'}, {...deps,readStartTimes:same}), 'killed');
  assert.equal(kills, 1);
});

test('readStartTime: live pid yields a stable, non-null token', {timeout: 90_000}, async () => {
  if (!supported) return;
  // Each read is asynchronous and bounded; a cold Windows query may take
  // several seconds. Two successful OS reads must agree.
  const attempts = process.platform === 'win32' ? 3 : 2;
  const tokens: string[] = [];
  for (let i = 0; i < attempts && tokens.length < 2; i++) {
    const token = await readStartTime(process.pid);
    if (token !== null) tokens.push(token);
  }
  assert.equal(tokens.length, 2, 'own start time is readable twice within the budget');
  assert.equal(tokens[0], tokens[1], 'start time is stable across reads');
});

test('Windows start-time probe issues one bounded query for all pids and rejects bad results', async () => {
  let calls = 0;
  const got = await readStartTimes([123, 456, 789], {platform: 'win32', query: async (pids, timeout) => {
    calls++; assert.deepEqual(pids, [123, 456, 789]); assert.equal(timeout, WINDOWS_START_TIME_TIMEOUT_MS);
    return '123 123456789\r\n456 not-a-token\r\n999 42\r\n';
  }});
  assert.equal(calls, 1);
  assert.equal(got.get(123), '123456789');
  assert.equal(got.get(456), null);
  assert.equal(got.get(789), null);
  assert.equal(got.has(999), false);
  assert.equal(await readStartTime(123, {platform: 'win32', query: async () => { throw new Error('fixture timeout'); }}), null);
  assert.equal(await readStartTime(1.5, {platform: 'win32', query: async () => { throw new Error('must not run'); }}), null);
});

test('macOS start-time probe keeps the lstart text as the token', async () => {
  const got = await readStartTimes([77, 78], {platform: 'darwin', query: async () => '   77 Fri Nov  6 14:46:13 2026\n'});
  assert.equal(got.get(77), 'Fri Nov  6 14:46:13 2026');
  assert.equal(got.get(78), null);
});

test('readStartTime: bogus pid → null', async () => {
  assert.equal(await readStartTime(-1), null);
  assert.equal(await readStartTime(0), null);
});

test('isAlive: self is alive, an absurd pid is not', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(2_000_000_000), false);
});

// Test a live child so a failed second OS read cannot kill the test runner.
test('reapProc: a "recycled" live pid is NOT killed (start time mismatch)', {timeout: 90_000}, async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {stdio:['pipe','ignore','ignore']});
  try {
    await once(child, 'spawn');
    assert.ok(child.pid);
    if (!supported) return;
    assert.notEqual(await readStartTime(child.pid), null, 'the child start time is readable');
    const outcome = await reapProc({ pid: child.pid, startTime: 'definitely-not-this-start-time' });
    assert.equal(outcome, 'reused');
    assert.ok(isAlive(child.pid), 'the child is still alive');
  } finally { child.kill(); }
});

test('reapProc: a dead pid → gone (nothing to kill)', async () => {
  const outcome = await reapProc({ pid: 2_000_000_000, startTime: null });
  assert.equal(outcome, 'gone');
});
