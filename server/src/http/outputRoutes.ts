import { openCheckedFile } from '../checkedFile.js';
import { constants, createReadStream } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkflowOutput } from '@arco/shared';
import { getClusterCached, displayNameFor } from '../clusterStore.js';
import { listOutputs, outputContext, readOutput, saveOutputText, transferOutput } from '../outputs.js';
import { outputDirectory, readOutputIndex } from '../outputStore.js';
import { keepCovering, readKeep } from '../keepStore.js';
import path from 'node:path';
import { readFileForExplorer } from '../http/fileRead.js';
import { REFUSED_EXTENSIONS, desktopOpenAvailable, isLoopbackAddress, launchOpener, openerCommand, refusalFor } from './outputOpen.js';
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
function json(res: ServerResponse, status: number, body: unknown): true { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); return true; }
async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  req.setEncoding('utf8');
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 3 * 1024 * 1024) throw new Error('Output request is too large.'); }
  const body = JSON.parse(text || '{}');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid output request.');
  return body;
}
export async function tryHandleOutputRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://localhost');
  if (!['/api/outputs', '/api/outputs/file', '/api/outputs/content', '/api/outputs/transfer', '/api/outputs/text', '/api/outputs/open'].includes(url.pathname)) return false;
  try {
    if (url.pathname === '/api/outputs' && req.method === 'GET') {
      const clusterId = url.searchParams.get('clusterId');
      const contexts = clusterId ? await (async () => {
        const cluster = getClusterCached(clusterId);
        if (!cluster) throw new Error('Cluster is unavailable.');
        const rows = await Promise.allSettled(cluster.members.map(async workflowId => ({ ...await outputContext(cluster.cwd, workflowId), producer: displayNameFor(workflowId) })));
        return rows.flatMap(row => row.status === 'fulfilled' ? [row.value] : []);
      })() : [await outputContext(url.searchParams.get('cwd') || undefined, url.searchParams.get('workflowId') || '')];
      // Keep the response bounded while considering every member. Process
      // stores sequentially so inline caches do not accumulate in memory.
      let combined: WorkflowOutput[] = [];
      let count = 0;
      for (const ctx of contexts) {
        const rows = await listOutputs(ctx); count += rows.length;
        const keptBy = await keptLookup(ctx.cwd, ctx.workflowId);
        combined.push(...rows.map(row => ({ ...row, producer: ctx.producer, ...(row.inline ? { inline: { content: '', language: row.inline.language } } : {}), ...keptBy(row.path) })));
        combined.sort((a, b) => b.updatedAt - a.updatedAt); combined = combined.slice(0, 2000);
      }
      return json(res, 200, { outputs: combined, truncated: count > 2000, limit: 2000, desktopOpen: desktopOpenAvailable(), refusedExtensions: REFUSED_EXTENSIONS, coverage: 'Workflow artifacts, path-backed artifacts, supported Write/Edit events, and scoped editor/media exports. Other changed files are not classified as generated.' });
    }
    if (['/api/outputs/file', '/api/outputs/content'].includes(url.pathname) && req.method === 'GET') {
      const ctx = await outputContext(url.searchParams.get('cwd') || undefined, url.searchParams.get('workflowId') || '');
      const id = url.searchParams.get('id') || '';
      if (url.pathname === '/api/outputs/content') {
        const inline = (await readOutputIndex(ctx.cwd, ctx.workflowId)).entries.find(entry => entry.id === id)?.inline;
        if (inline) return json(res, 200, { type: 'text', content: inline.content, size: Buffer.byteLength(inline.content) });
      }
      const { entry, file } = await readOutput(ctx, id);
      if (url.pathname === '/api/outputs/content') return json(res, 200, await readFileForExplorer(file));
      const handle = await openCheckedFile(file);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('Output is not a regular file.');
        const ext = entry.name.split('.').pop()?.toLowerCase() || '';
        // Active formats and unknown binaries are downloads, never executable previews.
        const preview = url.searchParams.get('download') !== '1' && !!MIME[ext];
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
        if (range && (start > end || start >= info.size)) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return true; }
        res.writeHead(range ? 206 : 200, { 'Content-Type': preview ? MIME[ext] : 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(entry.name)}`, 'Accept-Ranges': 'bytes', 'Content-Length': range ? end - start + 1 : info.size, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}) });
        if (info.size) await pipeline(createReadStream('', { fd: handle.fd, autoClose: false, emitClose: false, start, end }), res); else res.end();
        return true;
      } finally { await handle.close(); }
    }
    if (url.pathname === '/api/outputs/open' && req.method === 'POST') {
      if (!isLoopbackAddress(req.socket.remoteAddress)) return json(res, 403, { error: 'Files open only from the computer Arco runs on.' });
      if (!desktopOpenAvailable()) return json(res, 409, { error: 'This Arco has no desktop to open files on. Use Download instead.' });
      const body = await bodyOf(req);
      const ctx = await outputContext(typeof body.cwd === 'string' ? body.cwd : undefined, String(body.workflowId || ''));
      const { entry, file } = await readOutput(ctx, String(body.id || ''));
      const refusal = refusalFor(entry.name) || refusalFor(file);
      if (refusal) return json(res, 403, { error: refusal });
      const info = await lstat(file);
      if (!info.isFile()) throw new Error('Output is not a regular file.');
      console.log(`[arco] Output opened in the default app: workflow=${ctx.workflowId} output=${entry.id} name=${entry.name}`);
      await launchOpener(openerCommand(process.platform, file));
      return json(res, 200, { ok: true });
    }
    if (['/api/outputs/transfer', '/api/outputs/text'].includes(url.pathname) && req.method === 'POST') {
      const body = await bodyOf(req);
      const ctx = await outputContext(typeof body.cwd === 'string' ? body.cwd : undefined, String(body.workflowId || ''));
      if (url.pathname === '/api/outputs/text') { if (typeof body.content !== 'string') throw new Error('Text content is required.'); await saveOutputText(ctx, String(body.id || ''), body.content); }
      else {
        if (body.action !== 'copy' && body.action !== 'move') throw new Error('Choose Copy or Move explicitly.');
        await transferOutput(ctx, String(body.id || ''), String(body.destination || ''), body.action === 'move', undefined, typeof body.sourcePath === 'string' ? body.sourcePath : undefined);
      }
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'Method not allowed.' });
  } catch (err) {
    if (res.headersSent) { res.destroy(); return true; }
    const code = (err as NodeJS.ErrnoException).code;
    return json(res, code === 'ENOENT' ? 404 : code === 'EEXIST' ? 409 : 400, { error: code === 'EEXIST' ? 'A file already exists at the destination. Choose another name.' : err instanceof Error ? err.message : 'The output request failed.' });
  }
}

// KEEP marks for one conversation's artifacts, read once per listing. An
// unreadable or missing list marks nothing (UNKEEP then reports the problem).
async function keptLookup(cwd: string, workflowId: string): Promise<(file?: string) => { keptBy?: string }> {
  try {
    const dir = await outputDirectory(cwd, workflowId);
    const keep = await readKeep(dir);
    if (!keep.ok || keep.items.length === 0) return () => ({});
    return (file) => {
      if (!file) return {};
      const rel = path.relative(dir, file).split(path.sep).join('/');
      if (!rel.startsWith('artifacts/')) return {};
      const by = keepCovering(keep.items, rel);
      return by === null ? {} : { keptBy: by };
    };
  } catch { return () => ({}); }
}
