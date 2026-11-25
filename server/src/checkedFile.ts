import { randomUUID } from 'node:crypto';
import { constants, realpathSync, type Stats } from 'node:fs';
import { open, lstat, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { renameWithRetry } from './atomicFile.js';
import { FileAccessError } from './fileAccessPolicy.js';

// Callers first authorize a canonical path. Pin the opened regular file and
// verify its identity and parent again before exposing or changing bytes.
// This is a portable race check, not an operating-system filesystem sandbox.
export async function openCheckedFile(file: string, mode: 'read' | 'write' | 'replace' | 'create' = 'read', permissions = 0o600) {
  const target = path.resolve(file), parent = path.dirname(target);
  if (realpathSync(parent) !== parent) throw new FileAccessError();
  let before: Stats | undefined;
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
  if (overwrite) {
    await stageCheckedWrite(file, contents, 'write', permissions);
    return;
  }
  const handle = await openCheckedFile(file, 'create', permissions);
  try { await handle.writeFile(contents); } finally { await handle.close(); }
}

export async function readCheckedText(file: string): Promise<string> {
  const handle = await openCheckedFile(file);
  try { return await handle.readFile('utf8'); } finally { await handle.close(); }
}

export async function replaceCheckedFile(file: string, contents: string): Promise<void> {
  await stageCheckedWrite(file, contents, 'replace');
}

export async function atomicCheckedWriteFile(file: string, contents: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await stageCheckedWrite(file, contents, 'atomic');
}

async function stageCheckedWrite(
  file: string, contents: string | Buffer, mode: 'write' | 'replace' | 'atomic', permissions = 0o666,
): Promise<void> {
  const parent = path.dirname(file);
  if (realpathSync(parent) !== parent) throw new FileAccessError();
  const parentBefore = await lstat(parent);
  let before: Stats | undefined;
  if (mode === 'atomic') {
    try { before = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (before && !before.isFile()) throw new FileAccessError();
  } else {
    // Require the same access as the original in-place write. A check also
    // pins the inode before staging, without creating or truncating the target.
    const original = await openCheckedFile(file, mode === 'write' ? 'write' : 'read').catch(error => {
      if (mode === 'write' && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!original) {
      // Keep exclusive creation for new names. A concurrent creator wins.
      await writeCheckedFile(file, contents, false, permissions);
      return;
    }
    try { before = await original.stat(); } finally { await original.close(); }
  }
  const temp = path.join(parent, `.arco-write-${randomUUID()}.tmp`);
  try {
    const output = await openCheckedFile(temp, 'create', before ? before.mode & 0o777 : permissions);
    try {
      await output.writeFile(contents);
      if (before) await output.chmod(before.mode & 0o777);
      await output.sync();
    } finally { await output.close(); }
    await renameWithRetry(temp, file, async () => {
      let current;
      try { current = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parentNow = await lstat(parent);
      if (realpathSync(parent) !== parent || parentNow.dev !== parentBefore.dev || parentNow.ino !== parentBefore.ino
        || Boolean(before) !== Boolean(current)
        || (before && current && (!current.isFile() || before.dev !== current.dev || before.ino !== current.ino || current.isSymbolicLink()))) throw new FileAccessError();
    });
  } finally {
    try {
      if (realpathSync(parent) === parent) await rm(temp, { force: true });
    } catch { /* the parent may have moved */ }
  }
}
