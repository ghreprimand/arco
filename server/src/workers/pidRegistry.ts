// Durable registry of live worker/calibrator PIDs.
//
// Rationale: provider subprocesses are spawned with `detached: true`, so they
// survive the server's death (SIGTERM, crash, force-quit). Without a record
// on disk, a relaunched server has no way to reap them — leaving agents
// running headless, eating quota, possibly hung on unanswered tool-approval
// prompts. This registry persists every spawn to `~/.archon/worker-pids.json`
// and clears entries as workers settle. Startup reads the file and reaps
// anything still alive; shutdown reaps every tracked pid synchronously.
//
// H44 — each pid is paired with its process START TIME so reaping can tell a
// genuinely-stale worker from a recycled pid that now belongs to an unrelated
// process. See processStartTime.ts for the start-time read + the fail-toward-kill
// decision. File format: `{ "procs": [{ "pid": 123, "startTime": "..." }, ...] }`.
// A legacy `{ "pids": [...] }` file is still read (startTime null → fail toward
// kill, preserving the old behaviour across one upgrade). Written atomically;
// the file is authoritative, the in-memory cache mirrors it.

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { readStartTime, isAlive, shouldReap, type TrackedProc } from './processStartTime.js';
import { atomicWriteFileSync } from '../atomicFile.js';
import { archonHome } from '../archonHome.js';

const DIR = archonHome();
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
      // Legacy format — no start times recorded; null ⇒ fail toward kill.
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
    console.error('[archon] pid registry save failed:', (err as Error).message);
  }
}

export function registerWorkerPid(pid: number): void {
  if (!(pid > 0)) return;
  const c = load();
  if (c.has(pid)) return;
  c.set(pid, readStartTime(pid)); // capture start time now, at spawn
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

// Force-kill a pid's process group, falling back to the bare pid. Tries
// SIGKILL directly — callers are either shutting down or reaping zombies.
export function forceKillPid(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
    return;
  } catch {
    // fall through
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

export type ReapOutcome = 'killed' | 'reused' | 'gone';

// Verified reap: kill only if the live process is the SAME one we recorded.
// A recycled pid (different start time) is left alone; a missing pid is 'gone';
// unknown start time on either side falls through to a kill (fail-toward-kill).
export function reapProc(proc: TrackedProc): ReapOutcome {
  if (!isAlive(proc.pid)) return 'gone';
  const current = readStartTime(proc.pid);
  if (!shouldReap(proc.startTime, current)) return 'reused';
  forceKillPid(proc.pid);
  return 'killed';
}
