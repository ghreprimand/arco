// docs/ARCHITECTURE.md - Production Service Mode: pure helpers.
//
// This module is deliberately side-effect-free: argv parsing + systemd unit
// rendering only. No filesystem writes, no `systemctl` spawns, no auto-enable.
// The CLI entry (scripts/arco-service.ts) composes these with the actual
// install/start/stop side effects; the smoke (scripts/smoke/service-cli.ts)
// imports `parseServiceArgs` + `renderSystemdUnit` directly and asserts on
// their output WITHOUT a live install — so these must run on every platform.
//
// Import path for the smoke: '../service/unit.js'
//   parseServiceArgs(argv: string[]): ServiceArgs
//   renderSystemdUnit(opts: UnitOptions): string

export type ServiceCommand =
  | 'install'
  | 'start'
  | 'stop'
  | 'status'
  | 'logs'
  | 'uninstall';

export const SERVICE_COMMANDS: readonly ServiceCommand[] = [
  'install',
  'start',
  'stop',
  'status',
  'logs',
  'uninstall',
] as const;

export interface ServiceArgs {
  // null when argv carried no recognized subcommand — the CLI prints usage and
  // exits non-zero rather than guessing a default (unlike the dev launcher,
  // which defaults to `start`; a service action should always be explicit).
  command: ServiceCommand | null;
  // Whether `install` should also `systemctl --user enable` the unit so it
  // comes back on next login. Off by default — install writes + reloads only.
  enable: boolean;
  // `logs --journal` → tail the systemd journal (journalctl --user -u arco)
  // instead of the default Arco structured log file (~/.arco/logs/arco.log
  // via POSIX `tail -f`). Off by default so `logs` is cross-platform (macOS has
  // no journalctl); --journal is the Linux/systemd opt-in.
  journal: boolean;
  // `logs -n N` / `logs --lines N` tail count. undefined → systemd default.
  lines?: number;
  // Unknown tokens preserved for an actionable error message.
  unknown: string[];
}

export function parseServiceArgs(argv: string[]): ServiceArgs {
  const out: ServiceArgs = { command: null, enable: false, journal: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (out.command === null && (SERVICE_COMMANDS as readonly string[]).includes(tok)) {
      out.command = tok as ServiceCommand;
      continue;
    }
    if (tok === '--enable') {
      out.enable = true;
      continue;
    }
    if (tok === '--journal') {
      out.journal = true;
      continue;
    }
    if (tok === '-n' || tok === '--lines') {
      const n = parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(n)) out.lines = n;
      else out.unknown.push(tok);
      continue;
    }
    out.unknown.push(tok);
  }
  return out;
}

export interface UnitOptions {
  // Absolute repo root. ExecStart + WorkingDirectory derive from it.
  repoRoot: string;
  // Pass-through env from the operator's shell at install time, if set, so the
  // unit pins the same port/host the operator expects. Unset → systemd uses the
  // server's own defaults (ARCO_PORT=3001 / ARCO_HOST=127.0.0.1).
  port?: string | number;
  host?: string;
  // Tier-5 remote-management env, baked into the unit when the operator promotes
  // a hub-linked box (REMOTE_MANAGEMENT.md §9/§J2). Without these the compiled
  // server's initHubLink/initNtfyTransport stay INERT — workstation would come up a
  // working service but OFFLINE to the management hub and SILENT on ntfy, which
  // is exactly the failure the dev launcher's inline env avoided. Unset → both
  // stay off (an ordinary single-box install needs neither). Tailnet-only URLs.
  hubUrl?: string; // ARCO_HUB_URL — ws://<hub-tailnet>:<port>
  ntfyUrl?: string; // ARCO_NTFY_URL — http://<ntfy-tailnet>:<port>/<topic>
  // Seconds systemd waits before a restart-on-failure. A few seconds avoids a
  // crash-loop hammering the API while still recovering quickly.
  restartSec?: number;
}

// Render a systemd `--user` unit. Production runs the COMPILED server
// (`node server/dist/index.js`) — never tsx — with ARCO_SERVE_CLIENT=1 so the
// in-process static-serve fallback (router.ts) owns client/dist instead of Vite.
// Restart=on-failure is the B1 acceptance (survive a crash). WantedBy is
// default.target because a `--user` unit has no multi-user.target.
export function renderSystemdUnit(opts: UnitOptions): string {
  const { repoRoot } = opts;
  const restartSec = opts.restartSec ?? 3;
  const execStart = `node ${join(repoRoot, 'server', 'dist', 'index.js')}`;

  const env: string[] = [
    'Environment=ARCO_SERVE_CLIENT=1',
    'Environment=NODE_ENV=production',
    // Enable structured file logging (server/src/server/logger.ts). The server
    // tees console.* to a rotated JSONL file at ~/.arco/logs/arco.log so
    // `arco service logs` has a portable, structured source on top of journald.
    'Environment=ARCO_LOG_FILE=1',
    // IPv6 is disabled outright on this deployment (no usable v6 egress; a v6
    // usage fetch once crash-looped the service into a permanent "SERVER DOWN" —
    // see server/src/net/forceIpv4.ts). The server's OWN process hard-blocks v6
    // in code (forceIpv4.ts forces dns.lookup to family 4). This NODE_OPTIONS
    // line is the belt for the SPAWNED provider CLIs (claude/codex are
    // separate Node processes that inherit it) — it makes them prefer IPv4 too.
    'Environment=NODE_OPTIONS=--dns-result-order=ipv4first',
  ];
  if (opts.port !== undefined && String(opts.port).length > 0) {
    env.push(`Environment=ARCO_PORT=${opts.port}`);
  }
  if (opts.host !== undefined && opts.host.length > 0) {
    env.push(`Environment=ARCO_HOST=${opts.host}`);
  }
  if (opts.hubUrl !== undefined && opts.hubUrl.length > 0) {
    env.push(`Environment=ARCO_HUB_URL=${opts.hubUrl}`);
  }
  if (opts.ntfyUrl !== undefined && opts.ntfyUrl.length > 0) {
    env.push(`Environment=ARCO_NTFY_URL=${opts.ntfyUrl}`);
  }

  return [
    '[Unit]',
    'Description=Arco — multi-provider coding workbench',
    'Documentation=https://github.com/ghreprimand/arco',
    'After=network-online.target',
    'Wants=network-online.target',
    // Crash-loop bounding: pair with Restart=on-failure so a process that dies
    // immediately on boot is rate-limited rather than respawned forever. systemd
    // requires StartLimit* in [Unit], not [Service]. >5 failures in 60s → systemd
    // gives up (`failed` state) instead of hammering the API on a tight loop.
    'StartLimitIntervalSec=60',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${repoRoot}`,
    `ExecStart=${execStart}`,
    ...env,
    'Restart=on-failure',
    `RestartSec=${restartSec}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

// Local join — kept here (rather than importing 'path') so this stays a pure,
// dependency-light module the smoke can import without pulling node:path
// resolution quirks across platforms. POSIX systemd units always use '/'.
function join(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .filter((p) => p.length > 0)
    .join('/');
}
