import { nativeMediaLimits, type NativeMediaLimits } from './mediaLimits.js';
import { PDFDocument } from 'pdf-lib';
import { imagePixelSize } from '../../imageTokens.js';
export { imagePixelSize } from '../../imageTokens.js';
import { MODEL_IMAGE_MAX_EDGE } from '../attachments.js';
import type { ImageBlock, DocumentBlock } from './contentBlocks.js';

export type ToolResultContent = string | Array<{ type: 'text'; text: string } | ImageBlock | DocumentBlock>;
export type ImageReadResult = { text: string; content?: Exclude<ToolResultContent, string>; isError: boolean };


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

const measuredPdfPages = new WeakMap<object, Promise<number>>();

// Budget only newly produced images. Accepted history remains byte-identical
// for thinking/cache bindings. Count operator images and nested tool images.
export async function admitImageResult(history: unknown, pending: unknown, result: ImageReadResult, origin: 'tool' | 'attachment' = 'tool', limits: NativeMediaLimits = nativeMediaLimits()): Promise<ImageReadResult> {
  if (!result.content?.some(b => b.type === 'image' || b.type === 'document')) return result;
  let count = 0, bytes = 0, large = false, pages = 0;
  const unmeasured: Array<{ block: object; data: string }> = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!v || typeof v !== 'object') return;
    const b = v as Record<string, unknown>;
    if (b.type === 'tool_use' || b.type === 'server_tool_use') return;
    if (b.type === 'document') {
      const src = b.source as { type?: string; media_type?: string; data?: unknown } | undefined;
      if (src?.type !== 'base64' || src.media_type !== 'application/pdf' || typeof src.data !== 'string') return;
      bytes += src.data.length;
      if (typeof b.arcoPages === 'number' && Number.isInteger(b.arcoPages) && b.arcoPages > 0) pages += b.arcoPages;
      else unmeasured.push({ block: b, data: src.data });
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
  for (const pdf of unmeasured) {
    // Wire projections omit Arco metadata. Measure those PDFs without mutating
    // accepted history or inventing 100 pages for an ordinary document.
    let measured = measuredPdfPages.get(pdf.block);
    if (!measured) {
      measured = PDFDocument.load(Buffer.from(pdf.data, 'base64')).then(document => document.getPageCount(), () => 1);
      measuredPdfPages.set(pdf.block, measured);
    }
    pages += await measured; // Invalid PDF: leave format rejection to the API.
  }
  // The selected model controls image and PDF-page limits independently.
  // Unknown/custom endpoints keep the documented conservative app byte cap.
  if (count > limits.images || pages > limits.pdfPages || bytes > limits.encodedBytes || (count > 20 && large)) {
    const limit = count > limits.images ? `${limits.images} images` : pages > limits.pdfPages ? `${limits.pdfPages} PDF pages` : bytes > limits.encodedBytes ? `${limits.encodedBytes / 1024 / 1024} MiB encoded media` : '2000 px per image above 20 images';
    const action = origin === 'attachment' ? 'Use COMPACT or HANDOFF, then attach the file again.' : 'Use COMPACT or HANDOFF, then request the file again.';
    return { text: `${result.text}; image/document not sent: conversation image/document budget reached (${limit}; ${count} images, ${pages} PDF pages, ${(bytes / 1024 / 1024).toFixed(2)} MiB encoded media). ${action}`, isError: false };
  }
  return result;
}
