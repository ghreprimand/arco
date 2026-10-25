import { spawnSync } from 'child_process';
import { delimiter, join } from 'path';
import { homedir } from 'os';

const MANAGER_ENV_TIMEOUT_MS = 1000;

function readUserManagerEnvironment(): Record<string, string> {
  try {
    const result = spawnSync('systemctl', ['--user', 'show-environment'], {
      encoding: 'utf8',
      timeout: MANAGER_ENV_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0 || !result.stdout) return {};
    const out: Record<string, string> = {};
    for (const line of result.stdout.split('\n')) {
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      out[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return out;
  } catch {
    return {};
  }
}

function mergePathValues(...values: Array<string | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    for (const part of (value ?? '').split(delimiter)) {
      if (!part || seen.has(part)) continue;
      seen.add(part);
      out.push(part);
    }
  }
  return out.join(delimiter);
}

// Production service mode starts from systemd's user-manager environment, which
// can be much thinner than an interactive shell on boot. Patch the process PATH
// once before capability probes or provider spawns run, keeping common user CLI
// locations available even when the unit was started before shell init files.
//
// Order matters: mergePathValues dedups first-occurrence-wins, so the user-space
// CLI dirs must come BEFORE the stock process PATH. A root-owned system install
// (e.g. /usr/local/bin/claude) otherwise shadows the copy the operator actually
// maintains in ~/.npm-global/bin — which is exactly what happened on 2026-07-05:
// a reboot brought the user manager up with a minimal PATH (/usr/local/bin first,
// no ~/.npm-global/bin), and the CLI version probe silently flipped from the
// maintained v2.1.201 to a stale root-installed v2.1.63. Prepending user dirs
// matches normal shell convention (~/.npm-global/bin, ~/.local/bin prepend) and
// makes resolution reboot-independent.
export function hydrateProcessPathFromUserEnv(): void {
  const manager = readUserManagerEnvironment();
  process.env.PATH = mergePathValues(
    join(homedir(), '.npm-global', 'bin'),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.cargo', 'bin'),
    manager.PATH,
    process.env.PATH,
    '/usr/local/bin',
    '/usr/bin',
    '/usr/sbin',
  );
}

const DESKTOP_ENV_KEYS = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_CURRENT_DESKTOP',
  'XDG_SESSION_TYPE',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'HYPRLAND_INSTANCE_SIGNATURE',
  'QT_QPA_PLATFORMTHEME',
  'QT_QPA_PLATFORM',
  'QT_PLUGIN_PATH',
  'QML2_IMPORT_PATH',
] as const;

export function desktopLaunchEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const manager = readUserManagerEnvironment();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of DESKTOP_ENV_KEYS) {
    const value = manager[key] || process.env[key];
    if (value) env[key] = value;
  }
  if (manager.PATH) env.PATH = mergePathValues(process.env.PATH, manager.PATH);
  return { ...env, ...extra };
}

export function hasDesktopLaunchEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}
