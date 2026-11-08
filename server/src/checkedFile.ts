import { randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { open, lstat, rename, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { FileAccessError } from './fileAccessPolicy.js';

// Callers first authorize a canonical path. Pin the opened regular file and
// verify its identity and parent again before exposing or changing bytes.
// This is a portable race check, not an operating-system filesystem sandbox.
export async function openCheckedFile(file: string, mode: 'read' | 'replace' | 'create' = 'read', permissions = 0o600) {
  const target = path.resolve(file), parent = path.dirname(target);
  if (realpathSync(parent) !== parent) throw new FileAccessError();
  let before;
  try { before = await lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (before && (!before.isFile() || before.isSymbolicLink())) throw new FileAccessError();
  const flags = (mode === 'read' ? constants.O_RDONLY : constants.O_WRONLY)
    | constants.O_NOFOLLOW | constants.O_NONBLOCK
    | (mode === 'create' || (mode === 'replace' && !before) ? constants.O_CREAT | constants.O_EXCL : 0);
  const handle = await open(target, flags, permissions);
  try {
    const opened = await handle.stat();
    const current = await lstat(target);
    if (!opened.isFile() || !current.isFile() || current.isSymbolicLink()
      || opened.dev !== current.dev || opened.ino !== current.ino
      || (before && (opened.dev !== before.dev || opened.ino !== before.ino))
      || realpathSync(parent) !== parent || realpathSync(target) !== target) throw new FileAccessError();
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

export async function writeCheckedFile(file: string, contents: string | Buffer, overwrite = true, permissions = 0o666): Promise<void> {
  const handle = await openCheckedFile(file, overwrite ? 'replace' : 'create', permissions);
  try {
    // Opening with O_TRUNC would destroy content before the identity check.
    if (overwrite) await handle.truncate(0);
    await handle.writeFile(contents, typeof contents === 'string' ? 'utf8' : undefined);
  } finally { await handle.close(); }
}

export async function readCheckedText(file: string): Promise<string> {
  const handle = await openCheckedFile(file);
  try { return await handle.readFile('utf8'); } finally { await handle.close(); }
}

export async function replaceCheckedFile(file: string, contents: string): Promise<void> {
  const original = await openCheckedFile(file);
  const before = await original.stat();
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeCheckedFile(temp, contents, false, before.mode & 0o777);
    const current = await lstat(file);
    if (current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()
      || realpathSync(path.dirname(file)) !== path.dirname(file)) throw new FileAccessError();
    await rename(temp, file);
  } finally {
    await original.close();
    if (realpathSync(path.dirname(file)) === path.dirname(file)) await rm(temp, { force: true });
  }
}

export async function atomicCheckedWriteFile(file: string, contents: string | Buffer): Promise<void> {
  const parent = path.dirname(file);
  await mkdir(parent, { recursive: true });
  if (realpathSync(parent) !== parent) throw new FileAccessError();
  let before;
  try { before = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (before && (!before.isFile() || before.isSymbolicLink())) throw new FileAccessError();
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const output = await openCheckedFile(temp, 'create', before ? before.mode & 0o777 : 0o666);
    try { await output.writeFile(contents); await output.sync(); } finally { await output.close(); }
    let current;
    try { current = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (realpathSync(parent) !== parent || Boolean(before) !== Boolean(current)
      || (before && current && (before.dev !== current.dev || before.ino !== current.ino || current.isSymbolicLink()))) throw new FileAccessError();
    await rename(temp, file);
  } finally {
    if (realpathSync(parent) === parent) await rm(temp, { force: true });
  }
}
