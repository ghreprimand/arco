// WORKBENCH_EXPANSION_PLAN.md Part K / §K1 — operator PTY session pool.
//
// A "session" is a long-lived node-pty child that outlives any window or WS
// connection. The floating terminal window is a *view*: opening it attaches a
// data listener to an existing session, closing it detaches. Only an explicit
// Kill (or workflow-close / server-shutdown teardown) reaps the shell. This is
// THE load-bearing invariant — a `sleep 30` survives a window close+reopen.
//
// HARD FENCE: this is an operator-only surface. The PTY is NEVER registered as
// a tool the model can call (agents have their own per-turn Bash). Wiring a
// model into this manager is the autonomous-shell fence — don't.
//
// The raw byte stream travels over a dedicated `/terminal` WS path (see
// index.ts) and is NOT routed through events.jsonl or the seq'd `/ws`
// protocol — far too chatty. Only session lifecycle + operator command lines
// are persisted, by the caller, via broadcastWorkflow.

import * as pty from 'node-pty';
import { basename } from 'path';
import { resolveWithinCwd } from '../providers/ollamaTools.js';
import { reapProc } from '../workers/pidRegistry.js';
import {
  registerTerminalPid,
  unregisterTerminalPid,
  readRegisteredTerminalProcs,
  clearRegisteredTerminalPids,
} from './ptyPidRegistry.js';

// Bounded per-session scrollback so a re-attaching window can repaint history
// without us streaming the whole shell life. ~256 KB is a few thousand lines
// of typical output; older bytes are dropped from the front.
const SCROLLBACK_CAP_BYTES = 256 * 1024;

// Default terminal geometry before the first window attaches and fits. The
// shell renders against this until a resize() lands from the client.
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

// One attached viewer (a window / pop-out). K2 widens the prior single
// `onData`/`onExit` pair to a SET of these so two windows can view the SAME
// session and both receive live output. Each `attach` adds one and returns a
// disposer; `detach`/disposer removes exactly that one; `kill` disposes all.
interface Listener {
  onData: (data: string) => void;
  onExit?: (code: number) => void;
}

export interface PtySession {
  id: string;
  workflowId: string;
  cwd: string;
  shell: string;
  // Human-facing name for the session switcher. `shell N` (a per-workflow
  // monotonic counter) by default; the cwd basename when a non-root cwd was
  // requested (e.g. opening a terminal in `server/` → `server`).
  label: string;
  createdAt: number;
  proc: pty.IPty;
  // Bounded ring of raw output bytes for repaint-on-reattach. Stored as a
  // single growing Buffer that we trim from the front past the cap.
  scrollback: Buffer;
  // Attached viewers. K2 multi-listener: ALL receive every data/exit frame, so
  // two windows on one session render the same live stream. Empty = detached
  // (the shell keeps running — session ≠ connection).
  listeners: Set<Listener>;
  dataDisposable: pty.IDisposable;
  exitDisposable: pty.IDisposable;
  exited: boolean;
  lastCols: number;
  lastRows: number;
}

// Wire-facing summary for the session switcher / list reply. No proc/scrollback.
export interface PtySessionInfo {
  sessionId: string;
  label: string;
  cwd: string;
  createdAt: number;
}

// Resolve the operator's login shell. POSIX-first: $SHELL is the operator's
// configured shell; fall back to /bin/zsh on macOS (its default login shell)
// and /bin/bash elsewhere. Windows has no $SHELL; Windows PowerShell ships with
// every supported release, so it is the default there.
function resolveShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  if (process.env.SHELL) return process.env.SHELL;
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  private idCounter = 0;
  // Per-workflow monotonic counter for the `shell N` label. Never decrements
  // (so killing `shell 2` then opening another gives `shell 3`, not a reused
  // `shell 2` — matches how operators expect tab numbering to behave).
  private labelCounters = new Map<string, number>();

  // Compute a session label. A non-root requested cwd → its basename (so
  // "open terminal here" on `server/` reads `server`); otherwise `shell N`.
  private nextLabel(workflowId: string, cwd: string, workflowRoot: string): string {
    const n = (this.labelCounters.get(workflowId) ?? 0) + 1;
    this.labelCounters.set(workflowId, n);
    if (cwd !== workflowRoot) {
      const base = basename(cwd);
      if (base) return base;
    }
    return `shell ${n}`;
  }

  // Spawn a new session for `workflowId` rooted at `requestedCwd`. The cwd is
  // resolved through resolveWithinCwd against the workflow root — a path that
  // escapes the root throws and NO shell is spawned. Returns the new session.
  spawn(workflowId: string, workflowRoot: string, requestedCwd?: string): PtySession {
    // cwd guard — refuse to spawn outside the workflow root. resolveWithinCwd
    // throws on escape; let it propagate so the caller NACKs the attach.
    const cwd = requestedCwd ? resolveWithinCwd(workflowRoot, requestedCwd) : workflowRoot;
    const shell = resolveShell();
    const id = `term-${Date.now().toString(36)}-${(this.idCounter++).toString(36)}`;

    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
      // Inherit the server's env so the shell sees the operator's PATH etc.
      // TERM is forced to a value xterm.js renders cleanly against.
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const session: PtySession = {
      id,
      workflowId,
      cwd,
      shell,
      label: this.nextLabel(workflowId, cwd, workflowRoot),
      createdAt: Date.now(),
      proc,
      scrollback: Buffer.alloc(0),
      listeners: new Set(),
      dataDisposable: { dispose() {} },
      exitDisposable: { dispose() {} },
      exited: false,
      lastCols: DEFAULT_COLS,
      lastRows: DEFAULT_ROWS,
    };

    session.dataDisposable = proc.onData((data) => {
      this.appendScrollback(session, data);
      // Fan out to ALL attached viewers. Copy first so a listener that detaches
      // mid-iteration (rare) can't mutate the set under us.
      for (const l of [...session.listeners]) l.onData(data);
    });
    session.exitDisposable = proc.onExit(({ exitCode }) => {
      session.exited = true;
      for (const l of [...session.listeners]) l.onExit?.(exitCode);
      // The shell is gone; drop the session so a stale id can't be re-attached,
      // and clear its durable pid record (clean exit — nothing to reap on boot).
      unregisterTerminalPid(proc.pid);
      this.sessions.delete(id);
    });

    // Durable pid registry: a hard server kill reparents this child to init and
    // leaks it; the boot orphan sweep reaps anything still recorded here.
    registerTerminalPid(proc.pid);

    this.sessions.set(id, session);
    return session;
  }

  get(sessionId: string): PtySession | undefined {
    return this.sessions.get(sessionId);
  }

  // Sessions belonging to a workflow (for teardown on workflow-close).
  listForWorkflow(workflowId: string): PtySession[] {
    return [...this.sessions.values()].filter((s) => s.workflowId === workflowId);
  }

  // Every live session (for shutdown-time lifecycle events before killAll).
  allSessions(): PtySession[] {
    return [...this.sessions.values()];
  }

  // Wire-facing session list for the switcher / terminal_sessions reply.
  // Ordered oldest-first (createdAt) so the switcher renders stably.
  infoForWorkflow(workflowId: string): PtySessionInfo[] {
    return this.listForWorkflow(workflowId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => ({ sessionId: s.id, label: s.label, cwd: s.cwd, createdAt: s.createdAt }));
  }

  // Attach a window's data/exit listeners + replay scrollback so the window
  // repaints prior output. K2: this ADDS a listener (it no longer replaces the
  // prior one) so TWO windows can view the same session and both get live
  // output. Returns the scrollback (for the caller to flush as the first `data`
  // frame) AND a `dispose` that removes EXACTLY this listener — the channel
  // calls it on socket close. Replacing the prior singleton listener would have
  // silenced a second window; widening to a set preserves the single-window
  // case (one listener in, one out) while enabling the multi-window case.
  attach(
    sessionId: string,
    onData: (data: string) => void,
    onExit?: (code: number) => void,
  ): { scrollback: string; cols: number; rows: number; dispose: () => void } | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    const listener: Listener = { onData, onExit };
    s.listeners.add(listener);
    return {
      scrollback: s.scrollback.toString('utf8'),
      cols: s.lastCols,
      rows: s.lastRows,
      dispose: () => { s.listeners.delete(listener); },
    };
  }

  // Detach ALL viewers of a session WITHOUT killing the shell. Used as a
  // belt-and-suspenders fallback; the per-attach `dispose` is the precise path
  // (it removes only that window's listener, leaving a co-viewing window
  // attached). The session and its child keep running; scrollback keeps
  // accumulating so the next attach can repaint.
  detach(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.listeners.clear();
  }

  write(sessionId: string, data: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.exited) return;
    s.proc.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.exited) return;
    // node-pty throws on non-positive geometry; clamp defensively.
    const c = Math.max(1, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    s.lastCols = c;
    s.lastRows = r;
    try { s.proc.resize(c, r); } catch { /* race with exit — ignore */ }
  }

  // Explicit operator Kill: reap the PTY child and drop the session. SIGHUP is
  // node-pty's default and the right signal for a terminal hangup.
  kill(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try { s.dataDisposable.dispose(); } catch { /* ignore */ }
    try { s.exitDisposable.dispose(); } catch { /* ignore */ }
    s.listeners.clear();
    try { if (!s.exited) s.proc.kill(); } catch { /* already gone */ }
    // Clean kill — drop the durable pid record so the next boot sweep doesn't
    // SIGKILL a (possibly recycled) pid. We disposed exitDisposable above, so
    // onExit won't fire to do this for us.
    unregisterTerminalPid(s.proc.pid);
    this.sessions.delete(sessionId);
  }

  // Teardown for workflow-close: reap every session owned by the workflow.
  // Returns the killed sessions so the caller can emit lifecycle events.
  killForWorkflow(workflowId: string): PtySession[] {
    const owned = this.listForWorkflow(workflowId);
    for (const s of owned) this.kill(s.id);
    return owned;
  }

  // Process-shutdown teardown: reap everything. Best-effort; the kernel
  // reclaims fds on process death anyway, but PTYs are spawned without
  // `detached` so they die with us — this just makes it deterministic.
  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  private appendScrollback(session: PtySession, data: string): void {
    const chunk = Buffer.from(data, 'utf8');
    session.scrollback = Buffer.concat([session.scrollback, chunk]);
    if (session.scrollback.length > SCROLLBACK_CAP_BYTES) {
      session.scrollback = session.scrollback.subarray(
        session.scrollback.length - SCROLLBACK_CAP_BYTES,
      );
    }
  }
}

// Process-wide singleton. One pool for all workflows; sessions are keyed by id
// and tagged with their owning workflowId for teardown.
export const ptyManager = new PtyManager();

// Boot orphan sweep — SIGKILL any operator-terminal children left alive by a
// crashed/force-quit previous run, then clear the registry. Mirrors
// `reapOrphanWorkers` in index.ts; wired in alongside it before listen(). The
// durable registry is authoritative: anything still in it was a live PTY at the
// time of the prior (unclean) death, so it's safe to reap. Reuses the worker
// registry's `forceKillPid` (process-group SIGKILL, POSIX-portable) — node-pty
// pids are real OS pids.
export function reapOrphanTerminals(): void {
  const stale = readRegisteredTerminalProcs();
  if (stale.length === 0) {
    console.log('[arco] Terminal orphan sweep: registry clean, nothing to reap');
    return;
  }
  // H44 — start-time-verified reap so a recycled pid (now an unrelated process)
  // is left alone; only genuinely-leaked shells are SIGKILLed.
  let killed = 0, reused = 0, gone = 0;
  for (const p of stale) {
    const outcome = reapProc(p);
    if (outcome === 'killed') killed++;
    else if (outcome === 'reused') reused++;
    else gone++;
  }
  console.log(
    `[arco] Terminal orphan sweep (${stale.length} tracked): reaped ${killed}, ` +
    `already gone ${gone}, skipped ${reused} (pid recycled)`,
  );
  clearRegisteredTerminalPids();
}
