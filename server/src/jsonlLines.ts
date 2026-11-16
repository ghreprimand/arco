import { basename } from 'node:path';

const LARGE_RECORD_BYTES = 16 * 1024 * 1024;
const warnedSources = new Set<string>();

// Retain only the current record's bytes. Decode once at its boundary so a
// split UTF-8 character is never replaced and a long record does not build a
// chain of decoded string fragments. Large records stay readable as before.
export async function* jsonlLines(
  input: AsyncIterable<Buffer>,
  source: string,
  options: { finalLine?: boolean; carriageReturns?: boolean } = {},
): AsyncGenerator<string> {
  let parts: Buffer[] = [];
  let bytes = 0;
  let afterCr = false;
  const add = (part: Buffer): void => {
    if (!part.length) return;
    parts.push(part);
    bytes += part.length;
    if (bytes > LARGE_RECORD_BYTES && !warnedSources.has(source)) {
      warnedSources.add(source);
      console.warn(`[arco] A record in ${basename(source)} exceeds 16 MiB; reading it in full.`);
    }
  };
  const take = (): string => {
    const line = parts.length === 1 ? parts[0].toString('utf8') : Buffer.concat(parts, bytes).toString('utf8');
    parts = [];
    bytes = 0;
    return line;
  };
  for await (const chunk of input) {
    let start = 0;
    const hasCr = options.carriageReturns !== false && chunk.includes(0x0d);
    while (start < chunk.length) {
      if (afterCr) {
        afterCr = false;
        if (chunk[start] === 0x0a) { start++; continue; }
      }
      const lf = chunk.indexOf(0x0a, start);
      const cr = hasCr ? chunk.indexOf(0x0d, start) : -1;
      const end = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
      if (end < 0) break;
      add(chunk.subarray(start, end));
      yield take();
      afterCr = chunk[end] === 0x0d;
      start = end + 1;
    }
    add(chunk.subarray(start));
  }
  if (bytes && options.finalLine !== false) yield take();
}
