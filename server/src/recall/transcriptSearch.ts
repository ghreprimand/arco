import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readLogLines } from '../eventLog.js';

// Preserve ripgrep's case-insensitive regex semantics while reading sealed and
// live records through the canonical reader. Backpressure bounds the input;
// only one bounded matching line is retained, never the whole transcript.
export async function searchTranscript(dir: string, query: string, bin: string): Promise<{ available: boolean; text?: string }> {
  const child = spawn(bin, ['-i', '--max-count', '1', '--line-buffered', '-e', query, '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const input = Readable.from((async function* () { for await (const line of readLogLines(dir)) yield line + '\n'; })());
  let text = '', matched = false;
  const result = new Promise<{ available: boolean; text?: string }>((resolve) => {
    const timeout = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', (chunk: Buffer) => {
      matched = true;
      text += chunk.toString('utf8').slice(0, 4096 - text.length);
      if (text.includes('\n') || text.length >= 4096) child.kill();
    });
    child.on('error', () => { clearTimeout(timeout); input.destroy(); resolve({ available: false }); });
    child.on('close', () => { clearTimeout(timeout); input.destroy(); resolve({ available: true, ...(matched ? { text: text.split('\n', 1)[0] } : {}) }); });
  });
  const feeding = pipeline(input, child.stdin).catch(() => { /* rg stops after its first match; unreadable logs remain intact */ });
  const found = await result;
  await feeding;
  return found;
}
