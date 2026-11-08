import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';

export class UnsafeStorageRootError extends Error {
  constructor() { super('Storage folder and its parent folders must be real folders, not links.'); }
}

/** Refuse linked or non-directory components before creating managed storage. */
export async function ensureStorageRoot(root: string, create = true): Promise<void> {
  const absolute = path.resolve(root);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
      try { await mkdir(current); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      entry = await lstat(current);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new UnsafeStorageRootError();
    }
  }
}
