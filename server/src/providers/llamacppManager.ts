// llama-server lifecycle manager. Single global instance owns at most one
// running llama-server child process — the daemon model llama.cpp doesn't
// have natively. Model switching = SIGTERM old → wait for exit → spawn new
// with the new model's flags → poll /health until ready.
//
// Why a singleton: llama-server is one model per process and a single GGUF
// can fill 20+ GB of VRAM. Loading two simultaneously would either OOM the
// GPU or thrash, neither of which is acceptable for an interactive workflow.
// Operators who want concurrent models can run multiple Arco-external
// llama-server instances; this manager owns the one Arco spawns.
//
// Why an idle timer: the same VRAM-occupancy concern. A model that hasn't
// been used in N minutes shouldn't camp the GPU when an Ollama workflow or
// the operator's other GPU work might want it. The 10-min default mirrors
// Ollama's KEEP_ALIVE rationale (ollama.ts:152) — long enough to absorb
// gaps between turns, short enough that an unattended workflow doesn't
// hold VRAM forever.

import { execFile, spawn, type ChildProcess } from 'child_process';
import { createWriteStream, type WriteStream } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { EventEmitter } from 'events';
import type { LlamacppModelDef } from '@arco/shared';
import { readCatalog, findModel } from '../llamacppCatalog.js';
import { arcoHome } from '../arcoHome.js';

const LOG_PATH = path.join(arcoHome(), 'llamacpp.log');

function defaultPort(): number {
  const env = process.env.ARCO_LLAMACPP_PORT;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  // 8923: chosen to avoid common dev-server ports (3000/3001/5173/8000/8080)
  // and to not collide with Ollama's 11434.
  return 8923;
}

function defaultHost(): string {
  return process.env.ARCO_LLAMACPP_HOST ?? '127.0.0.1';
}

function idleEvictMs(): number {
  const env = process.env.ARCO_LLAMACPP_KEEPALIVE_MS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  // 10 minutes, matching Ollama's KEEP_ALIVE default.
  return 10 * 60 * 1000;
}

// Hard cap on model load time. A 30B-class GGUF on cold cache can take
// 60-90s to mmap + transfer to VRAM; 5 minutes is generous enough to cover
// HDDs and unusually slow GPUs without letting a hung load wedge the
// manager forever.
const HEALTH_TIMEOUT_MS = 5 * 60 * 1000;

// How often to poll /health while waiting for readiness. Tighter than
// strictly necessary — operators staring at a "model loading…" indicator
// appreciate sub-second latency on the transition.
const HEALTH_POLL_INTERVAL_MS = 500;

export interface LlamacppLoadedState {
  alias: string;
  port: number;
  host: string;
  pid: number;
  loadedAt: number;
  lastUsedAt: number;
}

export interface LlamacppManagerStatus {
  state: 'idle' | 'loading' | 'ready' | 'failed';
  alias?: string;
  port?: number;
  pid?: number;
  loadedAt?: number;
  lastUsedAt?: number;
  error?: string;
  // Additive metadata (docs/ARCHITECTURE.md): the argv of the most recent
  // llama-server spawn, retained purely so the model-health panel can answer
  // "what did the last launch look like?". Set on the existing spawn path in
  // doLoad(); NEVER read by spawn/keepalive/reap logic — read-only forensics.
  lastLaunchArgs?: string[];
}

class LlamacppManager extends EventEmitter {
  private current: LlamacppLoadedState | null = null;
  private child: ChildProcess | null = null;
  private logStream: WriteStream | null = null;
  // Pending load promise so concurrent ensureLoaded() callers de-dup onto a
  // single spawn. Cleared on resolution / rejection.
  private loadingPromise: Promise<LlamacppLoadedState> | null = null;
  private loadingAlias: string | null = null;
  private lastError: string | undefined;
  private idleTimer: NodeJS.Timeout | null = null;
  // Worker turns currently using the loaded model (see acquire()).
  private inUse = 0;
  // Additive A3 forensics: argv of the most recent spawn. Captured in doLoad on
  // the existing spawn path; surfaced via getStatus(). Read-only metadata — it
  // does not feed any lifecycle decision.
  private lastLaunchArgs: string[] | undefined;

  // Public API: workers call this before issuing their HTTP request.
  // Returns once the requested model is loaded and /health passes. Multiple
  // concurrent callers asking for the *same* alias share one spawn; a
  // caller asking for a *different* alias waits for the in-flight load to
  // finish, then triggers a switch.
  async ensureLoaded(alias: string): Promise<LlamacppLoadedState> {
    // Loop, re-checking state after every await: N callers parked on an
    // in-flight load (or on readCatalog) for the same new alias used to all
    // fall through and each start doLoad() — two llama-server spawns racing
    // for the one fixed port.
    for (;;) {
      if (this.current && this.current.alias === alias) {
        this.current.lastUsedAt = Date.now();
        this.armIdleTimer();
        return this.current;
      }
      if (this.loadingPromise && this.loadingAlias === alias) {
        return this.loadingPromise;
      }
      if (this.loadingPromise) {
        // Different alias requested mid-load — wait for the in-flight one
        // (success or failure) before kicking off the switch.
        try { await this.loadingPromise; } catch { /* re-check, then switch */ }
        continue;
      }

      const catalog = await readCatalog();
      const def = findModel(catalog, alias);
      if (!def) {
        throw new Error(`llama.cpp model "${alias}" not in ~/.arco/llamacpp.json`);
      }
      // Another caller may have started (or finished) a load during the
      // catalog read — go around again rather than spawn a second child.
      if (this.loadingPromise || (this.current && this.current.alias === alias)) continue;

      this.loadingAlias = alias;
      this.loadingPromise = this.doLoad(def).finally(() => {
        this.loadingPromise = null;
        this.loadingAlias = null;
      });
      return this.loadingPromise;
    }
  }

  // Pin the loaded model for the duration of a worker turn. lastUsedAt was
  // only refreshed in ensureLoaded() (once per turn), so a tool-loop turn
  // longer than the idle window got its llama-server SIGTERMed mid-turn.
  // The idle timer never evicts while inUse > 0. Release is idempotent and
  // restarts the idle clock from the end of the turn.
  acquire(): () => void {
    this.inUse++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUse = Math.max(0, this.inUse - 1);
      if (this.current) {
        this.current.lastUsedAt = Date.now();
        this.armIdleTimer();
      }
    };
  }

  getStatus(): LlamacppManagerStatus {
    // lastLaunchArgs is attached to every non-idle status so the model-health
    // panel can show the most recent launch regardless of current state.
    const launch = this.lastLaunchArgs ? { lastLaunchArgs: this.lastLaunchArgs } : {};
    if (this.loadingPromise && this.loadingAlias) {
      return { state: 'loading', alias: this.loadingAlias, ...launch };
    }
    if (this.current) {
      return {
        state: 'ready',
        alias: this.current.alias,
        port: this.current.port,
        pid: this.current.pid,
        loadedAt: this.current.loadedAt,
        lastUsedAt: this.current.lastUsedAt,
        ...launch,
      };
    }
    if (this.lastError) {
      return { state: 'failed', error: this.lastError, ...launch };
    }
    return { state: 'idle', ...launch };
  }

  // Resolved host/port the manager spawns llama-server on. Exposed read-only so
  // the model-health panel can probe whether the port currently has a listener.
  getEndpoint(): { host: string; port: number } {
    return { host: defaultHost(), port: defaultPort() };
  }

  // Operator-facing eviction: explicitly unload regardless of idle timer.
  // Useful for "free the VRAM, I'm about to do something else with it".
  async unload(): Promise<void> {
    this.clearIdleTimer();
    await this.killChild('manual unload');
    await ensureLogStream(this);
    await reapStaleLlamacppListener(this, defaultHost(), defaultPort(), 'manual unload');
  }

  // SIGTERM/SIGINT hook from the server bootstrap.
  async shutdown(): Promise<void> {
    this.clearIdleTimer();
    await this.killChild('Arco server shutdown');
  }

  // ---------- internals ----------

  private async doLoad(def: LlamacppModelDef): Promise<LlamacppLoadedState> {
    if (this.current) {
      await this.killChild(`switching to "${def.alias}"`);
    }
    this.lastError = undefined;
    this.emit('loading', { alias: def.alias });

    const port = defaultPort();
    const host = defaultHost();
    const args = buildSpawnArgs(def, port, host);
    // Retain for the A3 model-health panel (read-only forensics). Captured here
    // because this is the only spawn site; nothing downstream reads it back.
    this.lastLaunchArgs = args;

    await ensureLogStream(this);
    await reapStaleLlamacppListener(this, host, port, `loading "${def.alias}"`);
    const child = spawn('llama-server', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    appendLog(this, `\n[${new Date().toISOString()}] spawn llama-server ${args.join(' ')}\n`);
    pipeChildToLog(child, this);

    const exitWatcher = watchUnexpectedExit(child, this);

    try {
      await waitForHealth(host, port, child);
    } catch (err) {
      exitWatcher.cancel();
      await this.killChild('readiness check failed');
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.emit('failed', { alias: def.alias, error: msg });
      throw new Error(`llama-server failed to become ready: ${msg}`);
    }

    exitWatcher.cancel();
    const now = Date.now();
    this.current = {
      alias: def.alias,
      port,
      host,
      pid: child.pid ?? -1,
      loadedAt: now,
      lastUsedAt: now,
    };
    this.armIdleTimer();
    this.emit('ready', { alias: def.alias, port, pid: child.pid });
    return this.current;
  }

  private async killChild(reason: string): Promise<void> {
    const child = this.child;
    if (!child) {
      this.current = null;
      return;
    }
    this.child = null;
    this.current = null;
    appendLog(this, `[${new Date().toISOString()}] terminating llama-server (pid=${child.pid}): ${reason}\n`);
    if (child.exitCode !== null || child.signalCode !== null) return;

    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    // Give it 5s to flush + exit cleanly before SIGKILL.
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
    if (!exited) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    const ms = idleEvictMs();
    if (ms <= 0) return; // explicit opt-out: keep loaded forever
    this.idleTimer = setTimeout(() => {
      // Re-check at fire time — a concurrent ensureLoaded may have bumped
      // lastUsedAt past the deadline, or a turn still holds acquire(); in
      // either case re-arm rather than evict.
      if (!this.current) return;
      const idleFor = Date.now() - this.current.lastUsedAt;
      if (idleFor < ms || this.inUse > 0) {
        this.armIdleTimer();
        return;
      }
      void this.killChild(`idle for ${Math.round(idleFor / 1000)}s`);
    }, ms);
    // Don't keep the Node event loop alive purely for the idle timer —
    // server shutdown should be able to terminate cleanly.
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // Used by helpers that need to access this.logStream from outside the class.
  // Kept as a method so the helpers stay file-local.
  _setLogStream(s: WriteStream | null): void { this.logStream = s; }
  _getLogStream(): WriteStream | null { return this.logStream; }
}

// ---------- module helpers ----------

function buildSpawnArgs(def: LlamacppModelDef, port: number, host: string): string[] {
  const args: string[] = [
    '-m', def.ggufPath,
    '--host', host,
    '--port', String(port),
    // --jinja enables the chat template renderer needed for OpenAI-style
    // tool calling. Cheap to leave on for non-tool turns; required for tool
    // turns. See llama.cpp docs § Function Calling.
    '--jinja',
  ];
  if (def.mmprojPath) args.push('--mmproj', def.mmprojPath);
  if (typeof def.ctxSize === 'number' && def.ctxSize > 0) args.push('-c', String(def.ctxSize));
  if (typeof def.ngl === 'number') args.push('-ngl', String(def.ngl));
  if (def.chatTemplate) args.push('--chat-template', def.chatTemplate);
  if (Array.isArray(def.extraArgs)) args.push(...def.extraArgs);
  return args;
}

async function ensureLogStream(mgr: LlamacppManager): Promise<void> {
  if (mgr._getLogStream()) return;
  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
  const stream = createWriteStream(LOG_PATH, { flags: 'a' });
  mgr._setLogStream(stream);
}

function appendLog(mgr: LlamacppManager, line: string): void {
  const s = mgr._getLogStream();
  if (s) s.write(line);
}

interface PortOwner {
  pid: number;
  name: string;
  ppid?: number;
  cmdline?: string;
}

function execFileOutput(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 3000, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as { code?: unknown }).code;
        // `ss` returns 1 on some builds when no sockets match. Treat that
        // like empty output; ENOENT/timeout should still surface.
        if (code === 1 || code === '1') {
          resolve('');
          return;
        }
        reject(err);
        return;
      }
      resolve(`${stdout}${stderr}`);
    });
  });
}

async function readPortOwners(port: number): Promise<PortOwner[]> {
  let out: string;
  try {
    out = await execFileOutput('ss', ['-H', '-ltnp', 'sport', '=', `:${port}`]);
  } catch {
    return [];
  }
  const owners = new Map<number, PortOwner>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const re = /"([^"]+)",pid=(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const pid = parseInt(m[2], 10);
      if (!Number.isFinite(pid) || owners.has(pid)) continue;
      owners.set(pid, { pid, name: m[1] });
    }
  }
  await Promise.all([...owners.values()].map(enrichPortOwner));
  return [...owners.values()];
}

async function enrichPortOwner(owner: PortOwner): Promise<void> {
  try {
    const status = await fs.readFile(`/proc/${owner.pid}/status`, 'utf8');
    const ppid = /^PPid:\s+(\d+)\s*$/m.exec(status);
    if (ppid) owner.ppid = parseInt(ppid[1], 10);
  } catch { /* best-effort */ }
  try {
    const raw = await fs.readFile(`/proc/${owner.pid}/cmdline`, 'utf8');
    const cmdline = raw.split('\0').filter(Boolean).join(' ');
    if (cmdline) owner.cmdline = cmdline;
  } catch { /* best-effort */ }
}

function describeOwner(owner: PortOwner): string {
  const bits = [`${owner.name}[pid=${owner.pid}`];
  if (typeof owner.ppid === 'number') bits.push(`ppid=${owner.ppid}`);
  bits[0] += ']';
  const cmd = owner.cmdline ? ` ${owner.cmdline.slice(0, 180)}` : '';
  return `${bits.join(' ')}${cmd}`;
}

function isLlamacppOwner(owner: PortOwner): boolean {
  return owner.name === 'llama-server' || owner.cmdline?.includes('llama-server') === true;
}

function isOrphaned(owner: PortOwner): boolean {
  return owner.ppid === 1;
}

async function waitForPortToClear(port: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const owners = await readPortOwners(port);
    if (owners.length === 0) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function reapStaleLlamacppListener(
  mgr: LlamacppManager,
  host: string,
  port: number,
  reason: string,
): Promise<void> {
  const owners = await readPortOwners(port);
  if (owners.length === 0) return;

  const nonLlama = owners.filter((o) => !isLlamacppOwner(o));
  if (nonLlama.length > 0) {
    throw new Error(`llama-server port ${host}:${port} is occupied by non-llama process(es): ${nonLlama.map(describeOwner).join('; ')}`);
  }

  const active = owners.filter((o) => !isOrphaned(o));
  if (active.length > 0) {
    throw new Error(`llama-server port ${host}:${port} is occupied by active process(es) not owned by this Arco manager: ${active.map(describeOwner).join('; ')}`);
  }

  appendLog(mgr, `[${new Date().toISOString()}] reaping stale orphaned llama-server listener(s) on ${host}:${port} before ${reason}: ${owners.map(describeOwner).join('; ')}\n`);
  for (const owner of owners) {
    try {
      process.kill(owner.pid, 'SIGTERM');
    } catch (err) {
      throw new Error(`failed to terminate stale llama-server pid ${owner.pid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (await waitForPortToClear(port)) return;

  appendLog(mgr, `[${new Date().toISOString()}] stale llama-server listener(s) still present on ${host}:${port}; escalating to SIGKILL\n`);
  for (const owner of await readPortOwners(port)) {
    if (!isLlamacppOwner(owner) || !isOrphaned(owner)) continue;
    try { process.kill(owner.pid, 'SIGKILL'); } catch { /* already gone or no permission */ }
  }
  if (!(await waitForPortToClear(port))) {
    throw new Error(`llama-server port ${host}:${port} did not clear after reaping stale orphan(s)`);
  }
}

function pipeChildToLog(child: ChildProcess, mgr: LlamacppManager): void {
  const tag = (label: string) => (chunk: Buffer) => {
    const s = mgr._getLogStream();
    if (!s) return;
    // Prefix each line with stream label so grepping the log distinguishes
    // stdout (model load progress) from stderr (warnings, errors).
    const text = chunk.toString('utf8');
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      s.write(`[${label}] ${line}\n`);
    }
  };
  if (child.stdout) child.stdout.on('data', tag('out'));
  if (child.stderr) child.stderr.on('data', tag('err'));
}

// If llama-server dies during readiness wait, surface a useful error rather
// than letting waitForHealth time out 5 minutes later.
function watchUnexpectedExit(child: ChildProcess, mgr: LlamacppManager): { cancel: () => void } {
  let cancelled = false;
  const onExit = (code: number | null, signal: string | null): void => {
    if (cancelled) return;
    appendLog(mgr, `[${new Date().toISOString()}] llama-server exited unexpectedly (code=${code} signal=${signal})\n`);
  };
  child.once('exit', onExit);
  return {
    cancel: (): void => {
      cancelled = true;
      child.removeListener('exit', onExit);
    },
  };
}

async function waitForHealth(host: string, port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  const url = `http://${host}:${port}/health`;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`llama-server exited with code ${child.exitCode} before becoming ready`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
      // 503 = "loading" per llama-server convention; keep polling.
    } catch {
      // Connection refused while it boots — keep polling.
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  throw new Error(`/health did not pass within ${HEALTH_TIMEOUT_MS}ms`);
}

// Module-level singleton. Importers always get the same instance.
export const llamacppManager = new LlamacppManager();

// Used by the auth-probe path to pre-warm nothing (idempotent — no model is
// loaded until a worker asks for one).
export function getManagerStatus(): LlamacppManagerStatus {
  return llamacppManager.getStatus();
}
