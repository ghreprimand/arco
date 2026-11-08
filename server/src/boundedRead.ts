import { constants, promises as fs } from 'node:fs';

// Nonblocking open also closes the stat/open race for pipes on POSIX. Verify
// the opened handle, rather than trusting an earlier path lookup.
async function openRegular(path: string) {
  const before = await fs.stat(path);
  if (!before.isFile()) throw new Error('not a regular file; use Glob for directories');
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    return { handle, size: stat.size };
  } catch (error) { await handle.close(); throw error; }
}

export async function readRegularPrefix(path: string, cap: number) {
  const { handle, size } = await openRegular(path);
  try {
    const buffer = Buffer.alloc(Math.min(size, cap));
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    return { buffer: buffer.subarray(0, used), size };
  } finally { await handle.close(); }
}

// Keep at most a prefix of each line, even for a file with no newlines.
// Continue scanning so line-addressed reads and later Grep hits still work.
export async function* regularFileLines(path: string, cap: number, signal?: AbortSignal) {
  const { handle } = await openRegular(path);
  try {
    const chunk = Buffer.alloc(16384);
    let parts: Buffer[] = [], used = 0, truncated = false, number = 1;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      let start = 0;
      for (let i = 0; i <= bytesRead; i++) {
        if (i < bytesRead && chunk[i] !== 10) continue;
        const length = i - start;
        const keep = Math.min(length, cap - used);
        if (keep) { parts.push(Buffer.from(chunk.subarray(start, start + keep))); used += keep; }
        if (keep < length) truncated = true;
        if (i < bytesRead) {
          yield { text: Buffer.concat(parts, used).toString('utf8'), number: number++, truncated };
          parts = []; used = 0; truncated = false;
        }
        start = i + 1;
      }
    }
    yield { text: Buffer.concat(parts, used).toString('utf8'), number, truncated };
  } finally { await handle.close(); }
}

export async function readRegularRange(path: string, cap: number, offset: number, limit?: number, signal?: AbortSignal) {
  const { handle } = await openRegular(path);
  const output = Buffer.alloc(cap);
  let used = 0, line = 1;
  const result = (truncated: boolean) => ({ text: output.subarray(0, used).toString('utf8'), truncated });
  try {
    const chunk = Buffer.alloc(16384);
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) return result(false);
      for (let i = 0; i < bytesRead; i++) {
        const byte = chunk[i];
        if (line < offset) { if (byte === 10) line++; continue; }
        if (byte === 10 && limit !== undefined && line + 1 >= offset + limit) return result(false);
        if (used === cap) return result(true);
        output[used++] = byte;
        if (byte === 10) line++;
      }
    }
  } finally { await handle.close(); }
}

export async function readResponsePrefix(response: Response, cap: number) {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const parts: Buffer[] = [];
  let used = 0, done = false;
  try {
    while (used < cap) {
      const next = await reader.read();
      if (next.done) { done = true; break; }
      const keep = Math.min(next.value.byteLength, cap - used);
      parts.push(Buffer.from(next.value.subarray(0, keep)));
      used += keep;
    }
    return { text: Buffer.concat(parts, used).toString('utf8'), truncated: !done };
  } finally { if (!done) await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
