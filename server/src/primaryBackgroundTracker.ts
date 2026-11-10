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
//      polling. Each snapshot retains process ancestry and argv boundaries.
//   2. A shell-tool hint must match the process command. Provider and MCP
//      processes cannot claim a hint merely by appearing during a tool call.
//   3. After the turn ends and the parent exits, the tracker keeps polling
//      each tracked pid directly via /proc/<pid>/stat. This is possible
//      because Linux pids are stable for the lifetime of the process
//      regardless of reparenting to init.
//   4. Each tick we emit a `primary_activity` broadcast with the full
//      current state. Dead pids stay visible for DEAD_LINGER_MS so the
//      operator sees the completion, then drop off.

import { randomUUID } from 'crypto';
import type { PrimaryBackgroundJob, ServerMessage } from '@arco/shared';
import { snapshotDescendantProcesses, probePid, type DescendantProcess } from './workers/processActivity.js';

const POLL_INTERVAL_MS = 2000;
// A shell-tool hint older than this is considered stale — a new
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
  members: Set<number>;
}

interface BgHint {
  toolUseId: string;
  command: string;
  at: number;
}

export interface TrackerDeps {
  workflowId: string;
  broadcast: (msg: ServerMessage) => void;
  snapshotProcesses?: typeof snapshotDescendantProcesses;
  probe?: typeof probePid;
}

export class PrimaryBackgroundTracker {
  private readonly workflowId: string;
  private readonly broadcast: (msg: ServerMessage) => void;
  private readonly snapshotProcesses: typeof snapshotDescendantProcesses;
  private readonly probe: typeof probePid;
  private readonly jobs = new Map<number, TrackedJob>();
  private readonly pendingHints: BgHint[] = [];
  private parentPid: number | undefined;
  private readonly owners = new Map<number, TrackedJob>();
  private helpers: Array<{ command: string; args: string[] }> = [];
  private timer: NodeJS.Timeout | null = null;
  private lastBroadcastKey = '';

  constructor(deps: TrackerDeps) {
    this.workflowId = deps.workflowId;
    this.broadcast = deps.broadcast;
    this.snapshotProcesses = deps.snapshotProcesses ?? snapshotDescendantProcesses;
    this.probe = deps.probe ?? probePid;
  }

  // Arm tree-walk discovery. The current primary turn's CLI pid. Called from
  // seedWorker once the spawn returns a pid (usually ~50–200ms in).
  attachParent(pid: number, helpers: Array<{ command: string; args: string[] }> = []): void {
    this.parentPid = pid;
    this.helpers = helpers;
    this.ensureTimer();
  }

  // The primary turn has settled — the CLI process will exit shortly. Any
  // pids we've already tracked continue being polled directly; we just stop
  // tree-walking once the parent is gone.
  detachParent(): void {
    this.parentPid = undefined;
  }

  // Parsed from a shell-tool event. Discovery requires a matching command,
  // including providers that report a command without a background flag.
  noteBgHint(toolUseId: string, command: string): void {
    if (this.pendingHints.some(hint => hint.toolUseId === toolUseId)) return;
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
    this.owners.clear();
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
      const rows = await this.snapshotProcesses(this.parentPid);
      const byPid = new Map(rows.map(row => [row.pid, row]));
      const blocked = new Set<number>();
      const isBlocked = (row: DescendantProcess): boolean => {
        if (blocked.has(row.pid)) return true;
        const visited = new Set<number>();
        let ancestor: DescendantProcess | undefined = row;
        while (ancestor && !visited.has(ancestor.pid)) {
          visited.add(ancestor.pid);
          if (isHelper(ancestor.argv, this.helpers)) {
            for (const pid of visited) blocked.add(pid);
            return true;
          }
          ancestor = byPid.get(ancestor.ppid);
        }
        return false;
      };
      // Match shell argv before executable fallbacks: a sibling MCP process
      // may run the same executable as an agent command (for example Python).
      const candidates = rows.filter(row => !isBlocked(row));
      for (const hint of [...this.pendingHints]) {
        if (now - hint.at > BG_HINT_TTL_MS) continue;
        const shell = candidates.find(row => !this.owners.has(row.pid) && matchesShellCommand(row.argv, hint.command));
        const direct = shell ?? candidates.find(row => !this.owners.has(row.pid)
          && isProviderChild(row, byPid, this.parentPid!)
          && matchesDirectCommand(row.argv, hint.command));
        if (direct) await this.registerJob(direct.pid, now, hint);
      }
      // Retain ancestry across polls. A child can survive its shell and be
      // reparented after the turn; continue probing that job's known members.
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of candidates) {
          if (this.owners.has(row.pid)) continue;
          const owner = this.owners.get(row.ppid);
          if (!owner) continue;
          owner.members.add(row.pid);
          this.owners.set(row.pid, owner);
          changed = true;
        }
      }
    }

    // 2. Re-probe each tracked job directly. This is what keeps the list
    //    live after the parent CLI exits.
    for (const [key, job] of this.jobs) {
      const probes = await Promise.all([...job.members].map(async pid => ({ pid, ...await this.probe(pid) })));
      const alive = probes.filter(probe => probe.alive);
      const probe = { alive: alive.length > 0, cpuTicks: alive.reduce((n, p) => n + p.cpuTicks, 0), rssBytes: alive.reduce((n, p) => n + p.rssBytes, 0) };
      if (alive.length && !alive.some(p => p.pid === job.pid)) job.pid = alive[0].pid;
      if (!probe.alive) {
        if (job.alive) {
          job.alive = false;
          job.deadSince = now;
          job.cpuActive = false;
        }
        // Drop the job once it's been dead long enough for the operator
        // to have noticed the "done" state in the UI.
        if (job.deadSince && now - job.deadSince > DEAD_LINGER_MS) {
          this.jobs.delete(key);
          for (const pid of job.members) this.owners.delete(pid);
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
    const key = payload.map((j) => `${j.id}:${j.pid}:${j.alive ? 1 : 0}:${j.cpuActive ? 1 : 0}:${Math.round(j.rssBytes / (64 * 1024))}`).join('|');
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

  private async registerJob(pid: number, now: number, hint: BgHint): Promise<void> {
    const probe = await this.probe(pid);
    if (!probe.alive) return;
    const job: TrackedJob = {
      id: randomUUID(), pid, command: hint.command, toolUseId: hint.toolUseId,
      startedAt: now, lastSeenAt: now, alive: true,
      lastCpuTicks: probe.cpuTicks, cpuActive: false, lastRssBytes: probe.rssBytes,
      members: new Set([pid]),
    };
    this.jobs.set(pid, job);
    this.owners.set(pid, job);
    this.pendingHints.splice(this.pendingHints.indexOf(hint), 1);
  }
}

function basename(value: string): string {
  return value.replace(/\\/g, '/').split('/').pop()!.replace(/\.(exe|cmd)$/i, '').toLowerCase();
}
function shellCommand(argv: string[]): string | undefined {
  if (!/^(?:ba|da|z|k)?sh$|^(?:pwsh|powershell|cmd)$/.test(basename(argv[0] ?? ''))) return;
  const at = argv.findIndex((arg, i) => i > 0 && /^(?:-[a-z]*c|-(?:command|c)|\/c)$/i.test(arg));
  return at < 0 ? undefined : /^(?:pwsh|powershell|cmd)$/.test(basename(argv[0]))
    ? argv.slice(at + 1).join(' ') : argv[at + 1];
}
function matchesShellCommand(argv: string[], hint: string): boolean {
  const command = shellCommand(argv);
  if (command === undefined) return false;
  if (command === hint || argv.join(' ') === hint) return true;
  // Codex reports its shell wrapper as part of item.command. Match either
  // quote form without evaluating or expanding any operator-supplied text.
  const at = argv.findIndex((arg, i) => i > 0 && /^(?:-[a-z]*c|-(?:command|c)|\/c)$/i.test(arg));
  const prefix = argv.slice(0, at + 1).join(' ') + ' ';
  return hint === prefix + "'" + command.replace(/'/g, "'\\''") + "'"
    || hint === prefix + '"' + command.replace(/["\\$`]/g, '\\$&') + '"';
}
function matchesDirectCommand(argv: string[], hint: string): boolean {
  const commands = [argv.join(' '), [basename(argv[0] ?? ''), ...argv.slice(1)].join(' ')];
  // Bash may exec its final command. npm's Node launcher then replaces the
  // shell, so use the known launcher identity rather than rejecting the job.
  if (/^(?:node|nodejs)$/.test(basename(argv[0] ?? '')) && argv[1]) {
    const script = basename(argv[1]);
    const launcher = script === 'npm-cli.js' ? 'npm' : script === 'npx-cli.js' ? 'npx'
      : /^(?:npm|npx|pnpm|yarn)(?:\.(?:c?js|mjs))?$/.test(script) ? script.replace(/\.(?:c?js|mjs)$/, '') : undefined;
    if (launcher) commands.push([launcher, ...argv.slice(2)].join(' '));
  }
  return commands.includes(hint) || commands.includes(unwrappedShellHint(hint));
}
function unwrappedShellHint(hint: string): string {
  const match = /^(\S+)\s+(-[a-z]*c)\s+([\s\S]+)$/i.exec(hint);
  if (!match || !/^(?:ba|da|z|k)?sh$/.test(basename(match[1]))) return hint;
  const tail = match[3];
  if (tail.startsWith("'") && tail.endsWith("'")) return tail.slice(1, -1).replace(/'\\''/g, "'");
  if (tail.startsWith('"') && tail.endsWith('"')) return tail.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  return tail;
}
function isProviderChild(row: DescendantProcess, rows: Map<number, DescendantProcess>, root: number): boolean {
  const seen = new Set<number>();
  let parent = row.ppid;
  while (parent !== root) {
    if (seen.has(parent)) return false;
    seen.add(parent);
    const process = rows.get(parent);
    if (!process || !/^(?:codex(?:-[a-z0-9_-]+)?|claude|cursor-agent|agent|gemini)$/.test(basename(process.argv[0] ?? ''))) return false;
    parent = process.ppid;
  }
  return true;
}
function isHelper(argv: string[], helpers: Array<{ command: string; args: string[] }>): boolean {
  if (argv.some(arg => /[\\/]mcp[\\/](?:arco|cluster|voice)McpServer\.(?:js|ts)$/.test(arg))) return true;
  if (basename(argv[0] ?? '') === 'codebase-memory-mcp') return true;
  return helpers.some(helper => basename(argv[0] ?? '') === basename(helper.command)
    && helper.args.every((arg, i) => argv[i + 1] === arg));
}

// Claude and local workers emit objects; Codex exec emits the command text.
export function backgroundShellInput(input: string): { command?: string; run_in_background?: boolean } {
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { parsed = input; }
  if (typeof parsed === 'string') return parsed.trim() ? { command: parsed } : {};
  if (!parsed || typeof parsed !== 'object') return {};
  const value = parsed as Record<string, unknown>;
  return typeof value.command === 'string' ? {
    command: value.command,
    ...(value.run_in_background === true ? { run_in_background: true } : {}),
  } : {};
}
