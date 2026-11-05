import { symlink } from 'node:fs/promises';
import path from 'node:path';

// Folder links that work on every system: a junction on Windows (no special
// privilege; lstat reports it as a link), a directory symlink elsewhere. The
// target is made absolute, as junctions require.
export async function linkFolder(target: string, at: string): Promise<void> {
  const absolute = path.resolve(path.dirname(at), target);
  await symlink(absolute, at, process.platform === 'win32' ? 'junction' : 'dir');
}

// A file link, or false where the system does not allow one (Windows without
// the symlink privilege). Callers skip that check then.
export async function linkFile(target: string, at: string): Promise<boolean> {
  try { await symlink(target, at, 'file'); return true; }
  catch (err) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) return false;
    throw err;
  }
}
