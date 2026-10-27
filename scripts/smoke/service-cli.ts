// docs/ARCHITECTURE.md - Production Service Mode smoke.
//
// Tests the PURE functions only — CLI arg-parsing + systemd unit-file
// generation. NO live install: no systemctl/journalctl calls, no unit written
// to disk. Imports parseServiceArgs + renderSystemdUnit from
// scripts/service/unit.ts and asserts the load-bearing shape. Runs on any
// platform (the pure functions are side-effect-free), unlike the dev-server
// smokes which need :3001.
//
// Also guards the load-bearing boot invariant (ARCO_OPS_PLAN §B1): the
// compiled server can only start if `@arco/shared` resolves to compiled JS
// under bare `node`, not its .ts source — a regression in shared's conditional
// `exports` crash-loops the service on boot with ERR_UNKNOWN_FILE_EXTENSION.
// We assert the exports map statically (always) and, when shared/dist exists,
// boot a bare-node import to prove prod resolution lands on dist.
//
// Run: npm run smoke:service-cli  (no server needed)

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { step, assert, assertEq, summary } from './lib.js';
import {
  parseServiceArgs,
  renderSystemdUnit,
  SERVICE_COMMANDS,
} from '../service/unit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main() {
  await step('parseServiceArgs maps each subcommand', () => {
    for (const cmd of SERVICE_COMMANDS) {
      const parsed = parseServiceArgs([cmd]);
      assertEq(parsed.command, cmd, `"${cmd}" → command ${cmd}`);
      assert(parsed.unknown.length === 0, `"${cmd}" has no unknown tokens`);
    }
  });

  await step('no subcommand → command null (caller prints usage, exits non-zero)', () => {
    const parsed = parseServiceArgs([]);
    assertEq(parsed.command, null, 'empty argv → null command');
  });

  await step('unknown command surfaces in .unknown (not silently a default)', () => {
    const parsed = parseServiceArgs(['frobnicate']);
    assertEq(parsed.command, null, 'unknown token does not become a command');
    assert(parsed.unknown.includes('frobnicate'), 'unknown token preserved');
  });

  await step('--enable flag parsed for install', () => {
    const parsed = parseServiceArgs(['install', '--enable']);
    assertEq(parsed.command, 'install', 'command install');
    assertEq(parsed.enable, true, 'enable true');
    assert(parsed.unknown.length === 0, 'no unknown tokens');
  });

  await step('logs -n N / --lines N parsed as a number', () => {
    const a = parseServiceArgs(['logs', '-n', '50']);
    assertEq(a.command, 'logs', 'command logs');
    assertEq(a.lines, 50, '-n 50 → lines 50');
    const b = parseServiceArgs(['logs', '--lines', '200']);
    assertEq(b.lines, 200, '--lines 200 → lines 200');
  });

  // ── Unit rendering ──
  const repoRoot = '/home/op/Projects/Arco';
  let unit = '';

  await step('renderSystemdUnit emits load-bearing lines', () => {
    unit = renderSystemdUnit({ repoRoot });
    assert(unit.includes('[Unit]'), 'has [Unit] section');
    assert(unit.includes('[Service]'), 'has [Service] section');
    assert(unit.includes('[Install]'), 'has [Install] section');
    assert(unit.includes('WantedBy=default.target'), 'WantedBy=default.target (user unit)');
    assert(
      unit.includes(`ExecStart=node ${repoRoot}/server/dist/index.js`),
      'ExecStart runs node against server/dist/index.js',
    );
    assert(unit.includes(`WorkingDirectory=${repoRoot}`), 'WorkingDirectory set to repo root');
    assert(unit.includes('Environment=ARCO_SERVE_CLIENT=1'), 'ARCO_SERVE_CLIENT=1 set');
    assert(unit.includes('Environment=NODE_ENV=production'), 'NODE_ENV=production set');
    // IPv6 disabled for spawned provider CLIs — paired with the in-process hard
    // block (forceIpv4.ts). Regression guard for the 2026-06-05 crash-loop.
    assert(unit.includes('Environment=NODE_OPTIONS=--dns-result-order=ipv4first'), 'NODE_OPTIONS pins ipv4first');
    assert(unit.includes('Restart=on-failure'), 'Restart=on-failure (B1 acceptance)');
    assert(/RestartSec=\d+/.test(unit), 'RestartSec set');
  });

  await step('ExecStart uses compiled server — NOT tsx, NOT sudo', () => {
    const execLine = unit.split('\n').find((l) => l.startsWith('ExecStart=')) ?? '';
    assert(!execLine.includes('tsx'), 'ExecStart does not invoke tsx');
    assert(!/\bnpm run dev\b/.test(execLine), 'ExecStart does not run the dev wrapper');
    assert(!unit.includes('sudo'), 'unit contains no sudo (it is a --user unit)');
  });

  await step('ARCO_PORT / ARCO_HOST pass through only when provided', () => {
    const bare = renderSystemdUnit({ repoRoot });
    assert(!bare.includes('Environment=ARCO_PORT='), 'no ARCO_PORT line when unset');
    assert(!bare.includes('Environment=ARCO_HOST='), 'no ARCO_HOST line when unset');
    const pinned = renderSystemdUnit({ repoRoot, port: 4000, host: '0.0.0.0' });
    assert(pinned.includes('Environment=ARCO_PORT=4000'), 'ARCO_PORT passed through');
    assert(pinned.includes('Environment=ARCO_HOST=0.0.0.0'), 'ARCO_HOST passed through');
  });

  await step('ARCO_HUB_URL / ARCO_NTFY_URL bake into the unit only when provided', () => {
    // Tier-5 promotion: a hub-linked box must carry both URLs into the durable
    // unit, else the compiled server comes up offline-to-hub + silent-on-ntfy
    // (REMOTE_MANAGEMENT.md §9/§J2). Absent → no lines (ordinary single-box).
    const bare = renderSystemdUnit({ repoRoot });
    assert(!bare.includes('Environment=ARCO_HUB_URL='), 'no ARCO_HUB_URL line when unset');
    assert(!bare.includes('Environment=ARCO_NTFY_URL='), 'no ARCO_NTFY_URL line when unset');
    const linked = renderSystemdUnit({
      repoRoot,
      hubUrl: 'ws://100.64.0.20:3500',
      ntfyUrl: 'http://100.64.0.20:3501/arco-topic',
    });
    assert(
      linked.includes('Environment=ARCO_HUB_URL=ws://100.64.0.20:3500'),
      'ARCO_HUB_URL baked into the unit',
    );
    assert(
      linked.includes('Environment=ARCO_NTFY_URL=http://100.64.0.20:3501/arco-topic'),
      'ARCO_NTFY_URL baked into the unit',
    );
  });

  // ── Boot invariant: @arco/shared must resolve to compiled JS in prod ──
  await step('shared/package.json exports resolve prod → dist (not .ts)', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'shared', 'package.json'), 'utf8')) as {
      main?: string;
      exports?: { ['.']?: Record<string, string> };
    };
    const dot = pkg.exports?.['.'];
    assert(!!dot, 'shared exports has a "." entry');
    // The branches bare `node` (production / `arco service`) sees must point at
    // compiled JS — a .ts here is the crash-on-boot regression.
    assert(dot!.default?.endsWith('.js') === true, `default → .js (got ${dot!.default})`);
    assert(dot!.import?.endsWith('.js') === true, `import → .js (got ${dot!.import})`);
    assert(!dot!.default?.endsWith('.ts'), 'default must NOT be a .ts source');
    // Dev tooling still gets live source.
    assert(dot!.development?.endsWith('.ts') === true, `development → .ts (got ${dot!.development})`);
    assert(pkg.main?.endsWith('.js') === true, `top-level main → .js (got ${pkg.main})`);
  });

  await step('bare node resolves @arco/shared to compiled JS (when built)', () => {
    if (!existsSync(join(REPO_ROOT, 'shared', 'dist', 'index.js'))) {
      console.log('        (shared/dist absent — run `npm run build` to exercise this; skipping)');
      return;
    }
    // No --conditions: this is exactly how the systemd unit's `node
    // server/dist/index.js` resolves. Throws (non-zero exit) on the .ts regression.
    let ok = true;
    try {
      execFileSync(
        process.execPath,
        ['--input-type=module', '-e', 'import("@arco/shared").then(()=>process.exit(0),()=>process.exit(1))'],
        { cwd: REPO_ROOT, stdio: 'pipe' },
      );
    } catch {
      ok = false;
    }
    assert(ok, 'bare `node` imported @arco/shared without ERR_UNKNOWN_FILE_EXTENSION');
  });

  summary('service-cli');
}

main();
