import { MODEL_IMAGE_MAX_EDGE } from '../attachments.js';
import { sniffImageMediaType, type ImageBlock, type DocumentBlock } from './contentBlocks.js';

export type ToolResultContent = string | Array<{ type: 'text'; text: string } | ImageBlock | DocumentBlock>;
export type ImageReadResult = { text: string; content?: Exclude<ToolResultContent, string>; isError: boolean };

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

export function toolResultText(content: ToolResultContent): string {
  return typeof content === 'string' ? content : content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

// Event logs and text-only summaries retain receipts, never encoded pixels.
export function imageReceipts<T>(value: T): T {
  let media = false;
  const scan = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(scan); return; }
    if (!v || typeof v !== 'object') return;
    const b = v as Record<string, unknown>;
    if ((b.type === 'image' || b.type === 'document') && b.source) media = true;
    Object.values(b).forEach(scan);
  };
  scan(value);
  if (!media) return value;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.filter(b => !b || typeof b !== 'object' || !['thinking','redacted_thinking'].includes((b as {type?: string}).type ?? '')).map(walk);
    if (!v || typeof v !== 'object') return v;
    const obj = v as Record<string, unknown>;
    if ((obj.type === 'image' || obj.type === 'document') && obj.source) return { type: 'text', text: '[File media omitted from saved context; use Read with the same range to inspect it again.]' };
    const next = Object.fromEntries(Object.entries(obj).map(([key, child]) => [key, walk(child)]));
    if (next.role === 'assistant' && Array.isArray(next.content) && next.content.length === 0) next.content = [{type:'text',text:'[Prior reasoning omitted from saved file context.]'}];
    return next;
  };
  return walk(value) as T;
}

// Budget only newly produced images. Accepted history remains byte-identical
// for thinking/cache bindings. Count operator images and nested tool images.
export function admitImageResult(history: unknown, pending: unknown, result: ImageReadResult): ImageReadResult {
  if (!result.content?.some(b => b.type === 'image' || b.type === 'document')) return result;
  let count = 0, bytes = 0, large = false, pages = 0;
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!v || typeof v !== 'object') return;
    const b = v as Record<string, unknown>;
    if (b.type === 'document') {
      pages += typeof b.arcoPages === 'number' ? b.arcoPages : 100;
      const src = b.source as { data?: unknown } | undefined;
      if (typeof src?.data === 'string') bytes += src.data.length;
      return;
    }
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
  if (count + pages > 100 || bytes > 20 * 1024 * 1024 || (count > 20 && large)) {
    return { text: `${result.text}; not sent: conversation image/document budget reached. Compact or start a new conversation, then Read again.`, isError: false };
  }
  return result;
}
