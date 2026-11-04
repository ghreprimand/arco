// A fixture-only global install, startup, fake service and local package update.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const input = process.argv[2]; if (!input) throw new Error('Pass the native artifact directory.');
const sandbox = mkdtempSync(join(tmpdir(), 'arco-pack-smoke-'));
const stage = join(sandbox, 'stage'), next = join(sandbox, 'next'), home = join(sandbox, 'home'), bin = join(sandbox, 'bin');
const prefix = process.platform === 'win32' ? join(home, 'AppData', 'Roaming', 'npm') : join(home, '.local', 'share', 'arco-prefix');
mkdirSync(home); mkdirSync(bin);
for (const name of ['claude', 'codex', 'cursor-agent', 'agent', 'ollama', 'llama-server', 'llama-cli', 'lms', 'xolotl', 'systemctl', 'journalctl', 'schtasks', 'launchctl', 'gh', 'docker', 'podman', 'curl', 'wget', 'ssh']) {
  writeFileSync(join(bin, name), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  if (process.platform === 'win32') writeFileSync(join(bin, `${name}.cmd`), '@exit /b 97\r\n');
}
const env = { HOME: home, USERPROFILE: home, TMP: sandbox, TEMP: sandbox, TMPDIR: sandbox, ARCO_HOME: join(home, '.arco'), ARCO_UPDATE_CHECK: '0', npm_config_userconfig: join(home, 'npmrc'), npm_config_globalconfig: join(home, 'global-npmrc'), npm_config_cache: join(home, 'npm-cache'), npm_execpath: process.env.npm_execpath, PATH: [bin, dirname(process.execPath), process.env.PATH || ''].join(delimiter), CI: '1' };
for (const key of ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'SystemDrive', 'ProgramData', 'ProgramFiles', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) if (process.env[key]) env[key] = process.env[key];
const npm = env.npm_execpath;
const plainNpm = process.env.ARCO_SMOKE_PLAIN_NPM || npm;
if (!npm || !existsSync(npm)) throw new Error('Run this smoke through npm 12.');
if (!plainNpm || !existsSync(plainNpm)) throw new Error('The plain-install npm CLI was not found.');
function command(executable, args, options = {}) {
  const r = spawnSync(executable, args, { encoding: 'utf8', env, ...options });
  if (r.error || r.status !== 0) throw new Error(`${executable === process.execPath ? 'node' : executable} ${args[0]} failed`);
  return r.stdout;
}
const node = (...args) => command(process.execPath, args);
const runNpm = (args, options = {}) => command(process.execPath, [npm, ...args], options);
let child, restartedPid;
try {
  if (!/^12\./.test(runNpm(['--version']).trim())) throw new Error('The package smoke requires npm 12.');
  node(join(root, 'scripts/packaging/assemble.mjs'), stage, resolve(input), ...(process.env.ARCO_PACKAGE_SMOKE_HOST_ONLY === '1' ? ['--host-only'] : []));
  runNpm(['pack', '--ignore-scripts', '--pack-destination', sandbox], { cwd: stage });
  const builtManifest = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
  if (process.env.ARCO_PACKAGE_SMOKE_HOST_ONLY === '1' ? builtManifest.private !== true : builtManifest.private === true) throw new Error('The package publication guard is incorrect.');
  const name = builtManifest.name;
  const version = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8')).version;
  const archive = join(sandbox, `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`);
  const unpacked = join(sandbox, 'unpacked'); mkdirSync(unpacked);
  command('tar', ['-xzf', basename(archive), '-C', 'unpacked', '--strip-components=1'], { cwd: sandbox });
  for (const name of ['node-pty.txt', 'winpty.txt', 'node-addon-api.txt', 'better-sqlite3.txt', 'NOTICE.md']) if (!existsSync(join(unpacked, 'native', 'licenses', name))) throw new Error('A native component license is missing.');
  const audit = spawnSync(process.execPath, [join(root, 'scripts/public-audit.mjs'), '--package', unpacked], { cwd: root, encoding: 'utf8', env });
  if (audit.error || audit.status !== 0) {
    const assetDir = join(unpacked, 'client', 'dist', 'assets');
    for (const name of readdirSync(assetDir).filter((value) => /^index-.*\.js$/.test(value))) console.error(`Compiled client digest: ${createHash('sha256').update(readFileSync(join(assetDir, name))).digest('hex')}`);
    // The audit emits relative file labels and rule names only, never values.
    console.error((audit.stderr || '').slice(0, 5000));
    throw new Error('The extracted package did not pass the public audit.');
  }
  runNpm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', archive]);
  const plainPrefix = join(sandbox, 'plain-prefix');
  const plainInstall = spawnSync(process.execPath, [plainNpm, 'install', '--global', '--prefix', plainPrefix, '--foreground-scripts', '--loglevel=info', '--no-audit', '--no-fund', archive], {
    encoding: 'utf8', env: { ...env, CC: 'arco-no-compiler', CXX: 'arco-no-compiler' }, timeout: 300_000,
  });
  if (plainInstall.error || plainInstall.status !== 0) {
    const codes = [...new Set(`${plainInstall.stdout || ''}\n${plainInstall.stderr || ''}`.match(/\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EACCES|EPERM|ENOSPC)\b/g) || [])];
    const spawnError = /^(?:ETIMEDOUT|ENOENT|EACCES|EPERM)$/.test(plainInstall.error?.code || '') ? plainInstall.error.code : 'none';
    throw new Error(`Plain package installation failed without native build tools (status ${Number.isInteger(plainInstall.status) ? plainInstall.status : 'none'}, process ${spawnError}, npm codes ${codes.join(', ') || 'none'}).`);
  }
  if (/node-gyp|gyp info|gyp ERR!/i.test(`${plainInstall.stdout || ''}\n${plainInstall.stderr || ''}`)) throw new Error('Plain package installation attempted a native compile.');
  const plainRoot = join(plainPrefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', ...name.split('/'));
  const installedPty = JSON.parse(readFileSync(join(plainRoot, 'node_modules', 'node-pty', 'package.json'), 'utf8'));
  const installedSqlite = JSON.parse(readFileSync(join(plainRoot, 'node_modules', 'better-sqlite3', 'package.json'), 'utf8'));
  if (installedPty.scripts?.install || installedPty.scripts?.postinstall || installedSqlite.scripts?.install || installedSqlite.gypfile !== false) throw new Error('A native dependency still has an install-time build hook.');
  const packageRoot = join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', ...name.split('/'));
  const cli = join(packageRoot, 'scripts/packaging/arco.mjs');
  if (process.env.GITHUB_ACTIONS === 'true') {
    // Hosted runners are isolated. Reserve the default range to exercise real
    // startup selection without touching any operator's local workbench.
    const holders = []; let fixture;
    const fixtureHome = join(sandbox, 'port-home');
    const fixtureEnv = { ...env, ARCO_HOME: fixtureHome, ARCO_PORT: '3001' };
    const statePath = join(fixtureHome, 'port-state.json');
    const startFixture = async () => {
      fixture = spawn(process.execPath, [cli, 'start'], { env: fixtureEnv, stdio: 'ignore', windowsHide: true });
      for (let i = 0; i < 150; i++) {
        try {
          const state = JSON.parse(readFileSync(statePath, 'utf8'));
          const response = await fetch(`http://127.0.0.1:${state.port}/healthz`, { signal: AbortSignal.timeout(500) });
          if (response.ok && (await response.json()).pid === fixture.pid) return state.port;
        } catch { /* startup is still in progress */ }
        if (fixture.exitCode !== null) break;
        await new Promise((ok) => setTimeout(ok, 200));
      }
      throw new Error('Port recovery fixture did not start.');
    };
    const stopFixture = async () => {
      if (fixture && fixture.exitCode === null && fixture.signalCode === null) { fixture.kill(); await new Promise((ok) => fixture.once('exit', ok)); }
      fixture = undefined;
    };
    try {
      for (let port = 3001; port <= 3010; port++) { const holder = createServer((socket) => socket.destroy()); await new Promise((ok, fail) => { holder.once('error', fail); holder.listen(port, '127.0.0.1', ok); }); holders.push(holder); }
      const first = await startFixture();
      if (first <= 3010) throw new Error('Setup did not skip the occupied port range.');
      const duplicate = spawnSync(process.execPath, [cli, 'start'], { env: fixtureEnv, stdio: 'ignore', windowsHide: true, timeout: 30000 });
      if (duplicate.status !== 0) throw new Error('A second launch did not identify the running Arco home.');
      await stopFixture();
      const blocker = createServer((socket) => socket.destroy()); await new Promise((ok, fail) => { blocker.once('error', fail); blocker.listen(first, '127.0.0.1', ok); }); holders.push(blocker);
      fixtureEnv.ARCO_PORT = String(first);
      const second = await startFixture();
      if (second === first) throw new Error('The occupied saved port was reused.');
      const launcher = await import(pathToFileURL(join(packageRoot, 'scripts/packaging/launch.mjs')).href);
      let opened;
      await launcher.openArco({ tab: true, env: fixtureEnv, platform: process.platform, launch: (_cmd, args) => { opened = args[args.length - 1]; } });
      if (opened !== `http://localhost:${second}/`) throw new Error('The launcher did not follow the moved port.');
      await stopFixture(); delete fixtureEnv.ARCO_PORT;
      if (await startFixture() !== second) throw new Error('The moved port did not persist after restart.');
    } finally {
      await stopFixture();
      await Promise.all(holders.map((holder) => new Promise((ok) => holder.close(ok))));
    }
  }
  if (node(cli, 'version').trim() !== version) throw new Error('Installed version does not match.');
  const executable = join(prefix, ...(process.platform === 'win32' ? [] : ['bin']), process.platform === 'win32' ? 'arco.cmd' : 'arco');
  const fromShim = process.platform === 'win32' ? command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '& $env:ARCO_SMOKE_SHIM version; exit $LASTEXITCODE'], { env: { ...env, ARCO_SMOKE_SHIM: executable } }) : command(executable, ['version']);
  if (fromShim.trim() !== version) throw new Error('The installed arco command did not run.');
  env.ARCO_SHORTCUTS_DIR = join(sandbox, 'shortcuts');
  node(cli, 'shortcuts', 'add');
  const shortcut = join(env.ARCO_SHORTCUTS_DIR, process.platform === 'win32' ? 'Arco.lnk' : process.platform === 'darwin' ? 'Arco.app' : 'arco.desktop');
  if (!existsSync(shortcut)) throw new Error('The installed package did not create its shortcut.');
  if (process.platform === 'win32') {
    const check = "$s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut($env:ARCO_SMOKE_LINK); if ($l.TargetPath -notmatch 'wscript.exe$' -or $l.Arguments -notmatch 'open' -or $l.Arguments -notmatch 'arco.mjs') { exit 1 }";
    command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], { env: { ...env, ARCO_SMOKE_LINK: shortcut } });
  } else if (process.platform === 'darwin') {
    if (!readFileSync(join(shortcut, 'Contents/Info.plist'), 'utf8').includes('CFBundleExecutable') || !existsSync(join(shortcut, 'Contents/MacOS/Arco')) || !existsSync(join(shortcut, 'Contents/Resources/arco.icns'))) throw new Error('The application bundle is incomplete.');
  } else if (!readFileSync(shortcut, 'utf8').includes('Terminal=false')) throw new Error('The desktop shortcut is invalid.');
  node(cli, 'shortcuts', 'remove');
  if (existsSync(shortcut)) throw new Error('The shortcut was not removed.');
  const serviceModule = await import(pathToFileURL(join(packageRoot, 'scripts/packaging/services.mjs')).href);
  const unitPaths = { home: env.ARCO_HOME, config: join(env.ARCO_HOME, 'service/config.json'), unit: join(home, 'unit') };
  const calls = [];
  await serviceModule.serviceAction('install', { platform: process.platform, paths: unitPaths, env: { ...env, USERNAME: 'Fixture', USERDOMAIN: 'LOCAL' }, uid: 1000, run: (cmd, args) => { calls.push([cmd, ...args]); return { status: args.includes('/Query') || args[0] === 'print' ? 1 : 0 }; } });
  if (process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true') {
    const verifyUnit = join(sandbox, 'arco.service');
    cpSync(unitPaths.unit, verifyUnit);
    const verify = spawnSync('systemd-analyze', ['--user', 'verify', verifyUnit], { encoding: 'utf8', env: process.env });
    if (verify.error?.code === 'ENOENT') console.log('systemd-analyze unavailable; unit verification skipped.');
    else if (verify.error || verify.status !== 0) throw new Error(`systemd unit verification failed: ${(verify.stderr || verify.error?.message || '').slice(0, 2000)}`);
    else console.log('systemd user unit verified.');
  }
  if (!calls.some((args) => args.includes('enable') || args.includes('bootstrap') || args.includes('/Create'))) throw new Error('Service manager did not receive the install request.');
  if (process.platform === 'win32') {
    // The service task starts node through wscript.exe and the JScript launcher written at install.
    // Run that exact launcher (a path with spaces on purpose) and require the marker.
    const spaced = join(sandbox, 'dir with space'); mkdirSync(spaced);
    const marker = join(spaced, 'launcher-ran.txt');
    const script = join(spaced, 'probe.cjs');
    writeFileSync(script, `require('fs').writeFileSync(process.argv[2], 'ok');\n`);
    const launcher = join(dirname(unitPaths.config), 'launch.js');
    if (!existsSync(launcher)) throw new Error('The service launcher was not written at install.');
    const ran = spawnSync(serviceModule.windowsScriptHost(process.env), ['//B', '//Nologo', launcher, process.execPath, script, marker], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (!existsSync(marker)) throw new Error(`The service launcher did not run node (status ${ran.status}, signal ${ran.signal}, error ${ran.error?.code ?? 'none'}).`);
    // Ending the task kills only wscript.exe, so the real stop path must also end node and free the port.
    // Run a stand-in service through the launcher with the same command-line shape as service-run, simulate /End
    // by killing only the launcher process, then run the real stop code and require both processes gone.
    const holder = join(spaced, 'arco.mjs'), pidFile = join(spaced, 'holder.pid');
    writeFileSync(holder, `import { createServer } from 'node:net'; import { writeFileSync } from 'node:fs'; const s = createServer().listen(0, '127.0.0.1', () => writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + s.address().port));\nsetInterval(() => {}, 1000);\n`);
    const host = spawn(serviceModule.windowsScriptHost(process.env), ['//B', '//Nologo', launcher, process.execPath, holder, 'service-run', unitPaths.config], { stdio: 'ignore', windowsHide: true });
    let held = ''; for (let i = 0; i < 100 && !held; i++) { if (existsSync(pidFile)) held = readFileSync(pidFile, 'utf8'); else await new Promise((ok) => setTimeout(ok, 200)); }
    const [nodePid, heldPort] = held.split(' ').map(Number);
    if (!nodePid) throw new Error('The stand-in service did not start through the launcher.');
    const clearRecordedPid = serviceModule.writeWindowsServicePid(env.ARCO_HOME, nodePid);
    const { waitForRecordedPid } = await import(pathToFileURL(join(packageRoot, 'scripts/packaging/update.mjs')).href);
    const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const portFree = () => new Promise((ok) => { const probe = createServer(); probe.once('error', () => ok(false)); probe.listen(heldPort, '127.0.0.1', () => probe.close(() => ok(true))); });
    if (await portFree()) throw new Error('The stand-in service is not holding its port.');
    const stopRun = (cmd, args, options = {}) => cmd === 'schtasks.exe' ? (spawnSync('taskkill.exe', ['/PID', String(host.pid), '/F'], { stdio: 'ignore' }), { status: 0 }) : spawnSync(cmd, args, { ...options, windowsHide: true });
    // An unrelated Node process mentioning the same config path must survive.
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', unitPaths.config], { stdio: 'ignore', windowsHide: true });
    try {
      if (!unrelated.pid || !isAlive(unrelated.pid)) throw new Error('The unrelated process fixture did not start.');
      await serviceModule.serviceAction('stop', { platform: 'win32', paths: unitPaths, env: { ...env, USERNAME: 'Fixture', USERDOMAIN: 'LOCAL' }, run: stopRun });
      for (let i = 0; i < 50 && (isAlive(nodePid) || isAlive(host.pid)); i++) await new Promise((ok) => setTimeout(ok, 200));
      if (isAlive(nodePid)) { try { process.kill(nodePid); } catch {} throw new Error('Stopping the service left the Node process running.'); }
      if (isAlive(host.pid)) throw new Error('Stopping the service left the launcher running.');
      if (!isAlive(unrelated.pid)) throw new Error('Stopping the service killed an unrelated Node process.');
      if (await waitForRecordedPid(nodePid)) throw new Error('The recorded service process remained live after stop.');
      clearRecordedPid();
      if (!(await portFree())) throw new Error('Stopping the service did not free the port.');
    } finally { try { unrelated.kill(); } catch {} }
    const def = readFileSync(unitPaths.unit).toString('utf16le');
    if (!/wscript\.exe<\/Command><Arguments>\/\/B \/\/Nologo /.test(def)) throw new Error('The service definition does not use the windowless launcher.');
  }
  const listener = createServer(); await new Promise((ok) => listener.listen(0, '127.0.0.1', ok));
  const port = listener.address().port; await new Promise((ok) => listener.close(ok)); env.ARCO_PORT = String(port);
  const doctor = node(cli, 'doctor'); if (!doctor.includes('Native modules: ready')) throw new Error('Packaged native modules are not usable.');
  const plainDoctor = node(join(plainRoot, 'scripts/packaging/arco.mjs'), 'doctor'); if (!plainDoctor.includes('Native modules: ready')) throw new Error('The plain npm 12 install cannot load native modules.');
  const probe = `import { createRequire } from 'node:module';
import { activateRepairedTerminal } from ${JSON.stringify(pathToFileURL(join(packageRoot, 'scripts/packaging/native-repair.mjs')).href)};
activateRepairedTerminal(); console.log('terminal-binding-ready');
const pty = createRequire(${JSON.stringify(pathToFileURL(join(packageRoot, 'package.json')).href)})('node-pty');
const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
const args = process.platform === 'win32' ? ['/d', '/c', 'exit', '0'] : ['-c', 'exit 0'];
const term = pty.spawn(command, args, { cols: 80, rows: 24, cwd: process.cwd(), env: process.env }); console.log('terminal-started'); term.onData(() => {});
await new Promise((ok, fail) => { const timer = setTimeout(() => { term.kill(); fail(new Error('terminal timeout')); }, 30000); term.onExit(({ exitCode }) => { clearTimeout(timer); console.log('terminal-exited'); exitCode === 0 ? ok() : fail(new Error('terminal failed')); }); });
const setup = pty.spawn(process.execPath, [${JSON.stringify(join(plainRoot, 'scripts/packaging/arco.mjs'))}, 'setup'], { cols: 100, rows: 30, cwd: process.cwd(), env: process.env });
let setupText = '', answered = false;
setup.onData((chunk) => { setupText += chunk; if (!answered && setupText.includes('[Y/n]')) { answered = true; setup.write('n\\r'); } });
await new Promise((ok, fail) => { const timer = setTimeout(() => { setup.kill(); fail(new Error('setup timeout')); }, 30000); setup.onExit(({ exitCode }) => { clearTimeout(timer); if (exitCode !== 0 || !answered || !setupText.includes('Run arco start')) fail(new Error('setup failed')); else { console.log('setup-complete'); ok(); } }); });
process.exit(0);`;
  const terminalProbe = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', env, timeout: 45000 });
  if (terminalProbe.error || terminalProbe.status !== 0) {
    const markers = (terminalProbe.stdout || '').split(/\r?\n/).filter((line) => /^(terminal-binding-ready|terminal-started|terminal-exited|setup-complete)$/.test(line));
    throw new Error(`Packaged terminal probe failed (${markers.join(', ') || 'no milestones'}).`);
  }
  child = spawn(process.execPath, [cli, 'start'], { cwd: home, env, stdio: 'ignore', windowsHide: true });
  let live = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) }); if (response.ok) { live = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise((ok) => setTimeout(ok, 200));
  }
  if (!live) throw new Error('Packaged server did not reach healthz.');
  const appBase = `http://localhost:${port}`;
  const appSession = await fetch(`${appBase}/api/session`, { method: 'POST', headers: { Origin: appBase, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } });
  const appCookie = appSession.headers.get('set-cookie')?.split(';')[0];
  if (!appSession.ok || !appCookie) throw new Error('Could not create an app-window session.');
  const appDocs = await fetch(`${appBase}/api/docs?file=docs%2FVOICE.md`, { headers: { Cookie: appCookie, Origin: appBase } });
  if (!appDocs.ok) throw new Error('The app-window session cookie was not accepted.');
  const base = `http://127.0.0.1:${port}`;
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } });
  const cookie = session.headers.get('set-cookie')?.split(';')[0];
  if (!session.ok || !cookie) throw new Error('Could not create a fixture session.');
  const docs = await fetch(`${base}/api/docs?file=docs%2FVOICE.md`, { headers: { Cookie: cookie, Origin: base } });
  if (!docs.ok) { const body = await docs.json().catch(() => ({})); throw new Error(`The packaged manual reference is missing (HTTP ${docs.status}, ${body.error?.includes('protected state') ? 'protected state' : body.error?.includes('ENOENT') ? 'not found' : 'other error'}).`); }
  const originalPid = (await (await fetch(`${base}/healthz`)).json()).pid;
  const restart = await fetch(`${base}/api/restart`, { method: 'POST', headers: { Cookie: cookie, Origin: base } });
  if (!restart.ok) throw new Error('Packaged foreground restart was refused.');
  if (child.exitCode === null && child.signalCode === null) await new Promise((ok) => child.once('exit', ok)); child = undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) }); const info = await r.json(); if (r.ok && info.pid !== originalPid) { restartedPid = info.pid; break; } } catch {}
    await new Promise((ok) => setTimeout(ok, 200));
  }
  if (!restartedPid) throw new Error('The packaged foreground restart did not return.');
  process.kill(restartedPid, 'SIGTERM');
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(restartedPid, 0); } catch { restartedPid = undefined; break; }
    await new Promise((ok) => setTimeout(ok, 100));
  }
  // The process may be a zombie until its supervisor reaps it; the socket is
  // the relevant resource for the following package update.
  restartedPid = undefined;
  cpSync(stage, next, { recursive: true });
  const nextManifest = JSON.parse(readFileSync(join(next, 'package.json'), 'utf8')); nextManifest.version = '0.1.1';
  writeFileSync(join(next, 'package.json'), JSON.stringify(nextManifest, null, 2));
  const serverManifest = JSON.parse(readFileSync(join(next, 'server/package.json'), 'utf8')); serverManifest.version = '0.1.1';
  writeFileSync(join(next, 'server/package.json'), JSON.stringify(serverManifest, null, 2));
  runNpm(['pack', '--ignore-scripts', '--pack-destination', sandbox], { cwd: next });
  const nextArchive = join(sandbox, `${name.replace(/^@/, '').replace('/', '-')}-0.1.1.tgz`);
  const { updatePackage } = await import(pathToFileURL(join(packageRoot, 'scripts/packaging/update.mjs')).href);
  const actions = [];
  await updatePackage(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')), packageRoot, { env, home: env.ARCO_HOME, npm, managed: true, target: nextArchive, windowsRunning: async () => false, service: async (action) => actions.push(action) });
  if (actions.join(',') !== 'stop,start' || JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version !== '0.1.1') throw new Error('Local package update did not complete.');
  console.log('Package install, health, docs, native modules, fake service and local update passed.');
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise((ok) => child.once('exit', ok)); }
  if (restartedPid) { try { process.kill(restartedPid, 'SIGTERM'); } catch {} }
  rmSync(sandbox, { recursive: true, force: true });
}
