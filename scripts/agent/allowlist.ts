// arco-agent §6 — the fixed lifecycle-command allowlist.
//
// PURE module: maps a LifecycleCommand + Platform to the exact argv to execute.
// No spawning here (the runner does that) and no shell strings — argv arrays
// only, so there is never an interpolation surface. Returns null when a command
// is not supported on the platform (the handler reports unsupported-platform).
//
// These mirror the B1 control surface (scripts/arco-service.ts): the agent
// shells the SAME systemctl/journalctl templates, never free-form.
//
// Import path for scripts/smoke: '../agent/allowlist.js'

import type { LifecycleCommand, Platform } from '../../shared/src/protocol/remoteManagement.js';

export interface CommandSpec {
  cmd: string;
  args: string[];
}

export interface RenderOptions {
  // macOS launchctl targets are gui/<uid>/<label>; the uid is injected so this
  // stays pure (no process.getuid() call inside). Required on macOS: without it
  // there is no user domain to address and every macOS command renders null.
  // Ignored on Linux.
  uid?: number;
  // Unit/label overrides (defaults match the installed units). Kept for tests.
  arcoUnit?: string; // default 'arco.service'
  agentUnit?: string; // default 'arco-agent.service'
  macLabel?: string; // default MAC_SERVICE_LABEL, the packaged LaunchAgent
  logLines?: number; // default 200 for logs.tail
}

const LINUX_LOG_DEFAULT = 200;

// The label of the LaunchAgent that `arco service install` writes for package
// installs (scripts/packaging/services.mjs). A hand-maintained source-checkout
// job with another label is reached through the macLabel override.
export const MAC_SERVICE_LABEL = 'arco-workbench';

export function renderLifecycleCommand(
  command: LifecycleCommand,
  platform: Platform,
  opts: RenderOptions = {},
): CommandSpec | null {
  const arcoUnit = opts.arcoUnit ?? 'arco.service';
  const agentUnit = opts.agentUnit ?? 'arco-agent.service';
  const n = String(opts.logLines ?? LINUX_LOG_DEFAULT);

  if (platform === 'linux') {
    switch (command) {
      case 'arco.status':
        return { cmd: 'systemctl', args: ['--user', 'status', arcoUnit, '--no-pager'] };
      case 'arco.start':
        return { cmd: 'systemctl', args: ['--user', 'start', arcoUnit] };
      case 'arco.stop':
        return { cmd: 'systemctl', args: ['--user', 'stop', arcoUnit] };
      case 'arco.restart':
        return { cmd: 'systemctl', args: ['--user', 'restart', arcoUnit] };
      case 'arco.logs.tail':
        return { cmd: 'journalctl', args: ['--user', '-u', arcoUnit, '-n', n, '--no-pager'] };
      case 'arco-agent.status':
        return { cmd: 'systemctl', args: ['--user', 'status', agentUnit, '--no-pager'] };
      case 'arco-agent.restart':
        return { cmd: 'systemctl', args: ['--user', 'restart', agentUnit] };
      default:
        return null;
    }
  }

  if (platform === 'macos') {
    if (typeof opts.uid !== 'number' || !Number.isSafeInteger(opts.uid) || opts.uid < 0) return null;
    const label = opts.macLabel ?? MAC_SERVICE_LABEL;
    const target = `gui/${opts.uid}/${label}`;
    // Same verbs as `arco service start|stop|status` on macOS: stop sends
    // SIGTERM and leaves the job loaded, so a later start or restart can
    // kickstart it again (bootout would unload it and kickstart would fail).
    switch (command) {
      case 'arco.status':
        return { cmd: 'launchctl', args: ['print', target] };
      case 'arco.start':
        return { cmd: 'launchctl', args: ['kickstart', target] };
      case 'arco.stop':
        return { cmd: 'launchctl', args: ['kill', 'SIGTERM', target] };
      case 'arco.restart':
        return { cmd: 'launchctl', args: ['kickstart', '-k', target] };
      case 'arco.logs.tail':
        // The package job logs under the Arco home and a hand-maintained job
        // may log anywhere; no fixed path is safe to put in argv, so skip.
        return null;
      case 'arco-agent.status':
      case 'arco-agent.restart':
        // The agent supervising itself on macOS is a launchd later-add (§13.3).
        return null;
      default:
        return null;
    }
  }

  // windows / unknown — no lifecycle surface in v1.
  return null;
}
