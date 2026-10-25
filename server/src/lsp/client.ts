// Minimal LSP stdio client + per-(cwd, languageId) lifecycle manager
// (WORKBENCH_EXPANSION_PLAN.md §C3).
//
// We only need the diagnostics slice of LSP: spawn the server, handshake
// (initialize → initialized), didOpen the changed file, and forward the
// server's `textDocument/publishDiagnostics` notifications as Archon
// `diagnostics` protocol messages. We do NOT implement completion, hover,
// formatting, etc.
//
// Lifecycle discipline mirrors server/src/providers/llamacppManager.ts:
//   • one server process per (cwd, languageId) key, lazy-spawned on first use
//   • concurrent ensure() callers for the same key de-dup onto one spawn
//   • idle timer evicts a server unused for N minutes (SIGTERM → SIGKILL fuse)
//   • shutdown() kills every live server (wired from the SIGTERM/SIGINT hook)
//
// Orphan safety: language servers are spawned children WITHOUT `detached`, so
// they die with the Node process on a clean exit; shutdown() additionally
// SIGTERMs them so a graceful shutdown reaps them deterministically. We do NOT
// add a durable pid-registry + boot-sweep here (unlike the worker subprocesses
// in pidRegistry.ts) — see docs/GOTCHAS.md § LSP for the noted orphan gap: a
// hard `kill -9` of the Node server can leak an LSP child until the OS reaps
// it. Acceptable for a best-effort diagnostics subsystem; the worker token-
// burning processes are the ones that warrant the durable registry.
//
// 0-based → 1-based: LSP positions are 0-based (line + character). Archon's UI
// is 1-based. The single conversion point is `mapPublishDiagnostics` below
// (line/column = lspRange.start.line + 1 / .character + 1). Everything that
// crosses the protocol wire is already 1-based.

import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { relative, isAbsolute, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import type { DiagnosticItem, DiagnosticsMessage, DiagnosticSeverity } from '@archon/shared';
import { resolveServer, languageIdForPath, type ResolvedServer } from './servers.js';

// ── Pure: message framing (the bug-prone core; unit-tested by the smoke) ──

// An LSP message decoded off the stream. We only care about its `method` (for
// notifications) and `params` / `id` / `result`.
export interface LspMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

// Incremental frame reader for the LSP wire format:
//   Content-Length: <n>\r\n
//   \r\n
//   <n bytes of JSON>
// A single JSON message can arrive split across multiple `data` chunks, and
// multiple messages can arrive in one chunk — so we buffer bytes and only
// emit a message once we have its full Content-Length payload. Operates on
// Buffers throughout so a multibyte UTF-8 char split across a chunk boundary
// is counted by bytes (Content-Length is a BYTE count), not by JS string
// length.
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  // Append a chunk; return every complete message it now completes (possibly
  // zero, possibly several). Malformed JSON in a complete frame is skipped
  // (returned as no message) rather than throwing, so one bad frame can't wedge
  // the reader.
  push(chunk: Buffer): LspMessage[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: LspMessage[] = [];
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) break; // headers not fully arrived yet
      const header = this.buf.subarray(0, headerEnd).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // No Content-Length in this header block — unrecoverable framing; drop
        // up to and including the header terminator and resync.
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buf.length - bodyStart < len) break; // body not fully arrived
      const body = this.buf.subarray(bodyStart, bodyStart + len).toString('utf8');
      this.buf = this.buf.subarray(bodyStart + len);
      try {
        out.push(JSON.parse(body) as LspMessage);
      } catch {
        /* skip malformed frame, keep parsing the rest of the buffer */
      }
    }
    return out;
  }
}

// Encode an LSP message to a Content-Length-framed Buffer for stdin.
export function encodeMessage(msg: unknown): Buffer {
  const json = JSON.stringify(msg);
  const body = Buffer.from(json, 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

// ── Pure: publishDiagnostics → DiagnosticsMessage (the 0→1 conversion point) ──

// LSP DiagnosticSeverity: 1=Error 2=Warning 3=Information 4=Hint.
function mapSeverity(n: number | undefined): DiagnosticSeverity {
  switch (n) {
    case 1: return 'error';
    case 2: return 'warning';
    case 3: return 'info';
    case 4: return 'hint';
    default: return 'error'; // LSP says absent severity = client decides; treat as error (most actionable)
  }
}

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
}
interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: LspDiagnostic[];
}

// Convert a publishDiagnostics notification's params into the protocol message.
// THIS is the single 0-based→1-based conversion boundary: LSP line/character
// are 0-based, so we add 1 to each. `cwd` makes `file` cwd-relative for the UI.
export function mapPublishDiagnostics(
  params: PublishDiagnosticsParams,
  cwd: string,
  workflowId: string,
): DiagnosticsMessage {
  const abs = fileUriToPath(params.uri);
  const rel = abs && isAbsolute(abs) ? relative(cwd, abs) : (abs ?? params.uri);
  const items: DiagnosticItem[] = (params.diagnostics ?? []).map((d) => ({
    severity: mapSeverity(d.severity),
    message: d.message,
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    endLine: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    source: d.source,
    code: d.code,
  }));
  return { type: 'diagnostics', workflowId, file: rel, items };
}

// file:// URI → absolute path. Tolerant of non-file URIs (returns null).
function fileUriToPath(uri: string): string | null {
  try {
    if (!uri.startsWith('file:')) return null;
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

// ── Lifecycle manager ──

const IDLE_EVICT_MS = (() => {
  const env = process.env.ARCHON_LSP_KEEPALIVE_MS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 5 * 60 * 1000; // 5 minutes idle → evict
})();

const INIT_TIMEOUT_MS = 20_000; // initialize handshake budget

interface ServerEntry {
  key: string;
  cwd: string;
  languageId: string;
  child: ChildProcess;
  reader: FrameReader;
  nextId: number;
  // Resolves when the initialize response arrives.
  ready: Promise<void>;
  initialized: boolean;
  lastUsedAt: number;
  // Doc versions per opened file URI (LSP wants monotonic versions on change).
  openDocs: Map<string, number>;
}

export interface DiagnosticsSink {
  (msg: DiagnosticsMessage): void;
}

class LspManager extends EventEmitter {
  // Keyed by `${cwd}\0${languageId}`.
  private servers = new Map<string, ServerEntry>();
  // De-dup concurrent spawns for the same key.
  private pending = new Map<string, Promise<ServerEntry | null>>();
  // Per-(workflow) diagnostics sink, set by the worker hook each call. Keyed by
  // server key so each server forwards to the right workflow's broadcast.
  private sinks = new Map<string, { workflowId: string; sink: DiagnosticsSink }>();
  private idleTimer: NodeJS.Timeout | null = null;

  // Public entry point from the Native write hook. Fire-and-forget: the caller
  // never awaits this and any throw is swallowed at the call site, but we also
  // catch internally so a spawn failure can't reject into an unhandled promise.
  // `absPath` is the just-written file; `cwd` the workflow root; `workflowId`
  // for the broadcast.
  async notifyWritten(absPath: string, cwd: string, workflowId: string, sink: DiagnosticsSink): Promise<void> {
    try {
      const languageId = languageIdForPath(absPath);
      if (!languageId) return; // unsupported language → no-op
      const entry = await this.ensure(cwd, languageId);
      if (!entry) return; // no server installed → graceful no-op
      this.sinks.set(entry.key, { workflowId, sink });
      await entry.ready;
      entry.lastUsedAt = Date.now();
      this.armIdleTimer();
      await this.openOrChange(entry, absPath);
    } catch (err) {
      // Best-effort: diagnostics never break the write path. Surface for logs.
      this.emit('error', err instanceof Error ? err.message : String(err));
    }
  }

  // Lazy-spawn (or reuse) the server for (cwd, languageId). Concurrent callers
  // share one spawn via the pending map. Returns null if no server installed.
  private async ensure(cwd: string, languageId: string): Promise<ServerEntry | null> {
    const key = `${resolve(cwd)}\0${languageId}`;
    const existing = this.servers.get(key);
    if (existing && existing.child.exitCode === null && existing.child.signalCode === null) {
      return existing;
    }
    const inflight = this.pending.get(key);
    if (inflight) return inflight;

    const p = this.doSpawn(key, cwd, languageId).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, p);
    return p;
  }

  private async doSpawn(key: string, cwd: string, languageId: string): Promise<ServerEntry | null> {
    // resolveServer takes a path; synthesize one with a representative ext so
    // the registry maps to this languageId. We already know languageId, so we
    // ask the registry by re-deriving from a sample path is unnecessary — but
    // resolveServer is the single detection+candidate source of truth, so feed
    // it a path that maps to this languageId.
    const samplePath = samplePathForLanguage(languageId, cwd);
    const server: ResolvedServer | null = samplePath ? await resolveServer(samplePath) : null;
    if (!server) return null;

    const child = spawn(server.cmd, server.args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const reader = new FrameReader();
    let resolveReady!: () => void;
    let rejectReady!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej; });

    const entry: ServerEntry = {
      key, cwd, languageId, child, reader,
      nextId: 1, ready, initialized: false,
      lastUsedAt: Date.now(),
      openDocs: new Map(),
    };
    this.servers.set(key, entry);

    const initId = entry.nextId++;
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const msg of reader.push(chunk)) {
        this.onMessage(entry, msg, initId, resolveReady);
      }
    });
    child.stderr?.on('data', () => { /* swallow; servers are chatty on stderr */ });
    child.once('error', (e) => { rejectReady(e instanceof Error ? e : new Error(String(e))); this.dropServer(key); });
    child.once('exit', () => {
      // If it exits before initialize resolves, unblock waiters with a reject so
      // notifyWritten's await doesn't hang.
      if (!entry.initialized) { try { rejectReady(new Error('LSP server exited before initialize')); } catch { /* already settled */ } }
      this.dropServer(key);
    });

    // Send initialize. capabilities advertise publishDiagnostics support.
    const initParams = {
      processId: process.pid,
      rootUri: pathToFileURL(resolve(cwd)).href,
      rootPath: resolve(cwd),
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: false },
          synchronization: { didSave: true, dynamicRegistration: false },
        },
      },
      workspaceFolders: [{ uri: pathToFileURL(resolve(cwd)).href, name: 'archon' }],
    };
    this.send(entry, { jsonrpc: '2.0', id: initId, method: 'initialize', params: initParams });

    // Init timeout fuse so a hung server doesn't pin notifyWritten forever.
    const timer = setTimeout(() => {
      if (!entry.initialized) { try { rejectReady(new Error('LSP initialize timed out')); } catch { /* settled */ } this.killEntry(entry, 'initialize timeout'); }
    }, INIT_TIMEOUT_MS);
    timer.unref();
    ready.finally(() => clearTimeout(timer)).catch(() => { /* reject path */ });

    try {
      await ready;
    } catch {
      return null; // spawn/init failed → graceful no-op
    }
    this.armIdleTimer();
    return entry;
  }

  private onMessage(entry: ServerEntry, msg: LspMessage, initId: number, resolveReady: () => void): void {
    // initialize response → send initialized, mark ready.
    if (msg.id === initId && msg.result !== undefined && !entry.initialized) {
      entry.initialized = true;
      this.send(entry, { jsonrpc: '2.0', method: 'initialized', params: {} });
      resolveReady();
      return;
    }
    // server→client publishDiagnostics notification.
    if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
      const sinkEntry = this.sinks.get(entry.key);
      if (!sinkEntry) return;
      try {
        const out = mapPublishDiagnostics(msg.params as PublishDiagnosticsParams, entry.cwd, sinkEntry.workflowId);
        sinkEntry.sink(out);
      } catch (err) {
        this.emit('error', err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Open the doc (or close+reopen on subsequent writes — simplest correct path
  // for re-triggering a fresh diagnostics pass). Reads the file off disk.
  private async openOrChange(entry: ServerEntry, absPath: string): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(absPath, 'utf8');
    } catch {
      return; // file vanished between write and read — nothing to diagnose
    }
    const uri = pathToFileURL(absPath).href;
    const languageId = languageIdForPath(absPath) ?? entry.languageId;
    if (entry.openDocs.has(uri)) {
      // close then reopen: forces the server to re-publish for this doc without
      // tracking incremental ranges.
      this.send(entry, { jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } });
    }
    const version = (entry.openDocs.get(uri) ?? 0) + 1;
    entry.openDocs.set(uri, version);
    this.send(entry, {
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId, version, text } },
    });
  }

  private send(entry: ServerEntry, msg: unknown): void {
    if (!entry.child.stdin || entry.child.stdin.destroyed) return;
    try { entry.child.stdin.write(encodeMessage(msg)); } catch { /* stdin closed */ }
  }

  private dropServer(key: string): void {
    this.servers.delete(key);
    this.sinks.delete(key);
  }

  private armIdleTimer(): void {
    if (this.idleTimer) return; // single shared sweeper
    if (IDLE_EVICT_MS <= 0) return; // opt-out: keep servers forever
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const entry of [...this.servers.values()]) {
        if (now - entry.lastUsedAt >= IDLE_EVICT_MS) {
          this.killEntry(entry, `idle for ${Math.round((now - entry.lastUsedAt) / 1000)}s`);
        }
      }
      if (this.servers.size === 0 && this.idleTimer) {
        clearInterval(this.idleTimer);
        this.idleTimer = null;
      }
    }, Math.max(30_000, Math.floor(IDLE_EVICT_MS / 4)));
    this.idleTimer.unref();
  }

  private killEntry(entry: ServerEntry, reason: string): void {
    this.dropServer(entry.key);
    const child = entry.child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    // Try a graceful LSP shutdown first, then SIGTERM, then a SIGKILL fuse.
    try { this.send(entry, { jsonrpc: '2.0', id: entry.nextId++, method: 'shutdown', params: null }); } catch { /* ignore */ }
    try { this.send(entry, { jsonrpc: '2.0', method: 'exit' }); } catch { /* ignore */ }
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    t.unref();
    this.emit('reaped', { key: entry.key, reason });
  }

  // SIGTERM/SIGINT hook from server bootstrap: kill every live server.
  shutdown(): void {
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
    for (const entry of [...this.servers.values()]) {
      this.dropServer(entry.key);
      const child = entry.child;
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
  }

  // Introspection for tests/diagnostics.
  liveCount(): number { return this.servers.size; }
}

// Pick a representative file path for a languageId so resolveServer (which keys
// off extension) maps to the right candidate set.
const LANGUAGE_SAMPLE_EXT: Record<string, string> = {
  typescript: '.ts', typescriptreact: '.tsx',
  javascript: '.js', javascriptreact: '.jsx',
  python: '.py', go: '.go', rust: '.rs',
};

function samplePathForLanguage(languageId: string, cwd: string): string | null {
  const ext = LANGUAGE_SAMPLE_EXT[languageId];
  if (!ext) return null;
  return resolve(cwd, `__archon_lsp_probe__${ext}`);
}

// Module-level singleton (mirrors llamacppManager). Importers share one.
export const lspManager = new LspManager();
