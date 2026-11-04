// Durable registry of live worker/calibrator PIDs.
//
// Rationale: provider subprocesses are spawned with `detached: true`, so they
// survive the server's death (SIGTERM, crash, force-quit). Without a record
// on disk, a relaunched server has no way to reap them — leaving agents
// running headless, eating quota, possibly hung on unanswered tool-approval
// prompts. This registry persists every spawn to `~/.arco/worker-pids.json`
// and clears entries as workers settle. Startup reads the file and reaps
// verified live processes; shutdown checks every tracked pid synchronously.
//
// H44 — each pid is paired with its process START TIME so reaping can tell a
// genuinely-stale worker from a recycled pid that now belongs to an unrelated
// process. See processStartTime.ts for the start-time read and fail-closed
// decision. File format: `{ "procs": [{ "pid": 123, "startTime": "..." }, ...] }`.
// A legacy `{ "pids": [...] }` file is still read; unknown identities are retained
// without signalling the process. Written atomically;
// the file is authoritative, the in-memory cache mirrors it.

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { readStartTime, isAlive, shouldReap, type TrackedProc } from './processStartTime.js';
import { atomicWriteFileSync } from '../atomicFile.js';
import { arcoHome } from '../arcoHome.js';

const DIR = arcoHome();
const FILE = join(DIR, 'worker-pids.json');

// pid → startTime token (null = unknown).
let cache: Map<number, string | null> | null = null;

function load(): Map<number, string | null> {
  if (cache) return cache;
  const m = new Map<number, string | null>();
  try {
    const raw = readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw) as { procs?: unknown; pids?: unknown };
    if (Array.isArray(parsed.procs)) {
      for (const p of parsed.procs) {
        if (p && typeof (p as TrackedProc).pid === 'number' && (p as TrackedProc).pid > 0) {
          const st = (p as TrackedProc).startTime;
          m.set((p as TrackedProc).pid, typeof st === 'string' ? st : null);
        }
      }
    } else if (Array.isArray(parsed.pids)) {
      // Legacy format has no start time, so its live PID remains unverified.
      for (const pid of parsed.pids) {
        if (typeof pid === 'number' && pid > 0) m.set(pid, null);
      }
    }
  } catch {
    /* missing / unparseable → empty */
  }
  cache = m;
  return cache;
}

function save(): void {
  if (!cache) return;
  try {
    const procs: TrackedProc[] = Array.from(cache, ([pid, startTime]) => ({ pid, startTime }));
    atomicWriteFileSync(FILE, JSON.stringify({ procs }));
  } catch (err) {
    console.error('[arco] pid registry save failed:', (err as Error).message);
  }
}

export function registerWorkerPid(pid: number, probe: typeof readStartTime = readStartTime): void {
  if (!(pid > 0)) return;
  const c = load();
  const startTime = probe(pid); // capture the newly spawned process identity
  if (c.has(pid) && (startTime === null || c.get(pid) === startTime)) return;
  c.set(pid, startTime);
  save();
}

export function unregisterWorkerPid(pid: number): void {
  const c = load();
  if (c.delete(pid)) save();
}

export function readRegisteredPids(): number[] {
  return Array.from(load().keys());
}

export function readRegisteredProcs(): TrackedProc[] {
  return Array.from(load(), ([pid, startTime]) => ({ pid, startTime }));
}

export function clearRegisteredPids(): void {
  cache = new Map();
  save();
}

export function retainRegisteredProcs(procs: TrackedProc[]): void {
  cache = new Map(procs.map(p => [p.pid, p.startTime]));
  save();
}

// Force-kill a pid's process group, falling back to the bare pid. Tries
// SIGKILL directly — callers are either shutting down or reaping zombies.
export function forceKillPid(pid: number): boolean {
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    // fall through
  }
  try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
}

export type ReapOutcome = 'killed' | 'reused' | 'gone' | 'unverified';

// Never signal a live PID unless both recorded and current identities match.
// The dependencies are injectable for safe tests of the timeout path.
export function reapProc(proc: TrackedProc, deps: {
  isAlive: typeof isAlive; readStartTime: typeof readStartTime; kill: typeof forceKillPid;
} = { isAlive, readStartTime, kill: forceKillPid }): ReapOutcome {
  if (!deps.isAlive(proc.pid)) return 'gone';
  if (proc.startTime === null) return 'unverified';
  const current = deps.readStartTime(proc.pid);
  if (current === null) return 'unverified';
  if (!shouldReap(proc.startTime, current)) return 'reused';
  if (deps.kill(proc.pid)) return 'killed';
  return deps.isAlive(proc.pid) ? 'unverified' : 'gone';
}
