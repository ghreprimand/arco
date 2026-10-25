// ── Guarded Demucs stem-separation runner (Arco Ops §N4) ──
//
// True AI source separation (vocals / drums / bass / other, or a two-stems
// karaoke split) via the local **Demucs** CLI. Separate from the ffmpeg wrapper:
// it's a long-running, GPU-accelerated job that emits MULTIPLE output files, so
// it has its own runner + request/result shapes — but it reuses the SAME N2
// access fence (`resolveMediaInput` / `resolveMediaOutputDir` from ./ffmpeg).
//
// ── Four-question test (CLAUDE.md) ──
//   1. Operator-initiated — only on an explicit POST /api/media/stems click.
//   2. Deterministic & bounded — argv is built from WHITELISTED enums (model /
//      stem / format); no operator string reaches a flag or a path.
//   3. Visible — the route broadcasts media_stems_result (→ events.jsonl).
//   4. Reversible — output is a FRESH uniquified dir of NEW files; the source is
//      never touched; a cancel/failure rm's the whole fresh dir (no partials).
//
// ── Hard fences ──
//   • spawn WITH AN ARGV ARRAY ONLY — fixed literal binary 'demucs', every arg a
//     separate element. No shell, no interpolation.
//   • Input + output dir gated by the N2 fence (cwd | scratch | unconfined).
//   • Output lands in a FRESH `<stem>.stems[-N]/` dir we create — never an
//     existing path, never the source. Cancel/fail removes that whole dir.

import { spawn } from 'child_process';
import { promises as fs, constants as fsConstants } from 'fs';
import path from 'path';
import os from 'os';
import {
  STEM_MODELS,
  STEM_NAMES,
  STEM_FORMATS,
  type StemModel,
  type StemName,
  type StemFormat,
  type MediaStemsErrorCode,
  type MediaStemFile,
  type MediaStemsResult,
} from '@arco/shared';
import { resolveMediaInput, resolveMediaOutputDir, MediaOpError, type MediaAccess } from './ffmpeg.js';

const DEMUCS_BIN = 'demucs';
const DEFAULT_MODEL: StemModel = 'htdemucs';
const DEFAULT_FORMAT: StemFormat = 'mp3';

// A typed error so the route can branch on `code`.
export class DemucsError extends Error {
  code: MediaStemsErrorCode;
  constructor(code: MediaStemsErrorCode, message: string) {
    super(message);
    this.name = 'DemucsError';
    this.code = code;
  }
}

// ── Presence (cached) ────────────────────────────────────────────────────────
//
// A PATH scan, NOT a spawn: `demucs --help` imports torch (slow, seconds), so we
// just check the executable is resolvable. A server restart re-probes (install
// during a session is rare; restart is the documented recovery). POSIX X_OK
// check — on Windows the windows-port worktree would append PATHEXT (flagged).
let demucsAvailableCache: boolean | undefined;

export async function demucsAvailable(): Promise<boolean> {
  if (demucsAvailableCache !== undefined) return demucsAvailableCache;
  demucsAvailableCache = await binaryOnPath(DEMUCS_BIN);
  return demucsAvailableCache;
}

// Test seam: reset the cache (the smoke doesn't need it, but mirrors ffmpeg).
export function __resetDemucsCache(): void {
  demucsAvailableCache = undefined;
}

async function binaryOnPath(name: string): Promise<boolean> {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  // Common pip --user location isn't always on a non-interactive PATH; include it.
  dirs.push(path.join(os.homedir(), '.local', 'bin'));
  for (const dir of dirs) {
    try {
      await fs.access(path.join(dir, name), fsConstants.X_OK);
      return true;
    } catch {
      /* not here — keep scanning */
    }
  }
  return false;
}

// ── PURE: spec validation ────────────────────────────────────────────────────
// Reject a malformed request BEFORE building args. Returns null or a reason.
export function validateStemsSpec(spec: {
  model?: string;
  twoStems?: string;
  format?: string;
}): string | null {
  if (spec.model !== undefined && !(STEM_MODELS as readonly string[]).includes(spec.model)) {
    return `unknown model "${spec.model}"`;
  }
  if (spec.twoStems !== undefined && !(STEM_NAMES as readonly string[]).includes(spec.twoStems)) {
    return `unknown two-stems target "${spec.twoStems}"`;
  }
  if (spec.format !== undefined && !(STEM_FORMATS as readonly string[]).includes(spec.format)) {
    return `unknown format "${spec.format}"`;
  }
  return null;
}

// ── PURE: the security-critical arg builder ──────────────────────────────────
//
// Map whitelisted enums + resolved paths → demucs argv. No operator string is
// concatenated: model/stem/format come from the whitelists; outDir + inputAbs are
// the already-gated absolute paths. `--filename {stem}.{ext}` writes one file per
// stem (under demucs's forced `<model>/` subdir, which runDemucsStems flattens).
// CALL validateStemsSpec FIRST.
export function buildDemucsArgs(
  model: StemModel,
  twoStems: StemName | undefined,
  format: StemFormat,
  outDir: string,
  inputAbs: string,
): string[] {
  const args = ['-o', outDir, '-n', model, '--filename', '{stem}.{ext}'];
  if (format === 'mp3') args.push('--mp3');
  else if (format === 'flac') args.push('--flac');
  // wav is the demucs default (no flag) — but see the STEM_FORMATS note re torchcodec.
  if (twoStems) args.push('--two-stems', twoStems);
  args.push(inputAbs); // positional track — MUST be last.
  return args;
}

export interface RunDemucsOpts {
  signal?: AbortSignal;
  unconfined?: boolean;
  allowedRoots?: string[];
  model?: StemModel;
  twoStems?: StemName;
  format?: StemFormat;
  output?: { dir?: string };
}

// ── runDemucsStems — gate, fresh-dir, run, flatten, collect ──────────────────
export async function runDemucsStems(
  cwd: string,
  inputPath: string,
  opts: RunDemucsOpts = {},
): Promise<MediaStemsResult> {
  // 1. Validate the whitelisted enums.
  const specErr = validateStemsSpec({ model: opts.model, twoStems: opts.twoStems, format: opts.format });
  if (specErr) throw new DemucsError('bad-spec', specErr);

  const model = opts.model ?? DEFAULT_MODEL;
  const format = opts.format ?? DEFAULT_FORMAT;
  const access: MediaAccess = { cwd: cwd || undefined, unconfined: opts.unconfined ?? false, allowedRoots: opts.allowedRoots };

  // 2. Resolve + gate the INPUT (cwd | scratch | unconfined). The shared resolver
  //    throws a MediaOpError('bad-path'); re-key it as a DemucsError so the route
  //    returns a structured 200, not a 500.
  const inputAbs = gateOrThrow(() => resolveMediaInput(access, inputPath));

  // 3. Confirm the input exists + is a file.
  try {
    const st = await fs.stat(inputAbs);
    if (!st.isFile()) throw new DemucsError('input-missing', `"${inputPath}" is not a file`);
  } catch (err) {
    if (err instanceof DemucsError) throw err;
    throw new DemucsError('input-missing', `input not found: ${inputPath}`);
  }

  // 4. demucs present? (Graceful structured failure.)
  if (!(await demucsAvailable())) {
    throw new DemucsError(
      'demucs-missing',
      'demucs is not on PATH. Install it with the system package manager (see docs/OPERATIONS.md § Demucs); never curl|sh.',
    );
  }

  // 5. Resolve + gate the output PARENT dir (same tiers); must exist.
  const parent = gateOrThrow(() => resolveMediaOutputDir(access, opts.output?.dir, inputAbs));
  if (opts.output?.dir) {
    try {
      const dst = await fs.stat(parent);
      if (!dst.isDirectory()) throw new DemucsError('output-dir-missing', `output destination "${parent}" is not a directory`);
    } catch (err) {
      if (err instanceof DemucsError) throw err;
      throw new DemucsError('output-dir-missing', `output directory does not exist: ${parent}`);
    }
  }

  // 6. Create a FRESH uniquified subdir so a run never clobbers a prior one or
  //    the source. We own it ⇒ a cancel/failure can rm it whole, safely.
  const stem = path.basename(inputAbs, path.extname(inputAbs));
  const stemsDir = await freshDir(parent, `${stem}.stems`);

  // 7. Build argv + run demucs (spawn, argv array, no shell), wired to cancel.
  const args = buildDemucsArgs(model, opts.twoStems, format, stemsDir, inputAbs);
  try {
    await runDemucs(args, opts.signal);
  } catch (err) {
    await rmDir(stemsDir); // no partials are ever returned as success
    if (opts.signal?.aborted || err instanceof AbortError) {
      throw new DemucsError('cancelled', 'stem separation cancelled');
    }
    const msg = err instanceof Error ? err.message : String(err);
    // The common box-specific failure: torchaudio routes wav/flac saves through
    // TorchCodec, which may be absent. Point the operator at the working path.
    if (/torchcodec/i.test(msg)) {
      throw new DemucsError('demucs-failed', `demucs could not write ${format} (this torchaudio build needs the "torchcodec" package for wav/flac — use mp3, or add torchcodec with the system package manager). ${msg}`);
    }
    throw new DemucsError('demucs-failed', msg);
  }

  // 8. demucs wrote into stemsDir/<model>/ — flatten up to stemsDir, collect.
  const stems = await flattenAndCollect(stemsDir, cwd);
  if (stems.length === 0) {
    await rmDir(stemsDir);
    throw new DemucsError('demucs-failed', 'demucs produced no stem files');
  }

  let relDir = '';
  if (cwd) {
    const rel = path.relative(path.resolve(cwd), stemsDir);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) relDir = rel;
  }
  return { ok: true, model, dir: stemsDir, ...(relDir ? { relDir } : {}), stems };
}

// Move every file out of demucs's forced `<model>/` subdir up into `stemsDir`,
// then remove the now-empty subdir. Returns the collected stem files. Demucs
// creates exactly one model subdir; we read it back rather than assume its name.
async function flattenAndCollect(stemsDir: string, cwd: string): Promise<MediaStemFile[]> {
  const entries = await fs.readdir(stemsDir, { withFileTypes: true });
  const sub = entries.find((e) => e.isDirectory());
  const fromDir = sub ? path.join(stemsDir, sub.name) : stemsDir;

  const files = (await fs.readdir(fromDir, { withFileTypes: true })).filter((e) => e.isFile());
  const out: MediaStemFile[] = [];
  for (const f of files) {
    const dest = path.join(stemsDir, f.name);
    if (fromDir !== stemsDir) {
      try { await fs.rename(path.join(fromDir, f.name), dest); }
      catch { await fs.copyFile(path.join(fromDir, f.name), dest); }
    }
    const name = path.basename(f.name, path.extname(f.name));
    let relPath: string | undefined;
    if (cwd) {
      const rel = path.relative(path.resolve(cwd), dest);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) relPath = rel;
    }
    out.push({ name, path: dest, ...(relPath ? { relPath } : {}) });
  }
  if (sub && fromDir !== stemsDir) {
    try { await fs.rmdir(fromDir); } catch { /* non-empty / gone — leave it */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// mkdir a fresh `<base>` (then `<base>-2`, `-3`, …) under `parent`. Bounded loop.
async function freshDir(parent: string, base: string): Promise<string> {
  for (let n = 1; n < 10000; n++) {
    const candidate = path.join(parent, n === 1 ? base : `${base}-${n}`);
    try {
      await fs.mkdir(candidate, { recursive: false });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  // Pathological fallback.
  const fallback = path.join(parent, `${base}-${Date.now().toString(36)}`);
  await fs.mkdir(fallback, { recursive: true });
  return fallback;
}

// Run a shared-resolver gate, re-keying its MediaOpError('bad-path') into a
// DemucsError so the route's `instanceof DemucsError` branch handles it (a
// structured 200), not the unexpected-bug 500 path.
function gateOrThrow(fn: () => string): string {
  try {
    return fn();
  } catch (err) {
    if (err instanceof MediaOpError) {
      const code = err.code === 'input-missing' || err.code === 'output-dir-missing' ? err.code : 'bad-path';
      throw new DemucsError(code, err.message);
    }
    throw err;
  }
}

async function rmDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[arco] demucs: failed to clean ${dir}:`, err instanceof Error ? err.message : err);
  }
}

// Run demucs with an argv array; resolve on exit 0, reject with a bounded stderr
// tail otherwise. The AbortSignal SIGKILLs the child (route wires req-close →
// abort). No timeout — a long separation is normal; cancel is the escape hatch.
function runDemucs(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    // spawn, fixed literal binary, argv array — NO shell, NO interpolation.
    const child = spawn(DEMUCS_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    child.stderr?.on('data', (d) => {
      tail = (tail + d.toString()).slice(-4096); // bounded — progress bars are noisy
    });
    child.on('error', (err) => reject(err)); // e.g. ENOENT
    child.on('close', (code) => {
      if (signal?.aborted) return reject(new AbortError());
      if (code === 0) return resolve();
      reject(new Error(tail.trim().split('\n').slice(-6).join('\n') || `demucs exited ${code}`));
    });
    if (signal) {
      const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

class AbortError extends Error {
  constructor() { super('aborted'); this.name = 'AbortError'; }
}
