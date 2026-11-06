// Durable registry of live worker/calibrator PIDs.
//
// Rationale: provider subprocesses are spawned with `detached: true`, so they
// survive the server's death (SIGTERM, crash, force-quit). Without a record
// on disk, a relaunched server has no way to reap them — leaving agents
// running headless, eating quota, possibly hung on unanswered tool-approval
// prompts. This registry persists every spawn to `~/.arco/worker-pids.json`
// and clears entries as workers settle. Startup reads the file and reaps
// verified live processes; shutdown kills the children it still holds.
//
// H44 — each pid is paired with its process START TIME so reaping can tell a
// genuinely-stale worker from a recycled pid that now belongs to an unrelated
// process. See processStartTime.ts for the start-time read and fail-closed
// decision, and durablePidRegistry.ts for when the read happens (never as a
// blocking process probe on the server thread). File format: `{ "procs": [{ "pid": 123, "startTime": "..." }, ...] }`.
// A legacy `{ "pids": [...] }` file is still read; unknown identities are retained
// without signalling the process. Written atomically;
// the file is authoritative, the in-memory cache mirrors it.

import { join } from 'path';

import { type TrackedProc } from './processStartTime.js';
import { DurablePidRegistry, type RegisterOptions } from './durablePidRegistry.js';
import { arcoHome } from '../arcoHome.js';

export { forceKillPid, reapProc, reapProcs, reapAtShutdown, sweepRegistry } from './durablePidRegistry.js';
export type { ReapOutcome, ReapDeps, SweepCounts } from './durablePidRegistry.js';

export const workerPidRegistry = new DurablePidRegistry(join(arcoHome(), 'worker-pids.json'), 'worker');

export function registerWorkerPid(pid: number, opts: RegisterOptions = {}): void {
  workerPidRegistry.register(pid, opts);
}

export function unregisterWorkerPid(pid: number): void {
  workerPidRegistry.unregister(pid);
}

export function readRegisteredPids(): number[] {
  return workerPidRegistry.readPids();
}

export function readRegisteredProcs(): TrackedProc[] {
  return workerPidRegistry.readProcs();
}

export function clearRegisteredPids(): void {
  workerPidRegistry.clear();
}

export function retainRegisteredProcs(procs: TrackedProc[]): void {
  workerPidRegistry.retain(procs);
}
