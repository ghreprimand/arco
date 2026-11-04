#!/usr/bin/env -S npx tsx
// docs/ARCHITECTURE.md - `arco service install|start|stop|status|logs|uninstall`.
//
// Production runtime for Arco as a durable, restartable, inspectable service.
// This is a SEPARATE path from the dev launcher (scripts/arco, which drives
// `npm run dev` + Vite). Here the COMPILED server (server/dist/index.js) runs
// under a systemd `--user` unit with ARCO_SERVE_CLIENT=1 so it serves
// client/dist itself — no Vite in production.
//
// The unit-rendering + arg-parsing logic lives in scripts/service/unit.ts as
// pure functions (the smoke imports them without a live install). This file is
// the side-effecting shell: it writes the unit file and shells out to
// `systemctl --user` / `journalctl --user`.
//
// LINUX-FIRST: every `systemctl`/`journalctl` shell-out is Linux-only. On macOS
// the action subcommands print a manual-run pointer and exit 0 (launchd is a
// later K-tier add). The pure functions still work everywhere.
//
// Subprocess safety: execFile/spawn with argv arrays only — never shell:true,
// never sudo (a `--user` unit needs neither).

import '../server/src/envAliases.js'; // upstream-prefixed variables fill unset ARCO_* names
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  parseServiceArgs,
  renderSystemdUnit,
  SERVICE_COMMANDS,
  type ServiceArgs,
} from './service/unit.js';
import { arcoHome } from '../server/src/arcoHome.js';

// Repo root: this file lives at <root>/scripts/arco-service.ts.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// systemd `--user` unit location, respecting XDG_CONFIG_HOME.
const UNIT_NAME = 'arco.service';
function unitDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim()
    ? process.env.XDG_CONFIG_HOME
    : join(homedir(), '.config');
  return join(xdg, 'systemd', 'user');
}
function unitPath(): string {
  return join(unitDir(), UNIT_NAME);
}

const isMac = process.platform === 'darwin';

// Resolved Arco structured-log file path. Mirrors server/src/server/logger.ts:
// ARCO_LOG_DIR override, else ~/.arco/logs/arco.log. The CLI tails this
// file directly (no server import) so `logs` works without a running server.
function logFilePath(): string {
  const dir = process.env.ARCO_LOG_DIR && process.env.ARCO_LOG_DIR.trim()
    ? process.env.ARCO_LOG_DIR
    : join(arcoHome(), 'logs');
  return join(dir, 'arco.log');
}

function macNotice(): void {
  const server = join(REPO_ROOT, 'server', 'dist', 'index.js');
  console.log(
    [
      'systemd is not available on macOS — `arco service` actions are Linux-only.',
      '',
      'To run production mode manually:',
      `  cd ${REPO_ROOT}`,
      '  npm run build',
      `  ARCO_SERVE_CLIENT=1 NODE_ENV=production node ${server}`,
      '',
      'launchd support is a later K-tier add (see docs/SERVICE_MODE.md).',
    ].join('\n'),
  );
}

// Run `systemctl --user <args>` inheriting stdio so status/logs stream to the
// terminal. Returns the exit code; never throws on non-zero (callers decide).
function systemctlInherit(args: string[]): Promise<number> {
  return new Promise((res) => {
    const child = spawn('systemctl', ['--user', ...args], { stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`[arco service] failed to spawn systemctl: ${err.message}`);
      res(127);
    });
    child.on('exit', (code) => res(code ?? 1));
  });
}

async function daemonReload(): Promise<void> {
  await systemctlInherit(['daemon-reload']);
}

async function doInstall(args: ServiceArgs): Promise<number> {
  if (isMac) {
    macNotice();
    return 0;
  }
  // Build first so server/dist/index.js + client/dist exist. `npm run build`
  // does `rm -rf dist && tsc` in server, then bundles the client.
  console.log('[arco service] building (npm run build)…');
  const build = await new Promise<number>((res) => {
    const child = spawn('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`[arco service] build spawn failed: ${err.message}`);
      res(127);
    });
    child.on('exit', (code) => res(code ?? 1));
  });
  if (build !== 0) {
    console.error('[arco service] build failed — not writing unit.');
    return build;
  }

  const unit = renderSystemdUnit({
    repoRoot: REPO_ROOT,
    ...(process.env.ARCO_PORT ? { port: process.env.ARCO_PORT } : {}),
    ...(process.env.ARCO_HOST ? { host: process.env.ARCO_HOST } : {}),
    // Tier-5 promotion: capture the hub + ntfy env from the install-time shell so
    // the durable unit links the hub and pushes ntfy without an inline launcher.
    // (REMOTE_MANAGEMENT.md §9/§J2 — both stay inert when their var is unset.)
    ...(process.env.ARCO_HUB_URL ? { hubUrl: process.env.ARCO_HUB_URL } : {}),
    ...(process.env.ARCO_NTFY_URL ? { ntfyUrl: process.env.ARCO_NTFY_URL } : {}),
  });
  await mkdir(unitDir(), { recursive: true });
  await writeFile(unitPath(), unit, 'utf8');
  console.log(`[arco service] wrote ${unitPath()}`);
  if (process.env.ARCO_HUB_URL) {
    console.log(`[arco service] hub-linked: ARCO_HUB_URL=${process.env.ARCO_HUB_URL}`);
  }
  if (process.env.ARCO_NTFY_URL) {
    console.log('[arco service] ntfy push enabled (ARCO_NTFY_URL baked into unit).');
  }

  await daemonReload();
  if (args.enable) {
    await systemctlInherit(['enable', UNIT_NAME]);
    console.log('[arco service] enabled (will start on next login).');
  }
  console.log('[arco service] installed. Start with: arco service start');
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
    console.log(`[arco service] removed ${unitPath()}`);
  }
  await daemonReload();
  console.log('[arco service] uninstalled.');
  return 0;
}

// Best-effort readiness readout for `status`. Probes the live /readyz over
// loopback and prints one line. Never throws and never affects the caller's
// exit code: a stopped service → fetch rejects → "unreachable". Port mirrors
// the server's own default (ARCO_PORT || 3001).
async function printReadiness(): Promise<void> {
  const port = process.env.ARCO_PORT || '3001';
  try {
    const r = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = (await r.json()) as {
      status?: string;
      components?: Record<string, boolean>;
      pending?: string[];
    };
    if (body.status === 'ready') {
      const comps = Object.keys(body.components ?? {}).join(', ');
      console.log(`readiness: ready (${comps})`);
    } else {
      const pending = (body.pending ?? []).join(', ') || 'unknown';
      console.log(`readiness: NOT READY — pending: ${pending}`);
    }
  } catch {
    console.log(`readiness: unreachable (server not responding on :${port})`);
  }
}

// `arco service logs` — two sources:
//   default  → tail the Arco structured log file with `tail -n N -f` (POSIX:
//              Linux + macOS), so it works regardless of systemd. If the file is
//              absent, print a clear note and exit 0 (non-fatal — the service may
//              simply not be running with ARCO_LOG_FILE=1 yet).
//   --journal → the systemd journal via `journalctl --user -u arco -f`
//               (Linux/systemd only; on macOS prints the manual-run notice).
async function doLogs(args: ServiceArgs): Promise<number> {
  if (args.journal) {
    if (isMac) {
      macNotice();
      return 0;
    }
    const jargs = ['--user', '-u', UNIT_NAME, '-f'];
    if (args.lines !== undefined) jargs.push('-n', String(args.lines));
    return new Promise((res) => {
      const child = spawn('journalctl', jargs, { stdio: 'inherit' });
      child.on('error', (err) => {
        console.error(`[arco service] failed to spawn journalctl: ${err.message}`);
        res(127);
      });
      child.on('exit', (code) => res(code ?? 0));
    });
  }

  const file = logFilePath();
  if (!existsSync(file)) {
    console.log(
      `[arco service] no log file at ${file} — is the service running with ARCO_LOG_FILE=1?`,
    );
    return 0;
  }
  const n = args.lines ?? 200;
  return new Promise((res) => {
    const child = spawn('tail', ['-n', String(n), '-f', file], { stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`[arco service] failed to spawn tail: ${err.message}`);
      res(127);
    });
    child.on('exit', (code) => res(code ?? 0));
  });
}

async function doSystemctlAction(args: ServiceArgs): Promise<number> {
  if (isMac) {
    macNotice();
    return 0;
  }
  if (!existsSync(unitPath())) {
    console.error(
      `[arco service] no unit at ${unitPath()} — run \`arco service install\` first.`,
    );
    // `status` still probes readiness: the server may be running via `npm run
    // dev` or a manual `node dist/index.js` even with no unit installed, and the
    // readiness readout is independent of systemd. Other actions need the unit.
    if (args.command === 'status') await printReadiness();
    return 1;
  }
  switch (args.command) {
    case 'start':
      return systemctlInherit(['start', UNIT_NAME]);
    case 'stop':
      return systemctlInherit(['stop', UNIT_NAME]);
    case 'status': {
      // status returns non-zero when the unit is stopped — surface that exit
      // code as-is. The readiness line is ADDITIVE/best-effort: it probes the
      // live HTTP surface and never alters the systemctl exit code (a stopped
      // unit → fetch fails → "unreachable", still returns the systemctl code).
      const code = await systemctlInherit(['status', UNIT_NAME, '--no-pager']);
      await printReadiness();
      return code;
    }
    default:
      return 1;
  }
}

function usage(): void {
  console.error(
    [
      'Usage: arco service <command> [options]',
      '',
      'Commands:',
      '  install     build + write the systemd --user unit + daemon-reload',
      '  start       systemctl --user start arco',
      '  stop        systemctl --user stop arco',
      '  status      systemctl --user status arco',
      '  logs        tail ~/.arco/logs/arco.log -f  (--journal → journalctl)',
      '  uninstall   stop + disable + remove unit + daemon-reload',
      '',
      'Options:',
      '  --enable      (install) also enable the unit so it starts on login',
      '  --journal     (logs) follow the systemd journal instead of the log file',
      '  -n, --lines N (logs) tail the last N lines',
      '',
      `Recognized commands: ${SERVICE_COMMANDS.join(', ')}`,
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = parseServiceArgs(process.argv.slice(2));
  if (args.unknown.length > 0) {
    console.error(`[arco service] unrecognized argument(s): ${args.unknown.join(' ')}`);
    usage();
    process.exit(2);
  }
  if (args.command === null) {
    usage();
    process.exit(2);
  }

  let code: number;
  switch (args.command) {
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

// Only run when invoked as a script (not when something imports a symbol).
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  void main();
}
