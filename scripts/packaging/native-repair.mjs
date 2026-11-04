import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export function supportedNodeVersion(version = process.versions.node) {
  const match = /^(\d+)\./.exec(version);
  return !!match && [24, 26].includes(Number(match[1]));
}

export function npmCliPath(env = process.env, executable = process.execPath) {
  const bin = dirname(executable);
  const candidates = [env.npm_execpath, join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const cli = candidates.find((p) => p && p.endsWith('.js') && existsSync(p));
  if (!cli) throw new Error('Cannot locate npm. Reinstall Node.js with npm and retry.');
  return resolve(cli);
}
export function repairedNativeDir(env = process.env) {
  const home = resolve(env.ARCO_HOME?.trim() || join(homedir(), '.arco'));
  return join(home, 'native', `${process.platform}-${process.arch}`);
}
function matchingRepair(env = process.env) {
  const dir = repairedNativeDir(env);
  try {
    const expected = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).arcoNativeDependencies;
    const actual = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    return expected && ['better-sqlite3', 'node-pty'].every((name) => typeof expected[name] === 'string' && expected[name] === actual[name]);
  } catch { return false; }
}
export function nativeSqliteBinding(env = process.env) {
  const repaired = join(repairedNativeDir(env), 'better_sqlite3.node');
  const shipped = fileURLToPath(new URL(`../../native/${process.platform}-${process.arch}/better_sqlite3.node`, import.meta.url));
  return matchingRepair(env) && existsSync(repaired) ? repaired : shipped;
}
export function activateRepairedTerminal(env = process.env) {
  const repaired = join(repairedNativeDir(env), 'pty');
  const shipped = fileURLToPath(new URL(`../../native/${process.platform}-${process.arch}/pty`, import.meta.url));
  const pty = matchingRepair(env) && existsSync(join(repaired, 'pty.node')) ? repaired : shipped;
  if (!existsSync(join(pty, 'pty.node'))) throw new Error('Native terminal module missing or incompatible. Run arco setup --repair-native.');
  const require = createRequire(import.meta.url);
  require(join(pty, 'pty.node'));
  if (process.platform === 'win32') {
    for (const name of ['conpty.node', 'conpty_console_list.node']) require(join(pty, name));
  }
  const utils = require('node-pty/lib/utils.js');
  const original = utils.loadNativeModule;
  utils.loadNativeModule = (name) => {
    const file = join(pty, `${name}.node`);
    if (!existsSync(file)) return original(name);
    return { dir: pty, module: require(file) };
  };
}
export function repairNative(manifest, env = process.env) {
  const versions = manifest.arcoNativeDependencies;
  if (!versions || !['node-pty', 'better-sqlite3'].every((name) => /^\d+\.\d+\.\d+$/.test(versions[name] || ''))) throw new Error('Native dependency versions are missing from this package.');
  const target = repairedNativeDir(env), parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(parent, '.build-'));
  try {
    const dependencies = Object.fromEntries(Object.entries(versions));
    const allowScripts = Object.fromEntries(Object.entries(versions).map(([name, version]) => [`${name}@${version}`, true]));
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'arco-native-repair', version: '1.0.0', private: true, dependencies, allowScripts }, null, 2));
    const result = spawnSync(process.execPath, [npmCliPath(env), 'install', '--no-audit', '--no-fund'], { cwd: scratch, env: { ...env, npm_config_build_from_source: 'true', npm_config_cache: env.npm_config_cache || join(parent, '..', 'cache', 'npm'), npm_config_devdir: env.npm_config_devdir || join(parent, '..', 'cache', 'node-gyp') }, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('Native build failed. Install the platform build tools, then run arco setup --repair-native.');
    const modules = join(scratch, 'node_modules');
    const require = createRequire(join(scratch, 'package.json'));
    const sqliteRoot = join(modules, 'better-sqlite3');
    const sqliteBuild = join(sqliteRoot, 'build', 'Release', 'better_sqlite3.node');
    const sqlitePlatform = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? 'linuxmusl' : process.platform;
    const sqlitePrebuild = join(sqliteRoot, 'prebuilds', `${sqlitePlatform}-${process.arch}.node`);
    const sqliteBinding = existsSync(sqliteBuild) ? sqliteBuild : sqlitePrebuild;
    const Database = require('better-sqlite3'); new Database(':memory:', { nativeBinding: sqliteBinding }).close();
    if (typeof require('node-pty').spawn !== 'function') throw new Error('The rebuilt terminal module did not load.');
    const ptyRoot = join(modules, 'node-pty');
    const prebuild = join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`);
    const pty = existsSync(join(ptyRoot, 'build', 'Release', 'pty.node')) ? join(ptyRoot, 'build', 'Release') : prebuild;
    const staged = join(scratch, 'result'); mkdirSync(join(staged, 'pty'), { recursive: true });
    cpSync(sqliteBinding, join(staged, 'better_sqlite3.node'));
    cpSync(pty, join(staged, 'pty'), { recursive: true, filter: (path) => !/\.pdb$/i.test(path) });
    if (process.platform === 'darwin' && existsSync(join(staged, 'pty', 'spawn-helper'))) chmodSync(join(staged, 'pty', 'spawn-helper'), 0o755);
    writeFileSync(join(staged, 'manifest.json'), JSON.stringify(versions, null, 2) + '\n', { mode: 0o600 });
    // Retain an earlier repaired version if replacing the staged build fails.
    const backup = join(parent, `.previous-${process.pid}`);
    if (existsSync(backup)) throw new Error('A previous native repair needs manual cleanup.');
    if (existsSync(target)) renameSync(target, backup);
    try { renameSync(staged, target); } catch (error) { if (existsSync(backup)) renameSync(backup, target); throw error; }
    rmSync(backup, { recursive: true, force: true });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
