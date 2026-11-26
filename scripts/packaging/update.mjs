// Package updates snapshot the installed tree before replacing files.
import { spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { npmCliPath } from './native-repair.mjs';
import { readWindowsServicePid, runWindowsProbe, serviceAction, servicePaths } from './services.mjs';

export function compareVersions(a, b) {
  const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
  const x = pattern.exec(a), y = pattern.exec(b); if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) { const diff = BigInt(x[i]) - BigInt(y[i]); if (diff) return diff > 0n ? 1 : -1; }
  if (!x[4] || !y[4]) return x[4] === y[4] ? 0 : x[4] ? -1 : 1;
  const left = x[4].split('.'), right = y[4].split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined || right[i] === undefined) return left[i] === undefined ? -1 : 1;
    if (left[i] === right[i]) continue;
    const ln = /^\d+$/.test(left[i]), rn = /^\d+$/.test(right[i]);
    if (ln && rn) return BigInt(left[i]) > BigInt(right[i]) ? 1 : -1;
    if (ln !== rn) return ln ? -1 : 1;
    return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}
export function globalPrefix(root, platform = process.platform) {
  const parent = dirname(resolve(root));
  const modules = basename(parent) === 'node_modules'
    ? parent
    : basename(parent).startsWith('@') && basename(dirname(parent)) === 'node_modules'
      ? dirname(parent)
      : null;
  if (!modules) throw new Error('This is not a global npm installation.');
  return platform === 'win32' ? dirname(modules) : dirname(dirname(modules));
}
export function writeUpdateResult(resultFile, attemptId, result, now = Date.now) {
  const attempt = JSON.parse(readFileSync(resultFile, 'utf8'));
  if (attempt.attemptId !== attemptId || attempt.outcome !== 'running') return false;
  writeFileSync(resultFile, JSON.stringify({ ...attempt, outcome: result.outcome, ...(typeof result.message === 'string' ? { message: result.message } : {}), finishedAt: now() }), { mode: 0o600 });
  return true;
}
// npm diagnostics can contain registry credentials, URLs and local paths.
const safeErrorCodes = new Set([
  'E401', 'E403', 'E404', 'E405', 'E429', 'E500', 'E502', 'E503', 'E504',
  'EACCES', 'EAUTH', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EEXIST',
  'EINTEGRITY', 'EINVAL', 'EIO', 'ENOENT', 'ENOMSG', 'ENOSPC', 'ENOTCACHED',
  'ENOTEMPTY', 'ENOTFOUND', 'EOVERFLOW', 'EPERM', 'ERESOLVE', 'ETARGET',
  'ETIMEDOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN',
]);

function npmFailure(result) {
  const diagnostic = /^npm (?:error|ERR!) code ([A-Z0-9_]+)\r?$/mi;
  const code = result.error?.code ?? diagnostic.exec(result.stderr ?? '')?.[1] ?? diagnostic.exec(result.stdout ?? '')?.[1];
  if (safeErrorCodes.has(code)) return ' (' + code + ')';
  return Number.isInteger(result.status) ? ' (npm exit ' + result.status + ')' : '';
}

const publicRegistry = '--registry=https://registry.npmjs.org/';

function stagePackage(call, name, version, scratch) {
  const expectedName = `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
  const archive = join(scratch, expectedName);
  const result = call('Package download failed', [
    'pack', `${name}@${version}`, '--json', '--ignore-scripts', '--pack-destination', scratch,
    publicRegistry, '--prefer-online', '--fetch-retries=0', '--fetch-timeout=30000',
  ], { timeout: 90_000 });
  let packed, stat;
  try {
    stat = lstatSync(archive, { throwIfNoEntry: false });
    packed = JSON.parse(result.stdout);
  } catch { /* invalid npm output or archive */ }
  if (!Array.isArray(packed) || packed.length !== 1 || packed[0]?.name !== name
    || packed[0]?.version !== version || packed[0]?.filename !== expectedName || !stat?.isFile() || stat.size === 0) {
    throw new Error('Package download failed: npm did not stage the requested archive');
  }
  return archive;
}

export async function updatePackage(manifest, packageRoot, deps = {}) {
  const root = resolve(packageRoot);
  const env = deps.env ?? process.env, platform = deps.platform ?? process.platform;
  const home = deps.home ?? servicePaths(platform, env).home;
  const prefix = deps.prefix ?? globalPrefix(root, platform);
  let npm = deps.npm;
  if (!npm) {
    try { npm = npmCliPath(env, process.execPath, { packageRoot: root }); }
    catch (error) { throw new Error(`${error.message} To update manually, stop Arco, run npm install -g arco-workbench, then start Arco again.`); }
  }
  const run = deps.run ?? ((command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', env: { ...env, npm_config_cache: env.npm_config_cache || join(home, 'cache', 'npm') }, ...options }));
  const service = deps.service ?? ((action) => serviceAction(action));
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Package updates require a regular global installation, not a linked checkout.');
  const windowsRunning = deps.windowsRunning ?? (() => windowsArcoRunning());
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest.name)) throw new Error('Invalid package name.');
  if (deps.expected && !/^v\d+\.\d+\.\d+$/.test(deps.expected)) throw new Error('Invalid expected release.');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(home, 'package-update.lock'); let lockFd;
  try { lockFd = openSync(lock, 'wx', 0o600); } catch { throw new Error('Another update may be running. Verify that no update is active before removing package-update.lock from the Arco home.'); }
  let scratch, backup, preserve = false;
  let stopped = false, installAttempted = false;
  const call = (stage, args, options = {}) => {
    const result = run(process.execPath, [npm, ...args], options);
    if (result.error || result.status !== 0) throw new Error(stage + npmFailure(result));
    return result;
  };
  try {
    scratch = mkdtempSync(join(home, '.update-'));
    backup = join(scratch, 'previous-package');
    let version;
    if (!deps.target) {
      const result = call('Could not check npm for updates', [
        'view', `${manifest.name}@latest`, 'version', '--json', publicRegistry,
        '--prefer-online', '--fetch-retries=0', '--fetch-timeout=5000',
      ], { timeout: 10_000 });
      let parsed;
      try { parsed = JSON.parse(result.stdout); } catch { /* invalid npm output */ }
      version = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
      if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
        throw new Error('npm did not return a stable release version');
      }
      if (deps.expected && deps.expected !== `v${version}`) {
        throw new Error('The latest npm version changed. Use CHECK NOW to review it before updating');
      }
      const order = compareVersions(version, manifest.version);
      if (order === null) throw new Error('The installed or target package version is invalid.');
      if (order < 0) throw new Error('The latest package is older than this installation. A downgrade is not performed.');
      if (order === 0) return { outcome: 'unchanged', message: 'Already on the newest release.' };
    }
    const archive = deps.target ?? stagePackage(call, manifest.name, version, scratch);
    // Dependencies are not all bundled in the tarball. A full local snapshot
    // permits rollback even when the registry or the network is unavailable.
    cpSync(root, backup, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    if (!existsSync(join(backup, 'package.json'))) throw new Error('The rollback snapshot was not created.');
    const config = deps.config ?? servicePaths(platform, env).config;
    const managed = deps.managed ?? existsSync(config);
    const servicePid = platform === 'win32' && managed ? readWindowsServicePid(home) : null;
    if (managed) { await service('stop'); stopped = true; }
    if (platform === 'win32') {
      const running = servicePid ? await waitForRecordedPid(servicePid, deps) : await windowsRunning();
      if (running) throw new Error(servicePid ? `The Arco service process ${servicePid} is still running. Stop it before updating on Windows.` : 'Stop all Arco processes before updating on Windows.');
    }
    installAttempted = true;
    call('Package installation failed', ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, archive]);
    // The new package may define the service differently. A fresh process loads
    // the new code to
    // rewrite an unmodified Arco-owned definition; a failure keeps the old one.
    let refreshNote = '';
    if (managed && (platform === 'win32' || platform === 'linux')) {
      const refresh = deps.refresh ?? (() => run(process.execPath, [join(root, 'scripts/packaging/arco.mjs'), 'service', 'refresh'], { windowsHide: true }));
      try { const r = await refresh(); if (r?.error || (r?.status ?? 0) !== 0) refreshNote = ' The service definition was not refreshed; run arco service refresh.'; }
      catch { refreshNote = ' The service definition was not refreshed; run arco service refresh.'; }
    }
    if (stopped) { await service('start'); stopped = false; }
    return { outcome: 'updated', message: `Updated${version ? ` to v${version}` : ` ${manifest.name}`}; ${managed ? 'service restarted' : 'restart Arco to use the update'}.${refreshNote}` };
  } catch (error) {
    const detail = String(error.message).replace(/[.\s]+$/, '');
    let damaged;
    if (installAttempted) {
      // Keep both copies until a complete restoration is available. If the
      // copy fails, retain the snapshot and report its location for recovery.
      damaged = `${root}.arco-update-failed-${process.pid}`;
      try {
        if (lstatSync(damaged, { throwIfNoEntry: false })) throw new Error('A previous failed update needs manual recovery.');
        if (lstatSync(root, { throwIfNoEntry: false })) renameSync(root, damaged);
        try { cpSync(backup, root, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false }); }
        catch (copyError) { rmSync(root, { recursive: true, force: true }); if (lstatSync(damaged, { throwIfNoEntry: false })) renameSync(damaged, root); throw copyError; }
      } catch (rollback) {
        preserve = true;
        const code = safeErrorCodes.has(rollback.code) ? ' (' + rollback.code + ')' : '';
        throw new Error(`Update failed: ${detail}. Could not restore the previous package${code}. Keep Arco stopped and copy the snapshot back to the original package folder. Previous package snapshot: ${backup}`);
      }
    }
    if (stopped) {
      try { await service('start'); }
      catch {
        preserve = true;
        const recovery = installAttempted
          ? `The previous package was restored. Previous package snapshot: ${backup}`
          : 'The installed package was left unchanged.';
        throw new Error(`Update failed: ${detail}. The service could not restart. Check the service and run arco service start after resolving the error. ${recovery}`);
      }
    }
    const recovery = installAttempted ? ' The previous package was restored.' + (stopped ? ' The service was restarted.' : '') : '';
    let cleanupNote = '';
    if (damaged) {
      try { rmSync(damaged, { recursive: true, force: true }); }
      catch { cleanupNote = ' The failed package remains in quarantine beside the installation.'; }
    }
    throw new Error(`Update failed: ${detail}.${recovery}${cleanupNote}`);
  } finally {
    try { if (scratch && !preserve) rmSync(scratch, { recursive: true, force: true }); }
    finally { closeSync(lockFd); try { unlinkSync(lock); } catch { /* stale lock fails closed */ } }
  }
}

export async function waitForRecordedPid(pid, deps = {}) {
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const kill = deps.kill ?? process.kill.bind(process);
  const deadline = now() + 20_000;
  while (true) {
    try { kill(pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') return false;
      if (error.code !== 'EPERM') throw new Error('Cannot verify that the Arco service stopped on Windows.');
    }
    if (now() >= deadline) return true;
    await sleep(Math.min(500, deadline - now()));
  }
}

export async function windowsArcoRunning(run = runWindowsProbe) {
  const expression = String.raw`$ErrorActionPreference='Stop'; $nodes=@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"); if (@($nodes | Where-Object { [String]::IsNullOrWhiteSpace([string]$_.CommandLine) }).Count -gt 0) { throw 'Cannot inspect process command lines.' }; @($nodes | Where-Object { $_.CommandLine -match '(?i)(arco\.mjs.{0,3}\s+"?(start|service-run)(?:\s|"|$)|scripts[/\\]start\.mjs|server[/\\]dist[/\\]index\.js)' }).Count`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', expression], { timeout: 30_000 });
    if (!result.error && result.status === 0 && /^\d+$/.test((result.stdout || '').trim())) return Number(result.stdout.trim()) > 0;
  }
  throw new Error('Cannot verify that Arco is stopped on Windows after two process checks. Stop Arco and try again.');
}
