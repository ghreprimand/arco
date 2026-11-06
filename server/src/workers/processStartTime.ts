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
// ticks since boot). That read is cheap and bounded, so it is the only probe
// that may run synchronously on the server thread (registration, shutdown).
// macOS asks `ps -o pid=,lstart=` and Windows asks one .NET process query
// through PowerShell. Both start a process, so they run only asynchronously,
// batched into one query for every pid waiting at that moment, each query with
// a time limit. Unknown platforms return null and leave identity unverified.
// Tokens are the same strings 0.1.4 recorded, so its registry files still match.

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';

export interface TrackedProc {
  pid: number;
  // Opaque start-time token (Linux clock ticks, macOS lstart, Windows FILETIME). null when
  // unknown (legacy registry entry or an unreadable/non-POSIX read).
  startTime: string | null;
}

// One asynchronous query for a batch of pids, returning the raw output.
export type StartTimeQuery = (pids: number[], timeoutMs: number) => Promise<string>;

// A cold PowerShell start on a loaded Windows runner can take several seconds.
// The query never blocks the server, so the limit is generous; the registry
// retries while the child is still running.
export const WINDOWS_START_TIME_TIMEOUT_MS = 20_000;
export const DARWIN_START_TIME_TIMEOUT_MS = 5_000;

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function runQuery(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        // ps exits 1 when some pid is gone but still prints the live ones;
        // a query stopped by its time limit is discarded.
        const text = String(stdout ?? '');
        if (err && ((err as { killed?: boolean }).killed === true || text.trim() === '')) reject(err);
        else resolve(text);
      });
  });
}

export const runWindowsStartQuery: StartTimeQuery = (pids, timeout) => runQuery('powershell.exe', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
  `foreach ($i in @(${pids.join(',')})) { try { "$i " + [System.Diagnostics.Process]::GetProcessById($i).StartTime.ToFileTimeUtc() } catch {} }`,
], timeout);

export const runDarwinStartQuery: StartTimeQuery = (pids, timeout) =>
  runQuery('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], timeout);

// Parse "<pid> <token>" lines. Windows tokens must be integers.
export function parseStartTimes(raw: string, pids: number[], numeric: boolean): Map<number, string | null> {
  const out = new Map<number, string | null>(pids.map(pid => [pid, null]));
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!out.has(pid)) continue;
    if (numeric && !/^\d+$/.test(m[2])) continue;
    out.set(pid, m[2]);
  }
  return out;
}

// Linux: synchronous /proc read. Elsewhere: undefined, meaning "no cheap
// synchronous probe here; use readStartTimes".
export function readStartTimeCheap(pid: number, platform: NodeJS.Platform = process.platform): string | null | undefined {
  if (platform !== 'linux') return undefined;
  if (!validPid(pid)) return null;
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) is parenthesized and may contain spaces - split AFTER the
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

export interface StartTimeOptions {
  platform?: NodeJS.Platform;
  query?: StartTimeQuery;
}

// Read the start times of several pids without blocking the event loop.
// A failed or timed-out query yields null for every pid in it.
export async function readStartTimes(pids: number[], opts: StartTimeOptions = {}): Promise<Map<number, string | null>> {
  const platform = opts.platform ?? process.platform;
  const valid = [...new Set(pids.filter(validPid))];
  const out = new Map<number, string | null>(pids.map(pid => [pid, null]));
  if (valid.length === 0) return out;
  if (platform === 'linux' && !opts.query) {
    for (const pid of valid) out.set(pid, readStartTimeCheap(pid, 'linux') ?? null);
    return out;
  }
  const query = opts.query
    ?? (platform === 'win32' ? runWindowsStartQuery : platform === 'darwin' ? runDarwinStartQuery : null);
  if (!query) return out;
  const timeout = platform === 'win32' ? WINDOWS_START_TIME_TIMEOUT_MS : DARWIN_START_TIME_TIMEOUT_MS;
  try {
    const parsed = parseStartTimes(await query(valid, timeout), valid, platform === 'win32');
    for (const [pid, token] of parsed) out.set(pid, token);
  } catch { /* timeout or spawn failure: identity unknown */ }
  return out;
}

export async function readStartTime(pid: number, opts: StartTimeOptions = {}): Promise<string | null> {
  return (await readStartTimes([pid], opts)).get(pid) ?? null;
}

// Coalesce probes: every pid asked for while no query runs goes into the next
// single query, so a burst of starts costs one PowerShell process, not many.
export type StartTimeProbe = (pid: number) => Promise<string | null>;
export function createBatchedProbe(opts: StartTimeOptions = {}): StartTimeProbe {
  let waiting = new Map<number, Array<(token: string | null) => void>>();
  let running = false;
  const flush = async (): Promise<void> => {
    if (running || waiting.size === 0) return;
    running = true;
    const batch = waiting;
    waiting = new Map();
    let result = new Map<number, string | null>();
    try { result = await readStartTimes([...batch.keys()], opts); } catch { /* all unknown */ }
    for (const [pid, resolvers] of batch) for (const r of resolvers) r(result.get(pid) ?? null);
    running = false;
    void flush();
  };
  return (pid) => new Promise((resolve) => {
    const list = waiting.get(pid) ?? [];
    list.push(resolve);
    waiting.set(pid, list);
    setImmediate(() => { void flush(); });
  });
}

export const probeStartTime: StartTimeProbe = createBatchedProbe();

// Windows FILETIME (100 ns since 1601) to Unix milliseconds; null otherwise.
export function windowsTokenToMs(token: string): number | null {
  if (!/^\d+$/.test(token)) return null;
  return Number(BigInt(token) / 10_000n) - 11_644_473_600_000;
}

// A ChildProcess whose exit Node has not yet handled: its pid is still ours.
export function isChildRunning(child: { exitCode: number | null; signalCode: NodeJS.Signals | null } | null | undefined): boolean {
  return !!child && child.exitCode === null && child.signalCode === null;
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
