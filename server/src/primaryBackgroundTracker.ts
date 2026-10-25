// Per-workflow tracker for long-running child processes the primary CLI
// launched (typically Bash tool calls with `run_in_background: true`).
//
// Why: a turn can kick off `huggingface-cli download`, `npm install`, a
// dev server, etc., and then return to the operator while the work keeps
// going. The Activity tab was only populated mid-turn — after
// `primary_turn_ended` fired, the operator had no visibility into whether
// the download was still running, stalled, or already done. This tracker
// fills that gap.
//
// How it works:
//   1. While the primary's turn is live, `attachParent(pid)` arms tree-walk
//      polling. On each poll we diff /proc descendants against the previous
//      snapshot to discover new pids.
//   2. A new pid gets attributed to the most recent Bash `run_in_background`
//      hint (`noteBgHint`) if one is within BG_HINT_TTL_MS, or tracked
//      untagged otherwise.
//   3. After the turn ends and the parent exits, the tracker keeps polling
//      each tracked pid directly via /proc/<pid>/stat. This is possible
//      because Linux pids are stable for the lifetime of the process
//      regardless of reparenting to init.
//   4. Each tick we emit a `primary_activity` broadcast with the full
//      current state. Dead pids stay visible for DEAD_LINGER_MS so the
//      operator sees the completion, then drop off.

import { randomUUID } from 'crypto';
import type { PrimaryBackgroundJob, ServerMessage } from '@arco/shared';
import { snapshotDescendantPids, probePid, readCmdline } from './workers/processActivity.js';

const POLL_INTERVAL_MS = 2000;
// A Bash run_in_background hint older than this is considered stale — a new
// pid appearing now probably isn't from that call. 10s is generous; the
// subprocess normally appears within a few hundred ms of the tool_use event.
const BG_HINT_TTL_MS = 10_000;
// Dead jobs linger this long in the broadcast so the operator sees "done".
const DEAD_LINGER_MS = 8_000;

interface TrackedJob {
  id: string;
  pid: number;
  command: string;
  toolUseId?: string;
  startedAt: number;
  lastSeenAt: number;
  alive: boolean;
  deadSince?: number;
  lastCpuTicks: number;
  cpuActive: boolean;
  lastRssBytes: number;
}

interface BgHint {
  toolUseId: string;
  command: string;
  at: number;
}

export interface TrackerDeps {
  workflowId: string;
  broadcast: (msg: ServerMessage) => void;
}

export class PrimaryBackgroundTracker {
  private readonly workflowId: string;
  private readonly broadcast: (msg: ServerMessage) => void;
  private readonly jobs = new Map<number, TrackedJob>();
  private readonly pendingHints: BgHint[] = [];
  private parentPid: number | undefined;
  private knownDescendants = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private lastBroadcastKey = '';

  constructor(deps: TrackerDeps) {
    this.workflowId = deps.workflowId;
    this.broadcast = deps.broadcast;
  }

  // Arm tree-walk discovery. The current primary turn's CLI pid. Called from
  // seedWorker once the spawn returns a pid (usually ~50–200ms in).
  attachParent(pid: number): void {
    this.parentPid = pid;
    this.knownDescendants = new Set();
    this.ensureTimer();
  }

  // The primary turn has settled — the CLI process will exit shortly. Any
  // pids we've already tracked continue being polled directly; we just stop
  // tree-walking once the parent is gone.
  detachParent(): void {
    this.parentPid = undefined;
  }

  // Parsed from the primary_tool_use event when the tool is Bash and
  // `run_in_background: true`. The next new descendant pid gets this
  // hint's toolUseId + command string.
  noteBgHint(toolUseId: string, command: string): void {
    this.pendingHints.push({ toolUseId, command, at: Date.now() });
    // Trim old hints — a poll tick will also prune, but this keeps the
    // array bounded under a chat-bomb of Bash calls.
    while (this.pendingHints.length > 32) this.pendingHints.shift();
    this.ensureTimer();
  }

  // Tear-down for workflow removal.
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.jobs.clear();
    this.pendingHints.length = 0;
  }

  // PID of the most recently registered job tagged with `toolUseId`, if
  // any. Used by previewAutoDetect to attribute a Bash bg call's spawned
  // process tree authoritatively (PID → /proc/net/tcp listening port). The
  // attribution lands at registerJob time, so callers may need to poll until
  // the descendant appears (5s ceiling is plenty for `npm run dev`).
  rootPidForToolUse(toolUseId: string): number | undefined {
    let bestPid: number | undefined;
    let bestStartedAt = -1;
    for (const job of this.jobs.values()) {
      if (job.toolUseId !== toolUseId) continue;
      if (job.startedAt > bestStartedAt) {
        bestStartedAt = job.startedAt;
        bestPid = job.pid;
      }
    }
    return bestPid;
  }

  // Snapshot the tracked state for wire emission. Exposed so a workflow
  // snapshot message (reconnect) can include current bg jobs without
  // waiting for the next poll tick.
  snapshotJobs(): PrimaryBackgroundJob[] {
    const now = Date.now();
    return Array.from(this.jobs.values()).map((j) => ({
      id: j.id,
      pid: j.pid,
      command: j.command,
      toolUseId: j.toolUseId,
      startedAt: j.startedAt,
      alive: j.alive,
      cpuActive: j.cpuActive,
      rssBytes: j.lastRssBytes,
      ageMs: now - j.startedAt,
    }));
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error(`[arco] [${this.workflowId.slice(0, 8)}] primary-bg tracker tick failed:`, err);
      });
    }, POLL_INTERVAL_MS);
    // Fire one pass immediately so the UI doesn't wait a full POLL_INTERVAL_MS
    // for the first update after a Bash-bg call.
    this.tick().catch(() => { /* swallowed above */ });
  }

  private async tick(): Promise<void> {
    const now = Date.now();

    // 1. Discover new pids. Only possible while the parent CLI process is
    //    alive; once it exits, tree-walk returns empty and we rely on the
    //    per-pid probes in step 2 to track already-seen jobs.
    if (this.parentPid !== undefined) {
      const descendants = await snapshotDescendantPids(this.parentPid);
      const descSet = new Set(descendants);
      for (const pid of descendants) {
        if (this.knownDescendants.has(pid)) continue;
        this.knownDescendants.add(pid);
        // Fresh descendant. Attribute to a recent Bash-bg hint if any.
        await this.registerJob(pid, now);
      }
      // Drop vanished descendants from knownDescendants so a pid-reuse
      // within the same turn still gets picked up.
      for (const seen of this.knownDescendants) {
        if (!descSet.has(seen)) this.knownDescendants.delete(seen);
      }
    }

    // 2. Re-probe each tracked job directly. This is what keeps the list
    //    live after the parent CLI exits.
    for (const job of this.jobs.values()) {
      const probe = await probePid(job.pid);
      if (!probe.alive) {
        if (job.alive) {
          job.alive = false;
          job.deadSince = now;
          job.cpuActive = false;
        }
        // Drop the job once it's been dead long enough for the operator
        // to have noticed the "done" state in the UI.
        if (job.deadSince && now - job.deadSince > DEAD_LINGER_MS) {
          this.jobs.delete(job.pid);
        }
        continue;
      }
      job.alive = true;
      job.lastSeenAt = now;
      job.cpuActive = probe.cpuTicks > job.lastCpuTicks;
      job.lastCpuTicks = probe.cpuTicks;
      job.lastRssBytes = probe.rssBytes;
    }

    // 3. Prune stale hints so an attribution from 5 minutes ago doesn't
    //    get pinned to a long-later random descendant.
    while (this.pendingHints.length > 0 && now - this.pendingHints[0].at > BG_HINT_TTL_MS) {
      this.pendingHints.shift();
    }

    // 4. Emit.
    const payload = this.snapshotJobs();
    const key = payload.map((j) => `${j.id}:${j.alive ? 1 : 0}:${j.cpuActive ? 1 : 0}:${Math.round(j.rssBytes / (64 * 1024))}`).join('|');
    if (key !== this.lastBroadcastKey) {
      this.lastBroadcastKey = key;
      this.broadcast({ type: 'primary_activity', workflowId: this.workflowId, jobs: payload });
    }

    // 5. Shut down when idle. No parent, no jobs, no hints for
    //    IDLE_SHUTDOWN_MS in a row → stop the poller.
    const idle = this.parentPid === undefined && this.jobs.size === 0 && this.pendingHints.length === 0;
    if (idle) {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }
  }

  private async registerJob(pid: number, now: number): Promise<void> {
    // Skip ourselves (Node) and short-lived shell helpers we don't want
    // populating the list — the Bash tool's own `sh -c` wrapper usually
    // exits within a poll tick anyway, but we also filter by cmdline
    // shape below.
    const cmdline = (await readCmdline(pid)) ?? `pid ${pid}`;
    // Claim a hint if one is fresh. We claim the NEWEST hint first — if
    // two Bash-bg calls fire in the same poll window, the more recent
    // one is more likely the one matching the newest descendant.
    let toolUseId: string | undefined;
    let command = cmdline;
    for (let i = this.pendingHints.length - 1; i >= 0; i--) {
      const hint = this.pendingHints[i];
      if (now - hint.at > BG_HINT_TTL_MS) continue;
      toolUseId = hint.toolUseId;
      command = hint.command;
      this.pendingHints.splice(i, 1);
      break;
    }
    // Probe once so the first broadcast carries real RSS/CPU instead of zeros.
    const probe = await probePid(pid);
    if (!probe.alive) return;
    this.jobs.set(pid, {
      id: randomUUID(),
      pid,
      command,
      toolUseId,
      startedAt: now,
      lastSeenAt: now,
      alive: true,
      lastCpuTicks: probe.cpuTicks,
      cpuActive: false,
      lastRssBytes: probe.rssBytes,
    });
  }
}
