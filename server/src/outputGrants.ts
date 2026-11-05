// Exact destinations explicitly chosen through the operator-only output route.
// Project metadata alone never grants access to a home-folder file.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { arcoHome } from './arcoHome.js';
import { atomicWriteFile } from './atomicFile.js';

type Grant = { cwd: string; workflowId: string; file: string };

async function grantFile(grant: Grant, create: boolean): Promise<string | null> {
  const root = await realpath(arcoHome());
  const dir = path.join(root, 'output-destinations');
  if (create) await mkdir(dir, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'EEXIST') throw err; });
  try {
    const st = await lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || await realpath(dir) !== dir) throw new Error('Invalid output destination store.');
  } catch (err) {
    if (!create && (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const key = createHash('sha256').update(JSON.stringify([grant.cwd, grant.workflowId, grant.file])).digest('hex');
  return path.join(dir, `${key}.json`);
}

export async function hasOutputGrant(grant: Grant): Promise<boolean> {
  const file = await grantFile(grant, false);
  if (!file) return false;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size > 16 * 1024) throw new Error('Invalid output destination grant.');
      const item = JSON.parse(await handle.readFile('utf8')) as Grant;
      return item.cwd === grant.cwd && item.workflowId === grant.workflowId && item.file === grant.file;
    } finally { await handle.close(); }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error('Output destination permission could not be read.');
  }
}

export async function addOutputGrant(grant: Grant): Promise<void> {
  const file = await grantFile(grant, true);
  if (!file) throw new Error('Output destination permission could not be saved.');
  await atomicWriteFile(file, JSON.stringify(grant) + '\n', { mode: 0o600, skipMkdir: true });
}

export async function removeOutputGrant(grant: Grant): Promise<void> {
  const file = await grantFile(grant, false);
  if (file) await unlink(file).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'ENOENT') throw err; });
}
