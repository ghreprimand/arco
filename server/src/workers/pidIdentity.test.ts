// Process identity without blocking the server: registration reads the start
// time off the event loop (macOS, Windows) or cheaply (Linux), accepts the
// answer only while the child is still ours, and the boot sweep and shutdown
// keep PID-reuse safety. Registries here use their own temporary files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  createBatchedProbe, isAlive, isChildRunning, readStartTime, runWindowsStartQuery,
  type StartTimeQuery,
} from './processStartTime.js';
import { DurablePidRegistry, reapAtShutdown, sweepRegistry } from './durablePidRegistry.js';

const root = mkdtempSync(join(tmpdir(), 'arco-pid-identity-'));
let n = 0;
const registry = () => new DurablePidRegistry(join(root, `pids-${++n}.json`), 'test');
const onDisk = (r: DurablePidRegistry) => r.readProcs();
const supported = ['linux', 'darwin', 'win32'].includes(process.platform);

test.after(() => rmSync(root, { recursive: true, force: true }));

// Largest event-loop gap while `work` runs.
async function largestGap(work: () => Promise<unknown>): Promise<number> {
  let last = Date.now(), max = 0;
  const iv = setInterval(() => { const now = Date.now(); max = Math.max(max, now - last); last = now; }, 10);
  try { await new Promise(r => setTimeout(r, 30)); last = Date.now(); await work(); } finally { clearInterval(iv); }
  return max;
}

// A FILETIME for a moment in the past, as Windows reports a start time.
const filetime = (ms: number) => String((BigInt(ms) + 11_644_473_600_000n) * 10_000n);

// An asynchronous query answered by a separate process after `delayMs`.
const slowQuery = (delayMs: number, token: string): StartTimeQuery => (pids) => new Promise((resolve, reject) => {
  execFile(process.execPath, ['-e', `setTimeout(() => console.log(${JSON.stringify(pids.map(p => `${p} ${token}`).join('\n'))}), ${delayMs})`],
    (err, out) => (err ? reject(err) : resolve(String(out))));
});

function spawnIdle(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}
async function stop(child: ChildProcess): Promise<void> {
  if (isChildRunning(child)) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
}

test('registration does not block the event loop while a slow start-time query runs', { timeout: 30_000 }, async () => {
  const r = registry();
  const token = filetime(Date.now() - 5_000);
  const probe = createBatchedProbe({ platform: 'win32', query: slowQuery(1_500, token) });
  const gap = await largestGap(async () => {
    r.register(4242, { cheap: () => undefined, probe, platform: 'win32' });
    assert.deepEqual(onDisk(r), [{ pid: 4242, startTime: null }], 'recorded at once, identity pending');
    assert.equal(await r.whenIdentified(4242), token);
  });
  assert.ok(gap < 400, `event loop stalled for ${gap} ms`);
  assert.deepEqual(onDisk(r), [{ pid: 4242, startTime: token }]);
});

test('the Windows query runs PowerShell asynchronously (fake slow PowerShell)', { timeout: 30_000 }, async (t) => {
  if (process.platform === 'win32') { t.skip('fake powershell.exe is a shell script'); return; }
  const bin = mkdtempSync(join(root, 'bin-'));
  const token = filetime(Date.now() - 5_000);
  writeFileSync(join(bin, 'powershell.exe'), `#!/bin/sh\nsleep 1.5\necho "4343 ${token}"\n`);
  chmodSync(join(bin, 'powershell.exe'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  try {
    const r = registry();
    const probe = createBatchedProbe({ platform: 'win32' });
    const gap = await largestGap(async () => {
      r.register(4343, { cheap: () => undefined, probe, platform: 'win32' });
      assert.equal(await r.whenIdentified(4343), token);
    });
    assert.ok(gap < 400, `event loop stalled for ${gap} ms`);
    // A query past its limit is stopped and gives no identity.
    writeFileSync(join(bin, 'powershell.exe'), `#!/bin/sh\nsleep 5\necho "4444 ${token}"\n`);
    let elapsed = Date.now();
    assert.equal((await runWindowsStartQuery([4444], 300).catch(() => null)), null);
    elapsed = Date.now() - elapsed;
    assert.ok(elapsed < 3_000, `time limit not applied (${elapsed} ms)`);
  } finally { process.env.PATH = path; }
});

test('a spawned child gets its start time on this system', { timeout: 90_000 }, async () => {
  if (!supported) return;
  const child = spawnIdle();
  try {
    await once(child, 'spawn');
    const r = registry();
    r.register(child.pid!, { alive: () => isChildRunning(child) });
    const token = await r.whenIdentified(child.pid!);
    assert.notEqual(token, null, 'identity established');
    assert.equal(token, await readStartTime(child.pid!), 'matches a fresh read');
    assert.deepEqual(onDisk(r), [{ pid: child.pid, startTime: token }]);
  } finally { await stop(child); }
});

test('a start time that cannot be read ends in one logged refusal, no stall and no kill', { timeout: 30_000 }, async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const r = registry();
  let queries = 0;
  const probe = async () => { queries++; await new Promise(res => setTimeout(res, 100)); return null; };
  const gap = await largestGap(async () => {
    r.register(process.pid, { cheap: () => undefined, probe, platform: 'win32' });
    assert.equal(await r.whenIdentified(process.pid), null);
  });
  assert.ok(gap < 400, `event loop stalled for ${gap} ms`);
  assert.equal(queries, 3, 'bounded retries');
  assert.equal(warn.mock.callCount(), 1, 'logged once');
  assert.match(String(warn.mock.calls[0].arguments[0]), /start time could not be read/);
  assert.deepEqual(onDisk(r), [{ pid: process.pid, startTime: null }]);
  // A crash leaves this record; the next boot never kills it.
  const fresh = new DurablePidRegistry(join(root, `pids-${n}.json`), 'test');
  let kills = 0;
  const c = await sweepRegistry(fresh, { isAlive: () => true, readStartTimes: async () => { throw new Error('must not query a null identity'); }, kill: () => { kills++; return true; } });
  assert.equal(kills, 0);
  assert.equal(c.unverified, 1);
  assert.deepEqual(onDisk(fresh), [{ pid: process.pid, startTime: null }], 'kept for a later check');
});

test('an answer that arrives after the child exited or was unregistered is discarded', async () => {
  let running = true;
  let answer!: (v: string | null) => void;
  const r = registry();
  r.register(5151, { cheap: () => undefined, alive: () => running, probe: () => new Promise(res => { answer = res; }) });
  await new Promise(res => setImmediate(res));
  running = false;                 // Node handled the exit: the pid may now be reused
  answer(filetime(Date.now()));
  assert.equal(await r.whenIdentified(5151), null);
  assert.deepEqual(onDisk(r), [{ pid: 5151, startTime: null }]);

  const r2 = registry();
  r2.register(5252, { cheap: () => undefined, probe: () => new Promise(res => { answer = res; }) });
  const pending = r2.whenIdentified(5252)!;
  await new Promise(res => setImmediate(res));
  r2.unregister(5252);
  answer('123');
  assert.equal(await pending, null);
  assert.deepEqual(onDisk(r2), [], 'not re-added');
});

test('a Windows start time later than the registration is refused', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const r = registry();
  r.register(5353, { cheap: () => undefined, platform: 'win32', attempts: 1, probe: async () => filetime(Date.now() + 60_000) });
  assert.equal(await r.whenIdentified(5353), null);
});

test('start-time reads that arrive together share one query', async () => {
  const seen: number[][] = [];
  const probe = createBatchedProbe({ platform: 'win32', query: async (pids) => { seen.push([...pids]); return pids.map(p => `${p} 1`).join('\n'); } });
  const r = registry();
  for (const pid of [11, 12, 13, 14, 15]) r.register(pid, { cheap: () => undefined, probe });
  for (const pid of [11, 12, 13, 14, 15]) assert.equal(await r.whenIdentified(pid), '1');
  assert.deepEqual(seen, [[11, 12, 13, 14, 15]]);
});

test('shutdown kills a held child without a start-time read and keeps older records', () => {
  const r = registry();
  r.register(6161, { cheap: () => undefined, probe: () => new Promise(() => {}), alive: () => true });
  r.retain([...r.readProcs(), { pid: 6262, startTime: 'older-run' }]);
  const killed: number[] = [];
  const deps = { isAlive: () => true, cheap: () => undefined, kill: (pid: number) => { killed.push(pid); return true; } };
  assert.equal(reapAtShutdown({ pid: 6161, startTime: null }, r, { ...deps, cheap: () => { throw new Error('no probe for a held child'); } }), 'killed');
  assert.equal(reapAtShutdown({ pid: 6262, startTime: 'older-run' }, r, deps), 'unverified', 'left for the boot sweep');
  assert.equal(reapAtShutdown({ pid: 6262, startTime: 'older-run' }, r, { ...deps, cheap: () => 'older-run' }), 'killed', 'cheap check (Linux)');
  assert.equal(reapAtShutdown({ pid: 6262, startTime: 'older-run' }, r, { ...deps, cheap: () => 'other' }), 'reused');
  assert.deepEqual(killed, [6161, 6262]);
});

test('boot sweep cleans up records written by 0.1.4 and the legacy format', { timeout: 120_000 }, async () => {
  if (!supported) return;
  const ours = spawnIdle(), recycled = spawnIdle(), legacy = spawnIdle();
  try {
    await Promise.all([once(ours, 'spawn'), once(recycled, 'spawn'), once(legacy, 'spawn')]);
    const token = await readStartTime(ours.pid!);
    assert.notEqual(token, null);
    const file = join(root, 'v014.json');
    writeFileSync(file, JSON.stringify({ procs: [
      { pid: ours.pid, startTime: token },
      { pid: recycled.pid, startTime: 'not-this-process' },
      { pid: 2_000_000_000, startTime: 'gone' },
    ] }));
    const exited = once(ours, 'exit');
    const c = await sweepRegistry(new DurablePidRegistry(file, 'test'));
    assert.deepEqual({ ...c }, { tracked: 3, killed: 1, reused: 1, gone: 1, unverified: 0 });
    await exited;
    assert.ok(isAlive(recycled.pid!), 'a recycled pid is never killed');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).procs, []);

    const legacyFile = join(root, 'legacy.json');
    writeFileSync(legacyFile, JSON.stringify({ pids: [legacy.pid] }));
    const l = await sweepRegistry(new DurablePidRegistry(legacyFile, 'test'));
    assert.equal(l.unverified, 1);
    assert.ok(isAlive(legacy.pid!), 'an unknown identity is never killed');
    assert.deepEqual(new DurablePidRegistry(legacyFile, 'test').readProcs(), [{ pid: legacy.pid, startTime: null }], 'kept for a later check');
  } finally { await Promise.all([stop(ours), stop(recycled), stop(legacy)]); }
});
