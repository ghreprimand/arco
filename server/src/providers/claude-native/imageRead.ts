import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { readRegularPrefix } from '../../boundedRead.js';
import { deriveModelImage, MODEL_IMAGE_MAX_EDGE } from '../attachments.js';
import { sniffImageMediaType, MAX_IMAGE_RAW_BYTES, type ImageBlock } from './contentBlocks.js';

export type ToolResultContent = string | Array<{ type: 'text'; text: string } | ImageBlock>;
export type ImageReadResult = { text: string; content?: Exclude<ToolResultContent, string>; isError: boolean };
const SOURCE_CAP = 32 * 1024 * 1024;

// Header parsing does not need an external converter. Unknown or incomplete
// headers fail closed rather than submitting a block with unknown dimensions.
export function imagePixelSize(b: Buffer): { width: number; height: number } | null {
  const type = sniffImageMediaType(b);
  let width = 0, height = 0;
  if (type === 'image/png' && b.length >= 33 && b.toString('ascii', 12, 16) === 'IHDR') {
    width = b.readUInt32BE(16); height = b.readUInt32BE(20);
  } else if (type === 'image/gif' && b.length >= 13) {
    width = b.readUInt16LE(6); height = b.readUInt16LE(8);
  } else if (type === 'image/jpeg') {
    for (let i = 2; i + 4 <= b.length;) {
      if (b[i++] !== 255) break;
      while (b[i] === 255) i++;
      const marker = b[i++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (i + 2 > b.length) break;
      const length = b.readUInt16BE(i);
      if (length < 2 || i + length > b.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 8) {
        height = b.readUInt16BE(i + 3); width = b.readUInt16BE(i + 5); break;
      }
      i += length;
    }
  } else if (type === 'image/webp') {
    for (let i = 12; i + 8 <= b.length;) {
      const tag = b.toString('ascii', i, i + 4), length = b.readUInt32LE(i + 4), p = i + 8;
      if (p + length > b.length) break;
      if (tag === 'VP8X' && length >= 10) { width = 1 + b.readUIntLE(p + 4, 3); height = 1 + b.readUIntLE(p + 7, 3); break; }
      if (tag === 'VP8 ' && length >= 10 && b[p + 3] === 0x9d && b[p + 4] === 1 && b[p + 5] === 0x2a) {
        width = b.readUInt16LE(p + 6) & 0x3fff; height = b.readUInt16LE(p + 8) & 0x3fff; break;
      }
      if (tag === 'VP8L' && length >= 5 && b[p] === 0x2f) {
        const bits = b.readUInt32LE(p + 1); width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff); break;
      }
      i = p + length + (length % 2);
    }
  }
  return width > 0 && height > 0 ? { width, height } : null;
}

// Only private temporary copies are resized. Never create a sibling beside a
// project file, trust an existing sibling, or overwrite the original on Read.
export async function readImageResult(path: string, signal: AbortSignal): Promise<ImageReadResult | null> {
  signal.throwIfAborted();
  const prefix = await readRegularPrefix(path, 64 * 1024);
  const media = sniffImageMediaType(prefix.buffer);
  if (!media) {
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extname(path).toLowerCase())) return { text: `image: ${basename(path).replace(/[\r\n\0]/g, ' ')}; not sent: empty or unrecognized image data.`, isError: false };
    return null;
  }
  const name = basename(path).replace(/[\r\n\0]/g, ' ');
  const omitted = (reason: string): ImageReadResult => ({ text: `image: ${name} (${media}); not sent: ${reason}.`, isError: false });
  if (prefix.size > SOURCE_CAP) return omitted('source exceeds the 32 MB local image-read limit; resize the file first');
  let bytes = prefix.size <= prefix.buffer.length ? prefix.buffer : (await readRegularPrefix(path, SOURCE_CAP + 1)).buffer;
  if (bytes.length > SOURCE_CAP || sniffImageMediaType(bytes) !== media) return omitted('file changed while reading; retry');
  const complete = media === 'image/png' ? bytes.length >= 45 && bytes.subarray(-8, -4).toString('ascii') === 'IEND'
    : media === 'image/jpeg' ? bytes.length >= 4 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217
    : media === 'image/gif' ? bytes.length >= 14 && bytes[bytes.length - 1] === 59
    : bytes.length >= 20 && bytes.readUInt32LE(4) + 8 === bytes.length;
  if (!complete) return omitted('image is incomplete or malformed');
  let dims = imagePixelSize(bytes);
  if (!dims) return omitted('image dimensions could not be verified; use a valid PNG, JPEG, GIF or WebP');
  let scratch: string | undefined;
  try {
    if (Math.max(dims.width, dims.height) > MODEL_IMAGE_MAX_EDGE || bytes.length > MAX_IMAGE_RAW_BYTES) {
      scratch = realpathSync(await mkdtemp(join(tmpdir(), 'arco-read-image-')));
      const input = join(scratch, `image.${media.split('/')[1] === 'jpeg' ? 'jpg' : media.split('/')[1]}`);
      await writeFile(input, bytes, { flag: 'wx', mode: 0o600 });
      const resized = await deriveModelImage(input);
      signal.throwIfAborted();
      if (!resized) return omitted('image needs resizing but ImageMagick/sips is unavailable or conversion failed; resize it to at most 2000 pixels per side and 5 MB base64');
      bytes = (await readRegularPrefix(resized, MAX_IMAGE_RAW_BYTES + 1)).buffer;
      dims = imagePixelSize(bytes);
    }
    const actualMedia = sniffImageMediaType(bytes);
    if (!dims || !actualMedia || Math.max(dims.width, dims.height) > MODEL_IMAGE_MAX_EDGE || bytes.length > MAX_IMAGE_RAW_BYTES) return omitted('converted image exceeds the supported size or dimensions');
    signal.throwIfAborted();
    const text = `image: ${name}, ${dims.width}x${dims.height} (${actualMedia})`;
    return { text, isError: false, content: [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: actualMedia, data: bytes.toString('base64') } }] };
  } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
}

export function toolResultText(content: ToolResultContent): string {
  return typeof content === 'string' ? content : content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

// Event logs and text-only summaries retain receipts, never encoded pixels.
export function imageReceipts<T>(value: T): T {
  if (Array.isArray(value)) return value.map(imageReceipts) as T;
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  if (obj.type === 'image') return { type: 'text', text: '[Image omitted from saved context; use Read to inspect it again.]' } as T;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, imageReceipts(v)])) as T;
}

// Budget only newly produced images. Accepted history remains byte-identical
// for thinking/cache bindings. Count operator images and nested tool images.
export function admitImageResult(history: unknown, pending: unknown, result: ImageReadResult): ImageReadResult {
  if (!result.content?.some(b => b.type === 'image')) return result;
  let count = 0, bytes = 0, large = false;
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!v || typeof v !== 'object') return;
    const b = v as Record<string, unknown>;
    if (b.type === 'image') {
      count++;
      const src = b.source as { data?: unknown } | undefined;
      if (typeof src?.data === 'string') {
        bytes += src.data.length;
        const size = imagePixelSize(Buffer.from(src.data, 'base64'));
        if (!size || Math.max(size.width, size.height) > MODEL_IMAGE_MAX_EDGE) large = true;
      } else large = true;
      return;
    }
    Object.values(b).forEach(visit);
  };
  visit(history); visit(pending); visit(result.content);
  // 100 is safe on both 200k and larger windows. The aggregate byte budget
  // leaves room for text/tools below the API's 32 MB request-body limit.
  if (count > 100 || bytes > 20 * 1024 * 1024 || (count > 20 && large)) {
    return { text: `${result.text}; not sent: conversation image budget reached. Compact or start a new conversation, then Read again.`, isError: false };
  }
  return result;
}
