import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readWindowsServicePid, writeWindowsServicePid, refreshServiceDefinition, renderService, serviceAction, windowsScriptHost, WINDOWS_LAUNCHER, WINDOWS_END_TREE } from './services.mjs';
import { redirectServiceStdio, serviceLogReport, tailText } from './service-logs.mjs';

test('service pid record is replaced atomically and old cleanup cannot remove a newer record', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arco-service-pid-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'service'));
  assert.equal(readWindowsServicePid(home), null);
  const first = writeWindowsServicePid(home, 123), second = writeWindowsServicePid(home, 456);
  first(); assert.equal(readWindowsServicePid(home), 456);
  second(); assert.equal(readWindowsServicePid(home), null);
});

test('service definitions quote metacharacters and pin the Node path', () => {
  const args = { node: '/path & space/node', entry: '/app/"arco"', config: '/settings/<x>', home: '/data/', user: 'DOMAIN\\User' };
  assert.match(renderService('linux', args), /ExecStart="\/path & space\/node"/);
  assert.match(renderService('darwin', args), /<string>\/path &amp; space\/node<\/string>/);
  assert.match(renderService('win32', args), /<Command>C:\\Windows\\System32\\wscript.exe<\/Command><Arguments>\/\/B \/\/Nologo &quot;[^&]*launch.js&quot; &quot;\/path &amp; space\/node&quot; /);
  assert.throws(() => renderService('linux', { ...args, node: 'bad\nvalue' }), /unsupported/);
});

test('Linux unit renders an absolute unquoted working directory', () => {
  const args = { node: '/path & space/node', entry: '/app/arco', config: '/settings/config', home: '/data/arco%home' };
  const unit = renderService('linux', args);
  assert.match(unit, /^WorkingDirectory=\/data\/arco%%home$/m);
  assert.match(unit, /^ExecStart="\/path & space\/node"/m);
  assert.throws(() => renderService('linux', { ...args, home: '/data/with space' }), /unsupported/);
  assert.throws(() => renderService('linux', { ...args, home: 'relative' }), /absolute/);
});

test('service installation uses injected managers and keeps prior configuration', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'arco-service-fixture-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const platform of ['linux', 'darwin', 'win32']) {
    const home = join(base, platform); const paths = { home, config: join(home, 'service/config.json'), unit: join(home, 'unit') };
    const calls = []; const deps = { platform, uid: 999, paths, env: { ARCO_PORT: '4567', ARCO_HUB_URL: 'https://example.invalid/hub', ARCO_ALLOWED_ORIGINS: 'https://workbench.example:8443', ARCO_TRUSTED_PROXIES: '192.0.2.20', USERNAME: 'Fixture', USERDOMAIN: 'LOCAL' }, run: (cmd, args) => { calls.push([cmd, ...args]); return { status: args.includes('/Query') || args[0] === 'print' ? 1 : 0 };  } };
    await serviceAction('install', deps);
    assert.equal(JSON.parse(readFileSync(paths.config)).env.ARCO_PORT, '4567');
    assert.equal(JSON.parse(readFileSync(paths.config)).env.ARCO_HUB_URL, 'https://example.invalid/hub');
    assert.equal(JSON.parse(readFileSync(paths.config)).env.ARCO_ALLOWED_ORIGINS, 'https://workbench.example:8443');
    assert.equal(JSON.parse(readFileSync(paths.config)).env.ARCO_TRUSTED_PROXIES, '192.0.2.20');
    assert.ok(calls.length);
    deps.env.ARCO_PORT = '9999';
    await serviceAction('install', deps);
    assert.equal(JSON.parse(readFileSync(paths.config)).env.ARCO_PORT, '4567');
    await serviceAction('uninstall', deps);
  }
});

test('fresh macOS and Windows installs suppress expected missing-service probe output', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'arco-service-probe-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const platform of ['darwin', 'win32']) {
    const home = join(base, platform);
    const paths = { home, config: join(home, 'service/config.json'), unit: join(home, 'unit') };
    const probes = [];
    const deps = { platform, uid: 999, paths, env: { USERNAME: 'Fixture' }, run: (cmd, args, options = {}) => {
      if (args[0] === 'print' || args[0] === '/Query') {
        probes.push(options.stdio);
        return { status: 1, stderr: 'fixture: service not found' };
      }
      return { status: 0 };
    } };
    await serviceAction('install', deps);
    assert.deepEqual(probes, ['pipe', 'pipe'], `${platform} probes must not inherit output`);
  }
});

test('service installation reports a manager failure', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arco-service-failure-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = { home, config: join(home, 'service/config.json'), unit: join(home, 'unit') };
  await assert.rejects(serviceAction('install', { platform: 'win32', paths, env: { USERNAME: 'Fixture' }, run: (_cmd, args) => ({ status: args[0] === '/Query' ? 1 : 2 }) }), /schtasks.exe \/Create failed/);
});

test('an unrelated existing service is never overwritten', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arco-service-conflict-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = { home, config: join(home, 'service/config.json'), unit: join(home, 'unit') };
  writeFileSync(paths.unit, 'existing service');
  await assert.rejects(serviceAction('install', { platform: 'linux', paths, env: {}, run: () => { throw new Error('unexpected'); } }), /existing service/);
  assert.equal(readFileSync(paths.unit, 'utf8'), 'existing service');
});

 test('status refuses to inspect unrelated service without package configuration', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arco-service-absent-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = { home, config: join(home, 'service/config.json'), unit: join(home, 'unit') };
  await assert.rejects(serviceAction('status', { platform: 'linux', paths, env: {}, run: () => { throw new Error('unexpected manager call'); } }), /No packaged service/);
});

test('modified service definitions are never overwritten or acted on', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arco-service-modified-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = { home, config: join(home, 'service/config.json'), unit: join(home, 'unit') };
  const calls = []; const deps = { platform: 'linux', paths, env: {}, run: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0 }; } };
  await serviceAction('install', deps); writeFileSync(paths.unit, 'custom unit'); calls.length = 0;
  await assert.rejects(serviceAction('install', deps), /definition changed/);
  await assert.rejects(serviceAction('restart', deps), /definition changed/);
  assert.equal(readFileSync(paths.unit, 'utf8'), 'custom unit'); assert.equal(calls.length, 0);
});

test('the Windows task runs node through the script host launcher with every argument quoted', () => {
  const xml = renderService('win32', { node: 'C:\\Program Files\\nodejs\\node.exe', entry: 'C:\\a b\\arco.mjs', config: 'C:\\h\\config.json', home: 'C:\\h', user: 'D\\U', env: { SystemRoot: 'D:\\Win\\' } });
  assert.match(xml, /<Command>D:\\Win\\System32\\wscript.exe<\/Command>/);
  assert.match(xml, /<Arguments>\/\/B \/\/Nologo &quot;[^&]*launch.js&quot; &quot;C:\\Program Files\\nodejs\\node.exe&quot; &quot;C:\\a b\\arco.mjs&quot; &quot;service-run&quot; &quot;C:\\h\\config.json&quot;<\/Arguments>/);
  assert.match(xml, /<WorkingDirectory>C:\\h<\/WorkingDirectory>/);
  assert.equal(windowsScriptHost({}), 'C:\\Windows\\System32\\wscript.exe');
  assert.match(WINDOWS_LAUNCHER, /Run\(c\.join\(' '\), 0, true\)/);
  assert.doesNotMatch(renderService('linux', { node: '/n', entry: '/e', config: '/c', home: '/h' }), /wscript/);
});

async function ownedWindowsInstall(t, withOldDefinition) {
  const home = mkdtempSync(join(tmpdir(), 'arco-service-refresh-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = { home, config: join(home, 'service/config.json'), unit: join(home, 'unit') };
  const env = { USERNAME: 'Fixture', USERDOMAIN: 'LOCAL', SystemRoot: 'C:\\Windows' };
  const calls = [];
  await serviceAction('install', { platform: 'win32', paths, env, run: (cmd, args) => ({ status: args.includes('/Query') ? 1 : 0 }) });
  if (withOldDefinition) {
    // An older package registered a visible-window task running node directly.
    const old = renderService('win32', { node: process.execPath, entry: 'x', config: paths.config, home, user: 'LOCAL\\Fixture', env }).replace(/<Command>[^<]*<\/Command><Arguments>.*?<\/Arguments>/, `<Command>${process.execPath}</Command><Arguments>x</Arguments>`);
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(old, 'utf16le')]);
    writeFileSync(paths.unit, bytes);
    const saved = JSON.parse(readFileSync(paths.config, 'utf8'));
    const { createHash } = await import('node:crypto');
    saved.unitHash = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(paths.config, JSON.stringify(saved));
  }
  return { paths, env, calls, run: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0 }; } };
}

test('an older Arco-owned Windows definition is rewritten, and a current one is left alone', async (t) => {
  const f = await ownedWindowsInstall(t, true);
  const message = await refreshServiceDefinition({ platform: 'win32', paths: f.paths, env: f.env, run: f.run });
  assert.match(message, /updated/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].slice(0, 3), ['schtasks.exe', '/Create', '/TN']);
  assert.ok(f.calls[0].includes('/F') && f.calls[0].includes('arco-workbench'));
  assert.match(readFileSync(f.paths.unit).toString('utf16le'), /wscript\.exe<\/Command><Arguments>\/\/B/);
  f.calls.length = 0;
  assert.match(await refreshServiceDefinition({ platform: 'win32', paths: f.paths, env: f.env, run: f.run }), /current/);
  assert.equal(f.calls.length, 0);
});

test('Linux refresh repairs an unmodified old unit and refuses an edited unit', { skip: process.platform === 'win32' }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arco-linux-refresh-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = { home, config: join(home, 'service/config.json'), unit: join(home, 'unit') };
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return { status: args.includes('show') ? 1 : 0 }; };
  await serviceAction('install', { platform: 'linux', paths, env: {}, run });
  const old = readFileSync(paths.unit, 'utf8').replace(`WorkingDirectory=${home}`, `WorkingDirectory="${home}"`);
  writeFileSync(paths.unit, old);
  const saved = JSON.parse(readFileSync(paths.config, 'utf8'));
  const { createHash } = await import('node:crypto');
  saved.unitHash = createHash('sha256').update(old).digest('hex');
  writeFileSync(paths.config, JSON.stringify(saved));
  calls.length = 0;
  const beforeConfig = readFileSync(paths.config);
  await assert.rejects(refreshServiceDefinition({ platform: 'linux', paths, env: {}, run: () => ({ status: 1 }) }), /Could not reload/);
  assert.equal(readFileSync(paths.unit, 'utf8'), old);
  assert.deepEqual(readFileSync(paths.config), beforeConfig);
  assert.match(await refreshServiceDefinition({ platform: 'linux', paths, env: {}, run }), /updated/);
  const updated = readFileSync(paths.unit, 'utf8');
  assert.match(updated, new RegExp(`WorkingDirectory=${home}\\n`));
  assert.equal(JSON.parse(readFileSync(paths.config)).unitHash, createHash('sha256').update(updated).digest('hex'));
  assert.deepEqual(calls, [['systemctl', '--user', 'daemon-reload']]);
  writeFileSync(paths.unit, 'custom unit');
  await assert.rejects(refreshServiceDefinition({ platform: 'linux', paths, env: {}, run }), /definition changed/);
  assert.equal(readFileSync(paths.unit, 'utf8'), 'custom unit');
});

test('a modified definition is never replaced, and a failed registration keeps the old one', async (t) => {
  const f = await ownedWindowsInstall(t, true);
  const before = readFileSync(f.paths.unit);
  await assert.rejects(refreshServiceDefinition({ platform: 'win32', paths: f.paths, env: f.env, run: () => ({ status: 1 }) }), /Could not register/);
  assert.deepEqual(readFileSync(f.paths.unit), before);
  assert.equal(existsSync(`${f.paths.unit}.new`), false);
  writeFileSync(f.paths.unit, 'custom task');
  await assert.rejects(refreshServiceDefinition({ platform: 'win32', paths: f.paths, env: f.env, run: f.run }), /definition changed/);
  assert.equal(readFileSync(f.paths.unit, 'utf8'), 'custom task');
  assert.equal(f.calls.length, 0);
  const none = mkdtempSync(join(tmpdir(), 'arco-service-none-')); t.after(() => rmSync(none, { recursive: true, force: true }));
  assert.match(await refreshServiceDefinition({ platform: 'win32', paths: { home: none, config: join(none, 'service/config.json'), unit: join(none, 'unit') }, env: f.env, run: f.run }), /No packaged service/);
});

test('service stdout and stderr go to bounded files and the logs report shows them on Windows', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-service-logs-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = [], err = [];
  const streams = { stdout: { write: (c) => { out.push(c); return true; } }, stderr: { write: (c) => { err.push(c); return true; } } };
  const restore = redirectServiceStdio(dir, { max: 100, streams });
  streams.stdout.write('first line\n'); streams.stderr.write(Buffer.from('warning: something\n'));
  streams.stdout.write('x'.repeat(95) + '\n');
  assert.equal(out.length + err.length, 0, 'nothing reaches the original streams');
  assert.match(readFileSync(join(dir, 'service.stderr.log'), 'utf8'), /warning: something/);
  assert.ok(existsSync(join(dir, 'service.stdout.log.1')), 'rotated once past the bound');
  assert.match(readFileSync(join(dir, 'service.stdout.log.1'), 'utf8'), /first line/);
  assert.ok(readFileSync(join(dir, 'service.stdout.log'), 'utf8').length <= 100);
  restore();
  streams.stdout.write('back'); assert.deepEqual(out, ['back']);
  writeFileSync(join(dir, 'arco.log'), 'structured line\n');
  const win = serviceLogReport(dir, 'win32');
  assert.match(win, /== arco.log ==\nstructured line/); assert.match(win, /== service.stderr.log ==\nwarning: something/);
  assert.equal(serviceLogReport(dir, 'linux'), 'structured line\n');
  assert.equal(serviceLogReport(join(dir, 'missing'), 'win32'), 'No service log file is available.');
  assert.equal(tailText(join(dir, 'missing')), null);
});

test('a Windows stop ends the task and then every launcher or node process for this home, with its tree', async (t) => {
  const f = await ownedWindowsInstall(t, false);
  const seen = [];
  await serviceAction('stop', { platform: 'win32', paths: f.paths, env: f.env, run: (cmd, args, options = {}) => { seen.push({ cmd, args, options }); return { status: 0 }; } });
  assert.deepEqual(seen[0].args, ['/End', '/TN', 'arco-workbench']);
  assert.equal(seen[0].options.timeout, 30000, 'ending the scheduled task has a deadline');
  assert.equal(seen[1].cmd, 'powershell.exe');
  assert.equal(seen[1].args.at(-1), WINDOWS_END_TREE);
  assert.equal(seen[1].options.env.ARCO_SERVICE_MARK, f.paths.config);
  assert.match(WINDOWS_END_TREE, /taskkill\.exe \/PID \$id \/T \/F/);
  assert.match(WINDOWS_END_TREE, /taskkill\.exe \/PID \$id \/T \/F 2>\$null/, 'an already-exited process does not abort the survivor check');
  assert.match(WINDOWS_END_TREE, /\$LASTEXITCODE -ne 0.*GetProcesses\(\).*\$alive\.Count -gt 0/, 'a failed termination only passes when the process is gone');
  assert.match(WINDOWS_END_TREE, /node\.exe/);
  assert.match(WINDOWS_END_TREE, /wscript\.exe/);
  await assert.rejects(serviceAction('stop', { platform: 'win32', paths: f.paths, env: f.env, run: (cmd) => ({ status: cmd === 'powershell.exe' ? 1 : 0 }) }), /end the Arco service processes/);
  let attempts = 0;
  await serviceAction('stop', { platform: 'win32', paths: f.paths, env: f.env, run: (cmd, _args, options) => cmd === 'powershell.exe' ? (++attempts === 1 ? { error: Object.assign(new Error(), { code: 'ETIMEDOUT' }) } : (assert.equal(options.timeout, 30000), { status: 0 })) : { status: 0 } });
  assert.equal(attempts, 2);
  attempts = 0;
  await serviceAction('stop', { platform: 'win32', paths: f.paths, env: f.env, run: (cmd, args) => cmd === 'schtasks.exe' ? { status: 1 } : args.at(-1) === WINDOWS_END_TREE ? { status: 0 } : (++attempts === 1 ? { error: Object.assign(new Error(), { code: 'ETIMEDOUT' }) } : { status: 0, stdout: 'Ready' }) });
  assert.equal(attempts, 2);
  const checks = [];
  await serviceAction('stop', { platform: 'win32', paths: f.paths, env: f.env, run: (cmd, args) => {
    checks.push(args.at(-1));
    if (cmd === 'schtasks.exe') return { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
    return args.at(-1) === WINDOWS_END_TREE ? { status: 0 } : { status: 0, stdout: 'Ready' };
  } });
  assert.equal(checks.length, 3, 'a timed-out stop checks the task state and service process tree');
  await assert.rejects(serviceAction('stop', { platform: 'win32', paths: f.paths, env: f.env, run: (cmd, args) => {
    if (cmd === 'schtasks.exe') return { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
    return args.at(-1) === WINDOWS_END_TREE ? { status: 1 } : { status: 0, stdout: 'Ready' };
  } }), /end the Arco service processes/, 'a reported survivor remains an error');
});

test('Windows service stop requires both the service command and this home config', () => {
  const pattern = /-match '([^']+)'/.exec(WINDOWS_END_TREE)?.[1];
  assert.ok(pattern, 'service command identity is present');
  const command = new RegExp(pattern.replace('(?i)', ''), 'i');
  assert.ok(command.test('node "C:\\Program Files\\arco.mjs" "service-run" "C:\\home\\service\\config.json"'));
  assert.ok(command.test('wscript "C:\\home\\launch.js" "node" "C:\\app\\arco.mjs" "service-run" "C:\\home\\service\\config.json"'));
  assert.equal(command.test('node "C:\\other\\script.mjs" "C:\\home\\service\\config.json"'), false);
  assert.equal(command.test('node "C:\\app\\arco.mjs" "service-runner" "C:\\home\\service\\config.json"'), false);
  assert.match(WINDOWS_END_TREE, /\[regex\]::Escape\(\$m\)/i, 'config path is matched as a literal argument');
  assert.match(WINDOWS_END_TREE, /IsNullOrWhiteSpace.*throw 'Cannot inspect/, 'unknown command lines fail closed');
});
