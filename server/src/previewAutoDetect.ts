// Auto-bind the Preview tab's port when the agent starts a dev server.
//
// Signal source: every Bash(run_in_background) tool call gets sniffed for a
// dev-server-shaped command. If it matches, we kick off a short probe loop
// that races a small candidate-port list, and the first port that answers
// gets bound to the workflow via the same set-preview path the operator's
// manual flow uses.
//
// Manual-vs-auto precedence: a port the operator typed (manual: true) is
// never overridden. An auto-bound port (manual: false) is only replaced if
// the bound port has gone unreachable — otherwise the running app keeps its
// iframe and we ignore the new signal.

const PROBE_INTERVAL_MS = 1000;
const PROBE_DEADLINE_MS = 60_000;
const PROBE_TIMEOUT_MS = 500;
// Layer 2 — PID-attributed port discovery via /proc. Polls the bgTracker
// every PID_WATCH_INTERVAL_MS waiting for the descendant of the originating
// Bash call to appear, then walks /proc/<pid>/fd + /proc/net/tcp to find
// what it's listening on. Linux-only (no-op elsewhere).
const PID_WATCH_INTERVAL_MS = 500;

// Bash command shapes that indicate a dev server is being started. Bias
// toward false negatives: it's better to miss an exotic case (operator can
// type the port) than to start probing 10 random ports because the agent
// ran `npm run something-unrelated`.
const DEV_SERVER_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)\b|\bvite(?:\s|$)|\bnext\s+(?:dev|start)\b|\b(?:astro|nuxt|remix|svelte-kit|gatsby)\s+(?:dev|develop|start)\b|\bpython\s+-m\s+http\.server\b|\buvicorn\b|\bflask\s+run\b|\brails\s+s(?:erver)?\b|\bphp\s+-S\b|\bdeno\s+(?:run|task)\b|\bdocusaurus\s+start\b/;

// Per-framework default ports, plus generic fallbacks. Order matters — the
// probe races them in parallel, but a quicker first hit wins, and listing
// the most-likely ports first means we'll usually hit on the first tick.
const FRAMEWORK_PORTS: Array<{ re: RegExp; ports: number[]; label: string }> = [
  { re: /\bvite(?:\s|$)|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?dev\b/, ports: [5173, 5174, 5175], label: 'vite' },
  { re: /\bnext\s+(?:dev|start)\b/, ports: [3000, 3001], label: 'next' },
  { re: /\b(?:astro|gatsby)\s+(?:dev|develop)\b/, ports: [4321, 8000], label: 'astro' },
  { re: /\b(?:nuxt|remix|svelte-kit)\s+(?:dev|develop|start)\b/, ports: [3000, 5173], label: 'nuxt' },
  { re: /\bpython\s+-m\s+http\.server\b|\buvicorn\b|\bflask\s+run\b/, ports: [8000, 5000, 8080], label: 'python' },
  { re: /\brails\s+s\b/, ports: [3000], label: 'rails' },
  { re: /\bphp\s+-S\b/, ports: [8000], label: 'php' },
];

const DEFAULT_FALLBACK_PORTS = [5173, 3000, 4321, 8000, 8080, 5000];

// Parse an explicit port flag from the command. Anything we recognise wins
// over framework defaults.
function explicitPort(cmd: string): number | null {
  const m = cmd.match(/(?:^|\s)(?:--port[\s=]|-p\s+)(\d{2,5})\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return null;
  return n;
}

function frameworkLabel(cmd: string): string | undefined {
  for (const f of FRAMEWORK_PORTS) {
    if (f.re.test(cmd)) return f.label;
  }
  return undefined;
}

// Pull every plausible dev-server port out of agent-emitted prose. Matches
// `http://localhost:NNNN`, `http://127.0.0.1:NNNN`, `https://...:NNNN`. The
// scheme prefix narrows false positives (a stray "5181" in the agent's text
// won't trigger a probe; only a real URL does).
const URL_PORT_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d{2,5}))?(?:\/|\b)/gi;

function extractLocalhostPorts(text: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const m of text.matchAll(URL_PORT_RE)) {
    const raw = m[1];
    if (!raw) continue; // bare `http://localhost/` with no port — skip
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1 || n > 65535) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function buildCandidates(cmd: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const add = (p: number): void => {
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  const explicit = explicitPort(cmd);
  if (explicit !== null) add(explicit);
  for (const f of FRAMEWORK_PORTS) {
    if (f.re.test(cmd)) {
      for (const p of f.ports) add(p);
    }
  }
  for (const p of DEFAULT_FALLBACK_PORTS) add(p);
  return out;
}

// Single attempt against one port. We accept any HTTP response (1xx-5xx);
// "something is listening" is the question, not "did it return 200". A
// network error or timeout means nothing is bound yet.
export async function probeOnce(port: number, signal: AbortSignal): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'HEAD',
      signal,
      redirect: 'manual',
    });
    return r.status > 0;
  } catch {
    // Some HTTP servers (Vite included) don't honor HEAD — try GET as a
    // fallback before declaring the port dead.
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'GET',
        signal,
        redirect: 'manual',
      });
      // Drain so the connection releases promptly.
      try { await r.body?.cancel(); } catch { /* ignore */ }
      return r.status > 0;
    } catch {
      return false;
    }
  }
}

interface ActiveProbe {
  abort: AbortController;
  startedAt: number;
}

export interface AutoDetectDeps {
  // Server-side accessors so this module doesn't import the workflows map
  // directly. Caller wires them to the in-memory state in index.ts.
  getCurrentPreview: (wfid: string) => { port: number; manual: boolean } | undefined;
  setAutoBoundPort: (wfid: string, port: number, framework: string | undefined) => Promise<void>;
  clearAutoBoundPort: (wfid: string) => Promise<void>;
  // Cross-workflow conflict filter. When two workflows race two `npm run dev`
  // invocations, Vite auto-bumps the second to 5174, but BOTH probes would
  // otherwise grab the first port that answers (5173 — the first workflow's
  // server). We exclude ports already held by ANOTHER workflow so the second
  // workflow's probe falls through to its actual port.
  isPortHeldByOtherWorkflow: (selfWfid: string, port: number) => boolean;
  // Layer 2 attribution. Returns the PID of the descendant the bgTracker
  // attributed to this Bash tool_use, or undefined if it hasn't appeared
  // yet (caller polls). Returns undefined on non-bg Bash calls (no toolUseId
  // passed) — Layer 2 silently disables and Layer 1 carries the load.
  getRootPidForToolUse: (wfid: string, toolUseId: string) => number | undefined;
  // /proc-based listening-port discovery for the PID family. Linux-only.
  // Empty array on non-Linux or when /proc is gone.
  listeningPortsForPidFamily: (pid: number) => Promise<number[]>;
}

export class PreviewAutoDetect {
  private readonly active = new Map<string, ActiveProbe>();
  private readonly deps: AutoDetectDeps;

  constructor(deps: AutoDetectDeps) {
    this.deps = deps;
  }

  // Called from the seedWorker tool-use bridge. Cheap to call on every Bash
  // input — we filter here so callers don't need to know the regex.
  // `toolUseId` is the seedWorker-minted id for this Bash invocation. When
  // present, Layer 2 (PID-attributed port discovery) is armed in parallel
  // with Layer 1 (candidate-list HTTP probe). When absent (foreground Bash,
  // or any path without a toolUseId), only Layer 1 runs.
  notePotentialDevServerStart(workflowId: string, command: string, toolUseId?: string): void {
    if (typeof command !== 'string' || command.length === 0) return;
    if (!DEV_SERVER_RE.test(command)) return;
    const candidates = buildCandidates(command);
    if (candidates.length === 0) return;
    this.kickProbe(workflowId, candidates, frameworkLabel(command), toolUseId).catch((err) => {
      console.warn(`[arco] [${workflowId.slice(0, 8)}] preview auto-detect failed:`, err);
    });
  }

  // Called from the seedWorker primary_text bridge. Catches the case where a
  // dev server was already running BEFORE the chat (so no Bash hint fires);
  // the agent typically prints the URL in chat per the system-prompt nudge,
  // and we extract `localhost:NNNN` / `127.0.0.1:NNNN` ports as probe
  // candidates. No Layer 2 attribution since text mentions don't carry a
  // toolUseId — pure HTTP probe with the parsed port.
  noteAgentText(workflowId: string, text: string): void {
    if (typeof text !== 'string' || text.length === 0) return;
    const ports = extractLocalhostPorts(text);
    if (ports.length === 0) return;
    this.kickProbe(workflowId, ports, undefined, undefined).catch((err) => {
      console.warn(`[arco] [${workflowId.slice(0, 8)}] preview text-scan failed:`, err);
    });
  }

  // Called on workflow remove so we don't leak controllers.
  cancel(workflowId: string): void {
    const a = this.active.get(workflowId);
    if (!a) return;
    a.abort.abort();
    this.active.delete(workflowId);
  }

  private async kickProbe(workflowId: string, candidates: number[], framework: string | undefined, toolUseId?: string): Promise<void> {
    const current = this.deps.getCurrentPreview(workflowId);
    if (current?.manual) return; // operator owns the binding

    if (current && !current.manual) {
      // Auto-bound already. Only replace if the existing port has gone
      // unreachable (server died, port shifted) — otherwise leave the iframe
      // alone so the operator's view doesn't flicker between dev servers.
      const stillAlive = await probeOnce(current.port, AbortSignal.timeout(PROBE_TIMEOUT_MS));
      if (stillAlive) return;
      await this.deps.clearAutoBoundPort(workflowId).catch(() => { /* best-effort */ });
    }

    // Cancel any in-flight probe for this workflow — the new Bash hint
    // supersedes whatever we were chasing before.
    this.cancel(workflowId);

    const abort = new AbortController();
    const startedAt = Date.now();
    this.active.set(workflowId, { abort, startedAt });

    // Layer 1 (HTTP candidate-list probe) and Layer 2 (PID-attributed via
    // /proc) race each other. Whichever produces a non-conflict port first
    // wins; the other is cancelled. Layer 2 is the deterministic answer
    // when the bgTracker has the toolUseId; Layer 1 is the fallback for
    // foreground Bash and the non-Linux path.
    const decided = { value: false };
    const commit = async (port: number): Promise<boolean> => {
      if (decided.value || abort.signal.aborted) return false;
      const recheck = this.deps.getCurrentPreview(workflowId);
      if (recheck?.manual) return false;
      if (this.deps.isPortHeldByOtherWorkflow(workflowId, port)) return false;
      decided.value = true;
      abort.abort();
      await this.deps.setAutoBoundPort(workflowId, port, framework);
      return true;
    };

    try {
      await Promise.all([
        runHttpProbe(workflowId, candidates, abort.signal, this.deps, commit, startedAt),
        toolUseId
          ? runPidWatch(workflowId, toolUseId, abort.signal, this.deps, commit, startedAt)
          : Promise.resolve(),
      ]);
    } finally {
      // Only delete if still ours — a newer kickProbe may have replaced us.
      if (this.active.get(workflowId)?.abort === abort) {
        this.active.delete(workflowId);
      }
    }
  }
}

// Layer 1 — race a candidate port list with periodic re-probing. Resolves
// when commit() accepts a port or when the deadline / cancel fires.
async function runHttpProbe(
  workflowId: string,
  inputCandidates: number[],
  signal: AbortSignal,
  deps: AutoDetectDeps,
  commit: (port: number) => Promise<boolean>,
  startedAt: number,
): Promise<void> {
  // Conflict filter up-front so ports already owned by another workflow
  // never enter the race. Mutate the candidates list as we go (re-evaluating
  // would be cheap, but commit() also re-checks atomically).
  const candidates = inputCandidates.filter((p) => !deps.isPortHeldByOtherWorkflow(workflowId, p));
  if (candidates.length === 0) return;

  while (Date.now() - startedAt < PROBE_DEADLINE_MS && !signal.aborted) {
    const tickAbort = new AbortController();
    const linkedAbort = (): void => tickAbort.abort();
    signal.addEventListener('abort', linkedAbort);
    try {
      // First-truthy race within the tick: every candidate tries
      // concurrently; the first to respond resolves the winner. Promise.race
      // would settle on the first FAST-FAIL null, masking a slower truthy
      // hit on the same tick.
      const winner = await new Promise<number | null>((resolve) => {
        let pending = candidates.length;
        for (const port of candidates) {
          probeOnce(port, tickAbort.signal).then((ok) => {
            if (ok) { resolve(port); return; }
            if (--pending === 0) resolve(null);
          }).catch(() => { if (--pending === 0) resolve(null); });
        }
      });
      if (winner) {
        tickAbort.abort();
        const accepted = await commit(winner);
        if (accepted) return;
        // Conflict / manual override snuck in. Drop and keep racing.
        const idx = candidates.indexOf(winner);
        if (idx >= 0) candidates.splice(idx, 1);
        if (candidates.length === 0) return;
      }
      await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
    } finally {
      signal.removeEventListener('abort', linkedAbort);
    }
  }
}

// Layer 2 — wait for the bgTracker to attribute a descendant PID to the
// originating Bash call, then poll /proc for the listening port that PID
// family owns. Authoritative when it works; silently no-ops on non-Linux
// or when the tracker never picks up a PID (foreground command, fast-fail).
async function runPidWatch(
  workflowId: string,
  toolUseId: string,
  signal: AbortSignal,
  deps: AutoDetectDeps,
  commit: (port: number) => Promise<boolean>,
  startedAt: number,
): Promise<void> {
  while (Date.now() - startedAt < PROBE_DEADLINE_MS && !signal.aborted) {
    const pid = deps.getRootPidForToolUse(workflowId, toolUseId);
    if (pid !== undefined) {
      let ports: number[] = [];
      try {
        ports = await deps.listeningPortsForPidFamily(pid);
      } catch {
        // /proc race or non-Linux — fall through to the next tick.
      }
      // Filter conflicts up-front; commit() also re-checks atomically.
      const eligible = ports.filter((p) => !deps.isPortHeldByOtherWorkflow(workflowId, p));
      if (eligible.length > 0) {
        // Prefer the lowest-numbered port — dev servers typically pick the
        // canonical port over auxiliary HMR/dashboard ports they also open.
        eligible.sort((a, b) => a - b);
        for (const port of eligible) {
          if (signal.aborted) return;
          if (await commit(port)) return;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, PID_WATCH_INTERVAL_MS));
  }
}
