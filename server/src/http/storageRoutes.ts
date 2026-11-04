import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { arcoHome } from '../arcoHome.js';
import { snapshot } from '../workspace.js';
import { realpathWithinProjects } from '../projects.js';
import { lstat } from 'node:fs/promises';
import { projectCheckpointRoot, scanStorage, type StorageReport } from '../storageReport.js';
import { emptyScratch, StorageActionError } from '../storageActions.js';
import { workflows } from '../server/state.js';

const cache = new Map<string, Promise<StorageReport>>();
// Not a path, so it cannot collide with a project key.
const HOME_KEY = '\0home';
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) return null;
    chunks.push(chunk as Buffer);
  }
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  catch { return null; }
}

// A registered project whose state folder is not a link; null otherwise.
async function projectFor(cwd: unknown): Promise<string | null> {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const key = await realpathWithinProjects(path.resolve(cwd));
  if (!key) return null;
  try { if ((await lstat(path.join(key, '.arco'))).isSymbolicLink()) return null; }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
  return key;
}

const ACTION_STATUS: Record<StorageActionError['code'], number> = { keep_unreadable: 409, busy: 409, open: 409, kept: 409, exists: 409, not_found: 404, invalid: 400 };

// Operator storage actions. Each needs `confirm: true`: the client asks first.
async function handleStorageAction(req: IncomingMessage, res: ServerResponse, action: string): Promise<void> {
  const body = await readJson(req);
  if (!body) return json(res, 400, { error: 'invalid_body' });
  const project = await projectFor(body.path);
  if (!project) return json(res, 403, { error: 'Project is unavailable' });
  if (body.confirm !== true) return json(res, 400, { error: 'confirmation_required' });
  const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
  try {
    if (action === 'empty-scratch') {
      const result = await emptyScratch(project, workflowId, { busy: !!workflows.get(workflowId)?.busy });
      return json(res, 200, { ok: true, ...result });
    }
    return json(res, 404, { error: 'unknown_action' });
  } catch (err) {
    if (err instanceof StorageActionError) return json(res, ACTION_STATUS[err.code], { error: err.code, message: err.message });
    console.error('[arco] storage action failed:', err);
    return json(res, 500, { error: 'storage_action_failed' });
  }
}

export async function tryHandleStorageRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const actionMatch = /^\/api\/storage\/([a-z-]+)$/.exec(url.pathname);
  if (actionMatch && req.method === 'POST') { await handleStorageAction(req, res, actionMatch[1]); return true; }
  if (url.pathname !== '/api/storage-report' || req.method !== 'GET') return false;
  if (url.searchParams.get('scope') === 'home') {
    // Arco's own folder: voice and media models, caches, shared checkpoints,
    // task worktrees, saved clusters. Chat and Genesis project state folders
    // inside it are skipped here and measured as their own projects.
    if (url.searchParams.get('refresh') === '1') cache.delete(HOME_KEY);
    let pending = cache.get(HOME_KEY);
    if (!pending) { pending = scanStorage(arcoHome(), null, { scope: 'home' }); cache.set(HOME_KEY, pending); }
    await respond(res, HOME_KEY, pending);
    return true;
  }
  const cwd = url.searchParams.get('path');
  if (!cwd || !path.isAbsolute(cwd)) {
    res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Absolute path required' })); return true;
  }
  const key = await realpathWithinProjects(path.resolve(cwd));
  if (!key) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Project is unavailable' })); return true; }
  try { if ((await lstat(path.join(key, '.arco'))).isSymbolicLink()) { res.writeHead(403); res.end(); return true; } } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { res.writeHead(403); res.end(); return true; } }
  if (url.searchParams.get('refresh') === '1') cache.delete(key);
  let pending = cache.get(key);
  if (!pending) {
    const workspace = snapshot();
    const open = [...workspace.workflows.map(w => w.workflowId), ...workspace.clusters.flatMap(c => c.memberIds)];
    pending = scanStorage(path.join(key, '.arco'), projectCheckpointRoot(arcoHome(), path.resolve(cwd)), { open });
    cache.set(key, pending);
  }
  await respond(res, key, pending);
  return true;
}

async function respond(res: ServerResponse, key: string, pending: Promise<StorageReport>): Promise<void> {
  try {
    const result = await pending;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result));
  } catch {
    if (cache.get(key) === pending) cache.delete(key);
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Storage scan failed' }));
  }
}
