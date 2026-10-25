// H44 — PID-reuse guard (BORROWED_IMPROVEMENTS_EXECUTION.md Phase 2).
//
// The durable pid registries (pidRegistry.ts, ptyPidRegistry.ts) persist the
// pids of detached/long-lived children so a relaunched server can SIGKILL any
// that survived an unclean death. But a bare pid is ambiguous across a reboot or
// a busy machine: the OS recycles pid numbers, so a pid recorded by a prior run
// may now belong to an UNRELATED process (the operator's editor, a shell, even a
// system daemon). Blindly SIGKILLing it is a foot-gun.
//
// The fix is to pair every tracked pid with its process START TIME — a token
// that is stable for the life of a process and (effectively) unique per pid
// across recycling. At reap time we re-read the live process's start time and
// only kill when it matches what we recorded. A recycled pid (different start
// time) is left alone.
//
// fail-toward-kill on unknown: if we can't read the start time on EITHER side
// (recorded null from a legacy registry, or the live read fails / non-POSIX
// platform), we still kill — a genuinely stale worker eating quota is the worse
// outcome than a rare wrongful kill on a platform where we can't measure.
//
// Cross-platform: Linux reads /proc/<pid>/stat field 22 (starttime, in clock
// ticks since boot); macOS shells out to `ps -o lstart=`. Both are synchronous
// so the shutdown signal handler (which must finish before process.exit) can use
// them. Other platforms return null → fail-toward-kill.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export interface TrackedProc {
  pid: number;
  // Opaque start-time token (Linux clock ticks, macOS lstart string). null when
  // unknown (legacy registry entry or an unreadable/non-POSIX read).
  startTime: string | null;
}

// Synchronously read a pid's start time, or null if it can't be determined.
export function readStartTime(pid: number): string | null {
  if (!(pid > 0)) return null;
  if (process.platform === 'linux') {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm (field 2) is parenthesized and may contain spaces — split AFTER the
      // last ')'. After that split, original field 22 (starttime) is index 19
      // (matches processActivity.ts's field-index arithmetic: index = field - 3).
      const lastParen = raw.lastIndexOf(')');
      if (lastParen < 0) return null;
      const after = raw.slice(lastParen + 2).trim().split(/\s+/);
      const st = after[19];
      return st && /^\d+$/.test(st) ? st : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        timeout: 2000,
        encoding: 'utf8',
      });
      const s = out.trim();
      return s.length > 0 ? s : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') {
    // Windows has no /proc or ps; PowerShell reports the creation time as a
    // FILETIME, which is stable for the life of the process.
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        // The .NET call avoids Get-Process's module autoload, the slow part of
        // a cold PowerShell start.
        `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToFileTimeUtc()`], {
        timeout: 15_000,
        encoding: 'utf8',
        windowsHide: true,
      });
      const s = out.trim();
      return /^\d+$/.test(s) ? s : null;
    } catch {
      return null;
    }
  }
  return null; // unknown platform — fail toward kill
}

// Is the pid a live process right now? `kill(pid, 0)` probes existence without
// signalling. EPERM means it exists but we can't signal it (still "alive").
export function isAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Pure reap decision (unit-tested): kill UNLESS we can positively prove the pid
// was recycled — i.e. both start times are known and they differ.
export function shouldReap(recorded: string | null, current: string | null): boolean {
  if (recorded !== null && current !== null && recorded !== current) return false;
  return true;
}
