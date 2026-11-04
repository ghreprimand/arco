#!/usr/bin/env node
// Dependency-free updater. All commands receive argv arrays; no shell is used.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { writeUpdateResult } from './packaging/update.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stable = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function compareVersions(a, b) {
  const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
  const x = pattern.exec(a), y = pattern.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) { const d = BigInt(x[i]) - BigInt(y[i]); if (d) return d > 0n ? 1 : -1; }
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
export function compareTags(a, b) {
  return stable.test(a) && stable.test(b) ? compareVersions(a.slice(1), b.slice(1)) : null;
}
export function canonicalCheckoutPath(dir, platform = process.platform, realpath = realpathSync.native) {
  const path = realpath(dir);
  return platform === 'win32' ? path.replace(/\\/g, '/').toLowerCase() : path;
}
export function checkoutFingerprint(dir, platform = process.platform, realpath = realpathSync.native) {
  return createHash('sha256').update(canonicalCheckoutPath(dir, platform, realpath)).digest('hex');
}
export function npmCommand(env = process.env, executable = process.execPath, platform = process.platform) {
  if (platform !== 'win32') return { command: 'npm', prefix: [] };
  const candidates = [env.npm_execpath, join(dirname(executable), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const cli = candidates.find((p) => p && p.endsWith('.js') && existsSync(p));
  if (!cli) throw new Error('Cannot locate npm-cli.js. Start the updater using npm run arco:update.');
  return { command: executable, prefix: [cli] };
}
export function parseArgs(args) {
  const opts = { ref: null, main: false, yes: false, check: false, dry: false, downgrade: false, resultFile: null, expectedRelease: null, attemptId: null, requireService: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--ref' || a === '--result-file' || a === '--expected-release' || a === '--attempt-id') { if (!args[i+1] || args[i+1].startsWith('--')) throw new Error(`${a} needs a value`); opts[a === '--ref' ? 'ref' : a === '--result-file' ? 'resultFile' : a === '--attempt-id' ? 'attemptId' : 'expectedRelease'] = args[++i]; }
    else if (a === '--main') opts.main = true;
    else if (a === '--yes') opts.yes = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--dry-run') opts.dry = true;
    else if (a === '--allow-downgrade') opts.downgrade = true;
    else if (a === '--require-service') opts.requireService = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  if (opts.expectedRelease && (!stable.test(opts.expectedRelease) || opts.ref || opts.main)) throw new Error('Invalid expected release.');
  if (opts.attemptId && !/^[a-f0-9-]{36}$/.test(opts.attemptId)) throw new Error('Invalid update attempt.');
  if (opts.ref && opts.main) throw new Error('Choose either --ref or --main.');
  if (opts.ref && !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(opts.ref)) throw new Error('Use a tag or commit hash with --ref.');
  return opts;
}
export async function update(opts, deps = {}) {
  const cwd = deps.cwd ?? root;
  const run = deps.run ?? ((command, args) => spawnSync(command, args, { cwd, encoding: 'utf8' }));
  const result = run('git', ['rev-parse', '--git-path', 'arco-update.lock']);
  if (result.error || result.status !== 0) throw new Error('Not a Git checkout.');
  const lock = resolve(cwd, (result.stdout || '').trim());
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Another update may be running. After confirming none is active, remove the file named by git rev-parse --git-path arco-update.lock.');
    throw new Error('Could not create the update lock.');
  }
  try { return await performUpdate(opts, deps); }
  finally { closeSync(fd); try { unlinkSync(lock); } catch { /* leave a stale lock rather than risk another update */ } }
}
async function performUpdate(opts, deps = {}) {
  const cwd = deps.cwd ?? root, platform = deps.platform ?? process.platform, env = deps.env ?? process.env;
  const run = deps.run ?? ((command, args, options = {}) => spawnSync(command, args, { cwd, encoding: 'utf8', ...options }));
  const git = (...args) => { const r = run('git', args); if (r.error || r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.error?.message || '').trim()}`); return (r.stdout || '').trim(); };
  const call = (command, args) => { const r = run(command, args, { stdio: 'inherit' }); if (r.error || r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`); };
  const report = (deps.report ?? console.log);
  if (env.ARCO_DEPLOYMENT === 'docker') throw new Error('Update the Docker checkout on the host, then run docker compose up -d --build.');
  if (canonicalCheckoutPath(git('rev-parse', '--show-toplevel'), platform, deps.realpath) !== canonicalCheckoutPath(cwd, platform, deps.realpath)) throw new Error('Run the updater from the Arco checkout root.');
  const current = git('rev-parse', 'HEAD');
  for (const args of [['diff', '--quiet', '--ignore-cr-at-eol'], ['diff', '--cached', '--quiet']]) {
    const diff = run('git', args);
    if (diff.error || (diff.status !== 0 && diff.status !== 1)) throw new Error('Could not inspect tracked local changes.');
    if (diff.status === 1) throw new Error('Tracked local changes must be committed or discarded before updating.');
  }
  if (platform === 'win32' && await (deps.runningServer ?? windowsServerRunning)(cwd, env)) throw new Error('Arco is running from this checkout. Stop Arco, run npm run arco:update, then run npm start.');
  const remote = git('ls-remote', '--tags', 'origin');
  const remoteHeads = new Map();
  for (const line of git('ls-remote', '--heads', 'origin').split('\n')) {
    const match = /^([0-9a-f]+)\s+refs\/heads\/(.+)$/.exec(line);
    if (match) remoteHeads.set(match[2], match[1]);
  }
  const tags = new Map();
  for (const line of remote.split('\n')) { const m = /^([0-9a-f]+)\s+refs\/tags\/([^\s^]+)(\^\{\})?$/.exec(line); if (m) { const old = tags.get(m[2]); if (!old || m[3]) tags.set(m[2], m[1]); } }
  const newest = [...tags.keys()].filter((tag) => stable.test(tag)).sort((a, b) => compareTags(b, a))[0];
  if (opts.expectedRelease && newest !== opts.expectedRelease) throw new Error('The newest release changed. Review the release notice and try again.');
  if (!newest && !opts.ref && !opts.main) throw new Error('No stable release tag exists on origin.');
  if (opts.ref && !/^[0-9a-f]{7,40}$/i.test(opts.ref) && !tags.has(opts.ref)) throw new Error('The requested tag does not exist on origin.');
  git('fetch', '--tags', 'origin', '+refs/heads/*:refs/remotes/origin/*');
  const targetLabel = opts.main ? 'origin/main' : opts.ref ?? newest;
  let target;
  if (tags.has(targetLabel)) {
    target = git('rev-parse', '--verify', `refs/tags/${targetLabel}^{commit}`);
    if (target !== tags.get(targetLabel)) throw new Error('The local release tag differs from origin.');
  } else {
    if (opts.ref && !/^[0-9a-f]{7,40}$/i.test(opts.ref)) throw new Error('The requested tag does not exist on origin.');
    target = git('rev-parse', '--verify', `${targetLabel}^{commit}`);
    if (opts.main && target !== remoteHeads.get('main')) throw new Error('The fetched origin/main does not match origin.');
    const remoteTips = new Set([...remoteHeads.values(), ...tags.values()]);
    const reachable = [...remoteTips].some((tip) => run('git', ['merge-base', '--is-ancestor', target, tip]).status === 0);
    if (!reachable) throw new Error('The requested commit is not reachable from origin.');
  }
  // Git can overwrite ignored untracked files during checkout. Refuse every
  // collision, including an untracked symlink in a target file's parent path.
  const assertNoCollisions = () => {
  const tracked = new Set(git('ls-files', '-z').split('\0').filter(Boolean));
  for (const name of git('ls-tree', '-r', '--name-only', '-z', target).split('\0').filter(Boolean)) {
    const parts = name.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const relative = parts.slice(0, i).join('/');
      if (tracked.has(relative)) continue;
      try {
        const stat = lstatSync(join(cwd, relative));
        if (i === parts.length || stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('The target would overwrite an untracked or ignored local file. Move it before updating.');
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
        throw error;
      }
    }
  }
  };
  assertNoCollisions();
  const unpushed = git('rev-list', `${target}..${current}`, '--not', '--remotes=origin');
  if (unpushed) throw new Error('Local commits are missing from the target and origin. Push or preserve them before updating.');
  const currentVersion = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version;
  let targetVersion; try { targetVersion = JSON.parse(git('show', `${target}:package.json`)).version; } catch { throw new Error('The target does not contain a readable Arco package version.'); }
  if (typeof targetVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(targetVersion)) throw new Error('The target does not contain a valid Arco package version.');
  const comparison = compareVersions(currentVersion, targetVersion);
  if (comparison === null) throw new Error('The current or target version cannot be compared safely.');
  const explicitOlder = !!(opts.ref || opts.main) && target !== current && run('git', ['merge-base', '--is-ancestor', target, current]).status === 0;
  const isDowngrade = (comparison !== null && comparison > 0) || explicitOlder;
  if (isDowngrade && !opts.downgrade) throw new Error('Downgrade refused. Use --allow-downgrade; newer saved state may not be compatible.');
  const notes = stable.test(targetLabel) ? `https://github.com/ghreprimand/arco/releases/tag/${targetLabel}` : 'No release notes for this selection.';
  const label = opts.ref || opts.main ? `${targetLabel} (non-release selection)` : targetLabel;
  if (opts.check || opts.dry) {
    const service = opts.dry ? await (deps.serviceMode ?? detectService)(cwd, env, run, platform) : null;
    const steps = opts.dry ? `Would run: git checkout --detach ${target}; npm ci --include=dev; npm run build; ${service ? `systemctl --user stop ${service}; systemctl --user start ${service}` : 'restart the running server manually'}.` : '';
    report(`${opts.dry ? 'Dry run' : 'Check'}: ${currentVersion} (${current.slice(0, 12)}) -> ${targetVersion}, ${label} (${target.slice(0, 12)}). ${isDowngrade ? 'Downgrade: newer saved state may not be compatible. ' : ''}${steps} ${notes}`);
    return { outcome: 'checked', current, target };
  }
  if (current === target && !opts.requireService) { report(`Already at ${targetLabel} (${current.slice(0, 12)}). ${notes}`); return { outcome: 'unchanged', current, target }; }
  if ((opts.main || opts.ref || isDowngrade) && !opts.yes) {
    if (!deps.confirm && !process.stdin.isTTY) throw new Error('Non-release or downgrade selection requires confirmation or --yes.');
    const confirm = deps.confirm ?? (async (message) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return /^y(?:es)?$/i.test((await rl.question(message)).trim()); } finally { rl.close(); } });
    if (!await confirm('This selection may not be a release or may downgrade saved-state compatibility. Continue? [y/N] ')) throw new Error('Update cancelled.');
  }
  if (isDowngrade && opts.yes) report('Warning: newer saved state may not be compatible with a downgrade.');
  const branchResult = run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : null;
  const npm = deps.npm ?? npmCommand(env, process.execPath, platform);
  const service = await (deps.serviceMode ?? detectService)(cwd, env, run, platform);
  if (opts.requireService && !service) throw new Error('The active service for this checkout could not be verified. Run npm run arco:update from a terminal.');
  // An interactive confirmation can take arbitrarily long. Recheck the HEAD
  // and untracked collisions immediately before making checkout changes.
  if (git('rev-parse', 'HEAD') !== current) throw new Error('The checkout changed during confirmation. Try again.');
  assertNoCollisions();
  let changed = false, stopped = false;
  try {
    changed = true; call('git', ['checkout', '--detach', target]);
    call(npm.command, [...npm.prefix, 'ci', '--include=dev']); call(npm.command, [...npm.prefix, 'run', 'build']);
    if (service) { stopped = true; call('systemctl', ['--user', 'stop', service]); call('systemctl', ['--user', 'start', service]); stopped = false; }
    const restart = service ? 'Service restarted.' : platform === 'darwin' ? 'Restart foreground Arco: stop it and run npm start. For the documented launchd job run launchctl kickstart -k gui/$(id -u)/com.arco.app.' : 'Restart Arco: stop the current process and run npm start.';
    const warning = isDowngrade ? ' Downgrade: newer saved state may not be compatible.' : '';
    const message = `Updated to ${targetLabel} (${target.slice(0, 12)}) from ${currentVersion} (${current.slice(0, 12)}), detached${opts.ref || opts.main ? ' (non-release selection)' : ''}.${warning} ${restart} ${notes}`;
    report(message); return { outcome: 'updated', current, target, message };
  } catch (error) {
    if (changed) {
      try {
        if (platform === 'win32' && await (deps.runningServer ?? windowsServerRunning)(cwd, env)) throw new Error('Stop Arco before rollback; native modules are in use.');
        call('git', branch ? ['checkout', branch] : ['checkout', '--detach', current]);
        call(npm.command, [...npm.prefix, 'ci', '--include=dev']); call(npm.command, [...npm.prefix, 'run', 'build']);
        if (stopped) call('systemctl', ['--user', 'start', service]);
      } catch (rollback) { throw new Error(`Update failed: ${error.message}. Rollback failed: ${rollback.message}. Restore ${current} and rebuild manually.`); }
    }
    throw new Error(`Update failed: ${error.message}. Rolled back to ${current.slice(0, 12)} and rebuilt.`);
  }
}
export async function windowsServerRunning(cwd, env, deps = {}) {
  const port = Number(env.ARCO_PORT || env.PORT || 3001);
  for (const hostname of ['127.0.0.1', '::1']) {
    try {
      const url = `http://${hostname === '::1' ? '[::1]' : hostname}:${port}/healthz`;
      const response = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(700) });
      const json = await response.json();
      if (response.ok && json.status === 'live' && (!json.checkoutFingerprint || json.checkoutFingerprint === checkoutFingerprint(cwd, 'win32'))) return true;
    } catch { /* no server on this address */ }
  }
  // A different configured port may be in use. Inspect process command lines
  // without printing them; conservatively refuse an Arco-shaped Node process.
  const probe = (deps.spawn ?? spawnSync)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -match '(?i)(scripts[/\\\\]start\\.mjs|server[/\\\\](?:dist[/\\\\]index\\.js|src[/\\\\]index\\.ts))' }).Count"],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (probe.error || probe.status !== 0 || !/^\d+$/.test((probe.stdout || '').trim())) throw new Error('Cannot verify that Arco is stopped. Stop Arco, run npm run arco:update, then run npm start.');
  return Number(probe.stdout.trim()) > 0;
}
export async function detectService(cwd, env, run, platform) {
  if (platform !== 'linux' || env.ARCO_DEPLOYMENT === 'docker') return null;
  const unit = env.ARCO_SYSTEMD_UNIT || 'arco.service';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*\.service$/.test(unit)) throw new Error('Invalid systemd unit name.');
  const active = run('systemctl', ['--user', 'is-active', '--quiet', unit]);
  if (active.status !== 0) return null;
  const workdir = run('systemctl', ['--user', 'show', '--property=WorkingDirectory', '--value', unit]);
  try { return workdir.status === 0 && canonicalCheckoutPath(workdir.stdout.trim(), platform) === canonicalCheckoutPath(cwd, platform) ? unit : null; } catch { return null; }
}
async function main() {
  let opts;
  const writeResult = (result) => {
    if (!opts?.resultFile) return;
    if (!opts.attemptId) { writeFileSync(opts.resultFile, JSON.stringify({ ...result, finishedAt: Date.now() })); return; }
    writeUpdateResult(opts.resultFile, opts.attemptId, result);
  };
  try {
    opts = parseArgs(process.argv.slice(2));
    const result = await update(opts);
    writeResult(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { writeResult({ outcome: 'failed', message }); } catch { /* best effort */ }
    console.error(`Arco update: ${message}`); process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
