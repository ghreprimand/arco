import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdateManager, updateMode } from './updateManager.js';

test('run mode distinguishes Linux user service and other deployments', () => {
  assert.equal(updateMode('linux', { INVOCATION_ID: 'fixture' }), 'service');
  assert.equal(updateMode('linux', {}), 'foreground');
  assert.equal(updateMode('darwin', { INVOCATION_ID: 'fixture' }), 'foreground');
  assert.equal(updateMode('win32', {}), 'foreground');
  assert.equal(updateMode('linux', { INVOCATION_ID: 'fixture', ARCO_DEPLOYMENT: 'docker' }), 'docker');
});

test('service update accepts no target, checks latest and uses a separate transient unit', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arco-update-manager-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const calls: Array<[string, string[]]> = [];
  const manager = createUpdateManager({ home: () => home, mode: () => 'service', root: home, env: {},
    check: async () => ({ latest: 'v1.2.3', updateAvailable: true }), launch: (cmd, args) => { calls.push([cmd, args]); return { status: 0 }; } });
  assert.equal((await manager.start({ ref: 'main' })).status, 400);
  assert.equal((await manager.start({ expectedLatest: 'v1.0.0' })).status, 409);
  const result = await manager.start({ expectedLatest: 'v1.2.3' }); assert.equal(result.status, 202);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'systemd-run');
  assert.ok(calls[0][1].includes('--user')); assert.ok(calls[0][1].includes('--service-type=exec'));
  assert.ok(!calls[0][1].includes('--wait'));
  assert.ok(calls[0][1].includes('--yes')); assert.ok(calls[0][1].includes('--require-service')); assert.ok(!calls[0][1].includes('--ref'));
  const attempt = JSON.parse(readFileSync(join(home, 'update-result.json'), 'utf8'));
  assert.equal(attempt.outcome, 'running'); assert.match(attempt.attemptId, /^[a-f0-9-]{36}$/);
  assert.equal(result.attemptId, attempt.attemptId);
  assert.ok(attempt.startedAt > 0); assert.ok(attempt.fromVersion); assert.equal(attempt.target, 'v1.2.3');
  assert.ok(calls[0][1].includes(attempt.attemptId));
  assert.equal((await manager.start({ expectedLatest: 'v1.2.3' })).status, 409);
});

test('non-service and missing release refuse; failed launcher offers terminal fallback', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arco-update-manager-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const manager = createUpdateManager({ home: () => home, mode: () => 'foreground' });
  assert.equal((await manager.start({})).status, 409);
  const absent = createUpdateManager({ home: () => home, mode: () => 'service', check: async () => ({ latest: null, updateAvailable: false }) });
  assert.equal((await absent.start({ expectedLatest: 'v1.1.0' })).status, 409);
  const broken = createUpdateManager({ home: () => home, mode: () => 'service', check: async () => ({ latest: 'v1.1.0', updateAvailable: true }), launch: () => ({ status: 1 }) });
  assert.equal((await broken.start({ expectedLatest: 'v1.1.0' })).status, 503); assert.match(broken.status().result!.message!, /npm run arco:update/);
});

test('concurrent requests cannot launch two updaters', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arco-update-manager-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  let unblock!: () => void;
  const wait = new Promise<void>((resolve) => { unblock = resolve; }); let launches = 0;
  const manager = createUpdateManager({ home: () => home, mode: () => 'service', check: async () => { await wait; return { latest: 'v1.2.3', updateAvailable: true }; }, launch: () => { launches++; return { status: 0 }; } });
  const first = manager.start({ expectedLatest: 'v1.2.3' });
  assert.equal((await manager.start({ expectedLatest: 'v1.2.3' })).status, 409);
  unblock(); assert.equal((await first).status, 202); assert.equal(launches, 1);
});

test('a service name cannot be interpreted as a systemctl option', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arco-update-manager-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const manager = createUpdateManager({ home: () => home, mode: () => 'service', env: { ARCO_SYSTEMD_UNIT: '--bad.service' }, check: async () => ({ latest: 'v1.2.3', updateAvailable: true }) });
  assert.equal((await manager.start({ expectedLatest: 'v1.2.3' })).status, 409);
});

test('packaged service updates use a separate platform manager and only the confirmed release', async (t) => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const home = mkdtempSync(join(tmpdir(), 'arco-package-update-manager-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const calls: Array<[string, string[]]> = [];
    const manager = createUpdateManager({ home: () => home, root: home, platform, mode: () => 'service', env: { ARCO_PACKAGED: '1', USERNAME: 'fixture', USERDOMAIN: 'EXAMPLE' },
      check: async () => ({ latest: 'v1.2.3', updateAvailable: true }),
      launch: (command, args) => { calls.push([command, args]); return { status: 0 }; } });
    assert.equal(manager.status().packaged, true);
    assert.equal((await manager.start({ expectedLatest: 'v1.2.3' })).status, 202);
    assert.equal(calls[0][0], platform === 'linux' ? 'systemd-run' : platform === 'darwin' ? 'launchctl' : 'schtasks.exe');
    if (platform === 'win32') {
      assert.equal(calls[1][1][0], '/Run');
      const taskPath = calls[0][1].at(-1)!;
      const content = readFileSync(taskPath).subarray(2).toString('utf16le');
      assert.match(content, /package-update/); assert.match(content, /v1\.2\.3/); assert.doesNotMatch(content, /--ref/);
    } else {
      assert.ok(calls[0][1].includes('package-update'));
      assert.ok(calls[0][1].includes('v1.2.3'));
      assert.ok(!calls[0][1].includes('--ref'));
    }
  }
});

test('packaged macOS and Windows restarts are queued outside the service', (t) => {
  for (const platform of ['darwin', 'win32'] as const) {
    const home = mkdtempSync(join(tmpdir(), 'arco-package-restart-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const calls: Array<[string, string[]]> = [];
    const manager = createUpdateManager({ home: () => home, root: home, platform, mode: () => 'service', env: { ARCO_PACKAGED: '1', USERNAME: 'fixture', USERDOMAIN: 'EXAMPLE' },
      launch: (command, args) => { calls.push([command, args]); return { status: 0 }; } });
    assert.equal(manager.restart().ok, true);
    assert.equal(calls[0][0], platform === 'darwin' ? 'launchctl' : 'schtasks.exe');
    if (platform === 'win32') {
      const content = readFileSync(calls[0][1].at(-1)!).subarray(2).toString('utf16le');
      assert.match(content, /package-restart/); assert.equal(calls[1][1][0], '/Run');
    } else assert.ok(calls[0][1].includes('package-restart'));
  }
});


test('update results reject stale and unrelated attempts and retain a recent failure or successful target', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arco-result-test-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = 2_000_000; const path = join(home, 'update-result.json');
  const manager = createUpdateManager({ home: () => home, mode: () => 'service', now: () => now, version: '1.0.0' });
  const write = (x: object) => writeFileSync(path, JSON.stringify(x));
  write({ outcome: 'failed', message: 'old', finishedAt: now - 16 * 60_000 });
  assert.equal(manager.status().result, null);
  const attempt = { attemptId: 'fixture', startedAt: now - 2000, fromVersion: '1.0.0', target: 'v1.1.0' };
  write({ ...attempt, outcome: 'failed', message: 'fresh', finishedAt: now - 1000 });
  assert.equal(manager.status().result?.message, 'fresh');
  write({ ...attempt, fromVersion: '0.9.0', outcome: 'failed', message: 'other', finishedAt: now - 1000 });
  assert.equal(manager.status().result, null);
  const updated = createUpdateManager({ home: () => home, mode: () => 'service', now: () => now, version: '1.1.0' });
  write({ ...attempt, outcome: 'updated', message: 'updated', finishedAt: now - 1000 });
  assert.equal(updated.status().result?.message, 'updated');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).reportedAt, now);
  const later = createUpdateManager({ home: () => home, mode: () => 'service', now: () => now + 16 * 60_000, version: '1.1.0' });
  assert.equal(later.status().result, null);
  write({ ...attempt, outcome: 'updated', message: 'reconnected', finishedAt: now - 16 * 60_000, startedAt: now - 17 * 60_000 });
  assert.equal(updated.status().result?.message, 'reconnected');
  assert.equal(later.status().result, null);
});
