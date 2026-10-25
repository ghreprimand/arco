// H42 part A — systemd shutdown-window alignment probe
// (BORROWED_IMPROVEMENTS_EXECUTION.md Phase 2).
//
// On SIGTERM, index.ts's onSignal() does graceful shutdown work — SIGKILL the
// detached worker process groups, reap PTY/LSP children, then flush every
// workflow's buffered events.jsonl before exiting. systemd gives a unit only
// `TimeoutStopUSec` after SIGTERM before it escalates to SIGKILL. If that window
// is shorter than the time graceful shutdown needs, systemd hard-kills Archon
// mid-flush — losing tail events and leaving the durable state inconsistent.
//
// This probe reads the unit's TimeoutStopUSec and warns when it's below the
// graceful-shutdown budget. Part B (the onSignal forensics line — a bounded
// flush budget + a "shutdown took Nms" log) is deferred per the plan.
//
// SKIP off-systemd: only meaningful when the process was actually started by a
// systemd unit (INVOCATION_ID set) on Linux. Read-only — one `systemctl show`
// execFile, timeout-bounded, no shell.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';

const execFileAsync = promisify(execFile);

// Budget onSignal needs to reap children + flush all workflow events + exit
// (the explicit exit timer alone is 100ms; the variable cost is buffered-event
// I/O across open workflows). Conservative — the systemd default TimeoutStopUSec
// is 90s, far above this; only a hand-lowered TimeoutStopSec trips the warning.
export const GRACEFUL_SHUTDOWN_WINDOW_SEC = 10;

const SERVICE_UNIT = 'archon.service';

// Parse a systemd duration string (as emitted by `systemctl show`) into seconds.
// Forms: "1min 30s", "90s", "1h 2min", "500ms", "infinity", "0". Returns null
// when nothing parseable is found.
const UNIT_SECONDS: Record<string, number> = {
  us: 1e-6, µs: 1e-6, ms: 1e-3, s: 1, sec: 1,
  min: 60, h: 3600, hr: 3600, d: 86400, w: 604800,
};

export function parseSystemdDuration(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (s === 'infinity') return Infinity;
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(us|µs|ms|sec|s|min|hr|h|d|w)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1]);
    const mult = UNIT_SECONDS[m[2]];
    if (Number.isFinite(n) && mult !== undefined) {
      total += n * mult;
      matched = true;
    }
  }
  if (matched) return total;
  // Bare integer (e.g. "0") — treat as seconds.
  const bare = Number(s);
  return Number.isFinite(bare) ? bare : null;
}

// ── pure classification (unit-tested) ──────────────────────────────────────

export interface ShutdownWindowResult {
  status: 'ok' | 'warn' | 'skipped';
  detail: string;
  hint?: string;
}

export function classifyShutdownWindow(
  timeoutStopSec: number | null,
  windowSec: number = GRACEFUL_SHUTDOWN_WINDOW_SEC,
): ShutdownWindowResult {
  if (timeoutStopSec === null) {
    return { status: 'skipped', detail: 'TimeoutStopUSec not readable for the unit' };
  }
  if (!Number.isFinite(timeoutStopSec)) {
    return { status: 'ok', detail: 'TimeoutStopUSec=infinity — systemd waits indefinitely for graceful shutdown' };
  }
  if (timeoutStopSec >= windowSec) {
    return {
      status: 'ok',
      detail: `stop timeout ${timeoutStopSec}s ≥ graceful-shutdown budget ${windowSec}s`,
    };
  }
  return {
    status: 'warn',
    detail: `stop timeout ${timeoutStopSec}s < graceful-shutdown budget ${windowSec}s — systemd may SIGKILL mid-flush, losing tail events`,
    hint: `raise the unit's TimeoutStopSec to ≥ ${windowSec}s (systemctl --user edit ${SERVICE_UNIT})`,
  };
}

// ── probe ──────────────────────────────────────────────────────────────────

async function readTimeoutStopSec(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'systemctl',
      ['--user', 'show', SERVICE_UNIT, '-p', 'TimeoutStopUSec'],
      { timeout: 2000 },
    );
    const m = /TimeoutStopUSec=(.+)/.exec(stdout);
    if (!m) return null;
    return parseSystemdDuration(m[1]);
  } catch {
    return null;
  }
}

export async function probeShutdownWindow(): Promise<ShutdownWindowResult> {
  if (platform() !== 'linux') {
    return { status: 'skipped', detail: 'not Linux — systemd shutdown window not applicable' };
  }
  // Only meaningful when systemd actually started this process as a unit.
  if (!process.env.INVOCATION_ID) {
    return { status: 'skipped', detail: 'not started by systemd (dev / manual run) — no stop-timeout to check' };
  }
  const timeoutStopSec = await readTimeoutStopSec();
  return classifyShutdownWindow(timeoutStopSec);
}
