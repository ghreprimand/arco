// WORKBENCH_EXPANSION §H4 — pure helpers for persisting a Codex app-server
// `image_generation_call` (`imageGeneration` thread item) into the workflow cwd.
//
// The Codex app-server surfaces an `imageGeneration` ThreadItem when the model
// runs an `image_generation_call`. The item carries either:
//   - `savedPath`: an absolute path the app-server already wrote the image to, OR
//   - `result`: base64-encoded image bytes we must decode + write ourselves.
//
// This module is the PURE, side-effect-light core (decode + confine + name). The
// worker wraps it with the actual async fs write so the persist logic is unit-
// testable WITHOUT booting an app-server child (see scripts/smoke/image-gen-codex.ts).
//
// LIVE-SHAPE CAVEAT: the manual flags the `image_generation_call` RPC shape as
// "unproven". The binding (`bindings/v2/ThreadItem.ts`) is the contract we code
// against; this is validated against a captured/synthetic fixture pending a live
// operator Codex generation run. Do not claim live verification.
//
// NO subprocess / NO shell — every path is confined with resolveWithinCwd.

import { relative, isAbsolute } from 'path';
import { resolveWithinCwd } from '../ollamaTools.js';

// The `imageGeneration` arm of the ThreadItem union, narrowed for the helpers.
export interface ImageGenerationItem {
  type: 'imageGeneration';
  id: string;
  status: string;
  revisedPrompt: string | null;
  result: string;
  savedPath?: string;
}

// Decoded-payload cap — refuse anything larger so a runaway base64 blob can't
// allocate an unbounded Buffer. Mirrors imageWriteRoutes' MAX_DECODED_BYTES.
export const MAX_GENERATED_IMAGE_BYTES = 64 * 1024 * 1024;

// PNG magic bytes — the Codex `image_generation_call.result` is PNG in practice.
// We default the generated filename to .png; the sniff is best-effort (we still
// write whatever bytes came back, named .png) — generated images are raster PNGs.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type ResolveResult =
  | {
      // The app-server already wrote the image; surface its in-cwd relative path.
      // No bytes to write — `buf` is absent.
      ok: true;
      source: 'savedPath';
      relPath: string;
      abs: string;
    }
  | {
      // We must decode `result` and write `buf` to `abs` (relPath is cwd-relative).
      ok: true;
      source: 'decoded';
      relPath: string;
      abs: string;
      buf: Buffer;
    }
  | {
      // Nothing usable — structured failure, NEVER throws out to the caller.
      ok: false;
      reason: string;
    };

// Decode the base64 `result` payload defensively. Returns the Buffer, or null on
// empty / over-cap / undecodable input. Codex sends raw base64 (no data-URL
// prefix); we tolerate a `data:...;base64,` prefix too in case the shape drifts.
export function decodeGeneratedImage(result: unknown): Buffer | null {
  if (typeof result !== 'string' || result.length === 0) return null;
  let payload = result;
  const dataUrl = /^data:[a-z0-9.+/-]+;base64,(.*)$/is.exec(result);
  if (dataUrl) payload = dataUrl[1];
  if (!payload) return null;
  // Cheap pre-check before allocating (base64 inflates ~4/3).
  if ((payload.length / 4) * 3 > MAX_GENERATED_IMAGE_BYTES + 1024) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(payload, 'base64');
  } catch {
    return null;
  }
  // Buffer.from is lenient (silently drops invalid chars); guard an effectively
  // empty decode of a non-empty payload.
  if (buf.length === 0) return null;
  return buf;
}

// Best-effort: are these bytes a PNG? Used only to keep the .png default honest;
// non-PNG bytes are still written (named .png) — generated images are PNG.
export function looksLikePng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
}

// Generate a confined, unique-ish filename for a decoded image. `id` is the item
// id; we shorten it. Suffix added by the caller on a collision (handled by the
// fs-write wrapper, which retries). Pure — no fs.
export function generatedImageRelPath(id: string, suffix = ''): string {
  const shortId = (id || 'image').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'image';
  return `codex-image-${shortId}${suffix}.png`;
}

// THE core resolve. Decides where the generated image should live, confined to
// `cwd`. Never throws — a path escape / malformed payload becomes `{ ok:false }`.
//
//   - savedPath present + inside cwd  → surface that in-cwd relative path (no write).
//   - savedPath present + escapes cwd → fall through to decoding `result` and
//     writing a confined copy (so we never surface an out-of-cwd path); if
//     `result` is also unusable, fail.
//   - no savedPath                    → decode `result`, write to a confined name.
//   - nothing usable                  → fail.
export function resolveGeneratedImageTarget(cwd: string, item: ImageGenerationItem): ResolveResult {
  if (!cwd) return { ok: false, reason: 'no workflow cwd bound' };

  // 1. Prefer an app-server-written path IF it's inside the workflow cwd.
  if (typeof item.savedPath === 'string' && item.savedPath.length > 0) {
    try {
      const abs = resolveWithinCwd(cwd, item.savedPath);
      const relPath = relative(cwd, abs);
      // Defensive: relative() should never produce an escape here (resolveWithinCwd
      // already threw on one), but never surface an absolute/`..` path.
      if (relPath && !relPath.startsWith('..') && !isAbsolute(relPath)) {
        return { ok: true, source: 'savedPath', relPath, abs };
      }
    } catch {
      // savedPath escapes cwd — fall through to decode+copy the bytes in-cwd
      // rather than surfacing an out-of-cwd path.
    }
  }

  // 2. Decode the base64 result and write a confined copy.
  const buf = decodeGeneratedImage(item.result);
  if (!buf) {
    return {
      ok: false,
      reason:
        typeof item.savedPath === 'string' && item.savedPath.length > 0
          ? 'savedPath escapes cwd and result is missing/undecodable'
          : 'result is missing/empty/undecodable',
    };
  }

  const relPath = generatedImageRelPath(item.id);
  let abs: string;
  try {
    abs = resolveWithinCwd(cwd, relPath);
  } catch (err) {
    // Should be impossible (we built relPath from a sanitized id), but fail
    // closed rather than throw.
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, source: 'decoded', relPath, abs, buf };
}

// Title for the artifact + tool_use, from the revised prompt when present.
export function generatedImageTitle(item: ImageGenerationItem): string {
  const p = item.revisedPrompt?.trim();
  return p && p.length > 0 ? p : 'Generated image';
}

// Is this a successful generation per the item status? Codex uses 'completed' /
// 'failed'; treat anything non-failure as eligible (the resolve step still gates
// on actually having usable bytes/path).
export function isGenerationFailure(status: string): boolean {
  const s = (status || '').toLowerCase();
  return s === 'failed' || s === 'error' || s === 'cancelled' || s === 'canceled';
}
