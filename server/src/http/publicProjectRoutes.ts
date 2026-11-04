// /api/public-project -- guardrails for public projects (server/src/publicProject.ts).
//   GET  /api/public-project/remote?path=...        -> { state: 'none' | 'hosted' | 'public', host? }
//   GET  /api/public-project/state?path=...         -> project state report
//   POST /api/public-project/restore-ignore { path } -> { ok, backup? }
//   POST /api/public-project/stop-tracking { path }  -> { ok, removed }
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { IncomingMessage, ServerResponse } from 'http';
import { assertSafePath } from '../fileAccessPolicy.js';
import { checkProjectState, restoreIgnoreFile, stopTrackingState, suggestFromRemote } from '../publicProject.js';

function sendJson(res: ServerResponse, code: number, body: unknown): true {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

function validDir(value: unknown): string | null {
  if (typeof value !== 'string' || !isAbsolute(value)) return null;
  try { assertSafePath(value); return statSync(value).isDirectory() ? value : null; } catch { return null; }
}

async function readPath(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16 * 1024) return null;
    chunks.push(chunk as Buffer);
  }
  try { return (JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { path?: unknown }).path; } catch { return null; }
}

export async function tryHandlePublicProjectRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/public-project/')) return false;
  const action = url.pathname.slice('/api/public-project/'.length);
  try {
    if (req.method === 'GET' && (action === 'remote' || action === 'state')) {
      const cwd = validDir(url.searchParams.get('path'));
      if (!cwd) return sendJson(res, 400, { error: 'Choose an existing project folder.' });
      return sendJson(res, 200, action === 'remote' ? await suggestFromRemote(cwd) : await checkProjectState(cwd));
    }
    if (req.method === 'POST' && (action === 'restore-ignore' || action === 'stop-tracking')) {
      const cwd = validDir(await readPath(req));
      if (!cwd) return sendJson(res, 400, { error: 'Choose an existing project folder.' });
      if (action === 'restore-ignore') return sendJson(res, 200, { ok: true, ...restoreIgnoreFile(cwd) });
      return sendJson(res, 200, await stopTrackingState(cwd));
    }
  } catch (err) {
    return sendJson(res, 500, { error: err instanceof Error ? err.message : 'failed' });
  }
  return sendJson(res, 404, { error: 'not found' });
}
