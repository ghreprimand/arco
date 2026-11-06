// Durable registry of live operator-terminal (node-pty) PIDs.
//
// Rationale: node-pty children are NOT spawned `detached`, so a CLEAN server
// exit reaps them. But on a HARD kill (SIGKILL, OOM, crash, force-quit) the
// PTY children reparent to init and keep running — a long-lived `npm run dev`
// or REPL the operator started inside a terminal leaks across the restart with
// no record to reap it. This mirrors `server/src/workers/pidRegistry.ts` for
// worker subprocesses: persist every spawned PTY pid to
// `~/.arco/terminal-pids.json`, clear on clean kill/exit, and on boot reap
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
// with a legacy `{ "pids": [...] }` reader (unknown identity is not killed).
// Written atomically; the file is authoritative, the in-memory cache mirrors it.

import { join } from 'path';

import { type TrackedProc } from '../workers/processStartTime.js';
import { DurablePidRegistry, type RegisterOptions } from '../workers/durablePidRegistry.js';
import { arcoHome } from '../arcoHome.js';

export const terminalPidRegistry = new DurablePidRegistry(join(arcoHome(), 'terminal-pids.json'), 'terminal');

export function registerTerminalPid(pid: number, opts: RegisterOptions = {}): void {
  terminalPidRegistry.register(pid, opts);
}

export function unregisterTerminalPid(pid: number): void {
  terminalPidRegistry.unregister(pid);
}

export function readRegisteredTerminalPids(): number[] {
  return terminalPidRegistry.readPids();
}

export function readRegisteredTerminalProcs(): TrackedProc[] {
  return terminalPidRegistry.readProcs();
}

export function clearRegisteredTerminalPids(): void {
  terminalPidRegistry.clear();
}

export function retainRegisteredTerminalProcs(procs: TrackedProc[]): void {
  terminalPidRegistry.retain(procs);
}
