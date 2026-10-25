// ── Diagnostics check registry (ARCHON_OPS_PLAN.md §A1) ──
//
// The single source of probe logic behind GET /api/diagnostics. Every check is
// a deterministic, READ-ONLY probe of one moving part on this machine, returning
// a typed DiagnosticCheck. Six fixed groups: Core, Providers, Local Tools,
// Workbench, Storage, Security.
//
// Design fences (four-question test): operator-triggered (the Diagnostics tab's
// Refresh button calls the endpoint — no daemon); deterministic rules the
// operator can read (each probe below is a fixed action with a fixed status
// mapping); read-only (nothing here mutates settings, catalogs, or workflow
// state — the one write is a throwaway temp-file round-trip under a tmp dir,
// never a real workflow log); reversible (it's a readout — there's nothing to
// undo).
//
// Resilience invariants:
//   - Every probe is wrapped by safeProbe(): a thrown probe becomes an `error`
//     result carrying the message, never a crashed endpoint.
//   - Subprocess probes go through capabilities.ts/media/github helpers, which
//     already use execFile (argv array, NO shell) with a timeout and resolve the
//     missing-binary path to a benign value rather than throwing.
//   - Probes run concurrently (Promise.all) and each binary probe is itself
//     time-bounded by the underlying helper, so one slow binary can't hang the
//     whole call.
//   - Cross-platform: POSIX-only. The lone platform-specific note is the GPU
//     probe inside cookbook/hardware (which already degrades on macOS); nothing
//     here hardcodes a /usr path or a Linux-only binary.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir, platform, arch } from 'node:os';

import type {
  DiagnosticCheck,
  DiagnosticGroup,
  DiagnosticGroupId,
  DiagnosticsReport,
  DiagnosticStatus,
} from '@archon/shared';

import { readSettings } from '../settings.js';
import { ffmpegAvailable, ffprobeAvailable } from '../media/ffmpeg.js';
import { loadTokens as loadClaudeNativeTokens } from '../providers/claude-native/auth.js';
import { probeOllama } from '../providers/ollama.js';
import { isPrivateHost } from '../providers/endpointDiscovery.js';
import { HOST } from '../server/constants.js';
import { llamacppManager } from '../providers/llamacppManager.js';
import { readCatalog as readLlamacppCatalog } from '../llamacppCatalog.js';
import { probeHardware } from '../cookbook/hardware.js';
import { recallHomeDir } from '../recall/index.js';
import { readinessSnapshot } from '../server/readiness.js';
import { getLogFilePath } from '../server/logger.js';
import { probeCodeSkew } from './codeSkew.js';
import { probeShutdownWindow } from './shutdownWindow.js';
import { archonHome } from '../archonHome.js';

const execFileAsync = promisify(execFile);
const ARCHON_HOME = archonHome();

// ── result helpers ──────────────────────────────────────────────────────────

function mk(
  id: string,
  group: DiagnosticGroupId,
  label: string,
  status: DiagnosticStatus,
  detail: string,
  hint?: string,
): DiagnosticCheck {
  return hint ? { id, group, label, status, detail, hint } : { id, group, label, status, detail };
}

// Wrap a probe so a thrown error becomes an `error` result instead of crashing
// the whole report. The probe itself decides ok/warn/skipped; only an actual
// throw lands here.
async function safeProbe(
  id: string,
  group: DiagnosticGroupId,
  label: string,
  fn: () => Promise<DiagnosticCheck>,
): Promise<DiagnosticCheck> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return mk(id, group, label, 'error', `probe threw: ${message}`);
  }
}

// `which`-style PATH lookup that never throws. Returns the resolved path or null.
// POSIX `command -v` would need a shell; we use the `which` binary with an argv
// array (no shell) and treat any non-zero exit / ENOENT as "not found".
async function onPath(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [bin], { timeout: 3000 });
    const first = stdout.split('\n')[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

// Version probe: run `<bin> <flag>` and pull the first semver-ish token. Resolves
// to null when the binary is missing or errors. Mirrors capabilities.ts.
async function probeVersion(bin: string, flags: string[] = ['--version']): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, flags, { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    const text = `${stdout}\n${stderr}`;
    const m = text.match(/(\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?)/);
    return m ? m[1] : 'unknown';
  } catch {
    return null;
  }
}

// Directory size + existence. Best-effort recursive byte sum; never throws.
// Returns { exists, bytes }. Bounded by the dir's own contents — the Archon
// dirs are small (settings, catalogs, recall db, per-cwd events).
async function dirInfo(dir: string): Promise<{ exists: boolean; bytes: number }> {
  let total = 0;
  let exists = false;
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
      exists = true;
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      try {
        if (e.isDirectory()) {
          await walk(p);
        } else if (e.isFile()) {
          const st = await fs.stat(p);
          total += st.size;
        }
      } catch {
        // unreadable entry — skip, keep summing the rest
      }
    }
  }
  try {
    await fs.access(dir);
    exists = true;
  } catch {
    return { exists: false, bytes: 0 };
  }
  await walk(dir);
  return { exists, bytes: total };
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// ── CORE ─────────────────────────────────────────────────────────────────────

// Data/config dir read+write. Writes a throwaway probe file under ~/.archon and
// removes it — never touches a real workflow log.
async function checkDataDirRw(): Promise<DiagnosticCheck> {
  const id = 'core.data-dir-rw';
  const label = 'Data/config dir read+write';
  await fs.mkdir(ARCHON_HOME, { recursive: true });
  const probe = join(ARCHON_HOME, `.diag-probe-${process.pid}-${Date.now()}`);
  await fs.writeFile(probe, 'archon-diagnostics-probe\n', 'utf8');
  const back = await fs.readFile(probe, 'utf8');
  await fs.rm(probe, { force: true });
  if (!back.includes('archon-diagnostics-probe')) {
    return mk(id, 'core', label, 'error', `wrote ${ARCHON_HOME} but readback mismatched`);
  }
  return mk(id, 'core', label, 'ok', `${ARCHON_HOME} is readable and writable`);
}

// events.jsonl append+read round-trip — against a THROWAWAY temp path, not a
// real workflow log (the plan is explicit about not corrupting a real log).
// Proves the append-then-read pattern Archon's persistence relies on works on
// this filesystem.
async function checkEventsLogRoundTrip(): Promise<DiagnosticCheck> {
  const id = 'core.events-log-roundtrip';
  const label = 'events.jsonl append+read round-trip';
  const dir = await fs.mkdtemp(join(tmpdir(), 'archon-diag-events-'));
  const log = join(dir, 'events.jsonl');
  try {
    const lines = [
      JSON.stringify({ seq: 1, type: 'diag', t: Date.now() }),
      JSON.stringify({ seq: 2, type: 'diag', t: Date.now() }),
    ];
    await fs.appendFile(log, lines[0] + '\n', 'utf8');
    await fs.appendFile(log, lines[1] + '\n', 'utf8');
    const back = (await fs.readFile(log, 'utf8')).trim().split('\n');
    if (back.length !== 2) {
      return mk(id, 'core', label, 'error', `appended 2 lines, read back ${back.length}`);
    }
    const parsed = back.map((l) => JSON.parse(l) as { seq: number });
    if (parsed[0].seq !== 1 || parsed[1].seq !== 2) {
      return mk(id, 'core', label, 'error', 'round-trip seq order mismatch');
    }
    return mk(id, 'core', label, 'ok', 'append-then-read preserves order and content (temp probe)');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Settings cascade parses without throwing. readSettings layers defaults →
// global → (optional cwd); a malformed JSON file would throw here.
async function checkSettingsCascade(): Promise<DiagnosticCheck> {
  const id = 'core.settings-cascade';
  const label = 'Settings cascade parse';
  const settings = await readSettings();
  const providers = settings.enabledProviders ? Object.keys(settings.enabledProviders).length : 0;
  return mk(id, 'core', label, 'ok', `parsed (defaults → ~/.archon/settings.json); ${providers} provider toggles present`);
}

// Workflow-recovery registry readable. ~/.archon/known-cwds.json is the
// crash-recovery registry; a missing file is normal (no workflows yet) and is
// reported ok-empty, not an error. Malformed JSON degrades to warn.
async function checkRecoveryRegistry(): Promise<DiagnosticCheck> {
  const id = 'core.recovery-registry';
  const label = 'Workflow-recovery registry readable';
  const regPath = join(ARCHON_HOME, 'known-cwds.json');
  let raw: string;
  try {
    raw = await fs.readFile(regPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return mk(id, 'core', label, 'ok', 'no registry yet (no workflows recovered) — known-cwds.json absent');
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    const n = Array.isArray(parsed) ? parsed.length : 0;
    return mk(id, 'core', label, 'ok', `known-cwds.json parses; ${n} known cwd(s)`);
  } catch {
    return mk(id, 'core', label, 'warn', 'known-cwds.json is present but not valid JSON', 'delete ~/.archon/known-cwds.json to reset recovery');
  }
}

// Process readiness (ARCHON_OPS_PLAN.md §B2). Read-only snapshot of the /readyz
// gate. not-ready maps to `warn`, NOT `error`: not-ready is a transient boot
// state (the window before capabilities probe + store recovery finish), not a
// fault. By the time the operator can run this through the diagnostics endpoint
// the server is listening, so in practice this is ~always ok.
async function checkReadiness(): Promise<DiagnosticCheck> {
  const id = 'core.readiness';
  const label = 'Process readiness (/readyz)';
  const snap = readinessSnapshot();
  if (snap.ready) {
    const comps = Object.keys(snap.components).join(', ');
    return mk(id, 'core', label, 'ok', `ready (${comps}); up ${snap.uptimeSec}s`);
  }
  return mk(id, 'core', label, 'warn', `still booting — pending: ${snap.pending.join(', ')}`, 'transient during boot; /readyz returns 503 until capabilities + stores are ready');
}

// Structured file-logging status (ARCHON_OPS_PLAN.md §B3). Read-only: when file
// logging is active (getLogFilePath() non-null — set by ARCHON_LOG_FILE=1 in the
// systemd unit) report ok with the path + current size; when off (dev /
// ARCHON_LOG_FILE unset) report `skipped` — there is nothing to inspect and it's
// not a fault. One statSync, guarded.
async function checkLogs(): Promise<DiagnosticCheck> {
  const id = 'core.logs';
  const label = 'Structured file logging';
  const path = getLogFilePath();
  if (!path) {
    return mk(id, 'core', label, 'skipped', 'file logging off (dev / ARCHON_LOG_FILE unset) — console only');
  }
  try {
    const st = await fs.stat(path);
    return mk(id, 'core', label, 'ok', `logging to ${path} (${fmtBytes(st.size)})`);
  } catch {
    // Enabled but the file isn't there yet (no line written since boot) — still ok.
    return mk(id, 'core', label, 'ok', `file logging enabled → ${path} (no lines written yet)`);
  }
}

// Code-skew banner (H43). The live prod service runs the compiled `dist` frozen
// at the rev it booted from; on-disk HEAD can advance past it when the operator
// commits/pulls without rebuilding. WARN when the running build is behind; SKIP
// under tsx-watch dev (source is live) and when not a git checkout. Read-only —
// two `git rev-parse`/`rev-list` execFile reads, cwd-pinned, timeout-bounded.
async function checkCodeSkew(): Promise<DiagnosticCheck> {
  const id = 'core.code-skew';
  const label = 'Running build vs on-disk HEAD';
  const r = await probeCodeSkew();
  return mk(id, 'core', label, r.status, r.detail, r.hint);
}

// Systemd shutdown-window alignment (H42 part A). The unit's TimeoutStopUSec is
// the budget systemd gives onSignal to reap children + flush all workflow events
// before escalating to SIGKILL; WARN when it's below that budget. SKIP off-systemd
// (dev / non-Linux). Read-only — one `systemctl show` execFile.
async function checkShutdownWindow(): Promise<DiagnosticCheck> {
  const id = 'core.systemd-shutdown-window';
  const label = 'Systemd stop-timeout vs graceful shutdown';
  const r = await probeShutdownWindow();
  return mk(id, 'core', label, r.status, r.detail, r.hint);
}

// ── PROVIDERS ─────────────────────────────────────────────────────────────────

async function checkClaudeCli(): Promise<DiagnosticCheck> {
  const id = 'providers.claude-cli';
  const label = 'Claude CLI';
  const v = await probeVersion('claude');
  if (!v) {
    return mk(id, 'providers', label, 'warn', 'claude CLI not found on PATH', 'install @anthropic-ai/claude-code, or use the Claude Native transport');
  }
  return mk(id, 'providers', label, 'ok', `claude ${v}`);
}

async function checkClaudeNative(): Promise<DiagnosticCheck> {
  const id = 'providers.claude-native';
  const label = 'Claude Native (OAuth)';
  const tokens = await loadClaudeNativeTokens();
  if (!tokens) {
    return mk(id, 'providers', label, 'warn', 'no OAuth tokens at ~/.archon/auth.json', 'log in via Settings → Claude Native, or use the CLI transport');
  }
  const expired = typeof tokens.expiresAt === 'number' && tokens.expiresAt < Date.now();
  if (expired) {
    return mk(id, 'providers', label, 'warn', 'OAuth tokens present but expired (auto-refresh on next turn)', 're-login if refresh fails');
  }
  return mk(id, 'providers', label, 'ok', 'OAuth tokens present and unexpired');
}

async function checkCodexCli(): Promise<DiagnosticCheck> {
  const id = 'providers.codex';
  const label = 'Codex CLI';
  const v = await probeVersion('codex');
  if (!v) {
    return mk(id, 'providers', label, 'warn', 'codex CLI not found on PATH', 'install @openai/codex');
  }
  return mk(id, 'providers', label, 'ok', `codex ${v}`);
}

async function checkGeminiCli(): Promise<DiagnosticCheck> {
  const id = 'providers.gemini';
  const label = 'Gemini CLI';
  const v = await probeVersion('gemini');
  if (!v) {
    return mk(id, 'providers', label, 'warn', 'gemini CLI not found on PATH', 'install @google/gemini-cli');
  }
  return mk(id, 'providers', label, 'ok', `gemini ${v}`);
}

async function checkOllama(): Promise<DiagnosticCheck> {
  const id = 'providers.ollama';
  const label = 'Ollama daemon';
  const r = await probeOllama();
  if (!r.up) {
    return mk(id, 'providers', label, 'warn', `daemon not reachable${r.error ? ` (${r.error})` : ''}`, 'start `ollama serve`, or set settings.ollama.baseUrl');
  }
  return mk(id, 'providers', label, 'ok', `daemon reachable; ${r.models.length} model(s) installed`);
}

async function checkLlamacpp(): Promise<DiagnosticCheck> {
  const id = 'providers.llamacpp';
  const label = 'llama.cpp';
  const status = llamacppManager.getStatus();
  let catalogCount = 0;
  let catalogReadable = true;
  try {
    const catalog = await readLlamacppCatalog();
    catalogCount = catalog.models.length;
  } catch {
    catalogReadable = false;
  }
  if (!catalogReadable) {
    return mk(id, 'providers', label, 'warn', `manager state: ${status.state}; catalog (~/.archon/llamacpp.json) unreadable`, 'check ~/.archon/llamacpp.json is valid JSON');
  }
  if (status.state === 'failed') {
    return mk(id, 'providers', label, 'error', `last launch failed: ${status.error ?? 'unknown'}; ${catalogCount} model(s) registered`);
  }
  return mk(id, 'providers', label, 'ok', `manager ${status.state}; ${catalogCount} model(s) registered`);
}

// Antigravity is a CDP-driven desktop-app integration. There is no cheap,
// side-effect-free presence probe (a real probe would attach to the running
// app), so per the plan we report `skipped` ("not probed") rather than guess.
async function checkAntigravity(): Promise<DiagnosticCheck> {
  const id = 'providers.antigravity';
  const label = 'Antigravity (CDP)';
  return mk(id, 'providers', label, 'skipped', 'not probed — CDP presence has no cheap side-effect-free check');
}

// ── LOCAL TOOLS ───────────────────────────────────────────────────────────────

async function checkGh(): Promise<DiagnosticCheck> {
  const id = 'local-tools.gh';
  const label = 'GitHub CLI (gh) auth';
  const ghPath = await onPath('gh');
  if (!ghPath) {
    return mk(id, 'local-tools', label, 'warn', 'gh not found on PATH', 'install GitHub CLI for the GIT/GitHub primitives');
  }
  try {
    // `gh auth token` exits 0 with a token on stdout when authed, non-zero
    // otherwise. execFile, argv array, no shell. We never log the token.
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 5000 });
    if (stdout.trim().length > 0) {
      return mk(id, 'local-tools', label, 'ok', 'gh installed and authenticated');
    }
    return mk(id, 'local-tools', label, 'warn', 'gh installed but no auth token', 'run `gh auth login`');
  } catch {
    return mk(id, 'local-tools', label, 'warn', 'gh installed but not authenticated', 'run `gh auth login`');
  }
}

async function checkFfmpeg(): Promise<DiagnosticCheck> {
  const id = 'local-tools.ffmpeg';
  const label = 'ffmpeg';
  const ok = await ffmpegAvailable();
  return ok
    ? mk(id, 'local-tools', label, 'ok', 'ffmpeg available')
    : mk(id, 'local-tools', label, 'warn', 'ffmpeg not found', 'install ffmpeg for audio/video ops');
}

async function checkFfprobe(): Promise<DiagnosticCheck> {
  const id = 'local-tools.ffprobe';
  const label = 'ffprobe';
  const ok = await ffprobeAvailable();
  return ok
    ? mk(id, 'local-tools', label, 'ok', 'ffprobe available')
    : mk(id, 'local-tools', label, 'warn', 'ffprobe not found', 'install ffmpeg (ships ffprobe) for media metadata');
}

// LSP server detection — best-effort PATH lookup for the language servers Archon
// lazy-spawns after a Native Write/Edit. Absence is `warn`, never `error`: the
// LSP subsystem is a silent no-op without a server (the operator installs them
// upstream). Many boxes have some-but-not-all (this one has rust-analyzer but
// not typescript-language-server) — that degrades to warn with a per-server list.
async function checkLsp(): Promise<DiagnosticCheck> {
  const id = 'local-tools.lsp';
  const label = 'LSP servers';
  const candidates = ['typescript-language-server', 'pyright-langserver', 'gopls', 'rust-analyzer'];
  const found: string[] = [];
  const missing: string[] = [];
  for (const c of candidates) {
    if (await onPath(c)) found.push(c);
    else missing.push(c);
  }
  if (found.length === 0) {
    return mk(id, 'local-tools', label, 'warn', 'no language servers on PATH — inline diagnostics disabled', `optional: install any of ${candidates.join(', ')}`);
  }
  if (missing.length > 0) {
    return mk(id, 'local-tools', label, 'warn', `found: ${found.join(', ')}; absent: ${missing.join(', ')}`, 'absent servers just mean no diagnostics for those languages');
  }
  return mk(id, 'local-tools', label, 'ok', `all detected: ${found.join(', ')}`);
}

// Terminal PTY support — is node-pty importable in this runtime? A failed import
// (missing native build) means the integrated terminal won't spawn. Dynamic
// import so a load failure is a `warn`, not a module-eval crash.
async function checkPty(): Promise<DiagnosticCheck> {
  const id = 'local-tools.pty';
  const label = 'Terminal PTY support';
  try {
    const pty = await import('node-pty');
    if (pty && typeof pty.spawn === 'function') {
      return mk(id, 'local-tools', label, 'ok', 'node-pty importable; integrated terminal available');
    }
    return mk(id, 'local-tools', label, 'warn', 'node-pty imported but spawn() missing');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return mk(id, 'local-tools', label, 'warn', `node-pty not importable: ${message}`, 'rebuild native deps (npm rebuild node-pty)');
  }
}

// ── WORKBENCH ─────────────────────────────────────────────────────────────────

// Preview-proxy health: the proxy is wired into the HTTP router and has no
// external dependency to probe (it forwards to per-workflow loopback ports that
// only exist when an agent spawns a dev server). So the meaningful, deterministic
// readout is "the proxy module is loaded and the route is mounted" — which is
// always true if this endpoint is responding. Report ok with that framing.
async function checkPreviewProxy(): Promise<DiagnosticCheck> {
  const id = 'workbench.preview-proxy';
  const label = 'Preview proxy';
  return mk(id, 'workbench', label, 'ok', 'proxy route mounted (per-workflow targets bind on demand)');
}

// Recall index health — the machine-global recall.db under ~/.archon/recall.
// Absent is normal on a fresh machine (ok-empty); present-and-readable is ok.
//
// The binding probe comes FIRST: statting the db file says nothing about
// whether recall can actually open it, so an npm-12 install with
// better-sqlite3's scripts blocked used to report a confident `ok` here while
// recall was dead (no db file yet → "builds on first indexed turn", which never
// comes). The probe must CONSTRUCT a database, not just import the module —
// better-sqlite3 resolves its .node lazily, so `import()` alone succeeds with
// the binding missing (measured: a warn-less `ok` while the boot log said
// RECALL DISABLED). An in-memory open is cheap and touches no disk state.
async function checkRecall(): Promise<DiagnosticCheck> {
  const id = 'workbench.recall-index';
  const label = 'Recall index';
  try {
    const { default: Database } = await import('better-sqlite3');
    new Database(':memory:').close();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return mk(id, 'workbench', label, 'warn', `better-sqlite3 not loadable — recall/search disabled: ${message.split('\n')[0]}`, 'npm rebuild better-sqlite3 (npm 12 blocks install scripts unless root package.json `allowScripts` covers the installed version)');
  }
  const dbPath = join(recallHomeDir(), 'recall.db');
  try {
    const st = await fs.stat(dbPath);
    return mk(id, 'workbench', label, 'ok', `recall.db present (${fmtBytes(st.size)})`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return mk(id, 'workbench', label, 'ok', 'no recall index yet (builds on first indexed turn)');
    }
    throw err;
  }
}

// Knowledge index health — per-cwd <cwd>/.archon/knowledge/index.json. There is
// no machine-global knowledge store (it's project-scoped), so without a cwd the
// honest readout is `skipped` with that explanation.
async function checkKnowledge(): Promise<DiagnosticCheck> {
  const id = 'workbench.knowledge-index';
  const label = 'Knowledge index';
  return mk(id, 'workbench', label, 'skipped', 'knowledge bases are per-project (<cwd>/.archon/knowledge) — no machine-global index to probe');
}

// Cookbook hardware probe reachable — probeHardware is read-only and degrades to
// a CPU/Metal fallback on a box without nvidia-smi, so it always returns a
// profile. We report the backend + VRAM it found.
async function checkCookbookHardware(): Promise<DiagnosticCheck> {
  const id = 'workbench.cookbook-hardware';
  const label = 'Cookbook hardware probe';
  const hw = await probeHardware();
  const vram = hw.totalVramBytes > 0 ? `, ${fmtBytes(hw.totalVramBytes)} VRAM across ${hw.gpus.length} GPU(s)` : '';
  return mk(id, 'workbench', label, 'ok', `backend ${hw.backend}, ${fmtBytes(hw.systemRamBytes)} RAM, ${hw.cores} cores${vram}`);
}

// ── STORAGE ───────────────────────────────────────────────────────────────────

async function checkArchonHomeStorage(): Promise<DiagnosticCheck> {
  const id = 'storage.archon-home';
  const label = '~/.archon size';
  const info = await dirInfo(ARCHON_HOME);
  if (!info.exists) {
    return mk(id, 'storage', label, 'ok', '~/.archon does not exist yet (created on first use)');
  }
  return mk(id, 'storage', label, 'ok', `${ARCHON_HOME} — ${fmtBytes(info.bytes)}`);
}

// Per-cwd .archon storage. No single cwd is in scope for a global diagnostics
// call (workflows each have their own), so report `skipped` with the per-cwd
// location so the operator knows where to look.
async function checkProjectStorage(): Promise<DiagnosticCheck> {
  const id = 'storage.project-archon';
  const label = 'Per-project .archon size';
  return mk(id, 'storage', label, 'skipped', 'per-cwd <cwd>/.archon (events.jsonl, meta.json, plans) — scoped to each workflow, not a global path');
}

// ── SECURITY / EXPOSURE POSTURE (ARCHON_OPS_PLAN.md §A4) ──────────────────────
//
// Read-only exposure readout. The unifying rationale: Archon's HTTP/WS surface
// has NO AUTH and exposes a shell (PTY terminal), git/GitHub ops, filesystem
// read+write under cwd roots, and provider credentials. So the severity of every
// capability is CONDITIONED ON THE BIND ADDRESS — bound to loopback, only this
// machine can reach those powers (ok, informational); bound to a non-loopback
// address, the same powers are reachable by the LAN/tailnet (warn).
//
// Fences (this group flows into the shareable support bundle, so they bite
// doubly): every probe is a pure read of config/env/settings/manager-state — no
// mutation, no new subprocess (the lone exec reuses checkGh's `gh auth token`
// approach), no network connection. NEVER echo a token, env VALUE, baseUrl, or
// absolute path into a detail/hint — report BOOLEANS and CLASSIFICATIONS only.

// True when HOST resolves to a loopback bind (only this machine can reach the
// no-auth surface). Centralises the loopback test the capability checks share.
function isLoopbackBind(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

// Pure classifier for the server bind address. Exported so the smoke can
// unit-test the branch table directly (no live server needed). Returns the
// status + a path/value-free detail (+ optional hint).
export function classifyBindAddress(
  host: string,
): { status: DiagnosticStatus; detail: string; hint?: string } {
  if (isLoopbackBind(host)) {
    return { status: 'ok', detail: 'bound to loopback (127.0.0.1) — reachable only from this machine' };
  }
  if (host === '0.0.0.0' || host === '::') {
    return {
      status: 'warn',
      detail:
        'bound to 0.0.0.0 — the no-auth HTTP/WS surface (shell, git, filesystem, provider creds) is reachable by anything that can route to this host',
      hint: 'set ARCHON_HOST=127.0.0.1 unless you intend LAN exposure',
    };
  }
  if (isPrivateHost(host)) {
    return { status: 'warn', detail: 'bound to a private-network address — reachable on your LAN/tailnet' };
  }
  return { status: 'warn', detail: 'bound to a non-private address — potentially publicly reachable' };
}

async function checkBindAddress(): Promise<DiagnosticCheck> {
  const id = 'security.bind-address';
  const label = 'Server bind address';
  const c = classifyBindAddress(HOST);
  return mk(id, 'security', label, c.status, c.detail, c.hint);
}

async function checkRemoteAccess(): Promise<DiagnosticCheck> {
  const id = 'security.remote-access';
  const label = 'Remote access exposure';
  // Honest + deterministic: an external SSH/Vite tunnel is a documented operator
  // workflow Archon cannot detect from inside the process, so we report only
  // what the bind tells us.
  if (isLoopbackBind(HOST)) {
    return mk(id, 'security', label, 'ok', 'no exposure from Arco\'s own bind; remote use via SSH/Vite tunnel (a documented manual workflow) is not auto-detectable');
  }
  return mk(id, 'security', label, 'warn', 'non-loopback bind means remote operators on the same network can reach Arco directly');
}

async function checkTerminalExposure(): Promise<DiagnosticCheck> {
  const id = 'security.terminal';
  const label = 'Integrated terminal (shell) exposure';
  if (isLoopbackBind(HOST)) {
    return mk(id, 'security', label, 'ok', 'integrated terminal available to local clients only');
  }
  return mk(id, 'security', label, 'warn', 'integrated terminal (arbitrary shell in your cwds) is reachable by non-local clients');
}

// Boolean-only gh-auth presence (mirrors checkGh's `gh auth token` approach;
// the token itself is NEVER read into the detail).
async function ghTokenPresent(): Promise<boolean> {
  const ghPath = await onPath('gh');
  if (!ghPath) return false;
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 5000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function checkGitOpsExposure(): Promise<DiagnosticCheck> {
  const id = 'security.git-ops';
  const label = 'Git / GitHub operations exposure';
  const ghAuthed = await ghTokenPresent();
  if (isLoopbackBind(HOST)) {
    return mk(id, 'security', label, 'ok', `git ops${ghAuthed ? ' + authenticated gh' : ''} reachable by local clients only`);
  }
  if (ghAuthed) {
    return mk(id, 'security', label, 'warn', 'git push + authenticated gh operations are reachable by non-local clients');
  }
  return mk(id, 'security', label, 'warn', 'git operations are reachable by non-local clients');
}

// Count of writable cwd roots from ~/.archon/known-cwds.json (mirrors
// checkRecoveryRegistry's read). NEVER lists the paths — count only.
async function checkWritableCwdRoots(): Promise<DiagnosticCheck> {
  const id = 'security.writable-cwd-roots';
  const label = 'Writable cwd roots exposure';
  const regPath = join(ARCHON_HOME, 'known-cwds.json');
  let count = 0;
  try {
    const raw = await fs.readFile(regPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) count = parsed.length;
  } catch {
    // absent / malformed registry → 0 known roots; not an error for this readout
  }
  if (isLoopbackBind(HOST)) {
    return mk(id, 'security', label, 'ok', `${count} project root(s) are read/write via the API to local clients only`);
  }
  return mk(id, 'security', label, 'warn', `${count} writable project root(s) are reachable by non-local clients`);
}

async function checkProviderAuthExposure(): Promise<DiagnosticCheck> {
  const id = 'security.provider-auth';
  const label = 'Provider credentials exposure';
  // Presence booleans only — never the token or its path.
  const claudeTokens = await loadClaudeNativeTokens();
  const claudePresent = !!claudeTokens;
  const ghAuthed = await ghTokenPresent();
  const anyCreds = claudePresent || ghAuthed;
  if (isLoopbackBind(HOST)) {
    return mk(id, 'security', label, 'ok', anyCreds ? 'provider credentials present; spendable only by local clients' : 'no provider credentials detected');
  }
  if (anyCreds) {
    return mk(id, 'security', label, 'warn', 'provider credentials (Claude OAuth / gh) are spendable by non-local clients reaching the no-auth surface');
  }
  return mk(id, 'security', label, 'warn', 'non-loopback bind; no provider credentials detected to expose');
}

async function checkPreviewProxyExposure(): Promise<DiagnosticCheck> {
  const id = 'security.preview-proxy';
  const label = 'Preview proxy exposure';
  if (isLoopbackBind(HOST)) {
    return mk(id, 'security', label, 'ok', 'preview proxy reachable by local clients only');
  }
  return mk(id, 'security', label, 'warn', 'preview proxy can forward LAN clients to your loopback dev servers');
}

// Local model endpoints: llama.cpp bind host + resolved Ollama base-URL host.
// A non-loopback Ollama baseUrl is typically a DELIBERATE remote daemon (e.g. a
// workstation over Tailscale) → ok when private; warn only if non-private.
// NEVER prints the URL — classification words only.
async function checkLocalModelEndpoints(): Promise<DiagnosticCheck> {
  const id = 'security.local-model-endpoints';
  const label = 'Local model endpoint exposure';
  const llamaHost = process.env.ARCHON_LLAMACPP_HOST ?? '127.0.0.1';
  const llamaLoopback = isLoopbackBind(llamaHost);

  // Resolve the Ollama base URL host (settings → OLLAMA_URL_BASE → default).
  const settings = await readSettings();
  const ollamaBaseUrl = settings.ollama?.baseUrl ?? process.env.OLLAMA_URL_BASE ?? 'http://127.0.0.1:11434';
  let ollamaHost = '127.0.0.1';
  try {
    ollamaHost = new URL(ollamaBaseUrl).hostname;
  } catch {
    // unparseable → treat as default loopback; never surface the raw string
  }
  const ollamaLoopback = isLoopbackBind(ollamaHost);
  const ollamaPrivate = isPrivateHost(ollamaHost);

  if (llamaHost === '0.0.0.0') {
    return mk(id, 'security', label, 'warn', 'llama-server bound to 0.0.0.0', 'set ARCHON_LLAMACPP_HOST=127.0.0.1 unless you intend LAN exposure');
  }
  if (!ollamaLoopback && !ollamaPrivate) {
    return mk(id, 'security', label, 'warn', 'Ollama configured to a non-private host');
  }
  if (!ollamaLoopback && ollamaPrivate) {
    return mk(id, 'security', label, 'ok', 'Ollama configured to a remote daemon (operator-set)');
  }
  if (llamaLoopback && ollamaLoopback) {
    return mk(id, 'security', label, 'ok', 'local model endpoints bound to loopback');
  }
  return mk(id, 'security', label, 'ok', 'local model endpoints bound to loopback');
}

// Allowlist of known-risky env keys. Small + documented on purpose: report only
// these by NAME when set to a risky value — never the value itself.
//   ARCHON_HOST                    — flagged only when it is a non-loopback bind
//   NODE_TLS_REJECT_UNAUTHORIZED   — flagged only when '0' (TLS verification off)
//   /DANGEROUS|UNSAFE|SKIP_PERMISSION|NO_AUTH|YOLO/i — any env key matching this
async function checkRiskyEnvConfig(): Promise<DiagnosticCheck> {
  const id = 'security.risky-env-config';
  const label = 'Risky env / config flags';
  const flagged: string[] = [];
  if (process.env.ARCHON_HOST && !isLoopbackBind(process.env.ARCHON_HOST)) {
    flagged.push('ARCHON_HOST');
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    flagged.push('NODE_TLS_REJECT_UNAUTHORIZED');
  }
  const riskyName = /DANGEROUS|UNSAFE|SKIP_PERMISSION|NO_AUTH|YOLO/i;
  for (const key of Object.keys(process.env)) {
    if (riskyName.test(key) && !flagged.includes(key)) flagged.push(key);
  }
  if (flagged.length === 0) {
    return mk(id, 'security', label, 'ok', 'no risky env/config flags detected');
  }
  return mk(id, 'security', label, 'warn', `risky flag(s) set: ${flagged.join(', ')}`);
}

// ── registry assembly ────────────────────────────────────────────────────────

interface GroupSpec {
  id: DiagnosticGroupId;
  label: string;
  probes: Array<{ id: string; label: string; fn: () => Promise<DiagnosticCheck> }>;
}

const GROUPS: GroupSpec[] = [
  {
    id: 'core',
    label: 'Core',
    probes: [
      { id: 'core.data-dir-rw', label: 'Data/config dir read+write', fn: checkDataDirRw },
      { id: 'core.events-log-roundtrip', label: 'events.jsonl append+read round-trip', fn: checkEventsLogRoundTrip },
      { id: 'core.settings-cascade', label: 'Settings cascade parse', fn: checkSettingsCascade },
      { id: 'core.recovery-registry', label: 'Workflow-recovery registry readable', fn: checkRecoveryRegistry },
      { id: 'core.readiness', label: 'Process readiness (/readyz)', fn: checkReadiness },
      { id: 'core.logs', label: 'Structured file logging', fn: checkLogs },
      { id: 'core.code-skew', label: 'Running build vs on-disk HEAD', fn: checkCodeSkew },
      { id: 'core.systemd-shutdown-window', label: 'Systemd stop-timeout vs graceful shutdown', fn: checkShutdownWindow },
    ],
  },
  {
    id: 'providers',
    label: 'Providers',
    probes: [
      { id: 'providers.claude-cli', label: 'Claude CLI', fn: checkClaudeCli },
      { id: 'providers.claude-native', label: 'Claude Native (OAuth)', fn: checkClaudeNative },
      { id: 'providers.codex', label: 'Codex CLI', fn: checkCodexCli },
      { id: 'providers.gemini', label: 'Gemini CLI', fn: checkGeminiCli },
      { id: 'providers.ollama', label: 'Ollama daemon', fn: checkOllama },
      { id: 'providers.llamacpp', label: 'llama.cpp', fn: checkLlamacpp },
      { id: 'providers.antigravity', label: 'Antigravity (CDP)', fn: checkAntigravity },
    ],
  },
  {
    id: 'local-tools',
    label: 'Local Tools',
    probes: [
      { id: 'local-tools.gh', label: 'GitHub CLI (gh) auth', fn: checkGh },
      { id: 'local-tools.ffmpeg', label: 'ffmpeg', fn: checkFfmpeg },
      { id: 'local-tools.ffprobe', label: 'ffprobe', fn: checkFfprobe },
      { id: 'local-tools.lsp', label: 'LSP servers', fn: checkLsp },
      { id: 'local-tools.pty', label: 'Terminal PTY support', fn: checkPty },
    ],
  },
  {
    id: 'workbench',
    label: 'Workbench',
    probes: [
      { id: 'workbench.preview-proxy', label: 'Preview proxy', fn: checkPreviewProxy },
      { id: 'workbench.recall-index', label: 'Recall index', fn: checkRecall },
      { id: 'workbench.knowledge-index', label: 'Knowledge index', fn: checkKnowledge },
      { id: 'workbench.cookbook-hardware', label: 'Cookbook hardware probe', fn: checkCookbookHardware },
    ],
  },
  {
    id: 'storage',
    label: 'Storage',
    probes: [
      { id: 'storage.archon-home', label: '~/.archon size', fn: checkArchonHomeStorage },
      { id: 'storage.project-archon', label: 'Per-project .archon size', fn: checkProjectStorage },
    ],
  },
  {
    id: 'security',
    label: 'Security & Exposure',
    probes: [
      { id: 'security.bind-address', label: 'Server bind address', fn: checkBindAddress },
      { id: 'security.remote-access', label: 'Remote access exposure', fn: checkRemoteAccess },
      { id: 'security.terminal', label: 'Integrated terminal (shell) exposure', fn: checkTerminalExposure },
      { id: 'security.git-ops', label: 'Git / GitHub operations exposure', fn: checkGitOpsExposure },
      { id: 'security.writable-cwd-roots', label: 'Writable cwd roots exposure', fn: checkWritableCwdRoots },
      { id: 'security.provider-auth', label: 'Provider credentials exposure', fn: checkProviderAuthExposure },
      { id: 'security.preview-proxy', label: 'Preview proxy exposure', fn: checkPreviewProxyExposure },
      { id: 'security.local-model-endpoints', label: 'Local model endpoint exposure', fn: checkLocalModelEndpoints },
      { id: 'security.risky-env-config', label: 'Risky env / config flags', fn: checkRiskyEnvConfig },
    ],
  },
];

let archonVersionCache: string | undefined;
async function archonVersion(): Promise<string> {
  if (archonVersionCache !== undefined) return archonVersionCache;
  // package.json sits two levels above server/src at the repo root; resolve via
  // PROJECT_ROOT-style climb from this module. Best-effort — a miss reports
  // "unknown" rather than failing the report.
  try {
    const url = new URL('../../../package.json', import.meta.url);
    const raw = await fs.readFile(url, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    archonVersionCache = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    archonVersionCache = 'unknown';
  }
  return archonVersionCache;
}

// Build the full diagnostics report. Runs every probe concurrently across all
// groups (each safeProbe-wrapped + individually time-bounded), then assembles
// the grouped result in the fixed declaration order. Never throws.
export async function runDiagnostics(): Promise<DiagnosticsReport> {
  const groups: DiagnosticGroup[] = await Promise.all(
    GROUPS.map(async (g) => {
      const checks = await Promise.all(g.probes.map((p) => safeProbe(p.id, g.id, p.label, p.fn)));
      return { id: g.id, label: g.label, checks };
    }),
  );
  return {
    groups,
    generatedAt: Date.now(),
    archonVersion: await archonVersion(),
    platform: `${platform()}/${arch()}`,
  };
}
