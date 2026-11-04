import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWindowsProbe } from './services.mjs';
import { globalPrefix, updatePackage, waitForRecordedPid, windowsArcoRunning, writeUpdateResult } from './update.mjs';

const manifest = { name: '@scope/arco', version: '1.0.0' };
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'arco-update-package-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const calls = [], actions = []; const root = join(home, 'package'); mkdirSync(root); writeFileSync(join(root, 'package.json'), '{}');
  let fail = false;
  const run = (_command, args) => {
    const action = args[1]; calls.push(args.slice(1));
    if (action === 'view') return { status: 0, stdout: JSON.stringify(['1.1.0']) };
    if (action === 'pack') { const dir = args[args.indexOf('--pack-destination') + 1]; writeFileSync(join(dir, 'backup.tgz'), 'fixture'); return { status: 0, stdout: '[{"filename":"backup.tgz"}]' }; }
    if (action === 'install' && fail) { fail = false; return { status: 1 }; }
    return { status: 0, stdout: '' };
  };
  return { home, root, calls, actions, deps: { home, npm: 'npm-cli.js', prefix: home, managed: true, windowsRunning: async () => false, run, service: async (action) => actions.push(action) }, failInstall: () => { fail = true; } };
}

test('global prefix resolves both unscoped and legacy scoped installs', () => {
  const prefix = join(tmpdir(), 'fixture-prefix');
  const modules = join(prefix, 'lib', 'node_modules');
  assert.equal(globalPrefix(join(modules, 'arco-workbench'), 'linux'), prefix);
  assert.equal(globalPrefix(join(modules, '@scope', 'arco'), 'linux'), prefix);
  const windowsModules = join(prefix, 'node_modules');
  assert.equal(globalPrefix(join(windowsModules, 'arco-workbench'), 'win32'), prefix);
  assert.equal(globalPrefix(join(windowsModules, '@scope', 'arco'), 'win32'), prefix);
  assert.throws(() => globalPrefix(join(prefix, 'other', 'arco-workbench')), /not a global npm installation/);
});

test('unscoped updates use the installed package name', async (t) => {
  const f = fixture(t);
  const result = await updatePackage({ name: 'arco-workbench', version: '1.0.0' }, f.root, f.deps);
  assert.equal(result.outcome, 'updated');
  assert.equal(f.calls[0][1], 'arco-workbench@latest');
  assert.equal(f.calls[1].at(-1), 'arco-workbench@1.1.0');
});

test('unsafe unscoped names are refused before npm runs', async (t) => {
  const f = fixture(t);
  for (const name of ['-unsafe', '../escape', 'bad/name', 'name@latest']) {
    await assert.rejects(updatePackage({ name, version: '1.0.0' }, f.root, f.deps), /Invalid package name/);
  }
  assert.deepEqual(f.calls, []);
});

test('package update snapshots first and restarts the service after install', async (t) => {
  const f = fixture(t); const result = await updatePackage(manifest, f.root, f.deps);
  assert.equal(result.outcome, 'updated');
  assert.match(result.message, /^Updated to v1\.1\.0/);
  assert.deepEqual(f.actions, ['stop', 'start']);
  // On Windows the update also rewrites the service task in a fresh process
  // (`arco service refresh`), which the fixture records as a third call.
  const windows = process.platform === 'win32';
  assert.deepEqual(f.calls.map((args) => args[0]), windows ? ['view', 'install', 'service'] : ['view', 'install']);
  if (windows) assert.deepEqual(f.calls[2].slice(0, 2), ['service', 'refresh']);
  assert.equal(f.calls[1].at(-1), '@scope/arco@1.1.0');
  assert.equal(existsSync(join(f.home, 'package-update.lock')), false);
});

test('failed package installation restores the archive and restarts the service', async (t) => {
  const f = fixture(t); f.failInstall();
  if (process.platform !== 'win32') symlinkSync('package.json', join(f.root, 'link'));
  await assert.rejects(updatePackage(manifest, f.root, f.deps), /previous package was restored/);
  assert.deepEqual(f.calls.map((args) => args[0]), ['view', 'install']);
  assert.equal(readFileSync(join(f.root, 'package.json'), 'utf8'), '{}');
  if (process.platform !== 'win32') assert.equal(readlinkSync(join(f.root, 'link')), 'package.json');
  assert.deepEqual(f.actions, ['stop', 'start']);
});

test('Windows refuses live processes and fails closed when inspection fails', async (t) => {
  const f = fixture(t); f.deps.platform = 'win32'; f.deps.windowsRunning = async () => true;
  await assert.rejects(updatePackage(manifest, f.root, f.deps), (error) => /Stop all Arco processes/.test(error.message) && !error.message.includes('..'));
  assert.deepEqual(f.calls.map((args) => args[0]), ['view']);
  assert.deepEqual(f.actions, ['stop', 'start']);
  await assert.rejects(windowsArcoRunning(() => ({ status: 1, stdout: '' })), /Cannot verify/);
  let expression = '';
  assert.equal(await windowsArcoRunning((_cmd, args) => { expression = args[3]; return { status: 0, stdout: '0' }; }), false);
  assert.match(expression, /IsNullOrWhiteSpace.*throw 'Cannot inspect/, 'unknown command lines fail closed');
  const pattern = /-match '([^']+)'/.exec(expression)?.[1]; assert.ok(pattern);
  const matcher = new RegExp(pattern.replace('(?i)', ''), 'i');
  assert.ok(matcher.test('node C:\\work\\arco.mjs start'));
  assert.ok(matcher.test('node "C:\\work space\\arco.mjs" service-run'));
  assert.ok(matcher.test('node "C:\\work space\\arco.mjs" "service-run" "fixture"'));
  assert.ok(matcher.test('node "C:\\work space\\arco.mjs" "start"'));
  assert.equal(matcher.test('node C:\\work\\arco.mjs update'), false);
});

test('recorded service pid waits for exit and fails closed on unknown inspection errors', async () => {
  let clock = 0, probes = 0;
  const deps = { now: () => clock, sleep: async (ms) => { clock += ms; }, kill: () => { if (++probes === 3) throw Object.assign(new Error(), { code: 'ESRCH' }); } };
  assert.equal(await waitForRecordedPid(123, deps), false);
  assert.equal(clock, 1000);
  clock = 0;
  assert.equal(await waitForRecordedPid(123, { ...deps, kill: () => {} }), true);
  await assert.rejects(waitForRecordedPid(123, { ...deps, kill: () => { throw Object.assign(new Error(), { code: 'EINVAL' }); } }), /Cannot verify/);
});

test('process inspection retries a cold failure once and remains fail-closed', async () => {
  let calls = 0;
  assert.equal(await windowsArcoRunning((_cmd, _args, options) => { assert.equal(options.timeout, 30000); return ++calls === 1 ? { error: new Error('timeout') } : { status: 0, stdout: '0' }; }), false);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(windowsArcoRunning(() => { calls++; return { error: new Error('timeout') }; }), /two process checks/);
  assert.equal(calls, 2);
});

test('a stalled process probe returns after the timeout', async () => {
  const result = await runWindowsProbe(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 100 });
  assert.match(result.error.message, /timed out/);
});

test('managed update snapshots the recorded service pid before stopping', async (t) => {
  const f = fixture(t); mkdirSync(join(f.home, 'service'));
  const file = join(f.home, 'service', 'pid.json');
  writeFileSync(file, JSON.stringify({ version: 1, pid: 123 }));
  let checked = false;
  const deps = { ...f.deps, platform: 'win32', service: async (action) => { if (action === 'stop') rmSync(file); }, windowsRunning: async () => { throw new Error('CIM should not be needed'); }, kill: (pid, signal) => { assert.equal(pid, 123); assert.equal(signal, 0); checked = true; throw Object.assign(new Error(), { code: 'ESRCH' }); }, refresh: async () => ({ status: 0 }) };
  assert.equal((await updatePackage(manifest, f.root, deps)).outcome, 'updated');
  assert.equal(checked, true);
});

test('a service pid that remains live blocks the update with a clear message', async (t) => {
  const f = fixture(t); mkdirSync(join(f.home, 'service'));
  writeFileSync(join(f.home, 'service', 'pid.json'), JSON.stringify({ version: 1, pid: 123 }));
  let clock = 0;
  await assert.rejects(updatePackage(manifest, f.root, { ...f.deps, platform: 'win32', kill: () => {}, now: () => clock, sleep: async (ms) => { clock += ms; } }), /service process 123 is still running/);
  assert.deepEqual(f.actions, ['stop', 'start']);
  assert.deepEqual(f.calls.map((args) => args[0]), ['view']);
});

test('an unchanged or older registry version never stops the service', async (t) => {
  for (const version of ['1.0.0', '0.9.0']) {
    const f = fixture(t); f.deps.run = () => ({ status: 0, stdout: JSON.stringify(version) });
    if (version === '1.0.0') assert.equal((await updatePackage(manifest, f.root, f.deps)).outcome, 'unchanged');
    else await assert.rejects(updatePackage(manifest, f.root, f.deps), /downgrade/);
    assert.deepEqual(f.actions, []);
  }
});

test('linked checkouts are refused before any registry or service action', async (t) => {
  if (process.platform === 'win32') { t.skip('The fixture needs symlink privileges.'); return; }
  const f = fixture(t); const linked = join(f.home, 'linked-package'); symlinkSync(f.root, linked);
  await assert.rejects(updatePackage(manifest, linked, f.deps), /linked checkout/);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.actions, []);
});

test('a Windows update refreshes the service definition in a fresh process before starting, and tolerates failure', async (t) => {
  for (const outcome of ['ok', 'fails']) {
    const f = fixture(t); const order = [];
    const deps = { ...f.deps, platform: 'win32', service: async (action) => order.push(action), refresh: async () => { order.push('refresh'); return outcome === 'ok' ? { status: 0 } : { status: 1 }; } };
    const result = await updatePackage(manifest, f.root, deps);
    assert.deepEqual(order, ['stop', 'refresh', 'start']);
    assert.equal(/not refreshed/.test(result.message), outcome === 'fails');
  }
  const f = fixture(t); const order = [];
  await updatePackage(manifest, f.root, { ...f.deps, platform: 'linux', service: async (a) => order.push(a), refresh: async () => order.push('refresh') });
  assert.deepEqual(order, ['stop', 'start']);
});

test('a result keeps its attempt metadata and an older worker cannot replace a newer attempt', (t) => {
  const f = fixture(t); const path = join(f.home, 'update-result.json');
  const attempt = { attemptId: 'new', startedAt: 12, fromVersion: '1.0.0', target: 'v1.1.0', outcome: 'running' };
  writeFileSync(path, JSON.stringify(attempt));
  assert.equal(writeUpdateResult(path, 'old', { outcome: 'failed', message: 'old' }, () => 20), false);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), attempt);
  assert.equal(writeUpdateResult(path, 'new', { outcome: 'updated', message: 'done', target: 'other' }, () => 20), true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { ...attempt, outcome: 'updated', message: 'done', finishedAt: 20 });
});
