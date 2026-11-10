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
