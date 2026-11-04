import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { arcoHome } from '../arcoHome.js';
import { snapshot } from '../workspace.js';
import { realpathWithinProjects } from '../projects.js';
import { lstat } from 'node:fs/promises';
import { projectCheckpointRoot, scanStorage, type StorageReport } from '../storageReport.js';

const cache = new Map<string, Promise<StorageReport>>();
// Not a path, so it cannot collide with a project key.
const HOME_KEY = '\0home';
export async function tryHandleStorageRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
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
