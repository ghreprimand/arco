// One durable pid registry file (worker-pids.json or terminal-pids.json).
//
// File format, unchanged since 0.1.4: `{ "procs": [{ "pid": 123, "startTime": "..." }] }`.
// A legacy `{ "pids": [...] }` file is still read with unknown identities.
// Written atomically; the file is authoritative, the in-memory cache mirrors it.
//
// Identity at registration. A child Arco started cannot have its pid reused
// while Arco has not yet seen it exit: on Linux and macOS it stays unreaped
// (a zombie at worst) until Node's exit handling, and on Windows Node holds the
// process handle until then. So the start time may be read later, off the
// server thread, provided the answer is accepted only while the caller still
// reports the child as running. Linux reads /proc at once; macOS and Windows
// read asynchronously, batched, with retries while the child runs. A start
// time that cannot be read is logged once and the record keeps a null
// identity, which is never killed after a crash.
//
// Shutdown. Children Arco still holds are ours by the same argument and are
// killed without a probe. Records left from an earlier run are checked only
// where the probe is cheap (Linux); elsewhere they stay for the next boot
// sweep, which runs asynchronously before the server listens.

import { readFileSync } from 'fs';

import {
  isAlive, probeStartTime, readStartTimeCheap, readStartTimes, shouldReap, windowsTokenToMs,
  type StartTimeProbe, type TrackedProc,
} from './processStartTime.js';
import { atomicWriteFileSync } from '../atomicFile.js';

export type ReapOutcome = 'killed' | 'reused' | 'gone' | 'unverified';

export interface RegisterOptions {
  // True while the child has not been seen to exit (ChildProcess exitCode and
  // signalCode both null). Without it, "still registered" is used.
  alive?: () => boolean;
  // Test seams.
  probe?: StartTimeProbe;
  cheap?: (pid: number) => string | null | undefined;
  attempts?: number;
  platform?: NodeJS.Platform;
}

export const IDENTITY_ATTEMPTS = 3;
// A Windows token later than registration plus this margin cannot be the
// child that was just started, so it is refused.
const WINDOWS_TOKEN_MARGIN_MS = 2_000;

export class DurablePidRegistry {
  private cache: Map<number, string | null> | null = null;
  private owned = new Map<number, { gen: number; alive: () => boolean }>();
  private identities = new Map<number, Promise<string | null>>();
  private gen = 0;

  constructor(private readonly file: string, private readonly label: string) {}

  private load(): Map<number, string | null> {
    if (this.cache) return this.cache;
    const m = new Map<number, string | null>();
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { procs?: unknown; pids?: unknown };
      if (Array.isArray(parsed.procs)) {
        for (const p of parsed.procs) {
          if (p && typeof (p as TrackedProc).pid === 'number' && (p as TrackedProc).pid > 0) {
            const st = (p as TrackedProc).startTime;
            m.set((p as TrackedProc).pid, typeof st === 'string' ? st : null);
          }
        }
      } else if (Array.isArray(parsed.pids)) {
        // Legacy format has no start time, so its live PID remains unverified.
        for (const pid of parsed.pids) if (typeof pid === 'number' && pid > 0) m.set(pid, null);
      }
    } catch { /* missing / unparseable -> empty */ }
    this.cache = m;
    return m;
  }

  private save(): void {
    if (!this.cache) return;
    try {
      const procs: TrackedProc[] = Array.from(this.cache, ([pid, startTime]) => ({ pid, startTime }));
      atomicWriteFileSync(this.file, JSON.stringify({ procs }));
    } catch (err) {
      console.error(`[arco] ${this.label} pid registry save failed:`, (err as Error).message);
    }
  }

  private set(pid: number, token: string | null): void {
    const c = this.load();
    if (c.has(pid) && c.get(pid) === token) return;
    c.set(pid, token);
    this.save();
  }

  register(pid: number, opts: RegisterOptions = {}): void {
    if (!(pid > 0)) return;
    const gen = ++this.gen;
    const registeredAt = Date.now();
    const alive = opts.alive ?? (() => true);
    this.owned.set(pid, { gen, alive });
    const ours = (): boolean => {
      if (this.owned.get(pid)?.gen !== gen) return false;
      try { return alive(); } catch { return false; }
    };
    const c = this.load();
    const cheap = (opts.cheap ?? readStartTimeCheap)(pid);
    if (cheap !== undefined) {
      // A failed read keeps a token already on record; tokens must still match
      // before any kill, so an old token never authorizes one.
      if (cheap !== null || !c.has(pid)) this.set(pid, cheap);
      if (cheap === null) this.logUnknown(pid);
      this.identities.set(pid, Promise.resolve(cheap));
      return;
    }
    // Record the pid now; the identity follows when the probe answers.
    if (!c.has(pid)) this.set(pid, null);
    const probe = opts.probe ?? probeStartTime;
    const attempts = opts.attempts ?? IDENTITY_ATTEMPTS;
    const platform = opts.platform ?? process.platform;
    const work = (async (): Promise<string | null> => {
      for (let i = 0; i < attempts; i++) {
        if (!ours()) return null;
        let token: string | null = null;
        try { token = await probe(pid); } catch { token = null; }
        if (!ours()) return null;
        if (token !== null && platform === 'win32') {
          const ms = windowsTokenToMs(token);
          if (ms === null || ms > registeredAt + WINDOWS_TOKEN_MARGIN_MS) token = null;
        }
        if (token !== null) { this.set(pid, token); return token; }
      }
      if (ours()) this.logUnknown(pid);
      return null;
    })();
    this.identities.set(pid, work);
  }

  private logUnknown(pid: number): void {
    console.warn(`[arco] ${this.label} process ${pid}: start time could not be read; it will not be cleaned up after a crash`);
  }

  // Settles when the registration's start-time read has finished (tests, diagnostics).
  whenIdentified(pid: number): Promise<string | null> | undefined {
    return this.identities.get(pid);
  }

  unregister(pid: number): void {
    this.owned.delete(pid);
    this.identities.delete(pid);
    const c = this.load();
    if (c.delete(pid)) this.save();
  }

  // A child this server started and has not seen exit. Its pid cannot have
  // been reused, so it may be signalled without a start-time check.
  isHeld(pid: number): boolean {
    const o = this.owned.get(pid);
    if (!o) return false;
    try { return o.alive(); } catch { return false; }
  }

  readPids(): number[] {
    return Array.from(this.load().keys());
  }

  readProcs(): TrackedProc[] {
    return Array.from(this.load(), ([pid, startTime]) => ({ pid, startTime }));
  }

  clear(): void {
    this.cache = new Map();
    this.save();
  }

  retain(procs: TrackedProc[]): void {
    this.cache = new Map(procs.map(p => [p.pid, p.startTime]));
    this.save();
  }

  // Drop the given records only where pid and start time still match and no
  // registration of this run owns the pid (one made meanwhile is kept).
  settle(procs: TrackedProc[]): void {
    const c = this.load();
    let changed = false;
    for (const p of procs) {
      if (c.has(p.pid) && c.get(p.pid) === p.startTime && !this.owned.has(p.pid)) { c.delete(p.pid); changed = true; }
    }
    if (changed) this.save();
  }
}

// Force-kill a pid's process group, falling back to the bare pid. Tries
// SIGKILL directly - callers are either shutting down or reaping zombies.
export function forceKillPid(pid: number): boolean {
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    // fall through
  }
  try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
}

export interface ReapDeps {
  isAlive: typeof isAlive;
  readStartTimes: (pids: number[]) => Promise<Map<number, string | null>>;
  kill: typeof forceKillPid;
}
const defaultReapDeps: ReapDeps = { isAlive, readStartTimes: (pids) => readStartTimes(pids), kill: forceKillPid };

// Never signal a live PID unless both recorded and current identities match.
// One batched start-time query for every candidate; never blocks the loop.
export async function reapProcs(procs: TrackedProc[], deps: ReapDeps = defaultReapDeps): Promise<ReapOutcome[]> {
  const outcomes: ReapOutcome[] = procs.map(p => (deps.isAlive(p.pid) ? 'unverified' : 'gone'));
  const ask = procs.filter((p, i) => outcomes[i] === 'unverified' && p.startTime !== null).map(p => p.pid);
  if (ask.length === 0) return outcomes;
  let current = new Map<number, string | null>();
  try { current = await deps.readStartTimes(ask); } catch { /* all unknown */ }
  procs.forEach((p, i) => {
    if (outcomes[i] !== 'unverified' || p.startTime === null) return;
    const now = current.get(p.pid) ?? null;
    if (now === null) return;
    if (!shouldReap(p.startTime, now)) { outcomes[i] = 'reused'; return; }
    if (deps.kill(p.pid)) outcomes[i] = 'killed';
    else outcomes[i] = deps.isAlive(p.pid) ? 'unverified' : 'gone';
  });
  return outcomes;
}

export async function reapProc(proc: TrackedProc, deps: ReapDeps = defaultReapDeps): Promise<ReapOutcome> {
  return (await reapProcs([proc], deps))[0];
}

// Shutdown path: synchronous, no process probe. Held children are killed;
// other records are checked only where the start time is cheap to read.
export function reapAtShutdown(proc: TrackedProc, registry: DurablePidRegistry, deps: {
  isAlive: typeof isAlive; cheap: (pid: number) => string | null | undefined; kill: typeof forceKillPid;
} = { isAlive, cheap: (pid) => readStartTimeCheap(pid), kill: forceKillPid }): ReapOutcome {
  if (!deps.isAlive(proc.pid)) return 'gone';
  if (registry.isHeld(proc.pid)) {
    if (deps.kill(proc.pid)) return 'killed';
    return deps.isAlive(proc.pid) ? 'unverified' : 'gone';
  }
  if (proc.startTime === null) return 'unverified';
  const now = deps.cheap(proc.pid);
  if (now === undefined || now === null) return 'unverified';
  if (!shouldReap(proc.startTime, now)) return 'reused';
  if (deps.kill(proc.pid)) return 'killed';
  return deps.isAlive(proc.pid) ? 'unverified' : 'gone';
}

export interface SweepCounts { tracked: number; killed: number; reused: number; gone: number; unverified: number }

// Boot sweep shared by the worker and terminal registries. Records that are
// gone, killed or recycled are dropped; unverified ones stay for a later check.
export async function sweepRegistry(registry: DurablePidRegistry, deps: ReapDeps = defaultReapDeps): Promise<SweepCounts> {
  const stale = registry.readProcs().filter(p => !registry.isHeld(p.pid));
  const outcomes = await reapProcs(stale, deps);
  const counts: SweepCounts = { tracked: stale.length, killed: 0, reused: 0, gone: 0, unverified: 0 };
  const settled: TrackedProc[] = [];
  stale.forEach((p, i) => {
    counts[outcomes[i]]++;
    if (outcomes[i] !== 'unverified') settled.push(p);
  });
  registry.settle(settled);
  return counts;
}
