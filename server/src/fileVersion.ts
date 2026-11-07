import { constants, lstatSync, type BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export interface FileVersion { signature: string; sha256: string; size: number; mode: number; mtimeMs: number }
const signature = (st: BigIntStats) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;

// Hash through a bounded buffer and refuse a file that changes during reading.
export async function readFileVersion(file: string): Promise<FileVersion> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The source is not a supported regular file.');
    const size = Number(before.size), buffer = Buffer.alloc(64 * 1024), hash = createHash('sha256');
    let position = 0;
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) throw new Error('The source changed while it was read.');
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    if (signature(await handle.stat({ bigint: true })) !== signature(before)) throw new Error('The source changed while it was read.');
    return { signature: signature(before), sha256: hash.digest('hex'), size, mode: Number(before.mode & 0o777n), mtimeMs: Number(before.mtimeNs) / 1e6 };
  } finally { await handle.close(); }
}

export function fileVersionMatchesNow(file: string, version: FileVersion): boolean {
  try {
    const st = lstatSync(file, { bigint: true });
    return st.isFile() && signature(st) === version.signature;
  } catch { return false; }
}

export async function verifyFileVersion(file: string, version: FileVersion): Promise<void> {
  const current = await readFileVersion(file);
  if (current.signature !== version.signature || current.sha256 !== version.sha256) throw new Error('The source changed after it was copied.');
}
