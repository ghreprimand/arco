import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isPathWithin, safeDirectory } from './fileAccessPolicy.js';

// Application document stores own their descendants; links are never storage
// entries. The selected project itself may be reached through a volume alias.
export function managedPath(root: string, ...parts: string[]): string {
  if (!path.isAbsolute(root)) throw new Error('An absolute storage root is required');
  let probe = path.resolve(root);
  const missing: string[] = [];
  for (;;) {
    try { lstatSync(probe); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.unshift(path.basename(probe));
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
  const canonicalRoot = path.join(realpathSync(probe), ...missing);
  const target = path.resolve(canonicalRoot, ...parts);
  if (!isPathWithin(canonicalRoot, target)) throw new Error('Storage path escapes its root');
  let current = canonicalRoot;
  for (const part of path.relative(canonicalRoot, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('Storage paths cannot contain links');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return target;
}

export function projectDocumentPath(cwd: string, ...parts: string[]): string {
  return managedPath(safeDirectory(cwd), '.arco', ...parts);
}
