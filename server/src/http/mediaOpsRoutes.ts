import { IncomingMessage, ServerResponse } from 'http';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { stat } from 'fs/promises';
import { extname } from 'path';
import type {
  MediaOpRequest,
  MediaOpResult,
  MediaOpResultMessage,
  MediaOpSpec,
  MediaScratchResult,
  MediaInspectRequest,
  MediaInspectResult,
  MediaStemsRequest,
  MediaStemsResult,
  MediaStemsResultMessage,
} from '@archon/shared';
import { runMediaOp, MediaOpError, resolveMediaInput, inspectMedia, type MediaAccess } from '../media/ffmpeg.js';
import { runDemucsStems, DemucsError } from '../media/demucs.js';
import { saveScratchUpload, ScratchError } from '../media/scratch.js';
import { readSettings } from '../settings.js';
import { broadcastWorkflow } from '../server/broadcast.js';
import { PORT } from '../server/constants.js';
import { resolveBoundCwd } from './writeConfinement.js';

// ── Media ops + guarded raw-media serve (Workbench Expansion §H6) ──
//
//   POST /api/media/op    { cwd?, workflowId?, path, spec }  → MediaOpResult
//   GET  /api/media/raw?path=&cwd=&workflowId=               → bytes (Range-able)
//
// /op runs a guarded FFmpeg media op — audio (§H6) OR video (§H7): see
// ../media/ffmpeg.ts — execFile argv only, typed-spec → args, output confined +
// never the source, cancel kills the child. The op is operator-initiated; on
// success/failure we broadcast a media_op_result so it persists to events.jsonl
// (audit trail, mirrors §I3 git).
//
// /raw is the read-only byte server: it confines `path` to cwd (the SAME
// resolveWithinCwd guard) and streams the file with a correct Content-Type + HTTP
// Range support (206), which is what lets an ON-DISK audio file render a waveform
// / seek and an ON-DISK video stream into <video> (§H7). No write, no exec.
//
// Always HTTP 200 with a structured body for an operator-visible condition
// (rejected escape, missing ffmpeg, ffmpeg failure); only an unexpected server
// bug is a 500. Wired AFTER the existing routes in router.ts (distinct prefix).

// Content-Type by extension for the raw serve. Audio + video (video is read-only
// playback prep for H7); unknown → octet-stream (the browser still streams it).
const MEDIA_MIME: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};

// Resolve the effective cwd tier. A workflowId binds to the server's registered
// cwd (the caller's cwd is ignored); without one the caller's cwd must be a
// known root (writeConfinement.ts). The old "explicit cwd wins" let `cwd: "/"`
// make every path tier-1 "inside cwd" AND pick which project settings.json
// decided the mediaUnconfined fence. Neither given → '' (scratch /
// unconfined-only, as before). Given but unbound → null: the caller rejects.
async function resolveCwd(cwd: string | undefined, workflowId: string | undefined): Promise<string | null> {
  const bound = await resolveBoundCwd(cwd, workflowId);
  if (bound.ok) return bound.cwd;
  return bound.reason === 'none' ? '' : null;
}

function send(res: ServerResponse, code: number, body: unknown): true {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

export async function tryHandleMediaOpsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url || '';

  // ── POST /api/media/op ──
  if (url.startsWith('/api/media/op') && req.method === 'POST') {
    let body: MediaOpRequest;
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      body = JSON.parse(raw || '{}') as MediaOpRequest;
    } catch {
      return send(res, 200, { ok: false, code: 'bad-spec', error: 'invalid JSON body' } satisfies MediaOpResult);
    }

    const cwd = await resolveCwd(body.cwd, body.workflowId);
    // N2 — cwd is OPTIONAL now: a general-tool op on a scratch / absolute path
    // carries none. The resolver rejects a RELATIVE path with no cwd, which is
    // the only case that truly needs one.
    if (typeof body.path !== 'string' || !body.path) {
      return send(res, 200, { ok: false, code: 'bad-path', error: 'path is required' } satisfies MediaOpResult);
    }
    if (cwd === null) {
      return send(res, 200, { ok: false, code: 'bad-path', error: 'cwd is not a known workflow or project directory' } satisfies MediaOpResult);
    }
    const spec = body.spec as MediaOpSpec;
    // N2 access fence — read the cascade value (a project settings.json can pin
    // it per-repo). Undefined ⇒ open; only an explicit `false` locks it.
    const unconfined = (await readSettings(cwd || undefined)).mediaUnconfined !== false;

    // Cancel seam: if the request socket closes (operator hit Cancel / nav away),
    // abort → the ffmpeg child is SIGKILLed and the partial output unlinked.
    const ac = new AbortController();
    req.on('close', () => ac.abort());

    try {
      const result = await runMediaOp(cwd, body.path, spec, {
        signal: ac.signal,
        unconfined,
        output: body.output,
      });
      // relPath is set only for an output inside the workflow cwd; otherwise the
      // absolute outputPath is the operator-facing location.
      const where = result.relPath || result.outputPath;
      broadcastResult(body.workflowId, spec.op, true, `${spec.op} → ${where}`, result.relPath || undefined);
      return send(res, 200, {
        ok: true,
        outputPath: result.outputPath,
        ...(result.relPath ? { relPath: result.relPath } : {}),
      } satisfies MediaOpResult);
    } catch (err) {
      if (err instanceof MediaOpError) {
        // A cancelled op already cleaned up; don't broadcast a failure for it
        // (the client initiated it). Other expected conditions ARE audited.
        if (err.code !== 'cancelled') {
          broadcastResult(body.workflowId, spec?.op, false, `${spec?.op ?? 'op'} failed: ${err.message}`);
        }
        return send(res, 200, { ok: false, code: err.code, error: err.message } satisfies MediaOpResult);
      }
      // Truly unexpected — a server bug, not an operator-visible condition.
      return send(res, 500, { ok: false, code: 'ffmpeg-failed', error: err instanceof Error ? err.message : String(err) } satisfies MediaOpResult);
    }
  }

  // ── POST /api/media/scratch?name=<basename> — stage an imported blob (N2) ──
  //
  // Streams the raw request body into Archon's media-scratch area so ffmpeg can
  // act on a picker-imported / drag-dropped file. Returns the absolute on-disk
  // path to feed straight back as a MediaOpRequest.path. Always allowed (the
  // operator put the file here themselves; bounded by per-upload + total caps).
  if (url.startsWith('/api/media/scratch') && req.method === 'POST') {
    const parsed = new URL(url, `http://localhost:${PORT}`);
    const name = parsed.searchParams.get('name');
    const ac = new AbortController();
    // Abort ONLY on a genuine client abort. 'close' also fires on normal
    // completion, and for a large upload the request socket can close before
    // the disk write flushes — `req.complete` is false only when the message
    // was NOT fully received, so it cleanly distinguishes an abort from a
    // finished upload (without it we'd delete a valid file mid-flush).
    req.on('close', () => { if (!req.complete) ac.abort(); });
    try {
      const r = await saveScratchUpload(req, name, ac.signal);
      return send(res, 200, { ok: true, path: r.path, basename: r.basename, bytes: r.bytes } satisfies MediaScratchResult);
    } catch (err) {
      if (err instanceof ScratchError) {
        return send(res, 200, { ok: false, code: err.code, error: err.message } satisfies MediaScratchResult);
      }
      return send(res, 500, { ok: false, code: 'write-failed', error: err instanceof Error ? err.message : String(err) } satisfies MediaScratchResult);
    }
  }

  // ── POST /api/media/stems — Demucs stem separation (N4) ──
  //
  // Long-running, GPU-accelerated; writes a FRESH dir of stem files. Operator-
  // initiated; success/failure broadcasts media_stems_result → events.jsonl.
  if (url.startsWith('/api/media/stems') && req.method === 'POST') {
    let body: MediaStemsRequest;
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      body = JSON.parse(raw || '{}') as MediaStemsRequest;
    } catch {
      return send(res, 200, { ok: false, code: 'bad-spec', error: 'invalid JSON body' } satisfies MediaStemsResult);
    }
    if (typeof body.path !== 'string' || !body.path) {
      return send(res, 200, { ok: false, code: 'bad-path', error: 'path is required' } satisfies MediaStemsResult);
    }
    const cwd = await resolveCwd(body.cwd, body.workflowId);
    if (cwd === null) {
      return send(res, 200, { ok: false, code: 'bad-path', error: 'cwd is not a known workflow or project directory' } satisfies MediaStemsResult);
    }
    const unconfined = (await readSettings(cwd || undefined)).mediaUnconfined !== false;

    // Cancel seam: socket close → SIGKILL the demucs child + rm the fresh dir.
    const ac = new AbortController();
    req.on('close', () => ac.abort());

    try {
      const result = await runDemucsStems(cwd, body.path, {
        signal: ac.signal,
        unconfined,
        model: body.model,
        twoStems: body.twoStems,
        format: body.format,
        output: body.output,
      });
      broadcastStems(body.workflowId, result.model ?? 'demucs', true, `stems → ${result.relDir || result.dir} (${result.stems?.length ?? 0})`, result.stems?.length ?? 0, result.relDir);
      return send(res, 200, result);
    } catch (err) {
      if (err instanceof DemucsError) {
        if (err.code !== 'cancelled') {
          broadcastStems(body.workflowId, body.model ?? 'demucs', false, `stems failed: ${err.message}`, 0);
        }
        return send(res, 200, { ok: false, code: err.code, error: err.message } satisfies MediaStemsResult);
      }
      return send(res, 500, { ok: false, code: 'demucs-failed', error: err instanceof Error ? err.message : String(err) } satisfies MediaStemsResult);
    }
  }

  // ── POST /api/media/inspect — read-only ffprobe metadata (N3) ──
  //
  // Returns curated stream/format JSON; writes NO file (so it's its own endpoint,
  // not a MediaOpSpec). `path` is gated by the SAME access fence as an op input.
  if (url.startsWith('/api/media/inspect') && req.method === 'POST') {
    let body: MediaInspectRequest;
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      body = JSON.parse(raw || '{}') as MediaInspectRequest;
    } catch {
      return send(res, 200, { ok: false, code: 'bad-path', error: 'invalid JSON body' } satisfies MediaInspectResult);
    }
    if (typeof body.path !== 'string' || !body.path) {
      return send(res, 200, { ok: false, code: 'bad-path', error: 'path is required' } satisfies MediaInspectResult);
    }
    const cwd = await resolveCwd(body.cwd, body.workflowId);
    if (cwd === null) {
      return send(res, 200, { ok: false, code: 'bad-path', error: 'cwd is not a known workflow or project directory' } satisfies MediaInspectResult);
    }
    const unconfined = (await readSettings(cwd || undefined)).mediaUnconfined !== false;
    const access: MediaAccess = { cwd: cwd || undefined, unconfined };
    const result = await inspectMedia(access, body.path);
    return send(res, 200, result);
  }

  // ── GET /api/media/raw — read-only, fence-gated, Range-able ──
  if (url.startsWith('/api/media/raw') && req.method === 'GET') {
    try {
      const parsed = new URL(url, `http://localhost:${PORT}`);
      const rel = parsed.searchParams.get('path') || '';
      const cwd = await resolveCwd(parsed.searchParams.get('cwd') || undefined, parsed.searchParams.get('workflowId') || undefined);
      if (!rel) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('path is required');
        return true;
      }
      if (cwd === null) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('cwd is not a known workflow or project directory');
        return true;
      }
      // THE gate — same tiered resolver as the op (cwd | scratch | unconfined).
      // A '../' / absolute-outside path with the fence locked throws → 403.
      const unconfined = (await readSettings(cwd || undefined)).mediaUnconfined !== false;
      const access: MediaAccess = { cwd: cwd || undefined, unconfined };
      let abs: string;
      try {
        abs = resolveMediaInput(access, rel);
      } catch {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('path is outside the workflow folder (enable Unconfined media access to reach arbitrary paths)');
        return true;
      }

      let st;
      try {
        st = await stat(abs);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return true;
      }
      if (!st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not a file');
        return true;
      }

      const mime = MEDIA_MIME[extname(abs).toLowerCase()] || 'application/octet-stream';
      const total = st.size;
      const range = req.headers.range;

      // Range request → 206 partial content (needed for <audio>/<video> seeking
      // and wavesurfer's chunked fetch).
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (m) {
          let start = m[1] ? parseInt(m[1], 10) : 0;
          let end = m[2] ? parseInt(m[2], 10) : total - 1;
          if (Number.isNaN(start)) start = 0;
          if (Number.isNaN(end) || end >= total) end = total - 1;
          if (start > end || start >= total) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` });
            res.end();
            return true;
          }
          res.writeHead(206, {
            'Content-Type': mime,
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          });
          streamToResponse(createReadStream(abs, { start, end }), res);
          return true;
        }
      }

      // No / unparseable Range → whole file, advertising Range support.
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      streamToResponse(createReadStream(abs), res);
      return true;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(err instanceof Error ? err.message : String(err));
      return true;
    }
  }

  return false;
}

// pipeline, not .pipe(): .pipe() never destroys the source when the client
// disconnects, so every aborted Range request (a <video> seek aborts the prior
// one) leaked an open fd until EMFILE. pipeline tears both ends down on
// either side's error/close. The rejection is the expected client abort.
function streamToResponse(src: ReturnType<typeof createReadStream>, res: ServerResponse): void {
  pipeline(src, res).catch(() => { /* client aborted / read error — both ends already destroyed */ });
}

// Broadcast the op outcome to the workflow channel → persisted to events.jsonl
// (Activity / HISTORY marker). Skipped when there's no workflowId (a cwd-only
// call has no channel).
function broadcastResult(
  workflowId: string | undefined,
  op: MediaOpSpec['op'] | undefined,
  ok: boolean,
  summary: string,
  relPath?: string,
): void {
  if (!workflowId || !op) return;
  const event: MediaOpResultMessage = {
    type: 'media_op_result',
    workflowId,
    op,
    ok,
    summary,
    ...(relPath ? { relPath } : {}),
    ts: Date.now(),
  };
  broadcastWorkflow(workflowId, event);
}

// Broadcast a stems run outcome (N4) → events.jsonl. Skipped when there's no
// workflowId (a cwd-only general-tool call has no channel).
function broadcastStems(
  workflowId: string | undefined,
  model: string,
  ok: boolean,
  summary: string,
  count: number,
  relDir?: string,
): void {
  if (!workflowId) return;
  const event: MediaStemsResultMessage = {
    type: 'media_stems_result',
    workflowId,
    ok,
    model,
    count,
    summary,
    ...(relDir ? { relDir } : {}),
    ts: Date.now(),
  };
  broadcastWorkflow(workflowId, event);
}
