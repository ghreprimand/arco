import { getPublicProjectChoice } from '../publicProjectChoice.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { arcoHome } from '../arcoHome.js';
import { snapshot } from '../workspace.js';
import { realpathWithinProjects } from '../projects.js';
import { confinedPath } from '../fileAccessPolicy.js';
import { lstat, readFile } from 'node:fs/promises';
import { projectCheckpointRoot, scanStorage, type StorageReport } from '../storageReport.js';
import { compressOldLogs, deleteConversation, emptyScratch, StorageActionError } from '../storageActions.js';
import { sealWorkflowLogNow } from '../workflowStore.js';
import { archiveConversation, archivePath, listArchives, restoreConversation } from '../storageArchive.js';
import { isKept, readKeep } from '../keepStore.js';
import { openWorkflowIds, readPolicy, storageOverview, writePolicy, cachedOverviewAge } from '../storageOverview.js';
import { purgeWorkflow } from '../workflows/purgeWorkflow.js';
import { workflows } from '../server/state.js';
import { addKeep, removeKeep } from '../keepStore.js';
import { outputDirectory } from '../outputStore.js';
import { inspectArtifactCopy, copyReviewedArtifact, ignoreCopyDestination } from '../artifactCopy.js';

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

const ACTION_STATUS: Record<StorageActionError['code'], number> = { changed: 409, keep_unreadable: 409, busy: 409, open: 409, kept: 409, exists: 409, unsafe: 409, not_found: 404, invalid: 400 };

// Operator storage actions. Each needs `confirm: true`: the client asks first.
async function handleStorageAction(req: IncomingMessage, res: ServerResponse, action: string): Promise<void> {
  const body = await readJson(req);
  if (!body) return json(res, 400, { error: 'invalid_body' });
  const project = await projectFor(body.path);
  if (!project) return json(res, 403, { error: 'Project is unavailable' });
  if (body.confirm !== true) return json(res, 400, { error: 'confirmation_required' });
  const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
  try {
    if (action === 'compress-logs') {
      const open = openWorkflowIds();
      const result = await compressOldLogs(project, { isOpen: (id) => open.has(id), isBusy: (id) => !!workflows.get(id)?.busy, seal: sealWorkflowLogNow });
      return json(res, 200, { ok: true, ...result });
    }
    if (action === 'copy-review' || action === 'copy-confirm' || action === 'copy-ignore') {
      if (typeof body.itemPath !== 'string' || typeof body.destinationFolder !== 'string') return json(res, 400, { error: 'invalid' });
      // Keep the requested project spelling while validating the destination.
      // projectFor returns the canonical root, while a picker may send a path
      // under an alias of that root. The confinement check still rejects links
      // that leave this project, even when they point at another project.
      const destination = confinedPath(body.destinationFolder, [body.path as string], 'directory');
      const declaredPublic = body.publicProject === true || await getPublicProjectChoice(project) === true;
      const review = await inspectArtifactCopy(project, workflowId, body.itemPath, destination, declaredPublic);
      if (action === 'copy-review') return json(res, 200, review);
      if (typeof body.token !== 'string' || body.token !== review.token) return json(res, 409, { error: 'The artifact or destination changed. Review it again.' });
      if (action === 'copy-ignore') {
        await ignoreCopyDestination(project, review.target);
        return json(res, 200, { ok: true });
      }
      await copyReviewedArtifact(project, workflowId, body.itemPath, destination, declaredPublic, body.token, undefined, body.confirmUnscanned === true);
      return json(res, 200, { ok: true });
    }
    if (action === 'keep') {
      if (typeof body.itemPath !== 'string' || (body.reason !== 'operator' && body.reason !== 'size-warning')) return json(res, 400, { error: 'invalid' });
      const dir = await outputDirectory(project, workflowId);
      const items = await addKeep(dir, body.itemPath, body.reason);
      return json(res, 200, { ok: true, items });
    }
    if (action === 'unkeep') {
      if (body.all !== true && typeof body.itemPath !== 'string') return json(res, 400, { error: 'invalid' });
      const dir = await outputDirectory(project, workflowId);
      const items = await removeKeep(dir, body.all === true ? { all: true } : body.itemPath as string);
      return json(res, 200, { ok: true, items });
    }
    const busy = !!workflows.get(workflowId)?.busy;
    const open = openWorkflowIds().has(workflowId);
    if (action === 'empty-scratch') {
      const result = await emptyScratch(project, workflowId, { busy });
      return json(res, 200, { ok: true, ...result });
    }
    if (action === 'archive') return json(res, 200, { ok: true, ...(await archiveConversation(project, workflowId, { open, busy, by: 'operator' })) });
    if (action === 'restore') return json(res, 200, { ok: true, ...(await restoreConversation(project, workflowId)) });
    if (action === 'delete') {
      return json(res, 200, { ok: true, ...(await deleteConversation(project, workflowId, { open, busy, purge: purgeWorkflow, archiveFile: archivePath(project, workflowId) })) });
    }
    return json(res, 404, { error: 'unknown_action' });
  } catch (err) {
    if (err instanceof StorageActionError) return json(res, ACTION_STATUS[err.code], { error: err.code, message: err.message });
    if (action === 'keep' || action === 'unkeep' || action.startsWith('copy-')) return json(res, 400, { error: err instanceof Error ? err.message : 'The request could not be completed.' });
    console.error('[arco] storage action failed:', err);
    return json(res, 500, { error: 'storage_action_failed' });
  }
}

export async function tryHandleStorageRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/storage/policy') {
    if (req.method === 'GET') { json(res, 200, await readPolicy()); return true; }
    if (req.method === 'POST') {
      const body = await readJson(req);
      if (!body) { json(res, 400, { error: 'invalid_body' }); return true; }
      const patch: Record<string, unknown> = {};
      for (const key of ['autoArchiveClosedDays', 'budgetGiB', 'budgetNotice']) if (key in body) patch[key] = body[key];
      json(res, 200, await writePolicy(patch));
      return true;
    }
  }
  if (url.pathname === '/api/storage/budget' && req.method === 'GET') {
    // The notice reads the last measurement; it never starts a scan itself.
    const policy = await readPolicy();
    const age = cachedOverviewAge();
    const last = age === null ? null : await storageOverview().catch(() => null);
    json(res, 200, { enabled: policy.budgetNotice, limitBytes: policy.budgetGiB * 1024 ** 3, totalBytes: last?.totalBytes ?? null, measuredAt: last?.measuredAt ?? null, over: !!(policy.budgetNotice && last && last.totalBytes > policy.budgetGiB * 1024 ** 3) });
    return true;
  }
  const actionMatch = /^\/api\/storage\/([a-z-]+)$/.exec(url.pathname);
  if (actionMatch && req.method === 'POST') { await handleStorageAction(req, res, actionMatch[1]); return true; }
  if (url.pathname !== '/api/storage-report' || req.method !== 'GET') return false;
  if (url.searchParams.get('scope') === 'all') {
    try { json(res, 200, await storageOverview(url.searchParams.get('refresh') === '1')); }
    catch { json(res, 500, { error: 'Storage scan failed' }); }
    return true;
  }
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
  await respond(res, key, pending, (report) => withConversationState(key, report));
  return true;
}

// Fresh per response (the scan itself is cached): each conversation's name,
// KEEP state and working state, and the project's archives, for the STORAGE
// view. KEEP changes and archive actions show without measuring again.
async function withConversationState(cwd: string, report: StorageReport): Promise<unknown> {
  const conversations = await Promise.all(report.workflows.map(async (w) => {
    const dir = path.join(cwd, '.arco', 'workflows', w.id);
    let name: string | undefined;
    try { const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8')) as { name?: unknown }; if (typeof meta.name === 'string') name = meta.name; }
    catch { /* no meta: archived or partial folder */ }
    const keep = await readKeep(dir);
    return {
      ...w, ...(name ? { name } : {}), busy: !!workflows.get(w.id)?.busy,
      keep: keep.ok ? { readable: true, whole: isKept(keep.items, '.'), items: keep.items.length } : { readable: false, whole: false, items: 0 },
    };
  }));
  return { ...report, workflows: conversations, archives: await listArchives(cwd) };
}

async function respond(res: ServerResponse, key: string, pending: Promise<StorageReport>, shape?: (r: StorageReport) => Promise<unknown>): Promise<void> {
  try {
    const result = shape ? await shape(await pending) : await pending;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result));
  } catch {
    if (cache.get(key) === pending) cache.delete(key);
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Storage scan failed' }));
  }
}
