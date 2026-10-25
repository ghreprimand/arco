// ── Guarded FFmpeg audio-op wrapper (Workbench Expansion §H6) ──
//
// Server-side audio ops (clip / extract / convert / normalize / fade / channels
// / resample) for the Media studio. The operator picks an op + bounded params in
// the modal; this runs ffmpeg and writes a NEW file inside the workflow cwd.
//
// ── Four-question test (CLAUDE.md) ──
//   1. Operator-initiated — only runs on an explicit POST /api/media/op (a modal
//      button click). No timer, no hook, no agent triggers an ffmpeg run.
//   2. Deterministic & bounded — args come from a TYPED MediaOpSpec, not text.
//      buildArgs exhaustively switches the union; every operator value is a
//      validated number or a whitelisted enum.
//   3. Visible — the route broadcasts media_op_result (persisted to events.jsonl).
//   4. Reversible — output is a NEW file; the operator deletes it. Source is
//      never touched. A cancelled/failed op leaves NO partial file.
//
// ── Hard fences (the director reads this file line by line) ──
//   • execFile WITH AN ARGV ARRAY ONLY. NEVER exec, NEVER a shell string, NEVER
//     shell:true. The binary is the fixed literal 'ffmpeg' / 'ffprobe'. Every
//     argument is its own array element. So there is nothing a shell could parse
//     and nothing an operator string could become other than a single argv slot.
//   • TYPED-SPEC → ARGS. buildArgs is PURE and total over MediaOpSpec. The only
//     operator-influenced argv values are numbers (clip/extract/fade/resample —
//     coerced + clamped) and whitelisted enums (format/codec/bitrate/channels).
//     A path is the resolved+confined input/output, never raw operator text.
//   • PATH CONFINEMENT. Both the INPUT and the OUTPUT are resolved through
//     resolveWithinCwd (the same guard the Write/Edit tools + fileWriteRoutes
//     use). A '../' / absolute-outside / trailing-sep-sibling target throws and
//     is rejected. The output basename is sanitized (no separators / '..' /
//     leading dash / NUL) before it's ever resolved.
//   • NEVER OVERWRITES THE SOURCE. The output filename is derived from the input
//     stem + an op suffix + the target extension, then UNIQUIFIED (-2, -3, …) so
//     it can't collide with the source or a prior output. `-n` (never overwrite)
//     is also passed to ffmpeg as defense-in-depth.
//   • CANCEL/ERROR CLEANUP. An AbortSignal kills the ffmpeg child; any error /
//     abort unlinks the (possibly partial) output. No half-written file is ever
//     returned as success.

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { confinedPath, isPathWithin, safeDirectory } from '../fileAccessPolicy.js';
import { UPLOADS_DIR } from '../server/constants.js';
import {
  AUDIO_FORMATS,
  VIDEO_FORMATS,
  VIDEO_VCODECS,
  VIDEO_RES_PRESETS,
  VIDEO_RES_SCALE,
  VIDEO_DIM_MAX,
  STILL_FORMATS,
  ANIM_FORMATS,
  GIF_FPS_MIN,
  GIF_FPS_MAX,
  GIF_FPS_DEFAULT,
  SPECTROGRAM_DEFAULT_W,
  SPECTROGRAM_DEFAULT_H,
  SPEED_FACTOR_MIN,
  SPEED_FACTOR_MAX,
  GAIN_DB_MIN,
  GAIN_DB_MAX,
  JOIN_MAX_INPUTS,
  type AudioFormat,
  type AudioBitrate,
  type AudioSampleRate,
  type VideoFormat,
  type VideoVcodec,
  type VideoResolution,
  type VideoResPreset,
  type GeometryXform,
  type StillFormat,
  type AnimFormat,
  type MediaOpSpec,
  type MediaOpErrorCode,
  type MediaInspectStream,
  type MediaInspectResult,
} from '@archon/shared';
import { SCRATCH_ROOT } from './scratch.js';

// ── ffmpeg presence (cached) ────────────────────────────────────────────────
//
// A graceful, structured "missing" beats an unhandled spawn ENOENT. Cached
// because we check it on every op; a server restart re-probes (install during a
// session is rare and a restart is the documented recovery).
let ffmpegAvailableCache: boolean | undefined;

export async function ffmpegAvailable(): Promise<boolean> {
  if (ffmpegAvailableCache !== undefined) return ffmpegAvailableCache;
  ffmpegAvailableCache = await binaryRuns('ffmpeg', ['-version']);
  return ffmpegAvailableCache;
}

// Test-only seam: reset the cache (the smoke flips it; not used in prod).
export function __resetFfmpegCache(): void {
  ffmpegAvailableCache = undefined;
  ffprobeAvailableCache = undefined;
}

// ffprobe presence (cached) — the metadata-probe sibling of ffmpeg. Diagnostics
// (ARCHON_OPS_PLAN §A1) reports the two separately since a box can ship one
// without the other. Same graceful-missing discipline as ffmpegAvailable.
let ffprobeAvailableCache: boolean | undefined;

export async function ffprobeAvailable(): Promise<boolean> {
  if (ffprobeAvailableCache !== undefined) return ffprobeAvailableCache;
  ffprobeAvailableCache = await binaryRuns('ffprobe', ['-version']);
  return ffprobeAvailableCache;
}

function binaryRuns(bin: 'ffmpeg' | 'ffprobe', args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    // execFile, argv array — no shell. A missing binary rejects with ENOENT.
    execFile(bin, args, { timeout: 5000 }, (err) => resolve(!err));
  });
}

// ── PURE: filename sanitizer (mirrors install.ts::sanitizeModelFilename) ─────
//
// The output basename we DERIVE is already safe, but the input stem flows from
// the operator's chosen file, so we re-sanitize the derived basename as
// defense-in-depth before it's resolved. Reject anything that could escape the
// dir or smuggle a flag. Returns the bare basename (never a path) or null.
export function sanitizeOutputBasename(name: string): string | null {
  if (typeof name !== 'string') return null;
  const raw = name.trim();
  if (!raw) return null;
  if (raw.includes('\0')) return null;
  if (raw.includes('/') || raw.includes('\\')) return null;
  if (raw === '.' || raw === '..' || raw.includes('..')) return null;
  if (raw.startsWith('-')) return null;
  return raw;
}

// ── Media access fence (Part N2) ─────────────────────────────────────────────
//
// The studio is a GENERAL tool: it must act on a workflow file, on a picker-
// imported file staged in Arco scratch, or inside a finite operator-approved
// media directory. All tiers share canonical containment and protected-state
// checks. The boolean alone never authorizes arbitrary server paths.
export interface MediaAccess {
  cwd?: string;
  unconfined: boolean;
  allowedRoots?: string[];
}

// Resolve a path string (absolute, or relative-to-cwd) to an absolute path.
// Rejects NUL / empties / a relative path with no cwd to resolve against.
function toAbs(access: MediaAccess, p: string, what: string): string {
  if (typeof p !== 'string' || p.length === 0) throw new MediaOpError('bad-path', `${what} must be a non-empty string`);
  if (p.includes('\0')) throw new MediaOpError('bad-path', `${what} contains a NUL byte`);
  if (path.isAbsolute(p)) return path.resolve(p);
  if (access.cwd) return path.resolve(access.cwd, p);
  throw new MediaOpError('bad-path', `${what} "${p}" is relative but no workflow cwd is bound — pass an absolute path`);
}

function gate(access: MediaAccess, abs: string, kind: 'file' | 'directory'): string {
  const roots = [access.cwd, SCRATCH_ROOT, UPLOADS_DIR,
    ...(access.unconfined ? (access.allowedRoots ?? []).slice(0, 32) : [])]
    .filter((root): root is string => Boolean(root));
  try { return confinedPath(abs, roots, kind); } catch (err) {
    // Preserve the existing missing-file/destination recovery codes for a
    // nonexistent path spelled inside an otherwise authorized ordinary root.
    // No path is returned or opened when canonical resolution failed.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && roots.some((root) => {
      try { return isPathWithin(root, abs) || isPathWithin(safeDirectory(root), abs); } catch { return false; }
    })) {
      throw new MediaOpError(kind === 'file' ? 'input-missing' : 'output-dir-missing', 'media file or destination does not exist');
    }
    throw new MediaOpError('bad-path', 'media path is unavailable or outside permitted folders; add an allowed media folder in Settings for outside-project files');
  }
}

export function resolveMediaInput(access: MediaAccess, p: string): string {
  return gate(access, toAbs(access, p, 'input path'), 'file');
}

export function resolveMediaOutputDir(access: MediaAccess, dir: string | undefined, inputAbs: string): string {
  return gate(access, dir ? toAbs(access, dir, 'output dir') : path.dirname(inputAbs), 'directory');
}

// The EXTRA input paths a multi-input op carries (join's concatenands, swap-
// replace's audio track). Single-input ops return []. These are raw spec strings
// — runMediaOp resolves + gates each through the SAME fence as the primary input
// before any reaches buildArgs (so an out-of-cwd extra input with the fence
// locked is rejected exactly like the primary).
function specExtraInputs(spec: MediaOpSpec): string[] {
  if (spec.op === 'join') return spec.extraInputs;
  if (spec.op === 'swap' && spec.action.kind === 'replace') return [spec.action.audioPath];
  return [];
}

// ── PURE: numeric coercion ───────────────────────────────────────────────────
// A finite, non-negative number or null. ffmpeg time args are seconds; we cap
// nothing here (clip bounds are validated against in≤out in validateSpec).
function finiteNonNeg(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

// A finite number within [min, max] (inclusive) or null. Used by the §N3 numeric
// controls (speed factor, gain dB) so a malicious value can't ask for an absurd
// amplification / a degenerate filter.
function finiteInRange(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

// A positive integer ≤ VIDEO_DIM_MAX, or null. The geometry/gif/spectrogram pixel
// controls flow through this before any filter string is composed.
function pixelDim(v: unknown): number | null {
  return Number.isInteger(v) && (v as number) > 0 && (v as number) <= VIDEO_DIM_MAX ? (v as number) : null;
}

// ── PURE: video resolution validation ────────────────────────────────────────
// A resolution is undefined (no scaling), a bounded preset, or a {w,h} pair of
// positive integers ≤ VIDEO_DIM_MAX. Returns null on success or a reason string.
// This is what keeps the scale filter free of operator text: a preset maps to a
// fixed filter string; a {w,h} is validated then composed by us (never echoed).
function validateResolution(res: VideoResolution | undefined): string | null {
  if (res === undefined) return null;
  if (typeof res === 'string') {
    return (VIDEO_RES_PRESETS as readonly string[]).includes(res) ? null : `unknown resolution preset "${res}"`;
  }
  if (typeof res !== 'object') return 'resolution must be a preset or {w,h}';
  const { w, h } = res;
  if (!Number.isInteger(w) || !Number.isInteger(h)) return 'resolution w/h must be integers';
  if (w <= 0 || h <= 0) return 'resolution w/h must be > 0';
  if (w > VIDEO_DIM_MAX || h > VIDEO_DIM_MAX) return `resolution w/h must be ≤ ${VIDEO_DIM_MAX}`;
  return null;
}

// ── PURE: video resolution → the `-vf scale=…` filter string we CONTROL ──────
// Presets map to a fixed string; a {w,h} composes "scale=<w>:<h>" from the
// already-validated integers. Never raw operator text. Returns null for 'source'
// / undefined (no -vf added). CALL validateResolution FIRST.
function resolveScaleFilter(res: VideoResolution | undefined): string | null {
  if (res === undefined) return null;
  if (typeof res === 'string') {
    if (res === 'source') return null;
    return VIDEO_RES_SCALE[res as Exclude<VideoResPreset, 'source'>];
  }
  return `scale=${res.w}:${res.h}`;
}

// ── PURE: spec validation ────────────────────────────────────────────────────
//
// Reject a malformed spec BEFORE building args. Returns null on success or a
// reason string. Every numeric is checked finite/≥0/ordered; every enum is
// checked against its whitelist. This is the gate that makes buildArgs total.
export function validateSpec(spec: MediaOpSpec): string | null {
  if (!spec || typeof spec !== 'object') return 'spec must be an object';
  switch (spec.op) {
    case 'clip':
    case 'extract': {
      const i = finiteNonNeg(spec.inSec);
      const o = finiteNonNeg(spec.outSec);
      if (i === null || o === null) return `${spec.op}: inSec/outSec must be finite, ≥0`;
      if (i >= o) return `${spec.op}: inSec must be < outSec`;
      return null;
    }
    case 'convert': {
      if (!(spec.format in AUDIO_FORMATS)) return `convert: unknown format "${spec.format}"`;
      if (spec.bitrate !== undefined && !/^\d{2,3}k$/.test(spec.bitrate)) {
        return `convert: bad bitrate "${spec.bitrate}"`;
      }
      return null;
    }
    case 'normalize':
      return null;
    case 'fade': {
      const i = spec.inMs === undefined ? 0 : finiteNonNeg(spec.inMs);
      const o = spec.outMs === undefined ? 0 : finiteNonNeg(spec.outMs);
      if (i === null || o === null) return 'fade: inMs/outMs must be finite, ≥0';
      if ((spec.inMs ?? 0) <= 0 && (spec.outMs ?? 0) <= 0) return 'fade: at least one of inMs/outMs > 0';
      return null;
    }
    case 'channels':
      if (spec.mode !== 'mono' && spec.mode !== 'stereo') return 'channels: mode must be mono|stereo';
      return null;
    case 'resample':
      if (!Number.isInteger(spec.hz) || spec.hz <= 0) return 'resample: hz must be a positive integer';
      return null;
    case 'vclip': {
      const i = finiteNonNeg(spec.inSec);
      const o = finiteNonNeg(spec.outSec);
      if (i === null || o === null) return 'vclip: inSec/outSec must be finite, ≥0';
      if (i >= o) return 'vclip: inSec must be < outSec';
      if (spec.reencode !== undefined && typeof spec.reencode !== 'boolean') return 'vclip: reencode must be a boolean';
      return null;
    }
    case 'vconvert': {
      if (!(spec.format in VIDEO_FORMATS)) return `vconvert: unknown format "${spec.format}"`;
      if (spec.vcodec !== undefined && !VIDEO_VCODECS.includes(spec.vcodec)) {
        return `vconvert: unknown vcodec "${spec.vcodec}"`;
      }
      const resErr = validateResolution(spec.resolution);
      if (resErr) return `vconvert: ${resErr}`;
      return null;
    }
    case 'extract-audio': {
      if (!(spec.format in AUDIO_FORMATS)) return `extract-audio: unknown format "${spec.format}"`;
      // Span is optional, but if EITHER bound is present BOTH must be, finite, ordered.
      if (spec.inSec !== undefined || spec.outSec !== undefined) {
        const i = finiteNonNeg(spec.inSec);
        const o = finiteNonNeg(spec.outSec);
        if (i === null || o === null) return 'extract-audio: inSec/outSec must both be finite, ≥0';
        if (i >= o) return 'extract-audio: inSec must be < outSec';
      }
      return null;
    }
    case 'framegrab': {
      if (finiteNonNeg(spec.atSec) === null) return 'framegrab: atSec must be finite, ≥0';
      if (!(spec.format in STILL_FORMATS)) return `framegrab: unknown format "${spec.format}"`;
      return null;
    }
    case 'gif': {
      const i = finiteNonNeg(spec.inSec);
      const o = finiteNonNeg(spec.outSec);
      if (i === null || o === null) return 'gif: inSec/outSec must be finite, ≥0';
      if (i >= o) return 'gif: inSec must be < outSec';
      if (spec.fps !== undefined && finiteInRange(spec.fps, GIF_FPS_MIN, GIF_FPS_MAX) === null) {
        return `gif: fps must be in [${GIF_FPS_MIN}, ${GIF_FPS_MAX}]`;
      }
      if (spec.width !== undefined && pixelDim(spec.width) === null) return `gif: width must be an integer in (0, ${VIDEO_DIM_MAX}]`;
      if (spec.format !== undefined && !(spec.format in ANIM_FORMATS)) return `gif: unknown format "${spec.format}"`;
      return null;
    }
    case 'geometry':
      return validateGeometry(spec.xform);
    case 'speed': {
      if (finiteInRange(spec.factor, SPEED_FACTOR_MIN, SPEED_FACTOR_MAX) === null) {
        return `speed: factor must be in [${SPEED_FACTOR_MIN}, ${SPEED_FACTOR_MAX}]`;
      }
      if (typeof spec.video !== 'boolean') return 'speed: video must be a boolean';
      return null;
    }
    case 'gain':
      if (finiteInRange(spec.db, GAIN_DB_MIN, GAIN_DB_MAX) === null) return `gain: db must be in [${GAIN_DB_MIN}, ${GAIN_DB_MAX}]`;
      return null;
    case 'spectrogram': {
      if (spec.width !== undefined && pixelDim(spec.width) === null) return `spectrogram: width must be an integer in (0, ${VIDEO_DIM_MAX}]`;
      if (spec.height !== undefined && pixelDim(spec.height) === null) return `spectrogram: height must be an integer in (0, ${VIDEO_DIM_MAX}]`;
      return null;
    }
    case 'join': {
      if (!Array.isArray(spec.extraInputs) || spec.extraInputs.length === 0) return 'join: extraInputs must be a non-empty array';
      if (spec.extraInputs.length + 1 > JOIN_MAX_INPUTS) return `join: at most ${JOIN_MAX_INPUTS} inputs`;
      if (!spec.extraInputs.every((p) => typeof p === 'string' && p.length > 0)) return 'join: every extra input must be a non-empty path';
      if (typeof spec.video !== 'boolean') return 'join: video must be a boolean';
      return null;
    }
    case 'swap': {
      const a = spec.action;
      if (!a || typeof a !== 'object') return 'swap: action is required';
      if (a.kind === 'mute') return null;
      if (a.kind === 'replace') {
        if (typeof a.audioPath !== 'string' || !a.audioPath) return 'swap: replace requires an audioPath';
        return null;
      }
      return `swap: unknown action "${(a as { kind?: string }).kind}"`;
    }
    default:
      // `spec` is `never` here if the union is exhaustive — a new op forces a case.
      return `unknown op "${(spec as { op?: string }).op}"`;
  }
}

// ── PURE: geometry xform validation ──────────────────────────────────────────
// Exactly one transform; every numeric is a validated pixel dim / a quarter-turn
// enum / an axis enum / a bounded resolution. Returns null or a reason string.
function validateGeometry(x: GeometryXform | undefined): string | null {
  if (!x || typeof x !== 'object') return 'geometry: xform is required';
  switch (x.kind) {
    case 'crop':
      if (pixelDim(x.w) === null || pixelDim(x.h) === null) return `geometry crop: w/h must be integers in (0, ${VIDEO_DIM_MAX}]`;
      // Offsets may be 0 but not negative / non-integer / absurd.
      if (!Number.isInteger(x.x) || !Number.isInteger(x.y) || x.x < 0 || x.y < 0) return 'geometry crop: x/y must be integers ≥0';
      if (x.x > VIDEO_DIM_MAX || x.y > VIDEO_DIM_MAX) return `geometry crop: x/y must be ≤ ${VIDEO_DIM_MAX}`;
      return null;
    case 'rotate':
      if (x.degrees !== 90 && x.degrees !== 180 && x.degrees !== 270) return 'geometry rotate: degrees must be 90|180|270';
      return null;
    case 'flip':
      if (x.axis !== 'h' && x.axis !== 'v') return 'geometry flip: axis must be h|v';
      return null;
    case 'resize': {
      const err = validateResolution(x.resolution);
      return err ? `geometry resize: ${err}` : null;
    }
    default:
      return `geometry: unknown xform "${(x as { kind?: string }).kind}"`;
  }
}

// ── PURE: §N3 filter-string builders ─────────────────────────────────────────
//
// Each composes an ffmpeg filter string from ALREADY-VALIDATED numbers / enums.
// The operator never supplies the string — these are the only place a filter is
// formed, and every interpolated value has passed validateSpec.

// atempo accepts a per-link factor in [0.5, 2.0]; chain links to cover the full
// [0.25, 4] speed range (at most two links). Pitch is preserved (atempo).
function atempoChain(factor: number): string {
  const parts: string[] = [];
  let remaining = factor;
  while (remaining > 2 + 1e-9) { parts.push('atempo=2.0'); remaining /= 2; }
  while (remaining < 0.5 - 1e-9) { parts.push('atempo=0.5'); remaining *= 2; }
  parts.push(`atempo=${remaining}`);
  return parts.join(',');
}

// A single geometry transform → its `-vf` filter. CALL validateGeometry FIRST.
function geometryFilter(x: GeometryXform): string {
  switch (x.kind) {
    case 'crop': return `crop=${x.w}:${x.h}:${x.x}:${x.y}`;
    // transpose=1 = 90° clockwise, =2 = 90° counter-clockwise; 180 = two turns.
    case 'rotate': return x.degrees === 90 ? 'transpose=1' : x.degrees === 270 ? 'transpose=2' : 'transpose=1,transpose=1';
    case 'flip': return x.axis === 'h' ? 'hflip' : 'vflip';
    // resize reuses the H7 scale-filter resolver; 'source' yields no scaling.
    case 'resize': return resolveScaleFilter(x.resolution) ?? 'scale=iw:ih';
  }
}

// gif/webp filter: fps decimation + optional lanczos downscale; gif adds a
// generated palette (split → palettegen → paletteuse) for quality.
function animFilter(fps: number, width: number | undefined, format: AnimFormat): string {
  const chain = [`fps=${fps}`];
  if (width !== undefined) chain.push(`scale=${width}:-1:flags=lanczos`);
  const base = chain.join(',');
  if (format === 'webp') return base;
  return `${base},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;
}

// ── PURE: the security-critical arg builder ──────────────────────────────────
//
// Map a TYPED, pre-VALIDATED MediaOpSpec → ffmpeg argv. No I/O, no operator
// string concatenation: numbers are stringified, formats/codecs/modes come from
// the whitelists, paths are the already-confined input/output. `-n` refuses to
// overwrite (we also never point it at the source). `-nostdin` so a TTY-less
// child can't block on input. The smoke asserts the exact argv per op.
//
// `extraInputs` are the ALREADY-RESOLVED + GATED absolute paths of a multi-input
// op's additional inputs (join concatenates them; swap-replace maps in the first
// as the new audio track). Empty for single-input ops. They are gated abs paths,
// NOT raw spec strings — runMediaOp resolves them through the same access fence.
//
// CALL validateSpec FIRST — buildArgs assumes a valid spec (it's pure arg math).
export function buildArgs(
  spec: MediaOpSpec,
  inputPath: string,
  outputPath: string,
  extraInputs: string[] = [],
): string[] {
  // Common prefix: no stdin, never overwrite, then the single input.
  const pre = ['-nostdin', '-n', '-i', inputPath];

  switch (spec.op) {
    case 'clip':
      // Seek + duration around the input, stream-copy into the same container
      // (fast, lossless). -ss/-to are placed AFTER -i for frame accuracy.
      return [...pre, '-ss', String(spec.inSec), '-to', String(spec.outSec), '-c', 'copy', outputPath];
    case 'extract':
      // Same window but re-encode (frame-accurate on lossy sources). No -c copy.
      return [...pre, '-ss', String(spec.inSec), '-to', String(spec.outSec), outputPath];
    case 'convert': {
      const fmt: AudioFormat = spec.format;
      const codec = AUDIO_FORMATS[fmt].codec;
      const args = [...pre, '-c:a', codec];
      if (spec.bitrate) args.push('-b:a', spec.bitrate as AudioBitrate);
      args.push(outputPath);
      return args;
    }
    case 'normalize':
      // EBU R128 two-pass would be more precise, but single-pass loudnorm is the
      // common, fast default; the operator re-runs if they want more.
      return [...pre, '-af', 'loudnorm', outputPath];
    case 'fade': {
      const inMs = spec.inMs ?? 0;
      const outMs = spec.outMs ?? 0;
      const parts: string[] = [];
      if (inMs > 0) parts.push(`afade=t=in:st=0:d=${inMs / 1000}`);
      // The tail fade can't use `afade=t=out` without the clip's end time (which
      // we don't probe in this PURE builder). The duration-free idiom is to
      // reverse → fade-in the (now-leading) tail → reverse back: a clean
      // end-fade with no knowledge of the total length. This keeps buildArgs
      // pure + deterministic.
      if (outMs > 0) parts.push(`areverse`, `afade=t=in:st=0:d=${outMs / 1000}`, `areverse`);
      return [...pre, '-af', parts.join(','), outputPath];
    }
    case 'channels':
      return [...pre, '-ac', spec.mode === 'mono' ? '1' : '2', outputPath];
    case 'resample':
      return [...pre, '-ar', String(spec.hz), outputPath];
    case 'vclip': {
      // Seek window after -i (frame-accurate). Stream-copy by default (fast,
      // lossless, keeps the source container); re-encode when asked (frame-exact
      // cuts on inter-frame codecs). Re-encode lets ffmpeg pick codecs from the
      // output ext — both video + audio are mapped (`-map 0`-free single input).
      const win = ['-ss', String(spec.inSec), '-to', String(spec.outSec)];
      return spec.reencode
        ? [...pre, ...win, outputPath]
        : [...pre, ...win, '-c', 'copy', outputPath];
    }
    case 'vconvert': {
      const fmt: VideoFormat = spec.format;
      const def = VIDEO_FORMATS[fmt];
      // vcodec: operator override (whitelisted) or the container default. acodec:
      // always the container default. Neither is operator text.
      const vcodec = spec.vcodec ?? def.vcodec;
      const args = [...pre, '-c:v', vcodec, '-c:a', def.acodec];
      const scale = resolveScaleFilter(spec.resolution);
      if (scale) args.push('-vf', scale);
      args.push(outputPath);
      return args;
    }
    case 'extract-audio': {
      const acodec = AUDIO_FORMATS[spec.format].codec;
      // -vn drops the video stream; encode the audio to the target codec. Span is
      // optional (validated finite/ordered); placed after -i for accuracy.
      const win = (spec.inSec !== undefined && spec.outSec !== undefined)
        ? ['-ss', String(spec.inSec), '-to', String(spec.outSec)]
        : [];
      return [...pre, ...win, '-vn', '-c:a', acodec, outputPath];
    }
    case 'framegrab': {
      // Fast input-seek (-ss BEFORE -i) then take exactly one frame. -update 1
      // lets the image2 muxer write a single still to a fixed filename. jpeg gets
      // a quality bump. Custom argv (not `pre`) so -ss precedes -i.
      const jpeg = STILL_FORMATS[spec.format].ext === 'jpg';
      const q = jpeg ? ['-q:v', '2'] : [];
      return ['-nostdin', '-n', '-ss', String(spec.atSec), '-i', inputPath, '-frames:v', '1', '-update', '1', ...q, outputPath];
    }
    case 'gif': {
      // Input-seek + duration window, then the fps/scale(/palette) filter. -loop 0
      // loops forever. Custom argv so -ss/-t precede -i (fast seek).
      const fps = spec.fps ?? GIF_FPS_DEFAULT;
      const format: AnimFormat = spec.format ?? 'gif';
      const vf = animFilter(fps, spec.width, format);
      return ['-nostdin', '-n', '-ss', String(spec.inSec), '-t', String(spec.outSec - spec.inSec), '-i', inputPath, '-vf', vf, '-loop', '0', outputPath];
    }
    case 'geometry':
      return [...pre, '-vf', geometryFilter(spec.xform), outputPath];
    case 'speed': {
      // Audio tempo is pitch-preserved (atempo chain). For a video the panel sets
      // video:true → also re-time the picture (setpts=PTS/factor). A silent video
      // would fail on -af (rare); the operator sees a structured ffmpeg error.
      const atempo = atempoChain(spec.factor);
      return spec.video
        ? [...pre, '-vf', `setpts=PTS/${spec.factor}`, '-af', atempo, outputPath]
        : [...pre, '-af', atempo, outputPath];
    }
    case 'gain':
      return [...pre, '-af', `volume=${spec.db}dB`, outputPath];
    case 'spectrogram': {
      const w = spec.width ?? SPECTROGRAM_DEFAULT_W;
      const h = spec.height ?? SPECTROGRAM_DEFAULT_H;
      // showspectrumpic is a single-image filter source; -lavfi feeds it the input.
      return [...pre, '-lavfi', `showspectrumpic=s=${w}x${h}`, outputPath];
    }
    case 'join': {
      // N inputs (primary + the already-gated extras) → filter concat, re-encoded
      // (robust across same-or-mixed codecs; the demuxer fast-path is a future
      // optimization). The filter is built from the validated input COUNT only —
      // no operator string. The audio-only vs a/v stream layout is inferred from
      // the panel-built spec? No — join carries it via `video` (set by the panel).
      const inputs = [inputPath, ...extraInputs];
      const n = inputs.length;
      const inFlags = inputs.flatMap((p) => ['-i', p]);
      // Build "[0:v][0:a][1:v][1:a]…concat=n=N:v=1:a=1[outv][outa]" (or audio-only).
      const av = spec.video;
      const labels = Array.from({ length: n }, (_, i) => (av ? `[${i}:v][${i}:a]` : `[${i}:a]`)).join('');
      const filter = `${labels}concat=n=${n}:v=${av ? 1 : 0}:a=1${av ? '[outv][outa]' : '[outa]'}`;
      const maps = av ? ['-map', '[outv]', '-map', '[outa]'] : ['-map', '[outa]'];
      return ['-nostdin', '-n', ...inFlags, '-filter_complex', filter, ...maps, outputPath];
    }
    case 'swap': {
      if (spec.action.kind === 'mute') {
        // Drop the audio stream; stream-copy the rest (fast, lossless).
        return [...pre, '-c', 'copy', '-an', outputPath];
      }
      // replace: input 0 = video, input 1 = the new audio (already gated). Keep
      // the video (copy), take audio from input 1, end at the shorter stream.
      const audioInput = extraInputs[0];
      return ['-nostdin', '-n', '-i', inputPath, '-i', audioInput, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-shortest', outputPath];
    }
  }
}

// ── PURE: derive a safe, non-clobbering output basename ──────────────────────
//
// From the input basename + the op, build "<stem>.<suffix>.<ext>". convert uses
// the target format's ext; everything else keeps the source ext. The result is
// sanitized; uniquification (against existing files) happens in runAudioOp.
export function deriveOutputBasename(inputBasename: string, spec: MediaOpSpec): string {
  const ext = path.extname(inputBasename); // includes the dot, e.g. ".wav"
  const stem = path.basename(inputBasename, ext);
  const suffix: Record<MediaOpSpec['op'], string> = {
    clip: 'clip', extract: 'extract', convert: 'convert',
    normalize: 'normalized', fade: 'fade', channels: 'channels', resample: 'resample',
    vclip: 'clip', vconvert: 'convert', 'extract-audio': 'audio',
    framegrab: 'frame', gif: 'gif', geometry: 'geom', speed: 'speed',
    gain: 'gain', spectrogram: 'spectrum', join: 'join', swap: 'swap',
  };
  return `${stem}.${suffix[spec.op]}${targetOutputExt(inputBasename, spec)}`;
}

// ── PURE: the output extension an op produces ────────────────────────────────
// audio convert → AUDIO_FORMATS ext; video convert → VIDEO_FORMATS container
// ext; extract-audio → the chosen AUDIO_FORMATS ext; everything else keeps the
// source extension (clip/vclip stream-copy etc.). Includes the leading dot.
export function targetOutputExt(inputBasename: string, spec: MediaOpSpec): string {
  if (spec.op === 'convert') return `.${AUDIO_FORMATS[spec.format].ext}`;
  if (spec.op === 'vconvert') return `.${VIDEO_FORMATS[spec.format].ext}`;
  if (spec.op === 'extract-audio') return `.${AUDIO_FORMATS[spec.format].ext}`;
  // §N3 — a still / animation / spectrogram produces a NEW media type, so its ext
  // is the chosen format's, not the source's.
  if (spec.op === 'framegrab') return `.${STILL_FORMATS[spec.format].ext}`;
  if (spec.op === 'gif') return `.${ANIM_FORMATS[spec.format ?? 'gif'].ext}`;
  if (spec.op === 'spectrogram') return '.png';
  // geometry / speed / gain / join / swap keep the source container.
  return path.extname(inputBasename) || '';
}

// ── PURE: the output basename, honoring an operator-chosen name ──────────────
//
// N2 save-dialog: when the operator types a filename we use its STEM but FORCE
// the op's target extension (so a convert→mp3 named "take.wav" still lands as
// "take.mp3" and stays playable). No name ⇒ the derived non-clobbering name.
// The name is sanitized; an unsafe one returns null (caller → bad-path).
export function outputBasenameFor(
  operatorName: string | undefined,
  inputBasename: string,
  spec: MediaOpSpec,
): string | null {
  if (operatorName === undefined || operatorName.trim() === '') {
    return deriveOutputBasename(inputBasename, spec);
  }
  const safe = sanitizeOutputBasename(operatorName);
  if (!safe) return null;
  const givenExt = path.extname(safe);
  const stem = givenExt ? path.basename(safe, givenExt) : safe;
  return `${stem}${targetOutputExt(inputBasename, spec)}`;
}

// Append -2/-3/… before the extension until the path is free. Bounded loop; the
// caller has already confined `dir`. Returns the chosen basename (not a path).
async function uniqueBasename(dir: string, basename: string): Promise<string> {
  const ext = path.extname(basename);
  const stem = path.basename(basename, ext);
  let candidate = basename;
  for (let n = 2; n < 10000; n++) {
    try {
      await fs.access(path.join(dir, candidate));
    } catch {
      return candidate; // free
    }
    candidate = `${stem}-${n}${ext}`;
  }
  // Pathological — fall back to a timestamp suffix.
  return `${stem}-${Date.now().toString(36)}${ext}`;
}

// A typed error so the route can branch on `code` (e.g. show the install
// pointer for 'ffmpeg-missing').
export class MediaOpError extends Error {
  code: MediaOpErrorCode;
  constructor(code: MediaOpErrorCode, message: string) {
    super(message);
    this.name = 'MediaOpError';
    this.code = code;
  }
}

export interface RunMediaOpOpts {
  // Cancel seam — the route wires req.on('close') → abort, which SIGKILLs the
  // ffmpeg child and unlinks the partial output.
  signal?: AbortSignal;
  // Explicit outside-project access is limited to allowedRoots. Absent/false
  // allows only the workflow cwd, uploads and managed scratch.
  unconfined?: boolean;
  allowedRoots?: string[];
  // N2 — explicit output destination. `dir` (absolute or cwd-relative) chooses
  // where the new file lands (gated by the SAME tiers as the input); absent ⇒
  // alongside the input. `basename` chooses the filename (sanitized; the op's
  // target ext is forced); absent ⇒ the derived non-clobbering name.
  output?: { dir?: string; basename?: string };
}

export interface RunMediaOpResult {
  outputPath: string; // absolute
  relPath: string;    // cwd-relative (for "Reveal in Files")
}

// Back-compat aliases — H6 named these RunAudioOp*; H7 made the wrapper
// media-agnostic (it was only audio in name). Kept so older call sites / the
// audio-ops smoke keep compiling.
export type RunAudioOpOpts = RunMediaOpOpts;
export type RunAudioOpResult = RunMediaOpResult;

// ── runMediaOp — confine, derive, preflight, run, cleanup ────────────────────
//
// Renamed from runAudioOp in §H7: nothing in the body is audio-specific (it
// confines + derives + runs ffmpeg + cleans up for any MediaOpSpec — audio AND
// video). The audio/video editors call the aliases below; this is the one body.
//
// ORDERING (load-bearing): confine INPUT → confirm input exists → derive +
// uniquify + confine OUTPUT (never the source) → preflight ffmpeg present →
// build args → execFile with the AbortSignal → on success return; on error/abort
// unlink the partial output + throw a MediaOpError.
export async function runMediaOp(
  cwd: string,
  inputRelPath: string,
  spec: MediaOpSpec,
  opts: RunMediaOpOpts = {},
): Promise<RunMediaOpResult> {
  // N2 — cwd is now OPTIONAL. A general-tool op on a scratch / absolute path
  // carries none; resolveMediaInput rejects a RELATIVE path with no cwd (the
  // only case that genuinely needs one). So no blanket no-cwd guard here.

  // 1. Validate the typed spec BEFORE anything else.
  const specErr = validateSpec(spec);
  if (specErr) throw new MediaOpError('bad-spec', specErr);

  const access: MediaAccess = { cwd: cwd || undefined, unconfined: opts.unconfined ?? false, allowedRoots: opts.allowedRoots };

  // 2. Resolve + gate the INPUT path (cwd | scratch | unconfined). A '../' /
  //    absolute-outside path with the fence locked throws → bad-path.
  const inputAbs = resolveMediaInput(access, inputRelPath);

  // 3. Confirm the input exists + is a file.
  try {
    const st = await fs.stat(inputAbs);
    if (!st.isFile()) throw new MediaOpError('input-missing', `"${inputRelPath}" is not a file`);
  } catch (err) {
    if (err instanceof MediaOpError) throw err;
    throw new MediaOpError('input-missing', `input not found: ${inputRelPath}`);
  }

  // 4. ffmpeg present? (Graceful structured failure, never a spawn crash.)
  if (!(await ffmpegAvailable())) {
    throw new MediaOpError(
      'ffmpeg-missing',
      'ffmpeg is not on PATH. Install it (see docs/OPERATIONS.md § FFmpeg; or the system package manager).',
    );
  }

  // 5. Resolve + gate the OUTPUT directory (same tiers as the input). An
  //    explicit operator dir must exist + be a directory; the default (the
  //    input's dir) is known-good.
  const inputBasename = path.basename(inputAbs);
  const outDir = resolveMediaOutputDir(access, opts.output?.dir, inputAbs);
  if (opts.output?.dir) {
    try {
      const dst = await fs.stat(outDir);
      if (!dst.isDirectory()) throw new MediaOpError('output-dir-missing', `output destination "${outDir}" is not a directory`);
    } catch (err) {
      if (err instanceof MediaOpError) throw err;
      throw new MediaOpError('output-dir-missing', `output directory does not exist: ${outDir}`);
    }
  }

  // 6. Derive a SAFE, non-clobbering output basename — honoring an operator-
  //    chosen filename (stem kept, op's target ext forced) — then uniquify it
  //    against the chosen dir so it can never clobber the source or a prior run.
  const wanted = outputBasenameFor(opts.output?.basename, inputBasename, spec);
  if (!wanted) throw new MediaOpError('bad-path', `unsafe output name "${opts.output?.basename}"`);
  const safe = sanitizeOutputBasename(wanted);
  if (!safe) throw new MediaOpError('bad-path', `unsafe derived output name from "${inputBasename}"`);
  const uniqueName = await uniqueBasename(outDir, safe);
  const outputAbs = path.join(outDir, uniqueName);

  // Never the source — uniqueBasename guarantees it, but assert the invariant.
  if (outputAbs === inputAbs) {
    throw new MediaOpError('bad-path', 'refusing to overwrite the source file');
  }

  // 6b. Resolve + gate every EXTRA input (join / swap-replace) through the SAME
  //     fence, and confirm each is a real file. Only the gated abs paths reach
  //     buildArgs — never the raw spec strings.
  const extraInputs: string[] = [];
  for (const p of specExtraInputs(spec)) {
    const abs = resolveMediaInput(access, p);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) throw new MediaOpError('input-missing', `extra input "${p}" is not a file`);
    } catch (err) {
      if (err instanceof MediaOpError) throw err;
      throw new MediaOpError('input-missing', `extra input not found: ${p}`);
    }
    extraInputs.push(abs);
  }

  // 7. Build args from the typed spec (pure) + run ffmpeg via execFile (argv
  //    array, no shell), wired to the cancel signal.
  const args = buildArgs(spec, inputAbs, outputAbs, extraInputs);
  try {
    await runFfmpeg(args, opts.signal);
  } catch (err) {
    // Cancel or ffmpeg failure: delete the (possibly partial) output. No
    // half-written file is ever returned as success.
    await safeUnlink(outputAbs);
    if (opts.signal?.aborted || err instanceof AbortError) {
      throw new MediaOpError('cancelled', 'media op cancelled');
    }
    throw new MediaOpError('ffmpeg-failed', err instanceof Error ? err.message : String(err));
  }

  // relPath drives "Reveal in Files", which only makes sense for an output
  // inside the workflow cwd. For a scratch / arbitrary-path output there's no
  // Files-panel anchor, so relPath is empty and the client shows the absolute
  // outputPath instead.
  let relPath = '';
  if (cwd) {
    const rel = path.relative(path.resolve(cwd), outputAbs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) relPath = rel;
  }
  return { outputPath: outputAbs, relPath };
}

// Back-compat / intent aliases. Same body — audio AND video flow through
// runMediaOp. runAudioOp keeps the H6 route + audio-ops smoke compiling;
// runVideoOp is the H7 video editor's call name (reads as intent, not a 2nd path).
export const runAudioOp = runMediaOp;
export const runVideoOp = runMediaOp;

// Run ffmpeg with an argv array; resolve on exit 0, reject otherwise. The
// AbortSignal SIGKILLs the child (the route also wires req-close → abort).
function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    // execFile, fixed literal binary, argv array — NO shell, NO interpolation.
    const child = execFile('ffmpeg', args, { maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (signal?.aborted) return reject(new AbortError());
      if (err) {
        const tail = (stderr || '').toString().trim().split('\n').slice(-4).join('\n');
        return reject(new Error(tail || err.message));
      }
      resolve();
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

async function safeUnlink(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[archon] media: failed to delete partial ${p}:`, err instanceof Error ? err.message : err);
    }
  }
}

// ── ffprobe duration helper (validation / smoke assertions) ─────────────────
//
// Returns the audio stream duration in seconds, or null if ffprobe is absent /
// the file isn't probeable. execFile + argv array — no shell.
export async function probeDurationSec(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { timeout: 8000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const v = Number(String(stdout).trim());
        resolve(Number.isFinite(v) ? v : null);
      },
    );
  });
}

// Returns the audio codec name reported by ffprobe (e.g. "mp3", "pcm_s16le"), or
// null. Used by the smoke to assert a convert produced a valid target codec.
export async function probeAudioCodec(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { timeout: 8000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const v = String(stdout).trim();
        resolve(v || null);
      },
    );
  });
}

// ── inspect (Part N3) — ffprobe metadata, NO file written ────────────────────
//
// Read-only: resolves + gates `inputPath` through the SAME access fence as an op
// input, runs `ffprobe -show_format -show_streams -print_format json`, and
// projects the result down to the curated MediaInspectResult the panel renders.
// Always resolves a structured result (never throws for an operator-visible
// condition); the route returns it verbatim. This is the op-union's "render
// nothing" sibling — it deliberately lives OUTSIDE buildArgs/runMediaOp.
export async function inspectMedia(access: MediaAccess, inputPath: string): Promise<MediaInspectResult> {
  let inputAbs: string;
  try {
    inputAbs = resolveMediaInput(access, inputPath);
  } catch (err) {
    return { ok: false, code: 'bad-path', error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const st = await fs.stat(inputAbs);
    if (!st.isFile()) return { ok: false, code: 'input-missing', error: `"${inputPath}" is not a file` };
  } catch {
    return { ok: false, code: 'input-missing', error: `input not found: ${inputPath}` };
  }
  if (!(await ffprobeAvailable())) {
    return { ok: false, code: 'ffprobe-missing', error: 'ffprobe is not on PATH (install ffmpeg — see docs/OPERATIONS.md § FFmpeg).' };
  }
  const json = await runFfprobeJson(inputAbs);
  if (!json) return { ok: false, code: 'probe-failed', error: 'ffprobe produced no parseable output' };

  const fmt = (json.format ?? {}) as Record<string, unknown>;
  const streams: MediaInspectStream[] = Array.isArray(json.streams)
    ? (json.streams as Record<string, unknown>[]).map((s) => ({
        index: numOr(s.index, 0),
        type: typeof s.codec_type === 'string' ? s.codec_type : 'unknown',
        codec: typeof s.codec_name === 'string' ? s.codec_name : undefined,
        width: numUndef(s.width),
        height: numUndef(s.height),
        fps: parseFrameRate(s.avg_frame_rate),
        sampleRate: numUndef(s.sample_rate),
        channels: numUndef(s.channels),
        bitrate: numUndef(s.bit_rate),
      }))
    : [];
  return {
    ok: true,
    format: {
      name: typeof fmt.format_name === 'string' ? fmt.format_name : undefined,
      duration: numUndef(fmt.duration),
      size: numUndef(fmt.size),
      bitrate: numUndef(fmt.bit_rate),
    },
    streams,
  };
}

// Run ffprobe with JSON output; resolve the parsed object or null (probe failed /
// unparseable). execFile + argv array — no shell.
function runFfprobeJson(filePath: string): Promise<{ format?: unknown; streams?: unknown } | null> {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(String(stdout)));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

// ffprobe reports many numbers as strings ("1001", "44100"). Coerce to a finite
// number or undefined (the curated shape never carries NaN / a raw string).
function numUndef(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function numOr(v: unknown, fallback: number): number {
  return numUndef(v) ?? fallback;
}

// avg_frame_rate is a rational string like "30000/1001" → 29.97, or "0/0" →
// undefined (no meaningful rate). Rounded to 2 decimals for display.
function parseFrameRate(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^(\d+)\/(\d+)$/.exec(v.trim());
  if (!m) return undefined;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!den || !Number.isFinite(num) || !Number.isFinite(den)) return undefined;
  return Math.round((num / den) * 100) / 100;
}

// Returns the video codec name reported by ffprobe (e.g. "h264", "vp9"), or null
// (no video stream / ffprobe absent). Used by the video-ops smoke to assert a
// vconvert produced the target container's codec. execFile + argv array.
export async function probeVideoCodec(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { timeout: 8000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const v = String(stdout).trim();
        resolve(v || null);
      },
    );
  });
}
