#!/usr/bin/env node
import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { createServer } from 'node:net';
import { serviceAction, servicePaths, refreshServiceDefinition, SERVICE_ENV_KEYS, writeWindowsServicePid } from './services.mjs';
import { redirectServiceStdio, serviceLogReport } from './service-logs.mjs';
import { activateRepairedTerminal, nativeSqliteBinding, repairNative, supportedNodeVersion } from './native-repair.mjs';
import { updatePackage, writeUpdateResult } from './update.mjs';
import { openArco, shortcuts } from './launch.mjs';
import { isArcoHome, readPortState } from './ports.mjs';
import { knownProjects, unsealProjects } from './storage.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const [command = 'help', ...args] = process.argv.slice(2);
const help = `Usage: arco <command>\n\n  start                 Run the workbench in the foreground\n  open [--tab]          Open Arco in an app window or browser tab\n  shortcuts <action>    add or remove per-user launcher shortcuts\n  setup                 Configure and start a per-user service\n  setup --repair-native Repair native modules (build tools may be required)\n  service <action>      install, uninstall, start, stop, restart, status, logs or refresh\n  update                Update the installed package\n  voice setup           Install local voice components\n  version               Print the installed version\n  doctor                Check runtime, providers, port and service\n  storage unseal [--project <path>]...\n                        Write compressed conversation logs back to plain files\n                        before installing an older release (Arco must be stopped)\n`;
function requireSupportedNode() { if (!supportedNodeVersion()) throw new Error('Unsupported Node.js version. Install Node.js 24 or 26 and retry.'); }
function checkNative() {
  try {
    activateRepairedTerminal();
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3'); new Database(':memory:', { nativeBinding: nativeSqliteBinding() }).close();
    if (typeof require('node-pty').spawn !== 'function') throw new Error('terminal unavailable');
  } catch { throw new Error('Native modules are missing or incompatible. Run arco setup --repair-native.'); }
}
async function start() { requireSupportedNode(); process.env.ARCO_PACKAGED = '1'; process.env.NODE_ENV = 'production'; checkNative(); await import('../start.mjs'); }
function openBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }); child.on('error', () => {}); child.unref();
}
async function main() {
  if (command === 'version' || command === '--version') { console.log(manifest.version); return; }
  if (command === 'help' || command === '--help' || command === '-h') { console.log(help); return; }
  if (command === 'shortcut-open') { if (args.length !== 1 || resolve(args[0]) !== args[0]) throw new Error('Invalid shortcut home.'); process.env.ARCO_HOME = args[0]; await openArco(); return; }
  if (command === 'open') { if (args.length > 1 || (args.length && args[0] !== '--tab')) throw new Error('Use arco open [--tab].'); await openArco({ tab: args.includes('--tab') }); return; }
  if (command === 'shortcuts') { if (args.length !== 1) throw new Error('Use arco shortcuts add or remove.'); shortcuts(args[0]); return; }
  if (command === 'start') { if (args.length) throw new Error('arco start takes no arguments.'); await start(); return; }
  if (command === 'service-run') {
    if (args.length !== 1) throw new Error('The service configuration path is required.');
    const config = JSON.parse(readFileSync(args[0], 'utf8'));
    if (config.version !== 1 || !config.env || typeof config.env !== 'object') throw new Error('Invalid service configuration.');
    for (const name of SERVICE_ENV_KEYS) if (typeof config.env[name] === 'string') process.env[name] = config.env[name];
    process.env.ARCO_PACKAGE_SERVICE = '1'; process.env.ARCO_LOG_FILE = '1';
    if (process.platform === 'win32') {
      if (typeof config.env.ARCO_HOME !== 'string' || resolve(config.env.ARCO_HOME) !== resolve(dirname(dirname(args[0])))) throw new Error('Invalid service configuration home.');
      const clearPid = writeWindowsServicePid(dirname(dirname(args[0])));
      process.once('exit', clearPid);
      // No console window exists for the Windows service: keep raw output in
      // files, and move an older visible-window task definition to the current one.
      redirectServiceStdio(process.env.ARCO_LOG_DIR || join(dirname(dirname(args[0])), 'logs'));
      try { await refreshServiceDefinition(); } catch (error) { console.error(`arco: service definition not refreshed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    await start(); return;
  }
  if (command === 'service') {
    if (args.length !== 1) throw new Error('Provide exactly one service action.');
    if (args[0] === 'logs') {
      const paths = servicePaths(process.platform);
      let logDir = join(paths.home, 'logs');
      try { const saved = JSON.parse(readFileSync(paths.config, 'utf8')); if (typeof saved.env?.ARCO_LOG_DIR === 'string') logDir = saved.env.ARCO_LOG_DIR; } catch { /* use default */ }
      console.log(serviceLogReport(logDir)); return;
    }
    if (args[0] === 'refresh') { console.log(await refreshServiceDefinition()); return; }
    await serviceAction(args[0]); if (args[0] === 'uninstall') shortcuts('remove'); return;
  }
  if (command === 'setup') {
    requireSupportedNode();
    if (args.length && (args.length !== 1 || args[0] !== '--repair-native')) throw new Error('Unknown setup option.');
    if (args.includes('--repair-native')) { repairNative(manifest); console.log('Native modules repaired. Restart Arco.'); return; }
    if (!process.stdin.isTTY) throw new Error('Run arco setup in an interactive terminal.');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try {
      answer = await prompt.question('Install and start the per-user Arco service? [Y/n] ');
      if (!/^n/i.test(answer.trim())) {
        await serviceAction('install'); await serviceAction('start');
        const add = await prompt.question('Create an Arco application shortcut? [Y/n] ');
        if (!/^n/i.test(add.trim())) shortcuts('add');
      }
    } finally { prompt.close(); }
    if (/^n/i.test(answer.trim())) { console.log('Run arco start to start in the foreground.'); return; }
    const paths = servicePaths(process.platform);
    let port, ready = false;
    for (let i = 0; i < 100; i++) {
      const state = readPortState(paths.home);
      const config = JSON.parse(readFileSync(paths.config, 'utf8'));
      if (state && await isArcoHome(state.port, paths.home, fetch, config.env?.ARCO_HOST)) { port = state.port; ready = true; break; }
      await new Promise((done) => setTimeout(done, 200));
    }
    if (!ready) throw new Error('Arco did not become ready. Check arco service logs.');
    const saved = JSON.parse(readFileSync(paths.config, 'utf8'));
    const host = saved.env.ARCO_HOST || '127.0.0.1';
    const browserHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
    const url = `http://${browserHost}:${port}/`;
    console.log(`Arco is starting at ${url}`); openBrowser(url); return;
  }
  if (command === 'voice' && args.length === 1 && args[0] === 'setup') {
    const r = spawnSync(process.execPath, [join(root, 'scripts/voice/run.mjs'), 'setup.py'], { stdio: 'inherit', env: { ...process.env, ARCO_PACKAGED: '1' } });
    if (r.error || r.status !== 0) throw new Error('Voice setup failed.'); return;
  }
  if (command === 'storage') {
    if (args[0] !== 'unseal') throw new Error('Use arco storage unseal [--project <path>]...');
    const projects = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i] !== '--project' || !args[i + 1]) throw new Error('Use arco storage unseal [--project <path>]...');
      projects.push(resolve(args[++i]));
    }
    const paths = servicePaths(process.platform);
    const port = Number(readPortState(paths.home)?.port || process.env.ARCO_PORT || '3001');
    if (Number.isInteger(port) && await isArcoHome(port, paths.home, fetch, process.env.ARCO_HOST).catch(() => false)) {
      throw new Error('Arco is running. Stop it (arco service stop, or Ctrl+C) and run arco storage unseal again.');
    }
    await unsealProjects(projects.length ? projects : await knownProjects(paths.home));
    return;
  }
  if (command === 'doctor') {
    const supported = supportedNodeVersion();
    console.log(`Node ${process.versions.node}: ${supported ? 'supported' : 'unsupported; install Node.js 24 or 26'}`);
    if (!supported) process.exitCode = 1;
    else try { checkNative(); console.log('Native modules: ready'); }
    catch { console.log('Native modules unavailable. Run arco setup --repair-native.'); process.exitCode = 1; }
    const paths = servicePaths(process.platform);
    let saved = {}; try { saved = JSON.parse(readFileSync(paths.config, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const portState = readPortState(paths.home);
    const port = Number(portState?.port || process.env.ARCO_PORT || saved.env?.ARCO_PORT || '3001');
    if (!Number.isInteger(port) || port < 1 || port > 65535) { console.log('Port: invalid ARCO_PORT'); process.exitCode = 1; }
    else if (await isArcoHome(port, paths.home, fetch, saved.env?.ARCO_HOST || process.env.ARCO_HOST)) console.log(`Port ${port}: this Arco home is running`);
    else await new Promise((done) => {
      const socket = createServer();
      socket.once('error', () => { console.log(`Port ${port}: occupied by another program or unavailable`); done(); });
      socket.listen(port, '127.0.0.1', () => socket.close(() => { console.log(`Port ${port}: available on loopback`); done(); }));
    });
    const explicit = portState?.explicitPort || (!portState && (process.env.ARCO_PORT || saved.env?.ARCO_PORT));
    console.log(`Explicit port: ${explicit || 'not set'}`);
    for (const name of ['codex', 'claude', 'cursor-agent', 'ollama']) { const r = spawnSync(name, ['--version'], { encoding: 'utf8', timeout: 3000, windowsHide: true, shell: process.platform === 'win32' }); console.log(`${name}: ${r.status === 0 ? 'available' : 'not available'}`); }
    try { await serviceAction('status'); } catch { console.log('Service: unavailable or stopped'); }
    return;
  }
  if (command === 'package-restart-foreground') {
    await new Promise((done) => setTimeout(done, 1500));
    await start(); return;
  }
  if (command === 'package-restart') {
    const [home, task] = args;
    if (!home || resolve(home) !== home || !/^arco-updater-[a-f0-9-]+$/.test(task || '')) throw new Error('Invalid package restart request.');
    process.env.ARCO_HOME = home;
    await new Promise((done) => setTimeout(done, 1500));
    try { await serviceAction('restart'); }
    finally {
      if (process.platform === 'win32') { spawnSync('schtasks.exe', ['/Delete', '/TN', task, '/F'], { stdio: 'ignore', windowsHide: true }); rmSync(join(home, `${task}.xml`), { force: true }); }
      else if (process.platform === 'darwin') spawnSync('launchctl', ['remove', task], { stdio: 'ignore' });
    }
    return;
  }
  if (command === 'package-update') {
    const [expected, resultFile, task, attemptId] = args;
    if (!/^v\d+\.\d+\.\d+$/.test(expected || '') || !resultFile || basename(resultFile) !== 'update-result.json' || resolve(resultFile) !== resultFile || !/^[a-f0-9-]{36}$/.test(attemptId || '')) throw new Error('Invalid package update request.');
    const writeResult = (result) => writeUpdateResult(resultFile, attemptId, result);
    process.env.ARCO_HOME = dirname(resultFile);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      const result = await updatePackage(manifest, root, { expected });
      writeResult(result);
    } catch (error) {
      try { writeResult({ outcome: 'failed', message: error instanceof Error ? error.message : String(error) }); } catch { /* retain diagnostics if the result cannot be written */ }
      throw error;
    } finally {
      if (task && /^arco-updater-[a-f0-9-]+$/.test(task)) {
        if (process.platform === 'win32') { spawnSync('schtasks.exe', ['/Delete', '/TN', task, '/F'], { stdio: 'ignore', windowsHide: true }); rmSync(join(dirname(resultFile), `${task}.xml`), { force: true }); }
        else if (process.platform === 'darwin') spawnSync('launchctl', ['remove', task], { stdio: 'ignore' });
      }
    }
    return;
  }
  if (command === 'update') { if (args.length) throw new Error('arco update takes no arguments.'); const result = await updatePackage(manifest, root); console.log(result.message); return; }
  throw new Error(`Unknown command: ${command}. Run arco --help.`);
}
try { await main(); } catch (error) { console.error(`arco: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
