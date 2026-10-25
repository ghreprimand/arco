// archon-management — pure CLI arg parse + systemd unit render. Side-effect-free
// so the smoke imports and asserts without an install. Mirrors agent/unit.ts.

export type ManagementCommand =
  | 'keygen'
  | 'serve'
  | 'install'
  | 'start'
  | 'stop'
  | 'status'
  | 'restart'
  | 'logs'
  | 'uninstall';

export const MANAGEMENT_COMMANDS: readonly ManagementCommand[] = [
  'keygen',
  'serve',
  'install',
  'start',
  'stop',
  'status',
  'restart',
  'logs',
  'uninstall',
] as const;

export interface ManagementArgs {
  command: ManagementCommand | null;
  enable: boolean;
  out?: string;
  host?: string; // serve/install --host (tailnet IP)
  port?: number; // serve/install --port (default 3500)
  lines?: number;
  unknown: string[];
}

export function parseManagementArgs(argv: string[]): ManagementArgs {
  const out: ManagementArgs = { command: null, enable: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (out.command === null && (MANAGEMENT_COMMANDS as readonly string[]).includes(tok)) {
      out.command = tok as ManagementCommand;
      continue;
    }
    if (tok === '--enable') {
      out.enable = true;
      continue;
    }
    if (tok === '--out') {
      out.out = argv[++i];
      continue;
    }
    if (tok === '--host') {
      out.host = argv[++i];
      continue;
    }
    if (tok === '--port') {
      const p = parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(p)) out.port = p;
      else out.unknown.push(tok);
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

export interface ManagementUnitOptions {
  repoRoot: string;
  host: string; // tailnet IP — NEVER 0.0.0.0
  port: number;
  privateKeyPath: string; // hub.key location
  restartSec?: number;
}

// systemd `--user` unit for the hub. Binds the tailnet interface only (the
// operator passes the tailnet IP at install). Restart=always — it's a service.
export function renderManagementUnit(opts: ManagementUnitOptions): string {
  const restartSec = opts.restartSec ?? 3;
  const entry = posixJoin(opts.repoRoot, 'scripts', 'archon-management.ts');
  const execStart = `npx tsx ${entry} serve --host ${opts.host} --port ${opts.port}`;
  return [
    '[Unit]',
    'Description=archon-management — tailnet-only remote management hub',
    'Documentation=https://github.com/ghreprimand/arco',
    'After=network-online.target',
    'Wants=network-online.target',
    'StartLimitIntervalSec=60',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${opts.repoRoot}`,
    `ExecStart=${execStart}`,
    `Environment=ARCHON_HUB_KEY=${opts.privateKeyPath}`,
    'Restart=always',
    `RestartSec=${restartSec}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function posixJoin(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .filter((p) => p.length > 0)
    .join('/');
}
