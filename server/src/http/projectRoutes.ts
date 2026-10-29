// /api/projects -- the flat project list (server/src/projects.ts).
//   GET    /api/projects           -> { projects, scanFolder }
//   GET    /api/projects?locationPath=... -> also resolve a canonical location path
//   POST   /api/projects { path }  -> register an existing directory
//   DELETE /api/projects { path }  -> forget a registered directory (files untouched)
//   PATCH  /api/projects { id, displayName?, pinned?, archived? } -> organize
//   POST   /api/projects/relocate { id, path } -> point a missing project at its new folder
//   POST   /api/projects/create { name } -> new empty folder in the scan folder, registered
// Only the registered source is mutable here; scanned and recent entries
// follow the scan folder and the crash-recovery registry. Organization
// metadata lives in projectRecords.ts. No route deletes or moves files.
import { IncomingMessage, ServerResponse } from 'http';
import { assertSafePath } from '../fileAccessPolicy.js';
import { sanitizeProjectRoots } from '../settings.js';
import { addProject, createProject, listProjects, organizeProject, relocateProject, removeProject, type ProjectMutation } from '../projects.js';

function sendJson(res: ServerResponse, code: number, body: unknown): true {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

class BadRequest extends Error {}
const MAX_BODY = 64 * 1024;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BadRequest('request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf-8');
  if (!text) return {};
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new BadRequest('invalid JSON body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('invalid request body');
  return body as Record<string, unknown>;
}

const reply = (res: ServerResponse, result: ProjectMutation) =>
  (result.ok ? sendJson(res, 200, result.list) : sendJson(res, result.status ?? 400, { error: result.error }));

export async function tryHandleProjectRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (req.url || '').split('?')[0];
  const action = path === '/api/projects/relocate' ? relocateProject : path === '/api/projects/create' ? createProject : null;
  if (path !== '/api/projects' && !action) return false;
  try {
    if (action) return req.method === 'POST' ? reply(res, await action(await readBody(req))) : sendJson(res, 405, { error: 'method not allowed' });
    if (req.method === 'GET') {
      const requested = new URL(req.url || '/', 'http://localhost').searchParams.get('locationPath');
      const location = requested === null ? undefined : sanitizeProjectRoots([{ name: '', path: requested }])?.[0];
      if (requested !== null && !location) return sendJson(res, 400, { error: 'Choose an absolute folder path below the home or filesystem root.' });
      if (location) { try { assertSafePath(location.path); } catch { return sendJson(res, 400, { error: 'Choose an ordinary project folder outside protected state.' }); } }
      return sendJson(res, 200, { ...await listProjects(), ...(location ? { locationPath: location.path } : {}) });
    }
    if (req.method === 'POST' || req.method === 'DELETE') {
      const body = await readBody(req);
      return reply(res, req.method === 'POST' ? await addProject(body.path) : await removeProject(body.path));
    }
    if (req.method === 'PATCH') return reply(res, await organizeProject(await readBody(req)));
    return sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    if (err instanceof BadRequest) return sendJson(res, 400, { error: err.message });
    // The detail can name runtime-home files; keep it in the server log.
    console.error('[projects] request failed:', err);
    return sendJson(res, 500, { error: 'the project request could not be completed' });
  }
}
