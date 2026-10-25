// ARCHON_OPS_PLAN.md §B3 — structured file logging with size-based rotation.
//
// WHY a console tee, not call-site migration: server/src has 378 console.*
// call sites. Rather than rewrite them, initFileLogging() monkeypatches
// console.log/warn/error so each call (a) still writes to stdout/stderr — so
// systemd/journald keeps capturing it unchanged — and (b) appends one structured
// JSONL line to a rotated Archon-owned file. The file is the portable/structured
// complement to journald (works on macOS, greppable, bounded).
//
// WHY file output is gated on an env flag: with neither ARCHON_LOG_FILE nor
// ARCHON_LOG_DIR set (the default, incl. `npm run dev`), no structured file is
// written. The lightweight console wrapper is still installed because strict
// incognito must suppress stdout/stderr even in a redirected dev process.
//
// WHY best-effort: a logging failure must never crash the server, so every write
// path is wrapped — a broken disk degrades to "no file line", not a dead process.
//
// WHY rotation: bounds disk use under a long-lived service (5 MB × 5 files default).

import { appendFileSync, mkdirSync, statSync, renameSync, rmSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';

export interface FileLoggerOptions {
  dir: string;
  maxBytes?: number;
  keep?: number;
  fileName?: string;
}

export interface FileLogger {
  write(level: string, msg: string, fields?: Record<string, unknown>): void;
  path: string;
  close(): void;
  bytesWritten(): number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 5;
const DEFAULT_FILE_NAME = 'archon.log';

// Testable factory. Appends one JSON line per write with synchronous
// appendFileSync (so a line is on disk — and immediately readable — the instant
// write() returns; no stream-flush race). Rotates when the running byte counter
// would cross maxBytes. The counter is SEEDED from the existing file's size on
// open (so a restart doesn't reset rotation accounting), 0 if absent. Never
// throws out of write().
export function createFileLogger(opts: FileLoggerOptions): FileLogger {
  const maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES;
  const keep = opts.keep && opts.keep > 0 ? opts.keep : DEFAULT_KEEP;
  const fileName = opts.fileName || DEFAULT_FILE_NAME;
  const path = join(opts.dir, fileName);

  let bytes = 0;
  let dead = false; // set if dir creation fails irrecoverably — degrade to no-op

  try {
    mkdirSync(opts.dir, { recursive: true });
    try {
      bytes = statSync(path).size; // seed from existing file, 0 if absent
    } catch {
      bytes = 0;
    }
  } catch {
    dead = true;
  }

  // Shift archon.log.(keep-1)→drop … archon.log.1→archon.log.2, archon.log→.1,
  // then reset the counter (the next appendFileSync re-creates archon.log).
  function rotate(): void {
    try {
      rmSync(`${path}.${keep}`, { force: true });
    } catch { /* best-effort */ }
    for (let i = keep - 1; i >= 1; i--) {
      try {
        renameSync(`${path}.${i}`, `${path}.${i + 1}`);
      } catch { /* missing intermediate → nothing to shift */ }
    }
    try {
      renameSync(path, `${path}.1`);
    } catch { /* live file missing → nothing to move */ }
    bytes = 0;
  }

  return {
    path,
    bytesWritten: () => bytes,
    write(level, msg, fields) {
      if (dead) return;
      try {
        const rec: Record<string, unknown> = {
          ts: new Date().toISOString(),
          level,
          msg,
          ...(fields ?? {}),
        };
        const line = JSON.stringify(rec) + '\n';
        const len = Buffer.byteLength(line);
        // Rotate when this write would push us past the cap (but always keep at
        // least one line in a fresh file even if a single line exceeds maxBytes).
        if (bytes > 0 && bytes + len > maxBytes) rotate();
        appendFileSync(path, line);
        bytes += len;
      } catch {
        // best-effort — a logging failure must never propagate to the caller
      }
    },
    close() {
      // appendFileSync holds no persistent handle — nothing to flush/close.
    },
  };
}

// ── production console tee ──────────────────────────────────────────────────

let installed = false;
let fileLoggingEnabled = false;
let singleton: FileLogger | null = null;
let activePath: string | null = null;

// Strict-incognito boundary. AsyncLocalStorage suppresses logs emitted anywhere
// in an incognito create/turn promise tree (including provider callbacks). The
// token set is a second fence for delayed callbacks whose async context was
// detached by a library: an incognito workflow/worker id must never reach
// stdout, journald, or Archon's structured log. Tokens intentionally live only
// for this process lifetime and are never removed; late post-close callbacks
// therefore remain private too.
const logSuppression = new AsyncLocalStorage<boolean>();
const privateLogTokens = new Set<string>();

export function withoutOperationalLogging<T>(fn: () => T): T {
  return logSuppression.run(true, fn);
}

export function registerPrivateLogToken(token: string | undefined): void {
  if (!token) return;
  privateLogTokens.add(token);
  if (token.length >= 8) privateLogTokens.add(token.slice(0, 8));
}

export function shouldSuppressOperationalLog(message: string): boolean {
  if (logSuppression.getStore() === true) return true;
  for (const token of privateLogTokens) {
    if (message.includes(token)) return true;
  }
  return false;
}

function resolveNum(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Production entry. Returns false (and does nothing) unless file logging is
// requested via ARCHON_LOG_FILE=1 or an explicit ARCHON_LOG_DIR. Otherwise
// creates the singleton logger and monkeypatches console.log/warn/error so each
// call preserves stdout AND emits a structured line. Idempotent.
export function initFileLogging(): boolean {
  if (installed) return fileLoggingEnabled;
  const enabled = process.env.ARCHON_LOG_FILE === '1' || !!(process.env.ARCHON_LOG_DIR && process.env.ARCHON_LOG_DIR.trim());
  fileLoggingEnabled = enabled;
  const maxBytes = resolveNum('ARCHON_LOG_MAX_BYTES', DEFAULT_MAX_BYTES);
  const keep = resolveNum('ARCHON_LOG_KEEP', DEFAULT_KEEP);
  if (enabled) {
    const dir = process.env.ARCHON_LOG_DIR && process.env.ARCHON_LOG_DIR.trim()
      ? process.env.ARCHON_LOG_DIR
      : join(homedir(), '.archon', 'logs');
    singleton = createFileLogger({ dir, maxBytes, keep });
    activePath = singleton.path;
  }

  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const tee = (level: string, original: (...a: unknown[]) => void) => (...args: unknown[]) => {
    const message = format(...args);
    if (shouldSuppressOperationalLog(message)) return;
    original(...args); // stdout/stderr preserved → journald still captures
    singleton?.write(level, message);
  };
  console.log = tee('info', orig.log);
  console.warn = tee('warn', orig.warn);
  console.error = tee('error', orig.error);

  installed = true;
  if (enabled) {
    // Use the patched console so this startup line lands in the file too.
    console.log(`[archon] structured file logging → ${activePath} (max ${maxBytes}B × ${keep})`);
  }
  return enabled;
}

// Active log file path, or null when file logging is off. Used by the CLI and
// the core.logs diagnostics check.
export function getLogFilePath(): string | null {
  return activePath;
}
