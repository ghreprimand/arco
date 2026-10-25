// Linux /proc-based activity probe for worker subprocesses.
//
// Why: providers like Gemini batch all stdout into the final result event in
// `--json` mode. The operator sees a worker card sitting at "0 TOOLS · 2m"
// with empty output and can't tell whether the worker is actually working or
// frozen. This module gives us a real, ground-truth signal: is the worker
// process (or any of its descendants) consuming CPU? Are there any subprocess
// like an inventory.sh actively running?
//
// macOS / Windows fallback: probes silently return null (no /proc). Caller
// should treat absence as "no signal" rather than "frozen".

import { promises as fs } from 'fs';
import { existsSync } from 'fs';

export interface ProcessActivity {
  alive: boolean;
  // Sum of utime+stime across pid + all descendants, in clock ticks. Caller
  // diffs against the previous probe to get cpuActive bool.
  cpuTicks: number;
  // Subprocess count below pid (includes nested grandchildren). 0 when the
  // worker is sitting idle waiting on an API response.
  descendantCount: number;
  // Resident set size of the worker process itself (not including children).
  // Useful for spotting runaway memory.
  rssBytes: number;
}

const HZ = 100; // Linux SC_CLK_TCK — virtually always 100 on x86_64

// Read /proc/<pid>/stat and parse out (pid, comm, state, ppid, utime, stime,
// rss). Robust to comm containing spaces — comm is wrapped in parentheses, we
// take the LAST `)` then split the remainder.
interface StatRow {
  pid: number;
  ppid: number;
  utime: number;
  stime: number;
  rssPages: number;
}

async function readStat(pid: number): Promise<StatRow | null> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const lastParen = raw.lastIndexOf(')');
    if (lastParen < 0) return null;
    const after = raw.slice(lastParen + 2).trim().split(/\s+/);
    // Field indices (0-based) per man 5 proc, AFTER the comm field has been
    // stripped — i.e. our `after[0]` is the original field index 2 (state).
    //   after[0]  state
    //   after[1]  ppid
    //   after[11] utime
    //   after[12] stime
    //   after[21] rss (in pages)
    const ppid = Number(after[1]);
    const utime = Number(after[11]);
    const stime = Number(after[12]);
    const rssPages = Number(after[21]);
    if (Number.isNaN(ppid) || Number.isNaN(utime) || Number.isNaN(stime)) return null;
    return { pid, ppid, utime, stime, rssPages: Number.isNaN(rssPages) ? 0 : rssPages };
  } catch {
    return null;
  }
}

// Build a PID → stat-row map by scanning /proc once. Cheap on Linux (~1ms for
// a few hundred processes). We do this each probe so we don't miss
// short-lived subprocesses.
async function snapshotAllPids(): Promise<Map<number, StatRow>> {
  const out = new Map<number, StatRow>();
  let entries: string[];
  try {
    entries = await fs.readdir('/proc');
  } catch {
    return out;
  }
  const pids: number[] = [];
  for (const name of entries) {
    const pid = Number(name);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  // Read in parallel with a soft cap to avoid file-handle storms on small
  // systems. /proc reads are non-blocking so this is fast.
  const rows = await Promise.all(pids.map((p) => readStat(p)));
  for (const r of rows) {
    if (r) out.set(r.pid, r);
  }
  return out;
}

// Walk the PPID graph to find every descendant of `root`. Iterative BFS over
// the snapshot to avoid pathological deep recursion (and PID reuse oddities).
function findDescendants(root: number, snapshot: Map<number, StatRow>): StatRow[] {
  const childrenByPpid = new Map<number, StatRow[]>();
  for (const row of snapshot.values()) {
    const list = childrenByPpid.get(row.ppid);
    if (list) list.push(row);
    else childrenByPpid.set(row.ppid, [row]);
  }
  const out: StatRow[] = [];
  const queue: number[] = [root];
  const seen = new Set<number>([root]);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    const kids = childrenByPpid.get(pid);
    if (!kids) continue;
    for (const k of kids) {
      if (seen.has(k.pid)) continue;
      seen.add(k.pid);
      out.push(k);
      queue.push(k.pid);
    }
  }
  return out;
}

export async function probeProcessActivity(pid: number): Promise<ProcessActivity | null> {
  if (!existsSync('/proc')) return null; // non-Linux
  if (!existsSync(`/proc/${pid}`)) {
    return { alive: false, cpuTicks: 0, descendantCount: 0, rssBytes: 0 };
  }
  const snapshot = await snapshotAllPids();
  const root = snapshot.get(pid);
  if (!root) {
    return { alive: false, cpuTicks: 0, descendantCount: 0, rssBytes: 0 };
  }
  const descendants = findDescendants(pid, snapshot);
  let cpuTicks = root.utime + root.stime;
  let rssPages = root.rssPages;
  for (const d of descendants) {
    cpuTicks += d.utime + d.stime;
    rssPages += d.rssPages;
  }
  const pageSize = 4096; // glibc default; getconf PAGESIZE on x86_64 is 4096
  // rssBytes is the SUM across the whole process tree — gemini's runaway is
  // usually a child shell command (find / du), not the gemini process itself.
  // The auto-kill threshold and the operator MEM chip both work off this sum.
  return {
    alive: true,
    cpuTicks,
    descendantCount: descendants.length,
    rssBytes: rssPages * pageSize,
  };
}

// Convenience: ms of CPU time given a tick delta. utime+stime ticks at HZ
// (100Hz on Linux x86_64), so each tick = 10ms.
export function ticksToMs(ticks: number): number {
  return Math.round((ticks / HZ) * 1000);
}

// Read /proc/<pid>/cmdline and join its NUL-delimited argv into a display
// string. Returns null on non-Linux or a dead pid. Truncated to 256 chars
// so a multi-line --system-prompt doesn't blow up the activity feed.
export async function readCmdline(pid: number): Promise<string | null> {
  if (!existsSync('/proc')) return null;
  try {
    const raw = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
    // cmdline is NUL-delimited, trailing NUL after the last arg. Kernel
    // threads return empty; fall back to comm for those.
    const trimmed = raw.replace(/\0+$/, '').replace(/\0/g, ' ').trim();
    if (trimmed.length > 0) {
      return trimmed.length > 256 ? trimmed.slice(0, 253) + '...' : trimmed;
    }
    // Fallback: /proc/<pid>/comm (short name in brackets).
    try {
      const comm = (await fs.readFile(`/proc/${pid}/comm`, 'utf8')).trim();
      return comm ? `[${comm}]` : null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

// Per-pid probe used for tracked background jobs once the primary CLI has
// exited and we can no longer tree-walk from it. `alive=false` when the
// pid is gone.
export interface SinglePidProbe {
  alive: boolean;
  rssBytes: number;
  cpuTicks: number;
}

export async function probePid(pid: number): Promise<SinglePidProbe> {
  if (!existsSync('/proc') || !existsSync(`/proc/${pid}`)) {
    return { alive: false, rssBytes: 0, cpuTicks: 0 };
  }
  const row = await readStat(pid);
  if (!row) return { alive: false, rssBytes: 0, cpuTicks: 0 };
  return {
    alive: true,
    rssBytes: row.rssPages * 4096,
    cpuTicks: row.utime + row.stime,
  };
}

// Enumerate a snapshot of descendant pids (flat list, no grandchild flag).
// Shares the same /proc walk as probeProcessActivity — callers that need
// cmdlines follow up with readCmdline(pid) per entry.
export async function snapshotDescendantPids(parentPid: number): Promise<number[]> {
  if (!existsSync('/proc') || !existsSync(`/proc/${parentPid}`)) return [];
  const snapshot = await snapshotAllPids();
  return findDescendants(parentPid, snapshot).map((r) => r.pid);
}
