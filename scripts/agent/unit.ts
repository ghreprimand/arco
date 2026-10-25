// archon-agent §13.3 — pure helpers: CLI arg parsing + systemd `--user` unit
// rendering for the agent supervisor. Side-effect-free so the smoke imports and
// asserts on them without an install. Mirrors scripts/service/unit.ts.
//
// Linux autostart is a `--user` unit (enabled at install). macOS does NOT
// autostart in v1 — the CLI prints a manual notice (launchd is a later add).

export type AgentCommand =
  | 'keygen'
  | 'install'
  | 'start'
  | 'stop'
  | 'status'
  | 'restart'
  | 'logs'
  | 'uninstall'
  | 'selftest'
  | 'run';

export const AGENT_COMMANDS: readonly AgentCommand[] = [
  'keygen',
  'install',
  'start',
  'stop',
  'status',
  'restart',
  'logs',
  'uninstall',
  'selftest',
  'run',
] as const;

export interface AgentArgs {
  command: AgentCommand | null;
  enable: boolean; // install --enable → systemctl enable (autostart on login)
  out?: string; // keygen --out <dir>
  hubUrl?: string; // run/install --hub <url> (override ARCHON_HUB_URL)
  lines?: number; // logs -n N
  unknown: string[];
}

export function parseAgentArgs(argv: string[]): AgentArgs {
  const out: AgentArgs = { command: null, enable: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (out.command === null && (AGENT_COMMANDS as readonly string[]).includes(tok)) {
      out.command = tok as AgentCommand;
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
    if (tok === '--hub') {
      out.hubUrl = argv[++i];
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

export interface AgentUnitOptions {
  repoRoot: string;
  hubUrl?: string; // baked into the unit env when provided
  publicKeyPath?: string; // hub.pub location; defaults to ~/.archon/agent/hub.pub
  restartSec?: number;
}

// Render the archon-agent systemd `--user` unit. The agent runs via tsx (it is
// a small long-lived script, not part of the compiled server bundle) so it can
// share the repo's scripts/ without a separate build step. Restart=always
// because the agent is a supervisor — it should come back whenever it dies.
export function renderAgentUnit(opts: AgentUnitOptions): string {
  const restartSec = opts.restartSec ?? 3;
  const entry = posixJoin(opts.repoRoot, 'scripts', 'archon-agent.ts');
  const execStart = `npx tsx ${entry} run`;

  const env: string[] = [];
  if (opts.hubUrl) env.push(`Environment=ARCHON_HUB_URL=${opts.hubUrl}`);
  if (opts.publicKeyPath) env.push(`Environment=ARCHON_HUB_PUBKEY=${opts.publicKeyPath}`);

  return [
    '[Unit]',
    'Description=archon-agent — per-host lifecycle supervisor (tailnet-only)',
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
    ...env,
    'Restart=always',
    `RestartSec=${restartSec}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

// POSIX join (systemd units always use '/'); kept local so this stays a pure,
// dependency-light module the smoke imports cleanly. Matches service/unit.ts.
function posixJoin(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .filter((p) => p.length > 0)
    .join('/');
}
