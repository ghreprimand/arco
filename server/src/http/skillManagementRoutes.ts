// P8.6 Skill management routes: IMPORT and UPDATE (review, then confirm),
// ON/OFF, MOVE, DUPLICATE, contents and needs, SHARE WITH REPOSITORY.
// Matched before the plain /api/skills routes.
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { realpathWithinProjects } from '../projects.js';
import { assertSafePath } from '../fileAccessPolicy.js';
import {
  confirmImport, confirmUpdate, duplicateSkill, moveSkill, previewImport, previewShare, previewUpdate, setSkillOff, shareSkill, skillDetails,
  type FetchLike, type ImportSource,
} from '../skillManagement.js';
import type { SkillScope } from '../skills.js';

let fetchImpl: FetchLike = fetch as unknown as FetchLike;
/** Test surface: replace the network used for GitHub imports. */
export function _setSkillFetchForTest(f: FetchLike): void { fetchImpl = f; }

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, max: number): Promise<Record<string, unknown> | null> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    chunks.push(chunk as Buffer);
  }
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  catch { return null; }
}

const scopeOf = (v: unknown): SkillScope | null => (v === 'project' || v === 'global' ? v : null);

export async function tryHandleSkillManagementRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const match = /^\/api\/skills\/(import\/preview|import\/confirm|update\/preview|update\/confirm|state|move|duplicate|details|share\/preview|share)$/.exec(url.pathname);
  if (!match) return false;
  const action = match[1];
  const cwd = url.searchParams.get('cwd') ?? '';
  try {
    if (action === 'details') {
      if (req.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return true; }
      json(res, 200, { skills: await skillDetails(cwd) });
      return true;
    }
    if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return true; }
    const body = await readJson(req, action === 'import/preview' ? 12 * 1024 * 1024 : 64 * 1024);
    if (!body) { json(res, 400, { error: 'invalid_body' }); return true; }
    const scope = scopeOf(body.scope);
    const needsCwd = (s: SkillScope | null) => s === 'project' && !cwd;
    switch (action) {
      case 'import/preview': {
        const src = (body.source ?? {}) as Record<string, unknown>;
        let source: ImportSource;
        if (src.kind === 'github' && typeof src.url === 'string') source = { kind: 'github', url: src.url };
        else if (src.kind === 'folder' && typeof src.path === 'string' && path.isAbsolute(src.path)) { assertSafePath(src.path); source = { kind: 'folder', path: src.path }; }
        else if (src.kind === 'zip' && typeof src.name === 'string' && typeof src.data === 'string') source = { kind: 'zip', name: src.name, data: Buffer.from(src.data, 'base64') };
        else { json(res, 400, { error: 'Choose a GitHub link, a folder or a zip file.' }); return true; }
        json(res, 200, await previewImport(source, fetchImpl));
        return true;
      }
      case 'import/confirm': {
        if (!scope || typeof body.token !== 'string') { json(res, 400, { error: 'scope and token required' }); return true; }
        if (needsCwd(scope)) { json(res, 400, { error: 'cwd query required for project scope' }); return true; }
        json(res, 200, { skill: await confirmImport(body.token, scope, cwd) });
        return true;
      }
      case 'update/preview': {
        if (!scope || typeof body.slug !== 'string' || needsCwd(scope)) { json(res, 400, { error: 'scope and slug required' }); return true; }
        json(res, 200, await previewUpdate(scope, body.slug, cwd, fetchImpl));
        return true;
      }
      case 'update/confirm': {
        if (typeof body.token !== 'string') { json(res, 400, { error: 'token required' }); return true; }
        json(res, 200, { skill: await confirmUpdate(body.token) });
        return true;
      }
      case 'state': {
        if (!scope || typeof body.slug !== 'string' || typeof body.off !== 'boolean' || needsCwd(scope)) { json(res, 400, { error: 'scope, slug and off required' }); return true; }
        await setSkillOff(scope, body.slug, cwd, body.off);
        json(res, 200, { ok: true });
        return true;
      }
      case 'move': {
        const to = scopeOf(body.to);
        if (!scope || !to || typeof body.slug !== 'string' || needsCwd(scope) || needsCwd(to)) { json(res, 400, { error: 'scope, slug and to required' }); return true; }
        json(res, 200, { skill: await moveSkill(scope, body.slug, cwd, to) });
        return true;
      }
      case 'duplicate': {
        if (!scope || typeof body.slug !== 'string' || typeof body.name !== 'string' || needsCwd(scope)) { json(res, 400, { error: 'scope, slug and name required' }); return true; }
        json(res, 200, { skill: await duplicateSkill(scope, body.slug, cwd, body.name) });
        return true;
      }
      case 'share/preview':
      case 'share': {
        // Changes the project's ignore file: registered projects only.
        const project = cwd && path.isAbsolute(cwd) ? await realpathWithinProjects(path.resolve(cwd)) : null;
        if (!project) { json(res, 403, { error: 'Project is unavailable' }); return true; }
        if (typeof body.slug !== 'string') { json(res, 400, { error: 'slug required' }); return true; }
        if (action === 'share' && body.confirm !== true) { json(res, 400, { error: 'confirmation_required' }); return true; }
        json(res, 200, action === 'share' ? await shareSkill(project, body.slug) : await previewShare(project, body.slug));
        return true;
      }
    }
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
  return false;
}
