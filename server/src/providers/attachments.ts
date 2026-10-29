// Shared operator-attachment helpers for providers that don't carry their own

import { execFile } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { rename, stat, unlink } from 'fs/promises';
import { homedir } from 'os';
import { dirname, extname, join, resolve } from 'path';
import { promisify } from 'util';
import { UPLOADS_DIR } from '../server/constants.js';

// Claude API caps base64 images at 5 MB; every Arco provider uses the same
// ceiling so one attachment behaves the same on every transport.
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const IMAGE_MEDIA_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function imageMediaType(path: string): string | null {
  return IMAGE_MEDIA_TYPE[extname(path).toLowerCase()] ?? null;
}

export interface LoadedImage {
  path: string;
  mimeType: string;
  /** base64, no data: prefix */
  data: string;
}

export interface SplitAttachments {
  imagePaths: string[];
  nonImagePaths: string[];
}

export function splitAttachmentPaths(paths: string[] | undefined): SplitAttachments {
  const imagePaths: string[] = [];
  const nonImagePaths: string[] = [];
  for (const p of paths ?? []) {
    (imageMediaType(p) ? imagePaths : nonImagePaths).push(p);
  }
  return { imagePaths, nonImagePaths };
}

// Reads + base64-encodes image attachments. Unreadable or oversized images are
// skipped with a human-readable reason rather than failing the turn — the
// caller surfaces `skipped` as a system_notice so the operator knows.
export function loadImages(paths: string[]): { images: LoadedImage[]; skipped: string[] } {
  const images: LoadedImage[] = [];
  const skipped: string[] = [];
  for (const p of paths) {
    const mimeType = imageMediaType(p);
    if (!mimeType) continue;
    try {
      // Model copy (downscaled sibling) when one exists; `path` stays the
      // original so notices / refs name what the operator attached.
      const src = modelImagePath(p);
      const size = statSync(src).size;
      if (size === 0) {
        skipped.push(`attachment "${p}" is empty — skipped`);
        continue;
      }
      if (size > IMAGE_MAX_BYTES) {
        skipped.push(`attachment "${p}" exceeds ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)}MB image limit — skipped`);
        continue;
      }
      images.push({ path: p, mimeType: imageMediaType(src) ?? mimeType, data: readFileSync(src).toString('base64') });
    } catch (err) {
      skipped.push(`attachment "${p}" unreadable: ${err instanceof Error ? err.message : String(err)} — skipped`);
    }
  }
  return { images, skipped };
}

// Same `[attached file: …]` text-ref shape every other provider folds for
// non-image attachments, so transcripts read identically across providers.
export function attachmentRefs(paths: string[], label = 'attached file'): string {
  return paths.map((p) => `[${label}: ${p}]`).join('\n');
}

export function withAttachmentRefs(prompt: string, paths: string[], label?: string): string {
  if (paths.length === 0) return prompt;
  return `${prompt}\n\n${attachmentRefs(paths, label)}`;
}

export function attachmentDirs(paths: string[] | undefined): string[] {
  return [...new Set((paths ?? []).map((p) => dirname(p)))];
}

// ── Model-side image downscaling ─────────────────────────────────────────────
// Pasted screenshots/photos went to the model at full size: Native folded any
// image over the 5 MB base64 cap to a text path (the model never saw it), every
// other provider skipped anything over 5 MB raw, and Anthropic tightens the
// per-image limit to 2000px once a request carries >20 images. So each image
// upload gets a derived `<path>.model.<ext>` sibling fitted to 2000×2000 (and
// re-encoded JPEG q85 if still over ~3.75 MB raw). The ORIGINAL is never
// touched — Agent tabs may ask the agent to copy the asset into a project —
// and text refs keep naming it. Only the bytes the model sees are swapped.
// Uses whatever is on the box (ImageMagick `magick` → `convert`, macOS `sips`);
// no binary / any failure ⇒ original path, same as before this existed.

export const MODEL_IMAGE_MAX_EDGE = 2000;
// Anthropic's 5 MB cap is on the base64 string: 3.75 MB raw.
export const MODEL_IMAGE_MAX_RAW_BYTES = Math.floor((5 * 1024 * 1024) / 4) * 3;
const MODEL_TAG = '.model';
// Bounded so a stuck resize can't hold a turn hostage; a late copy still lands
// for the next turn.
const AWAIT_MODEL_IMAGE_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;
const CONVERT_TIMEOUT_MS = 30_000;
// A Q16-HDRI decode of an 8000px image is ~1 GB; two at once is the ceiling.
const MAX_CONCURRENT_DERIVES = 2;

const execFileP = promisify(execFile);

type ImageTool =
  | { kind: 'magick'; bin: string; identify: string[] }
  | { kind: 'sips'; bin: string };

// Absolute fallbacks matter: the systemd user unit's PATH omits ~/.local/bin
// (where the LFS box's IM7 lives) and Homebrew's prefixes.
function magickCandidates(): Array<{ bin: string; identify: (bin: string) => string[] }> {
  const im7 = (bin: string) => [bin, 'identify'];
  const im6 = (bin: string) => [bin.includes('/') ? join(dirname(bin), 'identify') : 'identify'];
  return [
    ...['magick', join(homedir(), '.local/bin/magick'), '/opt/homebrew/bin/magick', '/usr/local/bin/magick', '/usr/bin/magick']
      .map((bin) => ({ bin, identify: im7 })),
    ...['convert', '/usr/bin/convert', '/opt/homebrew/bin/convert', '/usr/local/bin/convert']
      .map((bin) => ({ bin, identify: im6 })),
  ];
}

let toolPromise: Promise<ImageTool | null> | null = null;

function detectImageTool(): Promise<ImageTool | null> {
  toolPromise ??= (async () => {
    for (const c of magickCandidates()) {
      try {
        const { stdout } = await execFileP(c.bin, ['-version'], { timeout: PROBE_TIMEOUT_MS });
        if (String(stdout).includes('ImageMagick')) return { kind: 'magick', bin: c.bin, identify: c.identify(c.bin) };
      } catch { /* next candidate */ }
    }
    if (process.platform === 'darwin' && existsSync('/usr/bin/sips')) return { kind: 'sips', bin: '/usr/bin/sips' };
    console.warn('[arco] no ImageMagick/sips found — image attachments go to the model at full size');
    return null;
  })();
  return toolPromise;
}

async function imageDimensions(tool: ImageTool, path: string): Promise<{ w: number; h: number } | null> {
  if (tool.kind === 'magick') {
    const [bin, ...pre] = tool.identify;
    const { stdout } = await execFileP(bin, [...pre, '-format', '%w %h', `${path}[0]`], { timeout: PROBE_TIMEOUT_MS });
    const m = /^(\d+) (\d+)/.exec(String(stdout).trim());
    return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
  }
  const { stdout } = await execFileP(tool.bin, ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { timeout: PROBE_TIMEOUT_MS });
  const w = /pixelWidth:\s*(\d+)/.exec(String(stdout));
  const h = /pixelHeight:\s*(\d+)/.exec(String(stdout));
  return w && h ? { w: Number(w[1]), h: Number(h[1]) } : null;
}

// Output format for the same-format pass. sips can't write WEBP, so it goes
// straight to JPEG there.
function sameFormatExt(tool: ImageTool, ext: string): string | null {
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') return ext;
  if (ext === '.webp' && tool.kind === 'magick') return ext;
  return null;
}

async function convertImage(tool: ImageTool, src: string, out: string, opts: { resize: boolean; jpeg: boolean }): Promise<void> {
  const fmt = opts.jpeg ? 'JPEG' : extname(out).slice(1).toUpperCase().replace('JPG', 'JPEG');
  if (tool.kind === 'magick') {
    // `[0]` = first frame; `jpeg:size` lets the JPEG decoder downsample on
    // load (memory); explicit `FMT:` output so a ':' in the name isn't read
    // as a format prefix. `-alpha remove` flattens transparency onto white.
    const args = ['-define', 'jpeg:size=4000x4000', `${src}[0]`, '-auto-orient'];
    if (opts.resize) args.push('-resize', `${MODEL_IMAGE_MAX_EDGE}x${MODEL_IMAGE_MAX_EDGE}>`);
    if (opts.jpeg) args.push('-background', 'white', '-alpha', 'remove', '-alpha', 'off', '-quality', '85');
    args.push(`${fmt}:${out}`);
    await execFileP(tool.bin, args, { timeout: CONVERT_TIMEOUT_MS });
    return;
  }
  const args: string[] = [];
  if (opts.resize) args.push('-Z', String(MODEL_IMAGE_MAX_EDGE));
  args.push('-s', 'format', opts.jpeg ? 'jpeg' : fmt.toLowerCase());
  if (opts.jpeg) args.push('-s', 'formatOptions', '85');
  args.push(src, '--out', out);
  await execFileP(tool.bin, args, { timeout: CONVERT_TIMEOUT_MS });
}

let activeDerives = 0;
const deriveWaiters: Array<() => void> = [];
async function withDeriveSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeDerives >= MAX_CONCURRENT_DERIVES) await new Promise<void>((r) => deriveWaiters.push(r));
  activeDerives += 1;
  try { return await fn(); } finally {
    activeDerives -= 1;
    deriveWaiters.shift()?.();
  }
}

// GIFs are left alone (animation); derived copies never derive again.
function isDerivable(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext !== '.gif' && imageMediaType(path) !== null && !DERIVED_RE.test(path);
}
const DERIVED_RE = /\.(png|jpe?g|webp)\.model\.(png|jpe?g|webp)$/i;

function siblingPaths(path: string): string[] {
  const ext = extname(path).toLowerCase();
  const same = `${path}${MODEL_TAG}${ext}`;
  const jpg = `${path}${MODEL_TAG}.jpg`;
  return same === jpg ? [same] : [same, jpg];
}

// Resize `path` into a `.model.<ext>` sibling when it is over 2000px on the
// long edge or over the raw cap. Returns the sibling, or null when no copy is
// needed or anything failed (warned, never thrown). Writes via tmp + rename so
// modelImagePath never observes a half-written file.
export async function deriveModelImage(path: string): Promise<string | null> {
  if (!isDerivable(path)) return null;
  const tmps: string[] = [];
  try {
    const tool = await detectImageTool();
    if (!tool) return null;
    const size = (await stat(path)).size;
    if (size === 0) return null;
    const dims = await imageDimensions(tool, path);
    if (!dims) throw new Error('could not read dimensions');
    const resize = Math.max(dims.w, dims.h) > MODEL_IMAGE_MAX_EDGE;
    if (!resize && size <= MODEL_IMAGE_MAX_RAW_BYTES) return null;
    return await withDeriveSlot(async () => {
      const ext = extname(path).toLowerCase();
      const tag = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      let outExt: string | null = null;
      let tmp: string | null = null;
      const sameExt = sameFormatExt(tool, ext);
      // Same-format first (keeps PNG text crisp); skip it when there's
      // nothing to resize — a no-op re-encode of an over-cap file just
      // lands over the cap again.
      if (sameExt && resize) {
        tmp = `${path}${MODEL_TAG}.tmp-${tag}${sameExt}`;
        tmps.push(tmp);
        await convertImage(tool, path, tmp, { resize, jpeg: false });
        outExt = sameExt;
      }
      if (!tmp || (await stat(tmp)).size > MODEL_IMAGE_MAX_RAW_BYTES) {
        tmp = `${path}${MODEL_TAG}.tmp-${tag}.jpg`;
        tmps.push(tmp);
        await convertImage(tool, path, tmp, { resize, jpeg: true });
        outExt = '.jpg';
      }
      const outSize = (await stat(tmp)).size;
      if (outSize === 0 || outSize > MODEL_IMAGE_MAX_RAW_BYTES) throw new Error(`derived copy is ${outSize} bytes`);
      const out = `${path}${MODEL_TAG}${outExt}`;
      await rename(tmp, out);
      console.log(`[arco] model image: ${path} (${dims.w}x${dims.h}, ${size}B) -> ${out} (${outSize}B)`);
      return out;
    });
  } catch (err) {
    console.warn(`[arco] model image derivation failed for ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    for (const t of tmps) await unlink(t).catch(() => {});
  }
}

const inflight = new Map<string, Promise<string | null>>();
// Paths already evaluated (no copy needed, or failed) — so the on-demand path
// in awaitModelImage doesn't re-run identify for them every turn.
const settled = new Set<string>();

// Fire-and-track: /upload calls this after the write and returns immediately.
export function queueModelImage(path: string): void {
  if (!isDerivable(path) || inflight.has(path)) return;
  const p = deriveModelImage(path).finally(() => {
    inflight.delete(path);
    settled.add(path);
  });
  inflight.set(path, p);
}

// SYNC: the derived sibling when it exists on disk, else the original. For
// synchronous turn builders; an in-flight derivation is not waited for.
export function modelImagePath(path: string): string {
  if (!isDerivable(path)) return path;
  for (const s of siblingPaths(path)) {
    if (existsSync(s)) return s;
  }
  return path;
}

// Awaits an in-flight derivation (bounded), deriving on demand for an upload
// that predates this code. On-demand is fenced to ./uploads so nothing new is
// ever written next to a project file.
export async function awaitModelImage(path: string, timeoutMs = AWAIT_MODEL_IMAGE_MS): Promise<string> {
  if (!isDerivable(path)) return path;
  if (!inflight.has(path) && !settled.has(path) && modelImagePath(path) === path
    && dirname(resolve(path)) === resolve(UPLOADS_DIR) && existsSync(path)) {
    queueModelImage(path);
  }
  const pending = inflight.get(path);
  if (pending) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      pending,
      new Promise<void>((r) => { timer = setTimeout(r, timeoutMs); timer.unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
  }
  return modelImagePath(path);
}

export async function awaitModelImages(paths: readonly string[] | undefined, timeoutMs = AWAIT_MODEL_IMAGE_MS): Promise<void> {
  await Promise.all((paths ?? []).map((p) => awaitModelImage(p, timeoutMs)));
}

// Test seam: force tool re-detection (or none) and clear per-path memory.
export function __resetModelImageStateForTests(opts: { disableTool?: boolean } = {}): void {
  toolPromise = opts.disableTool ? Promise.resolve(null) : null;
  inflight.clear();
  settled.clear();
}
