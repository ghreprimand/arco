import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { FileAccessError, assertSafePath, confinedPath, safeDirectory } from '../fileAccessPolicy.js';
import { knownRoots, resolveBoundCwd } from './writeConfinement.js';
import { UPLOADS_DIR } from '../server/constants.js';
import { SCRATCH_ROOT } from '../media/scratch.js';
import { artifactsDir } from '../workers/limits.js';

export async function readRoots(cwd?: string | null, workflowId?: string | null): Promise<string[]> {
  const bound = await resolveBoundCwd(cwd, workflowId);
  if (!bound.ok && bound.reason !== 'none') throw new FileAccessError();
  return [...(bound.ok ? [bound.cwd] : await knownRoots()), UPLOADS_DIR, SCRATCH_ROOT];
}

export async function resolveBrowserRead(p: string, cwd?: string | null, workflowId?: string | null, kind: 'file' | 'directory' = 'file'): Promise<string> {
  if (!p || p.includes('\0')) throw new FileAccessError();
  if (workflowId && cwd && kind === 'file') {
    assertSafePath(path.resolve(cwd, p));
    const tracked = await import('../outputs.js').then(m => m.resolveTrackedOutput(cwd, workflowId, p)).catch(() => null);
    if (tracked) return tracked;
  }
  const roots = await readRoots(cwd, workflowId);
  const bound = await resolveBoundCwd(cwd, workflowId);
  if (!path.isAbsolute(p) && !bound.ok) throw new FileAccessError();
  const target = path.isAbsolute(p) ? path.resolve(p) : path.resolve(bound.ok ? bound.cwd : '', p);
  assertSafePath(target);
  if (workflowId && bound.ok && kind === 'file') {
    const tracked = await import('../outputs.js').then(m => m.resolveTrackedOutput(bound.cwd, workflowId, target)).catch(() => null);
    if (tracked) return tracked;
  }
  try { return confinedPath(target, roots, kind); } catch (err) {
    // Only a missing bare filename can fall back to this bound workflow's
    // artifacts. Traversal, denied paths and unknown bindings never fall back.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || kind !== 'file' || !bound.ok || !workflowId
      || path.basename(p) !== p || p.includes('\\') || p.startsWith('.')) throw err;
    return confinedPath(path.join(artifactsDir(bound.cwd, workflowId), p), [bound.cwd]);
  }
}

// The project picker grants directory names only, not file content. Ordinary
// absolute locations may be navigated without pre-registering every ancestor
// (mounts, network shares, Windows drives); protected roots are never listed.
export async function listBrowserDirectory(dir: string, directoriesOnly: boolean) {
  const root = directoriesOnly ? safeDirectory(dir) : await resolveBrowserRead(dir, undefined, undefined, 'directory');
  const roots = directoriesOnly ? [] : await readRoots();
  const entries = await readdir(root, { withFileTypes: true });
  const out: Array<{ name: string; path: string; isDirectory: boolean }> = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const target = path.join(root, e.name);
    try {
      const real = directoriesOnly ? safeDirectory(target) : confinedPath(target, roots, 'either');
      // Content links must stay in an authorized project, including links
      // from a nested folder to a sibling inside that project.
      const isDirectory = (() => { try { safeDirectory(real); return true; } catch { return false; } })();
      if (!directoriesOnly || isDirectory) out.push({ name: e.name, path: target, isDirectory });
    } catch { /* protected, non-regular, dangling or escaping entry */ }
  }
  return { root, entries: out };
}

// Saved workflow artifacts remain readable after restart, even when no live
// workflow object exists. A live binding wins; otherwise the stored document
// must be beneath an already-known project and a validated workflow segment.
export async function resolveWorkflowDocument(cwd: string, workflowId: string, kind: 'artifacts' | 'handoffs', name: string): Promise<string> {
  if (!/^[a-z0-9_-]{1,64}$/i.test(workflowId) || path.basename(name) !== name || name.includes('\\') || name.startsWith('.')) throw new FileAccessError();
  let bound = await resolveBoundCwd(cwd, workflowId);
  if (!bound.ok) bound = await resolveBoundCwd(cwd, undefined);
  if (!bound.ok) throw new FileAccessError();
  const root = path.join(bound.cwd, '.arco', 'workflows', workflowId, kind);
  const target = path.join(root, name);
  const tracked = kind === 'artifacts' ? await import('../outputs.js').then(m => m.resolveTrackedOutput(bound.cwd, workflowId, target)).catch(() => null) : null;
  if (tracked) return tracked;
  confinedPath(target, [bound.cwd]);
  return confinedPath(target, [root]);
}
