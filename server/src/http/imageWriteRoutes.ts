import { IncomingMessage, ServerResponse } from 'http';
import { writeFile, stat, mkdir } from 'fs/promises';
import { dirname, extname, relative } from 'path';
import type { ImageWriteRequest, ImageWriteResult } from '@arco/shared';
import { broadcastWorkflow } from '../server/broadcast.js';
import { outputContext, outputDestination, resolveTrackedOutput, trackEditorOutput } from '../outputs.js';
import { boundCwdError, confineRealPath, resolveBoundCwd } from './writeConfinement.js';

// ── Guarded raster-image WRITE endpoint (Workbench Expansion §H2 part 1) ──────
//
//   POST /api/image/write   { cwd?, workflowId?, path, dataUrl, overwrite? }  → ImageWriteResult
//
// The server-side foundation the H2 image editor SAVES through (the big editor-UI
// port is a separate later phase). The editor encodes its canvas to a
// `data:image/<png|jpeg|webp>;base64,…` URL and POSTs it here. This route decodes
// the payload, confines the target path to the workflow cwd, enforces an image
// extension, and writes — refusing to clobber an existing file unless `overwrite`.
//
// NO subprocess, NO shell — pure fs. The load-bearing fences are:
//   (1) resolveWithinCwd — THE confinement gate. A '../' / absolute-outside /
//       trailing-sep-sibling path throws → rejected before any write touches disk
//       (same guard as the Write tools / media ops), plus a realpath re-check
//       so an in-cwd symlink pointing out is refused (writeConfinement.ts).
//   (2) overwrite-confirm — an existing target is NEVER replaced unless the caller
//       passes overwrite:true. A brand-new filename writes unconditionally.
//   (3) a decoded-size cap — a runaway data URL can't OOM the server.
//
// Always HTTP 200 with a structured body for an operator-visible condition
// (path escape, existing-file refusal, malformed/oversize data URL, missing cwd);
// only an unexpected server bug is a 500. Wired AFTER fileWrite/mediaOps in
// router.ts (distinct /api/image/ prefix, so no collision).

// Decoded-payload cap — reject anything larger so a malicious/runaway data URL
// can't allocate an unbounded Buffer. 64 MiB is generous for a raster save.
const MAX_DECODED_BYTES = 64 * 1024 * 1024;

// Supported image extensions ↔ the data-URL mime they must agree with. The
// extension is the on-disk truth (what the file gets named); we also require the
// data-URL mime to be one of these so the bytes match the name. We do NOT force a
// strict mime↔ext pairing (e.g. .jpg vs image/jpeg) — the extension just has to be
// an image type and the mime an image type.
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function send(res: ServerResponse, code: number, body: unknown): true {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

// Parse a `data:image/<type>;base64,<payload>` URL defensively. Returns the
// decoded Buffer + mime, or null on anything malformed / non-image / non-base64.
function parseImageDataUrl(dataUrl: unknown): { buf: Buffer; mime: string } | null {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) return null;
  // data:<mime>[;<params>];base64,<payload> — require base64 + an image mime.
  const m = /^data:([a-z]+\/[a-z0-9.+-]+)(;[^,]*)?;base64,(.*)$/is.exec(dataUrl);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!IMAGE_MIMES.has(mime)) return null;
  const payload = m[3];
  if (!payload) return null;
  // Reject before allocating if the base64 length implies an over-cap decode
  // (base64 inflates ~4/3, so decoded ≈ len * 3 / 4). Cheap pre-check.
  if (payload.length / 4 * 3 > MAX_DECODED_BYTES + 1024) return { buf: Buffer.alloc(0), mime: '__too_large__' };
  let buf: Buffer;
  try {
    buf = Buffer.from(payload, 'base64');
  } catch {
    return null;
  }
  // Buffer.from is lenient on bad base64 (silently drops invalid chars); guard
  // against an effectively-empty decode of a non-empty payload.
  if (buf.length === 0) return null;
  return { buf, mime };
}

export async function tryHandleImageWriteRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url || '';

  if (!(url.startsWith('/api/image/write') && req.method === 'POST')) return false;

  let body: ImageWriteRequest;
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw || '{}') as ImageWriteRequest;
  } catch {
    return send(res, 200, { ok: false, code: 'bad-image', error: 'invalid JSON body' } satisfies ImageWriteResult);
  }

  // A workflowId binds to the server's registered cwd (body.cwd ignored); with
  // none, body.cwd must be a known root. The old "explicit cwd wins" let
  // `cwd: "/"` confine against nothing. See writeConfinement.ts.
  const bound = await resolveBoundCwd(body.cwd, body.workflowId);
  if (!bound.ok) {
    return send(res, 200, { ok: false, code: 'no-cwd', error: boundCwdError(bound.reason) } satisfies ImageWriteResult);
  }
  const cwd = bound.cwd;
  if (typeof body.path !== 'string' || !body.path) {
    return send(res, 200, { ok: false, code: 'bad-path', error: 'path is required' } satisfies ImageWriteResult);
  }

  // (1) THE confinement gate — same guard as the Write tools / media ops. A '../'
  // / absolute-outside / trailing-sep-sibling path throws → rejected before any
  // write touches disk.
  let abs: string;
  try {
    const tracked = body.workflowId && body.sourcePath ? await resolveTrackedOutput(cwd, body.workflowId, body.sourcePath).catch(() => null) : null;
    abs = tracked ? await outputDestination(await outputContext(cwd, body.workflowId!), body.path) : await confineRealPath(cwd, body.path);
  } catch (err) {
    return send(res, 200, { ok: false, code: 'path-escape', error: err instanceof Error ? err.message : String(err) } satisfies ImageWriteResult);
  }

  // The on-disk name must carry an image extension (the bytes get named this).
  const ext = extname(abs).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) {
    return send(res, 200, { ok: false, code: 'bad-ext', error: `target must be an image file (${[...IMAGE_EXTS].join(', ')})` } satisfies ImageWriteResult);
  }

  // Parse + size-guard the data URL.
  const parsed = parseImageDataUrl(body.dataUrl);
  if (!parsed) {
    return send(res, 200, { ok: false, code: 'bad-image', error: 'dataUrl must be a base64 data:image/(png|jpeg|webp) URL' } satisfies ImageWriteResult);
  }
  // (3) decoded-size cap — set on the cheap pre-check OR the real decode.
  if (parsed.mime === '__too_large__' || parsed.buf.length > MAX_DECODED_BYTES) {
    return send(res, 200, { ok: false, code: 'too-large', error: `decoded image exceeds ${MAX_DECODED_BYTES} bytes` } satisfies ImageWriteResult);
  }

  // (2) overwrite-confirm — an existing target is never replaced unless the caller
  // explicitly opts in. A brand-new filename falls through and writes.
  let exists = false;
  try {
    const st = await stat(abs);
    exists = st.isFile() || st.isDirectory() || st.isSymbolicLink();
  } catch {
    exists = false; // ENOENT → new file
  }
  if (exists && body.overwrite !== true) {
    return send(res, 200, { ok: false, code: 'exists', error: 'file exists; pass overwrite:true to replace' } satisfies ImageWriteResult);
  }

  try {
    // Create the (confined) parent dir if the target is in a new subfolder —
    // mirrors fileWriteRoutes. dirname(abs) is already inside cwd (abs passed the
    // resolveWithinCwd gate), so the mkdir can't escape.
    const parent = dirname(abs);
    if (parent && parent !== cwd) await mkdir(parent, { recursive: true });
    await writeFile(abs, parsed.buf);
  } catch (err) {
    // A write failure on an already-confined path is operator-visible (e.g. the
    // target is a directory, or a permissions issue) — structured, not a 500.
    return send(res, 200, { ok: false, code: 'write-failed', error: err instanceof Error ? err.message : String(err) } satisfies ImageWriteResult);
  }

  if (body.workflowId) {
    broadcastWorkflow(body.workflowId, { type: 'output_saved', workflowId: body.workflowId, path: abs, sourcePath: body.sourcePath, ts: Date.now() });
    await trackEditorOutput(cwd, body.workflowId, abs, body.sourcePath).catch(() => { /* persisted event reconciles on refresh */ });
  }
  const relPath = relative(cwd, abs);
  return send(res, 200, { ok: true, relPath, bytes: parsed.buf.length } satisfies ImageWriteResult);
}
