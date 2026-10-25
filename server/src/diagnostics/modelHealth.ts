// ── Local model health report (ARCHON_OPS_PLAN.md §A3) ──
//
// The single source behind GET /api/diagnostics/model-health. A richer,
// structured sibling of the A1 Diagnostics tab, focused on the *model operator*
// question: "what can I run now / what's running / what failed last time / is my
// config stale?". Three subsystems — Ollama, llama.cpp, Cookbook — each a typed
// sub-report carrying concrete fields plus a roll-up DiagnosticStatus.
//
// Design fences (four-question test): operator-triggered (the model-health panel
// fetches on mount + on Refresh — no daemon); deterministic rules the operator
// can read (each builder below is a fixed READ-ONLY probe with a fixed status
// mapping); read-only (it reuses the existing ollama / llamacppManager / cookbook
// probes and reads ~/.archon/llamacpp.log + ~/.archon/models — it NEVER spawns a
// model, mutates a catalog, or changes manager lifecycle); reversible (a readout).
//
// Status framing for a model-operator lens (CLAUDE.md §A3): a missing/unreachable
// subsystem is `warn`/`skipped`, NOT `error` (the operator may simply not use it);
// a stale config or a fit mismatch is a `warn` with an actionable hint; `error`
// is reserved for "configured and should work but its last launch failed" (the
// llama.cpp manager state `failed`).
//
// Resilience: each subsystem builder is wrapped so a thrown probe degrades to a
// `warn` sub-report instead of failing the whole call. buildModelHealthReport
// never throws.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { basename } from 'node:path';
import { homedir, platform, arch } from 'node:os';

import type {
  CookbookHealth,
  DiagnosticStatus,
  LlamacppHealth,
  ModelFitWarning,
  ModelHealthModel,
  ModelHealthReport,
  ModelSpec,
  OllamaHealth,
} from '@archon/shared';

import { probeOllama, getOllamaBase } from '../providers/ollama.js';
import { llamacppManager } from '../providers/llamacppManager.js';
import { diagnoseLlamacppServeFailure } from '../providers/llamacppServeDiagnose.js';
import { readCatalog as readLlamacppCatalog } from '../llamacppCatalog.js';
import { probeHardware } from '../cookbook/hardware.js';
import { scoreFit } from '../cookbook/fit.js';
import { parseParams } from '../cookbook/catalog.js';
import { modelsDir } from '../cookbook/install.js';
import { archonHome } from '../archonHome.js';

const execFileAsync = promisify(execFile);
const ARCHON_HOME = archonHome();
const LLAMACPP_LOG = join(ARCHON_HOME, 'llamacpp.log');

// Lines of llama-server log to surface as the "last stderr" tail. The full log
// can be large; a tail is enough to see the last spawn + any failure.
const LOG_TAIL_LINES = 40;
// Read at most this many trailing bytes of the log before tailing, so a huge log
// doesn't get slurped into memory.
const LOG_TAIL_MAX_BYTES = 64 * 1024;

// ── helpers ───────────────────────────────────────────────────────────────────

// which-style PATH lookup that never throws. argv array, no shell.
async function onPath(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [bin], { timeout: 3000 });
    const first = stdout.split('\n')[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

// Read the trailing LOG_TAIL_LINES of a text file, bounded to the last
// LOG_TAIL_MAX_BYTES. Returns undefined if the file is absent/unreadable.
async function tailFile(path: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(path, 'r');
    const st = await handle.stat();
    if (st.size === 0) return undefined;
    const start = Math.max(0, st.size - LOG_TAIL_MAX_BYTES);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, start);
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    return lines.slice(-LOG_TAIL_LINES).join('\n');
  } catch {
    return undefined;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

// Best-effort liveness check on the llama-server port the manager owns. A
// listener on /health 200 (or any HTTP response) means something is up. Tight
// timeout so a hung port doesn't stall the report.
async function probeLlamacppPort(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok || res.status === 503; // 503 = "loading" per llama-server.
  } catch {
    return false;
  }
}

// Pull a GGUF quant tag from a filename (mirrors catalog.ts's logic, kept local
// so we don't widen that module's export surface).
function quantFromName(file: string): string {
  const base = file.replace(/\.gguf$/i, '');
  const q = /\b(Q\d+(?:_[A-Z0-9]+)*|IQ\d+(?:_[A-Z0-9]+)*|F16|BF16|F32)\b/i.exec(base);
  return q ? q[1].toUpperCase() : 'Q4_K_M';
}

function archFromName(name: string): ModelSpec['arch'] {
  const n = name.toLowerCase();
  if (/\bmoe\b/.test(n) || /\d+x\d+\s*b\b/.test(n) || /\d+b-a\d+b/.test(n) || /mixtral/.test(n)) return 'moe';
  if (/qwen/.test(n)) return 'qwen';
  if (/gemma/.test(n)) return 'gemma';
  if (/mistral/.test(n)) return 'mistral';
  if (/phi/.test(n)) return 'phi';
  if (/llama/.test(n)) return 'llama';
  return 'other';
}

// ── Ollama sub-report ───────────────────────────────────────────────────────

async function buildOllamaHealth(): Promise<OllamaHealth> {
  const baseUrl = await getOllamaBase();
  const probe = await probeOllama();
  if (!probe.up) {
    return {
      status: 'warn',
      baseUrl,
      reachable: false,
      modelCount: 0,
      models: [],
      detail: `Ollama daemon not reachable at ${baseUrl}${probe.error ? ` (${probe.error})` : ''}`,
      hint: 'start `ollama serve`, or set settings.ollama.baseUrl if it lives elsewhere',
    };
  }
  const models: ModelHealthModel[] = probe.models.map((name) => {
    const caps = probe.capabilities?.[name];
    const tags: string[] = [];
    if (caps?.tools) tags.push('tools');
    if (caps?.vision) tags.push('vision');
    if (caps?.thinking) tags.push('thinking');
    return { name, ...(tags.length > 0 ? { detail: tags.join(' / ') } : {}) };
  });
  // /api/version is cheap; fetch it best-effort so the panel can show it.
  let version: string | undefined;
  try {
    const res = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = (await res.json()) as { version?: unknown };
      if (typeof data.version === 'string' && data.version.length > 0) version = data.version;
    }
  } catch {
    /* version is optional */
  }
  const empty = models.length === 0;
  return {
    status: empty ? 'warn' : 'ok',
    baseUrl,
    reachable: true,
    modelCount: models.length,
    models,
    ...(version ? { version } : {}),
    detail: empty
      ? `daemon reachable at ${baseUrl} but no models installed`
      : `daemon reachable at ${baseUrl}; ${models.length} model(s) installed`,
    ...(empty ? { hint: 'pull a model via the Cookbook or `ollama pull <name>`' } : {}),
  };
}

// ── llama.cpp sub-report ──────────────────────────────────────────────────────

async function buildLlamacppHealth(): Promise<LlamacppHealth> {
  const binaryPath = await onPath('llama-server');
  const status = llamacppManager.getStatus();
  const { host, port } = llamacppManager.getEndpoint();

  let models: ModelHealthModel[] = [];
  let catalogReadable = true;
  // The failed loadout's configured ctx/ngl, so a DD13 fix can suggest concrete
  // lower values. Found by the loaded alias (the one whose launch failed).
  let failedCtxSize: number | undefined;
  let failedNgl: number | undefined;
  try {
    const catalog = await readLlamacppCatalog();
    models = catalog.models.map((m) => ({ name: m.alias, detail: basename(m.ggufPath) }));
    if (status.alias) {
      const def = catalog.models.find((m) => m.alias === status.alias);
      if (typeof def?.ctxSize === 'number') failedCtxSize = def.ctxSize;
      if (typeof def?.ngl === 'number') failedNgl = def.ngl;
    }
  } catch {
    catalogReadable = false;
  }

  const [lastStderrTail, portReachable] = await Promise.all([
    tailFile(LLAMACPP_LOG),
    status.state === 'ready' && status.port ? probeLlamacppPort(host, status.port) : Promise.resolve(false),
  ]);

  // Roll-up: failed launch is the one `error` case (configured + should work +
  // last launch failed). Missing binary or unreadable catalog is `warn`. idle
  // with no registered models is `warn` (nothing to run). Otherwise ok.
  let rollup: DiagnosticStatus;
  let detail: string;
  let hint: string | undefined;
  // DD13: when the last launch failed, diagnose the stderr tail (falling back to
  // the manager's error string) into a structured cause + one-click fixes.
  let diagnosis: ReturnType<typeof diagnoseLlamacppServeFailure> | undefined;
  if (status.state === 'failed') {
    diagnosis = diagnoseLlamacppServeFailure(lastStderrTail ?? status.error ?? '', {
      ...(typeof failedCtxSize === 'number' ? { currentCtxSize: failedCtxSize } : {}),
      ...(typeof failedNgl === 'number' ? { currentNgl: failedNgl } : {}),
    });
  }

  if (status.state === 'failed') {
    rollup = 'error';
    detail = `last llama-server launch failed: ${status.error ?? 'unknown'}`;
    hint = 'check the last-stderr tail below; verify the GGUF path + flags in ~/.archon/llamacpp.json';
  } else if (!binaryPath) {
    rollup = 'warn';
    detail = `llama-server not on PATH; ${models.length} model(s) registered`;
    hint = 'install llama.cpp (provides llama-server) to use the llama.cpp transport';
  } else if (!catalogReadable) {
    rollup = 'warn';
    detail = `manager ${status.state}; catalog (~/.archon/llamacpp.json) unreadable`;
    hint = 'check ~/.archon/llamacpp.json is valid JSON';
  } else if (models.length === 0) {
    rollup = 'warn';
    detail = 'no models registered in ~/.archon/llamacpp.json';
    hint = 'register a GGUF loadout (the Cookbook auto-registers downloads)';
  } else {
    rollup = 'ok';
    detail =
      status.state === 'ready'
        ? `manager ready (${status.alias ?? '?'} on :${status.port}); ${models.length} model(s) registered`
        : `manager ${status.state}; ${models.length} model(s) registered`;
  }

  return {
    status: rollup,
    binaryPath,
    modelCount: models.length,
    models,
    managerState: status.state,
    ...(status.alias ? { loadedAlias: status.alias } : {}),
    ...(typeof status.port === 'number' ? { port: status.port } : {}),
    ...(typeof status.pid === 'number' ? { pid: status.pid } : {}),
    ...(typeof status.loadedAt === 'number' ? { loadedAt: status.loadedAt } : {}),
    ...(typeof status.lastUsedAt === 'number' ? { lastUsedAt: status.lastUsedAt } : {}),
    ...(status.lastLaunchArgs ? { lastLaunchArgs: status.lastLaunchArgs } : {}),
    ...(lastStderrTail ? { lastStderrTail } : {}),
    ...(status.state === 'ready' ? { portReachable } : {}),
    ...(status.error ? { error: status.error } : {}),
    ...(diagnosis ? { diagnosis } : {}),
    detail,
    ...(hint ? { hint } : {}),
  };
}

// ── Cookbook sub-report ───────────────────────────────────────────────────────

// List GGUF files the Cookbook has downloaded under ~/.archon/models. READ-ONLY
// directory scan; a missing dir is normal (no downloads yet).
async function listDownloadedModels(): Promise<ModelHealthModel[]> {
  const dir = modelsDir();
  let names: string[];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && /\.gguf$/i.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
  const out: ModelHealthModel[] = [];
  for (const name of names) {
    let detail: string | undefined;
    try {
      const st = await fs.stat(join(dir, name));
      detail = fmtBytes(st.size);
    } catch {
      /* size is optional */
    }
    out.push({ name, ...(detail ? { detail } : {}) });
  }
  return out;
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

// Score every registered llama.cpp loadout against the detected hardware; flag
// any whose verdict is NO (won't fit on GPU at a useful context) or TIGHT. This
// reuses the SAME pure scoreFit() the Cookbook catalog uses — no new fit logic.
// A NO verdict is the actionable mismatch the panel warns on; TIGHT is surfaced
// too (little headroom) but kept distinct in the detail string.
function computeFitWarnings(
  registered: ModelHealthModel[],
  catalogSpecs: Array<{ alias: string; spec: ModelSpec }>,
  hw: Awaited<ReturnType<typeof probeHardware>>,
): ModelFitWarning[] {
  const warnings: ModelFitWarning[] = [];
  for (const { alias, spec } of catalogSpecs) {
    const fit = scoreFit(spec, hw);
    if (fit.verdict === 'NO') {
      warnings.push({
        alias,
        verdict: fit.verdict,
        detail: `${alias} (${spec.params || '?'}B ${spec.quant}) won't fit ${fmtBytes(hw.totalVramBytes)} VRAM on GPU — needs ~${fmtBytes(fit.estVramBytes)} (would spill to CPU offload)`,
      });
    } else if (fit.verdict === 'TIGHT') {
      warnings.push({
        alias,
        verdict: fit.verdict,
        detail: `${alias} (${spec.params || '?'}B ${spec.quant}) fits but tight — ~${fmtBytes(fit.estVramBytes)} of ${fmtBytes(hw.totalVramBytes)} VRAM, max ctx ${fit.maxContextThatFits}`,
      });
    }
  }
  void registered; // registered list is surfaced separately; specs drive fit.
  return warnings;
}

async function buildCookbookHealth(): Promise<CookbookHealth> {
  const hw = await probeHardware();
  const downloadedModels = await listDownloadedModels();

  // Derive a ModelSpec per registered llama.cpp loadout from its GGUF basename
  // (params + quant + arch parsed from the filename). The catalog is the
  // authoritative "selected/registered" set the operator can actually launch.
  let catalogSpecs: Array<{ alias: string; spec: ModelSpec }> = [];
  try {
    const catalog = await readLlamacppCatalog();
    catalogSpecs = catalog.models.map((m) => {
      const file = basename(m.ggufPath);
      const spec: ModelSpec = {
        params: parseParams(file) || parseParams(m.alias),
        quant: quantFromName(file),
        arch: archFromName(file + ' ' + m.alias),
        ...(typeof m.ctxSize === 'number' && m.ctxSize > 0 ? { contextMax: m.ctxSize } : {}),
      };
      return { alias: m.alias, spec };
    });
  } catch {
    /* unreadable catalog → no fit scoring; downloaded list still reported */
  }

  const fitWarnings = computeFitWarnings(downloadedModels, catalogSpecs, hw);

  // Roll-up: a fit mismatch is the actionable `warn` (a registered model the
  // operator can't actually run well on this box). Otherwise ok. No hardware is
  // never an error here — probeHardware always returns a (CPU-fallback) profile.
  const rollup: DiagnosticStatus = fitWarnings.length > 0 ? 'warn' : 'ok';
  const vram = hw.totalVramBytes > 0 ? `${fmtBytes(hw.totalVramBytes)} VRAM across ${hw.gpus.length} GPU(s)` : 'no GPU (CPU/Metal)';
  const detail =
    fitWarnings.length > 0
      ? `${hw.backend} backend, ${vram}; ${fitWarnings.length} registered model(s) don't fit cleanly`
      : `${hw.backend} backend, ${vram}; ${downloadedModels.length} downloaded GGUF(s), ${catalogSpecs.length} registered`;
  const hint =
    fitWarnings.length > 0
      ? 'pick a smaller quant / model that fits this hardware, or accept CPU offload (slow)'
      : undefined;

  return {
    status: rollup,
    hardware: hw,
    downloadedModelCount: downloadedModels.length,
    downloadedModels,
    fitWarnings,
    detail,
    ...(hint ? { hint } : {}),
  };
}

// ── public builder ─────────────────────────────────────────────────────────────

// Wrap a sub-report builder so a thrown probe degrades to a `warn` sub-report
// rather than failing the whole call. The fallback carries the error message.
async function safe<T extends { status: DiagnosticStatus; detail: string }>(
  fn: () => Promise<T>,
  fallback: (message: string) => T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return fallback(err instanceof Error ? err.message : String(err));
  }
}

export async function buildModelHealthReport(): Promise<ModelHealthReport> {
  const [ollama, llamacpp, cookbook] = await Promise.all([
    safe(buildOllamaHealth, (message) => ({
      status: 'warn' as const,
      baseUrl: 'unknown',
      reachable: false,
      modelCount: 0,
      models: [],
      detail: `Ollama health probe degraded: ${message}`,
    })),
    safe(buildLlamacppHealth, (message) => ({
      status: 'warn' as const,
      binaryPath: null,
      modelCount: 0,
      models: [],
      managerState: 'idle' as const,
      detail: `llama.cpp health probe degraded: ${message}`,
    })),
    safe(buildCookbookHealth, (message) => ({
      status: 'warn' as const,
      hardware: { gpus: [], totalVramBytes: 0, systemRamBytes: 0, cores: 0, backend: 'cpu' as const },
      downloadedModelCount: 0,
      downloadedModels: [],
      fitWarnings: [],
      detail: `Cookbook health probe degraded: ${message}`,
    })),
  ]);

  return {
    ollama,
    llamacpp,
    cookbook,
    generatedAt: Date.now(),
    platform: `${platform()}/${arch()}`,
  };
}
