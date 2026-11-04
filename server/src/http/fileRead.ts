import { open } from 'fs/promises';
import { constants } from 'fs';
import { FileAccessError } from '../fileAccessPolicy.js';
import { extname, resolve } from 'path';
import { MAX_TEXT_SIZE, MAX_IMAGE_SIZE } from '../server/constants.js';

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

export async function readFileForExplorer(path: string) {
  const ext = extname(path).toLowerCase();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new FileAccessError();
    const size = stats.size;
    if (IMAGE_MIME[ext]) {
      if (size > MAX_IMAGE_SIZE) return { type: 'too-large' as const, size, kind: 'image' as const };
      const buf = await handle.readFile();
      return {
        type: 'image' as const,
        dataUrl: `data:${IMAGE_MIME[ext]};base64,${buf.toString('base64')}`,
        size,
      };
    }
    if (size > MAX_TEXT_SIZE) return { type: 'too-large' as const, size, kind: 'text' as const };
    const buf = await handle.readFile();
    const sample = buf.subarray(0, Math.min(8192, buf.length));
    if (sample.includes(0)) {
      return { type: 'binary' as const, size };
    }
    return { type: 'text' as const, content: buf.toString('utf-8'), size };
  } finally { await handle.close(); }
}

// Claude CLI stores historical transcripts at
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// Encoding replaces every non-[A-Za-z0-9-] char with `-`, not just `/` — see
// sessionJsonl.ts::resolveSessionJsonlPath for the canonical rule. The old
// regex here only replaced `/`, so any cwd containing `_`, `.`, or whitespace
// (e.g. `Sample_Project`) silently mapped to a non-existent directory
// and the Resume picker + transcript endpoints returned empty.
export function encodeProjectDir(cwd: string): string {
  return resolve(cwd).replace(/[^A-Za-z0-9-]/g, '-');
}
