import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { update, parseArgs, compareTags, npmCommand, windowsServerRunning, checkoutFingerprint, canonicalCheckoutPath } from '../arco-update.mjs';

function git(cwd, ...args) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
function fixture(t, autocrlf = false) {
  const dir = mkdtempSync(join(tmpdir(), 'arco-update-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, 'origin.git'), source = join(dir, 'source'), checkout = join(dir, 'checkout');
  mkdirSync(remote); git(remote, 'init', '--bare'); mkdirSync(source); git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.invalid');
  const save = (version) => { writeFileSync(join(source, 'package.json'), JSON.stringify({ version }, null, 2) + '\n'); git(source, 'add', 'package.json'); git(source, 'commit', '-m', `release ${version}`); };
  save('1.0.0'); git(source, 'tag', 'v1.0.0'); git(source, 'remote', 'add', 'origin', remote); git(source, 'push', '-u', 'origin', 'main', '--tags');
  git(dir, ...(autocrlf ? ['-c', 'core.autocrlf=true'] : []), 'clone', '--branch', 'main', remote, checkout);
  if (autocrlf) git(checkout, 'config', 'core.autocrlf', 'true');
  writeFileSync(join(source, 'optional.txt'), 'release content'); git(source, 'add', 'optional.txt');
  save('1.1.0'); git(source, 'tag', 'v1.1.0'); git(source, 'tag', 'v2.0.0-rc.1'); git(source, 'push', 'origin', 'main', '--tags');
  const commands = []; let fail = null;
  const run = (cmd, args, options = {}) => { commands.push([cmd, ...args]); if (cmd === 'fake-npm') { if (fail === args[0]) { fail = null; return { status: 1, stdout: '', stderr: 'fixture failure' }; } return { status: 0, stdout: '', stderr: '' }; } return spawnSync(cmd, args, { cwd: checkout, encoding: 'utf8', ...options }); };
  const deps = { cwd: checkout, platform: 'linux', run, npm: { command: 'fake-npm', prefix: [] }, serviceMode: async () => null, report: () => {} };
  return { dir, source, checkout, commands, deps, failOnce: (s) => { fail = s; } };
}

test('stable version selection, check, dry run and update use the newest remote release', async (t) => {
  const f = fixture(t), before = git(f.checkout, 'rev-parse', 'HEAD');
  assert.equal(compareTags('v1.10.0', 'v1.9.99'), 1);
  await update(parseArgs(['--check']), f.deps); await update(parseArgs(['--dry-run']), f.deps);
  assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), before);
  const result = await update(parseArgs([]), f.deps);
  assert.equal(result.outcome, 'updated'); assert.equal(JSON.parse(readFileSync(join(f.checkout, 'package.json'))).version, '1.1.0');
  assert.deepEqual(f.commands.filter(([x]) => x === 'fake-npm').map((x) => x.slice(1)), [['ci', '--include=dev'], ['run', 'build']]);
});

test('main and explicit references need confirmation and cannot name unknown or unreachable commits', async (t) => {
  const f = fixture(t);
  await assert.rejects(update(parseArgs(['--main']), f.deps), /confirmation/);
  const head = git(f.source, 'rev-parse', 'HEAD');
  await update(parseArgs(['--ref', 'v2.0.0-rc.1', '--yes']), f.deps);
  assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), head);
  await assert.rejects(update(parseArgs(['--ref', 'v9.9.9', '--yes']), f.deps), /tag does not exist/);
  assert.throws(() => parseArgs(['--ref', '--bad']), /needs a value/);
  assert.throws(() => parseArgs(['--ref', 'main;echo']), /tag or commit/);
});

test('tracked edits, local commits and downgrade are refused; explicit downgrade preserves remote history', async (t) => {
  const f = fixture(t); writeFileSync(join(f.checkout, 'package.json'), '{"version":"modified"}');
  await assert.rejects(update(parseArgs([]), f.deps), /local changes/);
  git(f.checkout, 'restore', 'package.json'); git(f.checkout, 'config', 'user.name', 'Fixture'); git(f.checkout, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(f.checkout, 'extra'), 'fixture'); git(f.checkout, 'add', 'extra'); git(f.checkout, 'commit', '-m', 'local');
  await assert.rejects(update(parseArgs([]), f.deps), /Local commits/);
  git(f.checkout, 'reset', '--hard', 'HEAD~1'); await update(parseArgs([]), f.deps);
  await assert.rejects(update(parseArgs(['--ref', 'v1.0.0', '--yes']), f.deps), /Downgrade/);
  const messages = []; f.deps.report = (message) => messages.push(message);
  await update(parseArgs(['--ref', 'v1.0.0', '--allow-downgrade', '--dry-run']), f.deps);
  assert.match(messages[0], /newer saved state may not be compatible/);
  await update(parseArgs(['--ref', 'v1.0.0', '--allow-downgrade', '--yes']), f.deps);
  assert.match(messages[1], /^Warning: newer saved state/);
  assert.equal(JSON.parse(readFileSync(join(f.checkout, 'package.json'))).version, '1.0.0');
});

test('failed install or build rolls back the original branch and rebuilds it', async (t) => {
  for (const phase of ['ci', 'run']) { const f = fixture(t); const before = git(f.checkout, 'rev-parse', 'HEAD'); f.failOnce(phase);
    await assert.rejects(update(parseArgs([]), f.deps), /Rolled back/);
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), before); assert.equal(git(f.checkout, 'branch', '--show-current'), 'main');
    assert.equal(f.commands.filter(([x]) => x === 'fake-npm').at(-1)[1], 'run');
  }
});

test('Windows checkout identity resolves short names and normalizes slash and case', async (t) => {
  const f = fixture(t); const originalRun = f.deps.run;
  f.deps.platform = 'win32'; f.deps.runningServer = async () => false;
  f.deps.run = (cmd, args, options) => cmd === 'git' && args.join(' ') === 'rev-parse --show-toplevel'
    ? { status: 0, stdout: 'C:/Work/Long/Checkout\n' } : originalRun(cmd, args, options);
  const paths = [];
  f.deps.realpath = (path) => { paths.push(path); return path === f.checkout ? 'c:\\WORK\\LONG\\CHECKOUT' : 'C:/Work/Long/Checkout'; };
  await update(parseArgs(['--check']), f.deps);
  assert.deepEqual(paths, ['C:/Work/Long/Checkout', f.checkout]);
  const resolveAlias = (path) => path.includes('~') ? 'C:\\Work\\Long\\Checkout' : 'c:/work/long/checkout';
  assert.equal(canonicalCheckoutPath('C:\\Work\\LONG~1\\Checkout', 'win32', resolveAlias), canonicalCheckoutPath('c:/work/long/checkout', 'win32', resolveAlias));
  assert.equal(checkoutFingerprint('C:\\Work\\LONG~1\\Checkout', 'win32', resolveAlias), checkoutFingerprint('c:/work/long/checkout', 'win32', resolveAlias));
  assert.notEqual(canonicalCheckoutPath('/Case', 'linux', (p) => p), canonicalCheckoutPath('/case', 'linux', (p) => p));
});

test('Windows refuses a live checkout before fetch and resolves npm without a shell', async (t) => {
  const f = fixture(t); f.deps.platform = 'win32'; f.deps.runningServer = async () => true;
  await assert.rejects(update(parseArgs([]), f.deps), /Stop Arco.*npm run arco:update.*npm start/);
  assert.equal(f.commands.some(([, a]) => a === 'fetch'), false);
  const cli = join(f.dir, 'npm-cli.js'); writeFileSync(cli, '');
  assert.deepEqual(npmCommand({ npm_execpath: cli }, process.execPath, 'win32'), { command: process.execPath, prefix: [cli] });
});

test('Linux service update preserves the unit and stops then starts without reinstalling', async (t) => {
  const f = fixture(t); const base = f.deps.run;
  f.deps.serviceMode = async () => 'fixture.service';
  f.deps.run = (command, args, options) => command === 'systemctl' ? (f.commands.push([command, ...args]), { status: 0, stdout: '', stderr: '' }) : base(command, args, options);
  await update(parseArgs([]), f.deps);
  assert.deepEqual(f.commands.filter(([cmd]) => cmd === 'systemctl'), [['systemctl', '--user', 'stop', 'fixture.service'], ['systemctl', '--user', 'start', 'fixture.service']]);
});

test('line-ending normalization does not count as an edit', async (t) => {
  const f = fixture(t, true);
  const path = join(f.checkout, 'package.json');
  assert.match(readFileSync(path, 'utf8'), /\r\n/);
  writeFileSync(path, readFileSync(path));
  await update(parseArgs([]), f.deps);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, '1.1.0');
});


test('Windows detects the checkout on its configured port and fails closed when process inspection fails', async (t) => {
  const f = fixture(t); const seen = [];
  const live = await windowsServerRunning(f.checkout, { ARCO_PORT: '4321' }, {
    fetch: async (url) => { seen.push(url); return { ok: true, json: async () => ({ status: 'live', checkoutFingerprint: checkoutFingerprint(f.checkout, 'win32') }) }; },
    spawn: () => { throw new Error('should not inspect processes after a match'); },
  });
  assert.equal(live, true); assert.match(seen[0], /:4321\/healthz$/);
  const offline = async () => { throw new Error('offline'); };
  let expression = '';
  assert.equal(await windowsServerRunning(f.checkout, {}, { fetch: offline, spawn: (_command, args) => { expression = args[3]; return { status: 0, stdout: '0\n' }; } }), false);
  const pattern = /-match '([^']+)'/.exec(expression)?.[1]; assert.ok(pattern);
  const serverPath = new RegExp(pattern.replace('(?i)', ''), 'i');
  assert.ok(serverPath.test('C:\\work\\server\\src\\index.ts'));
  assert.ok(serverPath.test('C:\\work\\server\\dist\\index.js'));
  assert.ok(serverPath.test('C:\\work\\scripts\\start.mjs'));
  assert.equal(await windowsServerRunning(f.checkout, {}, { fetch: offline, spawn: () => ({ status: 0, stdout: '1\n' }) }), true);
  await assert.rejects(windowsServerRunning(f.checkout, {}, { fetch: offline, spawn: () => ({ status: 1, stdout: '' }) }), /Cannot verify/);
});

test('a release that changes after confirmation is refused before checkout', async (t) => {
  const f = fixture(t); const before = git(f.checkout, 'rev-parse', 'HEAD');
  await assert.rejects(update(parseArgs(['--expected-release', 'v1.0.0']), f.deps), /newest release changed/);
  assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), before);
});

test('a failed service start rolls back and restarts the original service', async (t) => {
  const f = fixture(t), old = git(f.checkout, 'rev-parse', 'HEAD'); const base = f.deps.run; let failStart = true;
  f.deps.serviceMode = async () => 'fixture.service';
  f.deps.run = (command, args, options) => {
    if (command !== 'systemctl') return base(command, args, options);
    f.commands.push([command, ...args]);
    if (args.includes('start') && failStart) { failStart = false; return { status: 1 }; }
    return { status: 0 };
  };
  await assert.rejects(update(parseArgs([]), f.deps), /Rolled back/);
  assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), old);
  assert.deepEqual(f.commands.filter(([cmd]) => cmd === 'systemctl').map((args) => args[2]), ['stop', 'start', 'start']);
});

test('unreachable commits and both staged and unstaged tracked changes refuse before checkout', async (t) => {
  const f = fixture(t); git(f.checkout, 'config', 'user.name', 'Fixture'); git(f.checkout, 'config', 'user.email', 'fixture@example.invalid');
  git(f.checkout, 'checkout', '-b', 'private-fixture'); writeFileSync(join(f.checkout, 'other'), 'local'); git(f.checkout, 'add', 'other'); git(f.checkout, 'commit', '-m', 'local fixture');
  const orphan = git(f.checkout, 'rev-parse', 'HEAD'); git(f.checkout, 'checkout', 'main');
  await assert.rejects(update(parseArgs(['--ref', orphan, '--yes']), f.deps), /not reachable/);
  writeFileSync(join(f.checkout, 'package.json'), 'changed'); git(f.checkout, 'add', 'package.json');
  await assert.rejects(update(parseArgs([]), f.deps), /local changes/);
  assert.equal(f.commands.some(([command, action]) => command === 'fake-npm' && action === 'ci'), false);
});


test('ignored untracked files that a target would overwrite are preserved', async (t) => {
  const f = fixture(t), before = git(f.checkout, 'rev-parse', 'HEAD');
  mkdirSync(join(f.checkout, '.git', 'info'), { recursive: true });
  writeFileSync(join(f.checkout, '.git', 'info', 'exclude'), 'optional.txt\n');
  const local = join(f.checkout, 'optional.txt'); writeFileSync(local, 'local fixture');
  await assert.rejects(update(parseArgs([]), f.deps), /overwrite an untracked or ignored local file/);
  assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), before);
  assert.equal(readFileSync(local, 'utf8'), 'local fixture');
  assert.equal(f.commands.some(([command]) => command === 'fake-npm'), false);
});

test('service-only updates fail safely if the current service cannot be verified', async (t) => {
  const f = fixture(t), before = git(f.checkout, 'rev-parse', 'HEAD');
  await assert.rejects(update(parseArgs(['--require-service']), f.deps), /could not be verified/);
  assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), before);
  assert.equal(f.commands.some(([cmd]) => cmd === 'fake-npm'), false);
});

test('an existing update lock prevents concurrent checkout changes', async (t) => {
  const f = fixture(t), before = git(f.checkout, 'rev-parse', 'HEAD');
  const lock = join(f.checkout, '.git', 'arco-update.lock'); writeFileSync(lock, 'fixture');
  await assert.rejects(update(parseArgs([]), f.deps), /Another update/);
  assert.equal(readFileSync(lock, 'utf8'), 'fixture'); assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), before);
});

test('explicit origin main updates after confirmation', async (t) => {
  const f = fixture(t); const result = await update(parseArgs(['--main', '--yes']), f.deps);
  assert.equal(result.target, git(f.source, 'rev-parse', 'HEAD'));
  assert.match(result.message, /non-release selection/);
});


test('untracked collisions created during confirmation are not overwritten', async (t) => {
  const f = fixture(t), before = git(f.checkout, 'rev-parse', 'HEAD');
  const local = join(f.checkout, 'optional.txt');
  f.deps.confirm = async () => { writeFileSync(local, 'new local fixture'); return true; };
  await assert.rejects(update(parseArgs(['--ref', 'v1.1.0']), f.deps), /overwrite an untracked/);
  assert.equal(readFileSync(local, 'utf8'), 'new local fixture');
  assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), before);
});


test('a newer prerelease cannot silently downgrade to the newest stable tag', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'package.json'), JSON.stringify({ version: '1.2.0-rc.1' }));
  git(f.source, 'add', 'package.json'); git(f.source, 'commit', '-m', 'prerelease'); git(f.source, 'push', 'origin', 'main');
  git(f.checkout, 'pull', '--ff-only'); const before = git(f.checkout, 'rev-parse', 'HEAD');
  await assert.rejects(update(parseArgs([]), f.deps), /Downgrade refused/);
  assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), before);
});


test('explicit commits reachable from another origin branch are accepted', async (t) => {
  const f = fixture(t);
  git(f.checkout, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
  git(f.source, 'checkout', '-b', 'release-fixture');
  writeFileSync(join(f.source, 'package.json'), JSON.stringify({ version: '1.2.0' }));
  git(f.source, 'add', 'package.json'); git(f.source, 'commit', '-m', 'branch fixture');
  git(f.source, 'push', 'origin', 'release-fixture');
  const branchHead = git(f.source, 'rev-parse', 'HEAD');
  const result = await update(parseArgs(['--ref', branchHead, '--yes']), f.deps);
  assert.equal(result.target, branchHead);
});
