import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { openCheckedFile } from '../checkedFile.js';

export class IsolatedArtifactTooLarge extends Error {}

/** Read a bounded regular file without following a worker-controlled symlink. */
export async function readIsolatedArtifact(root: string, input: string, limit: number): Promise<Buffer> {
  const target = resolve(root, input), rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Artifact is outside the workspace.');
  const parts = rel.split(sep);
  const canonicalRoot = await realpath(root);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  const directories: Array<Awaited<ReturnType<typeof open>>> = [];
  try {
    if (process.platform === 'linux') {
      // The isolated process cannot rename the mounted workspace root. Pin each
      // directory before opening the next component, so changing a symlink or
      // swapping a subdirectory cannot redirect the server to another tree.
      const rootHandle = await open(canonicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      directories.push(rootHandle);
      for (const part of parts.slice(0, -1)) {
        const parent = directories[directories.length - 1];
        directories.push(await open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
      }
      const parent = directories[directories.length - 1];
      file = await open(`/proc/self/fd/${parent.fd}/${parts[parts.length - 1]}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } else {
      file = await openCheckedFile(resolve(canonicalRoot, ...parts));
    }
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('Artifact is not a regular file.');
    if (info.size > limit) throw new IsolatedArtifactTooLarge('Artifact exceeds the size limit.');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new IsolatedArtifactTooLarge('Artifact exceeds the size limit.');
    return buffer.subarray(0, length);
  } finally {
    await file?.close();
    for (const directory of directories.reverse()) await directory.close();
  }
}
