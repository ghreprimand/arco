// /api/public-project -- guardrails for public projects (server/src/publicProject.ts).
//   GET  /api/public-project/choice?path=...        -> { choice: boolean | null }
//   POST /api/public-project/choice { path, value }  -> { choice: boolean }
//   GET  /api/public-project/remote?path=...        -> { state: 'none' | 'hosted' | 'public', host? }
//   GET  /api/public-project/state?path=...         -> project state report
//   POST /api/public-project/restore-ignore { path } -> { ok, backup? }
//   POST /api/public-project/stop-tracking { path }  -> { ok, removed }
// The two POST actions change a project: they take registered projects only
// (403 otherwise) and refuse a linked .arco or .arco/.gitignore (409).
import { lstatSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { IncomingMessage, ServerResponse } from 'http';
import { assertSafePath, safeDirectory } from '../fileAccessPolicy.js';
import { checkProjectState, restoreIgnoreFile, stopTrackingState, suggestFromRemote } from '../publicProject.js';
import { realpathWithinProjects } from '../projects.js';
import { getPublicProjectChoice, setPublicProjectChoice } from '../publicProjectChoice.js';

function sendJson(res: ServerResponse, code: number, body: unknown): true {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

function validDir(value: unknown): string | null {
  if (typeof value !== 'string' || !isAbsolute(value)) return null;
  try { return safeDirectory(value); } catch { return null; }
}

// A link at .arco or .arco/.gitignore would make RESTORE IGNORE FILE write, or
// STOP TRACKING act, somewhere other than the project's own state folder.
function linkedStateReason(cwd: string): string | null {
  for (const [p, label] of [[join(cwd, '.arco'), 'The project state folder .arco'], [join(cwd, '.arco', '.gitignore'), 'The file .arco/.gitignore']] as const) {
    try { if (lstatSync(p).isSymbolicLink()) return `${label} is a link; Arco does not follow it. Replace it with a real folder or file first.`; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return `${label} cannot be checked.`; }
  }
  return null;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16 * 1024) return null;
    chunks.push(chunk as Buffer);
  }
  try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8')); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}

export async function tryHandlePublicProjectRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/public-project/')) return false;
  const action = url.pathname.slice('/api/public-project/'.length);
  try {
    if (req.method === 'GET' && action === 'choice') {
      const cwd = validDir(url.searchParams.get('path'));
      if (!cwd) return sendJson(res, 400, { error: 'Choose an existing project folder.' });
      return sendJson(res, 200, { choice: await getPublicProjectChoice(cwd) });
    }
    if (req.method === 'POST' && action === 'choice') {
      const body = await readBody(req);
      const cwd = validDir(body?.path);
      if (!cwd || typeof body?.value !== 'boolean') return sendJson(res, 400, { error: 'Choose an existing project folder and a public-project value.' });
      await setPublicProjectChoice(cwd, body.value);
      return sendJson(res, 200, { choice: body.value });
    }
    if (req.method === 'GET' && (action === 'remote' || action === 'state')) {
      const cwd = validDir(url.searchParams.get('path'));
      if (!cwd) return sendJson(res, 400, { error: 'Choose an existing project folder.' });
      return sendJson(res, 200, action === 'remote' ? await suggestFromRemote(cwd) : await checkProjectState(cwd));
    }
    if (req.method === 'POST' && (action === 'restore-ignore' || action === 'stop-tracking')) {
      const requested = validDir((await readBody(req))?.path);
      if (!requested) return sendJson(res, 400, { error: 'Choose an existing project folder.' });
      const cwd = await realpathWithinProjects(resolve(requested));
      if (!cwd) return sendJson(res, 403, { error: 'Only a project in the PROJECTS list can be changed here.' });
      const linked = linkedStateReason(cwd);
      if (linked) return sendJson(res, 409, { error: linked });
      if (action === 'restore-ignore') return sendJson(res, 200, { ok: true, ...restoreIgnoreFile(cwd) });
      return sendJson(res, 200, await stopTrackingState(cwd));
    }
  } catch (err) {
    return sendJson(res, 500, { error: err instanceof Error ? err.message : 'failed' });
  }
  return sendJson(res, 404, { error: 'not found' });
}
