// Durable registry of live operator-terminal (node-pty) PIDs.
//
// Rationale: node-pty children are NOT spawned `detached`, so a CLEAN server
// exit reaps them. But on a HARD kill (SIGKILL, OOM, crash, force-quit) the
// PTY children reparent to init and keep running — a long-lived `npm run dev`
// or REPL the operator started inside a terminal leaks across the restart with
// no record to reap it. This mirrors `server/src/workers/pidRegistry.ts` for
// worker subprocesses: persist every spawned PTY pid to
// `~/.archon/terminal-pids.json`, clear on clean kill/exit, and on boot reap
// anything still alive from a prior crashed run.
//
// Kept in a SEPARATE file (and a separate JSON) from the worker registry so the
// two reap paths can't clobber each other's pid set. The kill primitives are
// shared — `forceKillPid` / `reapProc` from the worker registry — because
// process-group SIGKILL is identical for both and is already POSIX-portable.
//
// H44 — pids are paired with their process START TIME (see processStartTime.ts)
// so the boot sweep won't SIGKILL a recycled pid that now belongs to an
// unrelated process. File format: `{ "procs": [{ "pid": 123, "startTime": "..." }] }`,
// with a legacy `{ "pids": [...] }` reader (startTime null → fail toward kill).
// Written atomically; the file is authoritative, the in-memory cache mirrors it.

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { readStartTime, type TrackedProc } from '../workers/processStartTime.js';
import { atomicWriteFileSync } from '../atomicFile.js';
import { archonHome } from '../archonHome.js';

const DIR = archonHome();
const FILE = join(DIR, 'terminal-pids.json');

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
    console.error('[archon] terminal pid registry save failed:', (err as Error).message);
  }
}

export function registerTerminalPid(pid: number): void {
  if (!(pid > 0)) return;
  const c = load();
  if (c.has(pid)) return;
  c.set(pid, readStartTime(pid));
  save();
}

export function unregisterTerminalPid(pid: number): void {
  const c = load();
  if (c.delete(pid)) save();
}

export function readRegisteredTerminalPids(): number[] {
  return Array.from(load().keys());
}

export function readRegisteredTerminalProcs(): TrackedProc[] {
  return Array.from(load(), ([pid, startTime]) => ({ pid, startTime }));
}

export function clearRegisteredTerminalPids(): void {
  cache = new Map();
  save();
}
