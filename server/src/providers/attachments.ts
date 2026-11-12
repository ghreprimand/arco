import { managedUploadPath } from '../uploadImages.js';
import { readFileContent, fileHeaderKind, isSvgPrefix } from '../fileContent.js';
import { readRegularPrefix } from '../boundedRead.js';
// Shared operator-attachment helpers for providers that don't carry their own

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'fs';
import { rename, unlink, writeFile } from 'fs/promises';
import { dirname, extname, join, resolve } from 'path';
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
  '.heic': 'image/heic',
  '.heif': 'image/heic',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.bmp': 'image/bmp',
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

// Model-side image fitting uses the shared portable decoder. Original uploads
// are optimized at upload time; compatible derived siblings serve model input
// on every OS without further changes to the retained upload.
export const MODEL_IMAGE_MAX_EDGE = 2000;
// Anthropic's 5 MB cap is on the base64 string: 3.75 MB raw.
export const MODEL_IMAGE_MAX_RAW_BYTES = Math.floor((5 * 1024 * 1024) / 4) * 3;
const MODEL_TAG = '.model';
// Bounded so a stuck resize can't hold a turn hostage; a late copy still lands
// for the next turn.
const AWAIT_MODEL_IMAGE_MS = 5_000;
const DERIVED_RE = /\.model\.(png|jpe?g|webp)$/i;
function isDerivable(path: string): boolean { return !DERIVED_RE.test(path); }
function siblingPaths(path: string): string[] {
  return [...new Set([`${path}${MODEL_TAG}${extname(path).toLowerCase()}`, `${path}${MODEL_TAG}.png`, `${path}${MODEL_TAG}.jpg`])];
}

// The portable decoder verifies and fits pixels without external programs.
// The upload caller owns the directory; on-demand callers are still fenced
// to uploads below. Read tools never call this sibling-writing adapter.
export async function deriveModelImage(path: string): Promise<string | null> {
  const canonical = managedUploadPath(path);
  if (!isDerivable(path) || !canonical) return null;
  let tmp: string | undefined;
  try {
    const prefix = await readRegularPrefix(canonical, 4096);
    const originalType = fileHeaderKind(prefix.buffer);
    if (!originalType.startsWith('image/') && !(originalType === 'text/plain' && (/\.svg$/i.test(path) || isSvgPrefix(prefix.buffer)))) return null;
    const result = await readFileContent(canonical, { limits: { images: true, documents: false, maxImageEdge: MODEL_IMAGE_MAX_EDGE, maxImageBase64Bytes: 5 * 1024 * 1024 } });
    const image = result.blocks.find(b => b.type === 'image');
    if (!image || image.type !== 'image') return null;
    // Valid, already-small API formats need no extra file. A decoded result
    // proves validity; the receipt records whether the pixels were scaled.
    if (['image/png','image/jpeg','image/gif','image/webp'].includes(originalType)
      && prefix.size <= MODEL_IMAGE_MAX_RAW_BYTES && !result.text.includes('; scaled from ')) return null;
    const suffix = image.mediaType === 'image/jpeg' ? '.jpg' : '.png';
    const out = `${canonical}${MODEL_TAG}${suffix}`;
    tmp = `${out}.tmp-${process.pid}-${Math.random().toString(36).slice(2,8)}`;
    if (managedUploadPath(canonical) !== canonical) return null;
    await writeFile(tmp, Buffer.from(image.data,'base64'), {flag:'wx',mode:0o600});
    if (managedUploadPath(canonical) !== canonical || managedUploadPath(tmp) !== tmp) return null;
    await rename(tmp,out);
    return out;
  } catch { return null; }
  finally { if(tmp && managedUploadPath(tmp) === tmp) await unlink(tmp).catch(()=>{}); }
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
function isUploadDirectory(dir: string): boolean {
  try {
    const root = lstatSync(UPLOADS_DIR);
    return root.isDirectory() && !root.isSymbolicLink() && realpathSync(UPLOADS_DIR) === realpathSync(dir);
  } catch { return false; }
}

export async function awaitModelImage(path: string, timeoutMs = AWAIT_MODEL_IMAGE_MS): Promise<string> {
  if (!isDerivable(path)) return path;
  if (!inflight.has(path) && !settled.has(path) && modelImagePath(path) === path
    && isUploadDirectory(dirname(resolve(path))) && existsSync(path)) {
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

// Test seam: clear per-path memory. Codec verification uses externalPrograms:false.
export function __resetModelImageStateForTests(): void {
  inflight.clear();
  settled.clear();
}
