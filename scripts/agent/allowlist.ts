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
  // stays pure (no process.getuid() call inside). Ignored on Linux.
  uid?: number;
  // Unit/label overrides (defaults match the installed units). Kept for tests.
  arcoUnit?: string; // default 'arco.service'
  agentUnit?: string; // default 'arco-agent.service'
  macLabel?: string; // default 'com.arco.app'
  logLines?: number; // default 200 for logs.tail
}

const LINUX_LOG_DEFAULT = 200;

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
    const uid = opts.uid ?? 0;
    const label = opts.macLabel ?? 'com.arco.app';
    const target = `gui/${uid}/${label}`;
    // macOS has no autostart in v1 (§13.3) — these still let a RUNNING agent
    // drive a manually/launchd-launched Arco. Log path mirrors the documented
    // ~/Library/Logs/Arco/arco.log (HOME-relative via tail's own expansion
    // is unsafe in argv; the handler passes an absolute path — see agent.ts).
    switch (command) {
      case 'arco.status':
        return { cmd: 'launchctl', args: ['print', target] };
      case 'arco.start':
        return { cmd: 'launchctl', args: ['kickstart', target] };
      case 'arco.stop':
        return { cmd: 'launchctl', args: ['bootout', target] };
      case 'arco.restart':
        return { cmd: 'launchctl', args: ['kickstart', '-k', target] };
      case 'arco.logs.tail':
        // Absolute log path is resolved by the caller and passed via macLogPath;
        // when absent we cannot safely build a tilde path in argv, so skip.
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
