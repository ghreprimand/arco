import { constants, createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkflowOutput } from '@arco/shared';
import { getClusterCached, displayNameFor } from '../clusterStore.js';
import { listOutputs, outputContext, readOutput, saveOutputText, transferOutput } from '../outputs.js';
import { readOutputIndex } from '../outputStore.js';
import { readFileForExplorer } from '../http/fileRead.js';
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
  if (!['/api/outputs', '/api/outputs/file', '/api/outputs/content', '/api/outputs/transfer', '/api/outputs/text'].includes(url.pathname)) return false;
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
        combined.push(...rows.map(row => ({ ...row, producer: ctx.producer, ...(row.inline ? { inline: { content: '', language: row.inline.language } } : {}) })));
        combined.sort((a, b) => b.updatedAt - a.updatedAt); combined = combined.slice(0, 2000);
      }
      return json(res, 200, { outputs: combined, truncated: count > 2000, limit: 2000, coverage: 'Workflow artifacts, path-backed artifacts, supported Write/Edit events, and scoped editor/media exports. Other changed files are not classified as generated.' });
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
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
