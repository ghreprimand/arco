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
import { shouldReap, readStartTime, isAlive, readWindowsStartTime, WINDOWS_START_TIME_TIMEOUT_MS } from './processStartTime.js';
import { reapProc } from './pidRegistry.js';

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

test('a timed-out or unrecorded identity never sends a kill', () => {
  let kills = 0;
  const deps = {isAlive: () => true, readStartTime: () => null, kill: () => {kills++; return true;}};
  const timeout = {...deps, readStartTime: (pid:number) => readWindowsStartTime(pid, () => { throw Object.assign(new Error('fixture timeout'), {code:'ETIMEDOUT'}); })};
  assert.equal(reapProc({pid:123,startTime:'recorded'}, timeout), 'unverified');
  assert.equal(reapProc({pid:123,startTime:'recorded'}, deps), 'unverified');
  assert.equal(reapProc({pid:123,startTime:null}, {...deps,readStartTime:()=>{throw new Error('must not query without a recorded identity');}}), 'unverified');
  assert.equal(kills, 0);
  assert.equal(reapProc({pid:123,startTime:'same'}, {...deps,readStartTime:()=>'same',kill:()=>false}), 'unverified');
  assert.equal(reapProc({pid:123,startTime:'other'}, {...deps,readStartTime:()=>'same'}), 'reused');
  assert.equal(kills, 0);
  assert.equal(reapProc({pid:123,startTime:'same'}, {...deps,readStartTime:()=>'same'}), 'killed');
  assert.equal(kills, 1);
});

test('readStartTime: live pid yields a stable, non-null token', {timeout: 50_000}, () => {
  if (!['linux', 'darwin', 'win32'].includes(process.platform)) return;
  // A cold Windows process query can time out on a loaded runner. Each attempt
  // is bounded and independent; two successful OS reads must still agree.
  const attempts = process.platform === 'win32' ? 5 : 2;
  const tokens: string[] = [];
  for (let i = 0; i < attempts && tokens.length < 2; i++) {
    const token = readStartTime(process.pid);
    if (token !== null) tokens.push(token);
  }
  assert.equal(tokens.length, 2, 'own start time is readable twice within the budget');
  assert.equal(tokens[0], tokens[1], 'start time is stable across reads');
});

test('Windows start-time probe issues one bounded query and rejects bad results', () => {
  let calls = 0;
  assert.equal(readWindowsStartTime(123, (pid, timeout) => {
    calls++; assert.equal(pid, 123); assert.equal(timeout, WINDOWS_START_TIME_TIMEOUT_MS);
    assert.ok(timeout <= 8_000); return '123456789\r\n';
  }), '123456789');
  assert.equal(calls, 1);
  assert.equal(readWindowsStartTime(123, () => 'not a token'), null);
  assert.equal(readWindowsStartTime(123, () => { throw new Error('fixture timeout'); }), null);
  assert.equal(readWindowsStartTime(1.5, () => { throw new Error('must not run'); }), null);
});

test('readStartTime: bogus pid → null', () => {
  assert.equal(readStartTime(-1), null);
  assert.equal(readStartTime(0), null);
});

test('isAlive: self is alive, an absurd pid is not', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(2_000_000_000), false);
});

// Test a live child so a failed second OS read cannot kill the test runner.
test('reapProc: a "recycled" live pid is NOT killed (start time mismatch)', {timeout: 30_000}, async (t) => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {stdio:['pipe','ignore','ignore']});
  try {
    await once(child, 'spawn');
    assert.ok(child.pid);
    if (readStartTime(child.pid) === null) { t.skip('no process start time on this platform'); return; }
    const outcome = reapProc({ pid: child.pid, startTime: 'definitely-not-this-start-time' });
    assert.equal(outcome, 'reused');
    assert.ok(isAlive(child.pid), 'the child is still alive');
  } finally { child.kill(); }
});

test('reapProc: a dead pid → gone (nothing to kill)', () => {
  const outcome = reapProc({ pid: 2_000_000_000, startTime: null });
  assert.equal(outcome, 'gone');
});
