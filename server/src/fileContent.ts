import { decodeLegacyText } from './fileContent/legacyText.js';
import { binaryResult, legacyTextResult } from './fileContent/types.js';
import { withFileDecodeSlot } from './fileContent/decodeSlots.js';
import { fileHeaderKind } from './fileContent/detect.js';
export { fileHeaderKind } from './fileContent/detect.js';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { readRegularPrefix, readRegularRange } from './boundedRead.js';

export type FileContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; width: number; height: number; name: string }
  | { type: 'document'; mediaType: 'application/pdf'; data: string; name: string; pages: number };
export interface FileContentLimits {
  images?: boolean;
  documents?: boolean;
  maxImageBase64Bytes?: number;
  maxImageEdge?: number;
  maxImages?: number;
  maxDocumentPages?: number;
  maxDocumentBase64Bytes?: number;
  maxTextBytes?: number;
}
export interface FileContentOptions {
  /** Internal codec verification can bypass optional installed converters. */
  externalPrograms?: boolean;
  signal?: AbortSignal;
  /** One-based pages, sheets, slides or cells: "1-3,5". */
  pages?: string;
  offset?: number;
  limit?: number;
  limits?: FileContentLimits;
}
export interface FileContentResult {
  text: string;
  blocks: FileContentBlock[];
  kind: string;
  truncated: boolean;
  isError: boolean;
}
export const MAX_FILE_CONTENT_BYTES = 512 * 1024 * 1024;

/** Route SVG and XML prefixes through the shared decoder. */
export function isSvgPrefix(bytes: Uint8Array): boolean {
  return /<svg[\s>]|<\?xml[\s>]/i.test(Buffer.from(bytes).toString('utf8'));
}

function note(name: string, size: number, reason: string, isError = false): FileContentResult {
  const text = `file: ${basename(name).replace(/[\r\n\0]/g, ' ')}, ${size} bytes; ${reason}`;
  return { text, blocks: [{ type: 'text', text }], kind: 'binary', truncated: false, isError };
}

/** Caller authorizes the canonical path. This function verifies the opened file. */
export async function readFileContent(path: string, options: FileContentOptions = {}): Promise<FileContentResult> {
  options.signal?.throwIfAborted();
  const prefix = await readRegularPrefix(path, 4096);
  const kind = fileHeaderKind(prefix.buffer);
  const structured = /\.(?:svg|ipynb)$/i.test(path) || isSvgPrefix(prefix.buffer) || /"(?:cells|nbformat)"\s*:/.test(prefix.buffer.toString('utf8'));
  if ((kind === 'text/plain' || kind === 'invalid-utf8') && !structured) {
    const r = await readRegularRange(path, Math.min(options.limits?.maxTextBytes ?? 256 * 1024, 1024 * 1024), Math.max(1, options.offset ?? 1), options.limit, options.signal, 8192, decodeLegacyText);
    if (r.invalidUtf8 || r.text.includes('\0')) return binaryResult(basename(path), prefix.size, r.text.includes('\0') ? 'application/octet-stream' : 'invalid-utf8', options);
    if (r.legacyDecoded) return legacyTextResult(r.text, { limits: options.limits }, r.truncated);
    const text = r.text + (r.truncated ? '\n[Text truncated; use offset and limit for another range.]' : '');
    return { text, blocks: [{ type: 'text', text }], kind: 'text', truncated: r.truncated, isError: false };
  }
  if (prefix.size > MAX_FILE_CONTENT_BYTES) return note(path, prefix.size, 'too large to decode safely (512 MB source limit); crop an image or export selected document pages.');
  return withFileDecodeSlot(async () => {
    const data = prefix.size <= prefix.buffer.length ? prefix.buffer : (await readRegularPrefix(path, MAX_FILE_CONTENT_BYTES + 1)).buffer;
    return decodeContentBytes(data, basename(path), options);
  }, options.signal);
}

/** Decode untrusted bounded bytes without fetching URLs or reading external resources. */
export async function fileContentFromBytes(bytes: Uint8Array, name: string, options: FileContentOptions = {}): Promise<FileContentResult> {
  return withFileDecodeSlot(() => decodeContentBytes(bytes,name,options), options.signal);
}
async function decodeContentBytes(bytes: Uint8Array, name: string, options: FileContentOptions): Promise<FileContentResult> {
  options.signal?.throwIfAborted();
  if (bytes.byteLength > MAX_FILE_CONTENT_BYTES) return note(name, bytes.byteLength, 'too large to decode safely (512 MB source limit); crop an image or export selected document pages.');
  {
    options.signal?.throwIfAborted();
    const js = new URL('./fileContent/worker.js', import.meta.url);
    const source = !existsSync(js);
    const worker = new Worker(source ? new URL('./fileContent/worker.ts', import.meta.url) : js, {
      execArgv: source ? ['--import', 'tsx'] : [],
      resourceLimits: { maxOldGenerationSizeMb: 2048, maxYoungGenerationSizeMb: 32 },
    });
    try {
      return await new Promise<FileContentResult>((resolve, reject) => {
        const timer = setTimeout(() => finish(note(name, bytes.byteLength, 'decoding exceeded its time limit; select a smaller range.', true)), 30_000);
        const onAbort = () => { clearTimeout(timer); reject(options.signal?.reason ?? new Error('Cancelled')); };
        const finish = (result: FileContentResult) => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); resolve(result); };
        worker.once('message', finish);
        worker.once('error', () => finish(note(name, bytes.byteLength, 'decoding failed safely; the file may be unsupported or malformed.', true)));
        worker.once('exit', code => { if (code !== 0) finish(note(name, bytes.byteLength, 'decoding exceeded its resource limit or failed.', true)); });
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted) { onAbort(); return; }
        const data = Uint8Array.from(bytes);
        const { signal: _signal, ...wireOptions } = options;
        worker.postMessage({ data, name: basename(name), options: wireOptions }, [data.buffer]);
      });
    } finally { await worker.terminate(); }
  }
}
