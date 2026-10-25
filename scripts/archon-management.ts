#!/usr/bin/env -S npx tsx
// ARCHON_OPS_PLAN.md §K2 — `archon-management` tailnet-only remote-management hub.
//
// One service (suggested host: hub-host) that aggregates registered Archon
// instances, derives online/stale/offline from heartbeats, SIGNS lifecycle
// commands with the hub Ed25519 private key, and routes signed/workflow-scoped
// actions to the owning instance (which re-validates). The K3 mobile console
// consumes its HTTP/WS surface. See docs/REMOTE_MANAGEMENT.md §2/§5/§6.
//
// TAILNET-ONLY: `serve` binds the host you pass (the tailnet IP), NEVER 0.0.0.0
// and NEVER a public/Funnel path. On the hub host that is its tailnet IP; :443 there is
// already taken by tailscaled, so the hub defaults to :3500.
//
// Subcommands:
//   keygen [--out DIR]   generate the hub Ed25519 keypair (hub.key 600 + hub.pub)
//   serve [--host H] [--port P]   run the hub (loads ARCHON_HUB_KEY / hub.key)
//   install [--enable] [--host H] [--port P]   write the systemd --user unit
//   start|stop|status|restart    systemctl --user on archon-management.service
//   logs [-n N]          follow the hub journal
//   uninstall            stop + disable + remove the unit
//
// Subprocess safety: execFile/spawn argv arrays only — never shell, never sudo.

import '../server/src/envAliases.js'; // ARCO_* aliases take precedence over ARCHON_*
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  parseManagementArgs,
  renderManagementUnit,
  MANAGEMENT_COMMANDS,
  type ManagementArgs,
} from './management/unit.js';
import { generateHubKeypair } from './agent/signing.js';
import { createHub } from './management/hub.js';
import { parseSshTargets } from './management/sshLifecycle.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_NAME = 'archon-management.service';
const DEFAULT_PORT = 3500;
const isMac = process.platform === 'darwin';

function unitDir(): string {
  const xdg =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim()
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), '.config');
  return join(xdg, 'systemd', 'user');
}
function unitPath(): string {
  return join(unitDir(), UNIT_NAME);
}
function hubDir(): string {
  return join(homedir(), '.archon', 'hub');
}
function defaultKeyPath(): string {
  return process.env.ARCHON_HUB_KEY || join(hubDir(), 'hub.key');
}

function systemctlInherit(args: string[]): Promise<number> {
  return new Promise((res) => {
    const child = spawn('systemctl', ['--user', ...args], { stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`[archon-management] failed to spawn systemctl: ${err.message}`);
      res(127);
    });
    child.on('exit', (code) => res(code ?? 1));
  });
}

async function doKeygen(args: ManagementArgs): Promise<number> {
  const { publicKey, privateKey } = generateHubKeypair();
  const dir = args.out || hubDir();
  await mkdir(dir, { recursive: true });
  const keyPath = join(dir, 'hub.key');
  const pubPath = join(dir, 'hub.pub');
  if (existsSync(keyPath)) {
    console.error(`[archon-management] refusing to overwrite existing ${keyPath} — remove it first.`);
    return 1;
  }
  await writeFile(keyPath, privateKey, { mode: 0o600 });
  await writeFile(pubPath, publicKey, { mode: 0o644 });
  console.log(`[archon-management] wrote ${keyPath} (PRIVATE — hub only, mode 600)`);
  console.log(`[archon-management] wrote ${pubPath} (PUBLIC — copy to each agent's ~/.archon/agent/hub.pub)`);
  return 0;
}

async function doServe(args: ManagementArgs): Promise<number> {
  const keyPath = defaultKeyPath();
  if (!existsSync(keyPath)) {
    console.error(`[archon-management] serve: hub private key missing at ${keyPath} — run \`archon-management keygen\` first.`);
    return 2;
  }
  const privateKeyPem = readFileSync(keyPath, 'utf8');
  const host = args.host || process.env.ARCHON_HUB_HOST || '127.0.0.1';
  const port = args.port ?? Number(process.env.ARCHON_HUB_PORT) ?? DEFAULT_PORT;
  if (host === '0.0.0.0' || host === '::') {
    console.error('[archon-management] refusing to bind a public/all-interfaces address — pass the tailnet IP (trust boundary §1).');
    return 2;
  }
  // K4 — optional Tailscale-SSH fallback targets (~/.archon/hub/ssh-targets.json).
  // Best-effort: a missing/garbage file just means no SSH fallback.
  const sshTargetsPath = join(hubDir(), 'ssh-targets.json');
  const sshTargets = existsSync(sshTargetsPath)
    ? parseSshTargets(readFileSync(sshTargetsPath, 'utf8'))
    : {};
  const nTargets = Object.keys(sshTargets).length;
  if (nTargets > 0) console.log(`[archon-management] loaded ${nTargets} SSH lifecycle target(s) from ${sshTargetsPath}`);

  const hub = createHub({
    privateKeyPem,
    host,
    port: Number.isFinite(port) ? port : DEFAULT_PORT,
    log: (m) => console.log(`[archon-management] ${m}`),
    sshTargets,
  });
  const addr = await hub.listen();
  console.log(`[archon-management] hub up on ${addr.host}:${addr.port} (tailnet-only). Agents connect to ws://${addr.host}:${addr.port}/agent`);
  await new Promise<void>((res) => {
    const shutdown = () => {
      void hub.close().then(res);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}

async function doInstall(args: ManagementArgs): Promise<number> {
  if (isMac) {
    console.log('[archon-management] systemd is Linux-only; the hub is intended to run on the Linux VPS (hub-host).');
    return 0;
  }
  const host = args.host || process.env.ARCHON_HUB_HOST;
  if (!host) {
    console.error('[archon-management] install: pass --host <tailnet-ip> (the hub must bind the tailnet interface, not 0.0.0.0).');
    return 2;
  }
  const port = args.port ?? DEFAULT_PORT;
  const unit = renderManagementUnit({
    repoRoot: REPO_ROOT,
    host,
    port,
    privateKeyPath: defaultKeyPath(),
  });
  await mkdir(unitDir(), { recursive: true });
  await writeFile(unitPath(), unit, 'utf8');
  console.log(`[archon-management] wrote ${unitPath()} (binds ${host}:${port})`);
  if (!existsSync(defaultKeyPath())) {
    console.log(`[archon-management] NOTE: hub key missing at ${defaultKeyPath()} — run \`archon-management keygen\` before start.`);
  }
  await systemctlInherit(['daemon-reload']);
  if (args.enable) {
    await systemctlInherit(['enable', UNIT_NAME]);
    console.log('[archon-management] enabled (autostart on next login).');
  }
  console.log('[archon-management] installed. Start with: archon-management start');
  return 0;
}

async function doUninstall(): Promise<number> {
  await systemctlInherit(['stop', UNIT_NAME]);
  await systemctlInherit(['disable', UNIT_NAME]);
  if (existsSync(unitPath())) {
    await rm(unitPath(), { force: true });
    console.log(`[archon-management] removed ${unitPath()}`);
  }
  await systemctlInherit(['daemon-reload']);
  console.log('[archon-management] uninstalled.');
  return 0;
}

async function doSystemctlAction(args: ManagementArgs): Promise<number> {
  switch (args.command) {
    case 'start':
      return systemctlInherit(['start', UNIT_NAME]);
    case 'stop':
      return systemctlInherit(['stop', UNIT_NAME]);
    case 'restart':
      return systemctlInherit(['restart', UNIT_NAME]);
    case 'status':
      return systemctlInherit(['status', UNIT_NAME, '--no-pager']);
    default:
      return 1;
  }
}

async function doLogs(args: ManagementArgs): Promise<number> {
  const jargs = ['--user', '-u', UNIT_NAME, '-f'];
  if (args.lines !== undefined) jargs.push('-n', String(args.lines));
  return new Promise((res) => {
    const child = spawn('journalctl', jargs, { stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`[archon-management] failed to spawn journalctl: ${err.message}`);
      res(127);
    });
    child.on('exit', (code) => res(code ?? 0));
  });
}

function usage(): void {
  console.error(
    [
      'Usage: archon-management <command> [options]',
      '',
      'Commands:',
      '  keygen [--out DIR]   generate the hub Ed25519 keypair',
      '  serve [--host IP] [--port N]   run the hub (tailnet IP; default :3500)',
      '  install [--enable] --host IP [--port N]   write the systemd --user unit',
      '  start | stop | status | restart   control the hub service',
      '  logs [-n N]          follow the hub journal',
      '  uninstall            stop + disable + remove the unit',
      '',
      `Recognized commands: ${MANAGEMENT_COMMANDS.join(', ')}`,
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = parseManagementArgs(process.argv.slice(2));
  if (args.unknown.length > 0) {
    console.error(`[archon-management] unrecognized argument(s): ${args.unknown.join(' ')}`);
    usage();
    process.exit(2);
  }
  if (args.command === null) {
    usage();
    process.exit(2);
  }
  let code: number;
  switch (args.command) {
    case 'keygen':
      code = await doKeygen(args);
      break;
    case 'serve':
      code = await doServe(args);
      break;
    case 'install':
      code = await doInstall(args);
      break;
    case 'uninstall':
      code = await doUninstall();
      break;
    case 'logs':
      code = await doLogs(args);
      break;
    default:
      code = await doSystemctlAction(args);
      break;
  }
  process.exit(code);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  void main();
}
