#!/usr/bin/env -S npx tsx
// ARCHON_OPS_PLAN.md §K1 — `archon-agent` per-host lifecycle supervisor.
//
// A tiny always-on supervisor (one per workstation) that the management hub (K2)
// drives over a tailnet WebSocket to start/stop/restart/tail-logs the LOCAL
// Archon service — and nothing else. Its entire inbound vocabulary is the fixed
// LifecycleCommand allowlist, and it executes a command ONLY when signed by the
// hub's Ed25519 key (§13.2). No file access, no workflow access, no free-form
// shell. See docs/REMOTE_MANAGEMENT.md §6.
//
// Subcommands:
//   keygen [--out DIR]   generate a hub Ed25519 keypair (run on the hub; copy the
//                        private half to the hub, hub.pub to each agent)
//   install [--enable] [--hub URL]
//                        write the systemd --user unit (+ enable for autostart)
//   start|stop|status|restart   systemctl --user on archon-agent.service
//   logs [-n N] [--journal]     tail the agent log / journal
//   uninstall            stop + disable + remove unit
//   selftest             offline crypto+allowlist confidence check (no hub)
//   run                  the long-lived agent: connect to the hub, register,
//                        heartbeat, execute signed lifecycle commands
//
// LINUX-FIRST: systemctl/journalctl paths are Linux-only; on macOS the lifecycle
// subcommands print a manual notice (no autostart in v1, §13.3). keygen/selftest
// run everywhere.
//
// Subprocess safety: execFile/spawn with argv arrays only — never shell:true,
// never sudo (a --user unit needs neither).

import '../server/src/envAliases.js'; // ARCO_* aliases take precedence over ARCHON_*
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseAgentArgs, renderAgentUnit, AGENT_COMMANDS, type AgentArgs } from './agent/unit.js';
import { generateHubKeypair, signCommand, verifyCommand, newNonce } from './agent/signing.js';
import { renderLifecycleCommand } from './agent/allowlist.js';
import { NonceStore } from './agent/handle.js';
import { createAgentConnection, systemctlRunner } from './agent/agent.js';
import { buildInstanceDescriptor, detectPlatform } from './agent/identity.js';
import { LIFECYCLE_COMMANDS } from '../shared/src/protocol/remoteManagement.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_NAME = 'archon-agent.service';
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
function agentDir(): string {
  return join(homedir(), '.archon', 'agent');
}
function defaultPubkeyPath(): string {
  return process.env.ARCHON_HUB_PUBKEY || join(agentDir(), 'hub.pub');
}
function repoVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function macNotice(): void {
  console.log(
    [
      'systemd is not available on macOS — `archon-agent` service actions are Linux-only.',
      'macOS does not autostart the agent in v1 (it starts with the app launcher); a launchd',
      'unit is a later add. keygen / selftest / run still work manually here.',
    ].join('\n'),
  );
}

function systemctlInherit(args: string[]): Promise<number> {
  return new Promise((res) => {
    const child = spawn('systemctl', ['--user', ...args], { stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`[archon-agent] failed to spawn systemctl: ${err.message}`);
      res(127);
    });
    child.on('exit', (code) => res(code ?? 1));
  });
}

async function doKeygen(args: AgentArgs): Promise<number> {
  const { publicKey, privateKey } = generateHubKeypair();
  if (!args.out) {
    console.log('# Ed25519 hub keypair (§13.2)');
    console.log('# Keep the PRIVATE key on the hub ONLY (never commit). Copy the');
    console.log('# PUBLIC key to each agent at ~/.archon/agent/hub.pub.\n');
    console.log('## hub.key (PRIVATE — hub only)\n' + privateKey);
    console.log('## hub.pub (PUBLIC — distribute to agents)\n' + publicKey);
    return 0;
  }
  await mkdir(args.out, { recursive: true });
  const keyPath = join(args.out, 'hub.key');
  const pubPath = join(args.out, 'hub.pub');
  await writeFile(keyPath, privateKey, { mode: 0o600 });
  await writeFile(pubPath, publicKey, { mode: 0o644 });
  console.log(`[archon-agent] wrote ${keyPath} (PRIVATE — hub only, mode 600)`);
  console.log(`[archon-agent] wrote ${pubPath} (PUBLIC — copy to each agent)`);
  return 0;
}

async function doInstall(args: AgentArgs): Promise<number> {
  if (isMac) {
    macNotice();
    return 0;
  }
  const hubUrl = args.hubUrl || process.env.ARCHON_HUB_URL;
  const unit = renderAgentUnit({
    repoRoot: REPO_ROOT,
    ...(hubUrl ? { hubUrl } : {}),
    publicKeyPath: defaultPubkeyPath(),
  });
  await mkdir(unitDir(), { recursive: true });
  await writeFile(unitPath(), unit, 'utf8');
  console.log(`[archon-agent] wrote ${unitPath()}`);
  if (!hubUrl) {
    console.log('[archon-agent] NOTE: no --hub URL and ARCHON_HUB_URL unset — set it before `run`.');
  }
  if (!existsSync(defaultPubkeyPath())) {
    console.log(`[archon-agent] NOTE: hub public key missing at ${defaultPubkeyPath()} — provision it before \`run\`.`);
  }
  await systemctlInherit(['daemon-reload']);
  if (args.enable) {
    await systemctlInherit(['enable', UNIT_NAME]);
    console.log('[archon-agent] enabled (autostart on next login).');
  }
  console.log('[archon-agent] installed. Start with: archon-agent start');
  return 0;
}

async function doUninstall(): Promise<number> {
  if (isMac) {
    macNotice();
    return 0;
  }
  await systemctlInherit(['stop', UNIT_NAME]);
  await systemctlInherit(['disable', UNIT_NAME]);
  if (existsSync(unitPath())) {
    await rm(unitPath(), { force: true });
    console.log(`[archon-agent] removed ${unitPath()}`);
  }
  await systemctlInherit(['daemon-reload']);
  console.log('[archon-agent] uninstalled.');
  return 0;
}

async function doSystemctlAction(args: AgentArgs): Promise<number> {
  if (isMac) {
    macNotice();
    return 0;
  }
  if (!existsSync(unitPath()) && args.command !== 'status') {
    console.error(`[archon-agent] no unit at ${unitPath()} — run \`archon-agent install\` first.`);
    return 1;
  }
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

async function doLogs(args: AgentArgs): Promise<number> {
  if (isMac) {
    macNotice();
    return 0;
  }
  const jargs = ['--user', '-u', UNIT_NAME, '-f'];
  if (args.lines !== undefined) jargs.push('-n', String(args.lines));
  return new Promise((res) => {
    const child = spawn('journalctl', jargs, { stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`[archon-agent] failed to spawn journalctl: ${err.message}`);
      res(127);
    });
    child.on('exit', (code) => res(code ?? 0));
  });
}

// Offline confidence check — no hub, no systemctl exec. Proves the crypto +
// allowlist behave: every lifecycle command signs→verifies→renders on this
// platform, and forged / stale / replayed / wrong-instance commands are
// rejected. Exit 0 = all good.
function doSelftest(): number {
  const { publicKey, privateKey } = generateHubKeypair();
  const instanceId = 'selftest-instance';
  const platform = detectPlatform();
  const now = Date.now();
  const seen = new Set<string>();
  let failures = 0;
  const fail = (m: string) => {
    console.error(`  ✗ ${m}`);
    failures++;
  };
  const ok = (m: string) => console.log(`  ✓ ${m}`);

  console.log(`archon-agent selftest (platform=${platform})`);

  for (const cmd of LIFECYCLE_COMMANDS) {
    const signed = signCommand(privateKey, { cmd, instanceId, nonce: newNonce(), issuedAt: now });
    const v = verifyCommand(signed, {
      publicKeyPem: publicKey,
      expectInstanceId: instanceId,
      now,
      seenNonce: (n) => seen.has(n),
    });
    if (!v.ok) {
      fail(`${cmd}: valid signed command failed verification (${v.failure})`);
      continue;
    }
    const spec = renderLifecycleCommand(cmd, platform);
    if (platform === 'linux' && !spec) fail(`${cmd}: no allowlist template on linux`);
    else ok(`${cmd}: signed→verified${spec ? `→ ${spec.cmd} ${spec.args.join(' ')}` : ' (no template on this platform)'}`);
  }

  // Negative cases.
  const base = { cmd: 'archon.status' as const, instanceId, nonce: newNonce(), issuedAt: now };
  const good = signCommand(privateKey, base);

  // Flip a LEADING (data) char — not the trailing '=' padding, which decodes to
  // identical signature bytes and would not actually corrupt the signature.
  const forged = { payload: base, signature: good.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) };
  if (verifyCommand(forged, { publicKeyPem: publicKey, expectInstanceId: instanceId, now, seenNonce: () => false }).failure === 'bad-signature') ok('forged signature rejected');
  else fail('forged signature NOT rejected');

  const stale = signCommand(privateKey, { ...base, nonce: newNonce(), issuedAt: now - 5 * 60_000 });
  if (verifyCommand(stale, { publicKeyPem: publicKey, expectInstanceId: instanceId, now, seenNonce: () => false }).failure === 'stale') ok('stale command rejected');
  else fail('stale command NOT rejected');

  if (verifyCommand(good, { publicKeyPem: publicKey, expectInstanceId: instanceId, now, seenNonce: (n) => n === base.nonce }).failure === 'replay') ok('replayed nonce rejected');
  else fail('replayed nonce NOT rejected');

  const wrong = signCommand(privateKey, { ...base, nonce: newNonce() });
  if (verifyCommand(wrong, { publicKeyPem: publicKey, expectInstanceId: 'someone-else', now, seenNonce: () => false }).failure === 'wrong-instance') ok('wrong-instance command rejected');
  else fail('wrong-instance command NOT rejected');

  if (failures === 0) {
    console.log('selftest PASSED');
    return 0;
  }
  console.error(`selftest FAILED (${failures} failure(s))`);
  return 1;
}

async function doRun(args: AgentArgs): Promise<number> {
  const hubUrl = args.hubUrl || process.env.ARCHON_HUB_URL;
  if (!hubUrl) {
    console.error('[archon-agent] run: no hub URL — set ARCHON_HUB_URL or pass --hub ws://<hub>:<port>');
    console.error('[archon-agent] the management hub is K2; until it is deployed there is nothing to connect to.');
    return 2;
  }
  const pubPath = defaultPubkeyPath();
  if (!existsSync(pubPath)) {
    console.error(`[archon-agent] run: hub public key missing at ${pubPath} — run \`archon-agent keygen\` on the hub and copy hub.pub here.`);
    return 2;
  }
  const publicKeyPem = readFileSync(pubPath, 'utf8');
  const instance = buildInstanceDescriptor({
    repoRoot: REPO_ROOT,
    version: repoVersion(),
    serviceRestart: detectPlatform() === 'linux',
  });
  console.log(`[archon-agent] starting as "${instance.name}" (${instance.instanceId}) → hub ${hubUrl}`);
  const conn = createAgentConnection({
    hubUrl,
    instance,
    publicKeyPem,
    runner: systemctlRunner(),
    nonceStore: new NonceStore(),
    log: (m) => console.log(`[archon-agent] ${m}`),
  });
  conn.start();
  // Run until signaled.
  await new Promise<void>((res) => {
    const shutdown = () => {
      conn.stop();
      res();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}

function usage(): void {
  console.error(
    [
      'Usage: archon-agent <command> [options]',
      '',
      'Commands:',
      '  keygen [--out DIR]   generate an Ed25519 hub keypair',
      '  install [--enable] [--hub URL]   write the systemd --user unit',
      '  start | stop | status | restart  control the agent service',
      '  logs [-n N]          follow the agent journal',
      '  uninstall            stop + disable + remove the unit',
      '  selftest             offline crypto + allowlist confidence check',
      '  run                  connect to the hub and supervise (needs ARCHON_HUB_URL)',
      '',
      `Recognized commands: ${AGENT_COMMANDS.join(', ')}`,
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = parseAgentArgs(process.argv.slice(2));
  if (args.unknown.length > 0) {
    console.error(`[archon-agent] unrecognized argument(s): ${args.unknown.join(' ')}`);
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
    case 'install':
      code = await doInstall(args);
      break;
    case 'uninstall':
      code = await doUninstall();
      break;
    case 'logs':
      code = await doLogs(args);
      break;
    case 'selftest':
      code = doSelftest();
      break;
    case 'run':
      code = await doRun(args);
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
