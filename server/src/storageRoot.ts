import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export class UnsafeStorageRootError extends Error {
  constructor() { super('The managed storage folder must be a real folder, not a link.'); }
}

/** Resolve user-selected parents, but never follow a linked managed root. */
export async function ensureStorageRoot(root: string, create = true): Promise<string> {
  const absolute = path.resolve(root);
  const parent = path.dirname(absolute);
  if (create) await mkdir(parent, { recursive: true });
  const canonicalParent = await realpath(parent);
  const managed = path.join(canonicalParent, path.basename(absolute));
  let entry;
  try { entry = await lstat(managed); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
    try { await mkdir(managed); }
    catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
    entry = await lstat(managed);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new UnsafeStorageRootError();
  return managed;
}
