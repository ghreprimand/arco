// H44 - PID-reuse guard (docs/GOTCHAS.md).
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
// Fail closed when either start time is unknown. A timed-out query or a
// legacy record without a token cannot prove that a live pid is ours.
// The caller keeps the record for a later retry instead of signalling it.
//
// Cross-platform: Linux reads /proc/<pid>/stat field 22 (starttime, in clock
// ticks since boot); macOS shells out to `ps -o lstart=`. Both are synchronous
// so the shutdown signal handler (which must finish before process.exit) can use
// them. Windows uses one bounded .NET process query. Unknown platforms return
// null and leave identity unverified.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export interface TrackedProc {
  pid: number;
  // Opaque start-time token (Linux clock ticks, macOS lstart, Windows FILETIME). null when
  // unknown (legacy registry entry or an unreadable/non-POSIX read).
  startTime: string | null;
}

// Keep each Windows probe bounded and issue exactly one process query.
// The injected runner lets the bound and parsing be checked without Windows.
export const WINDOWS_START_TIME_TIMEOUT_MS = 8_000;
type WindowsStartQuery = (pid: number, timeout: number) => string;
function runWindowsStartQuery(pid: number, timeout: number): string {
  return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToFileTimeUtc()`], {
    timeout, encoding: 'utf8', windowsHide: true,
  });
}
export function readWindowsStartTime(pid: number, query: WindowsStartQuery = runWindowsStartQuery): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const value = query(pid, WINDOWS_START_TIME_TIMEOUT_MS).trim();
    return /^\d+$/.test(value) ? value : null;
  } catch { return null; }
}

// Synchronously read a pid's start time, or null if it can't be determined.
export function readStartTime(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
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
  if (process.platform === 'win32') return readWindowsStartTime(pid);
  return null; // unknown platform - identity unverified
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

// A signal is safe only when both start times are known and equal.
export function shouldReap(recorded: string | null, current: string | null): boolean {
  return recorded !== null && current !== null && recorded === current;
}
