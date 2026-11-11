import { lstat, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { MAX_FILE_CONTENT_BYTES, readFileContent, type FileContentBlock, type FileContentResult } from '../../fileContent.js';
import { admitImageResult, type ImageReadResult, type ToolResultContent } from './imageRead.js';
import type { AnyContentBlock, DocumentBlock, ImageBlock } from './contentBlocks.js';

export function nativeFileBlocks(blocks: readonly FileContentBlock[]): Exclude<ToolResultContent, string> {
  return blocks.map(block => {
    if (block.type === 'text') return block;
    if (block.type === 'image') return { type: 'image', source: { type: 'base64', media_type: block.mediaType as ImageBlock['source']['media_type'], data: block.data } };
    return { type: 'document', title: block.name, arcoPages: block.pages, source: { type: 'base64', media_type: 'application/pdf', data: block.data } } as DocumentBlock;
  });
}
export function nativeFileOutcome(result: FileContentResult): { text: string; content?: Exclude<ToolResultContent, string>; isError: boolean } {
  const hasMedia = result.blocks.some(b => b.type !== 'text');
  const content = hasMedia ? nativeFileBlocks(result.blocks) : undefined;
  const text = content ? content.filter(b => b.type === 'text').map(b => b.text).join('\n') : result.text;
  return { text, ...(content ? { content } : {}), isError: result.isError };
}

export async function nativeAttachmentContent(prompt: string, paths: readonly string[] | undefined, history: unknown, signal?: AbortSignal, admit?: (pending: unknown, result: ImageReadResult, origin: 'attachment') => Promise<ImageReadResult>, attachmentOnly = false): Promise<{ content: string | AnyContentBlock[]; notices: string[] }> {
  if (!paths?.length) return { content: prompt || '[empty message]', notices: [] };
  const blocks: AnyContentBlock[] = []; const notices: string[] = [];
  if (prompt) blocks.push({ type: 'text', text: prompt });
  for (const path of paths) {
    signal?.throwIfAborted();
    try {
      const decoded = await readFileContent(await realpath(path), { signal, attachmentOnly, limits: { images: true, documents: false } });
      const result = nativeFileOutcome(decoded);
      const admitted = admit ? await admit(blocks, result, 'attachment') : await admitImageResult(history, blocks, result, 'attachment');
      blocks.push(...(admitted.content ?? [{ type: 'text' as const, text: admitted.text }]));
      blocks.push({ type: 'text', text: `[attached file: ${attachmentOnly ? basename(path).replace(/[\r\n\0]/g, ' ') : path}]${!attachmentOnly && decoded.kind === 'pdf' ? ' PDF sent as text and scanned pages as images; use Read with pages and pdf_mode=visual for layout or figures.' : ''}` });
      if (admitted.isError || admitted.text !== result.text) notices.push(admitted.text);
    } catch (error) {
      signal?.throwIfAborted();
      const text = attachmentOnly ? `[Attached file unavailable: ${basename(path).replace(/[\r\n\0]/g, ' ')}; attach it again.]` : `[Attached file unavailable: ${path}; ${error instanceof Error ? error.message : 'read failed'}]`;
      blocks.push({ type: 'text', text }); notices.push(text);
    }
  }
  return { content: blocks, notices };
}

/** Restore only recorded upload references, never paths inferred from message text. */
export async function restoreChatAttachments(messages: import('./contentBlocks.js').MessageParam[], markers: Map<string, string>): Promise<import('./contentBlocks.js').MessageParam[]> {
  const { managedUploadPath } = await import('../../uploadImages.js');
  const restored: import('./contentBlocks.js').MessageParam[] = [];
  const encoded = JSON.stringify(messages);
  const missing = [...markers.keys()].filter(marker => !encoded.includes(marker));
  if (missing.length) {
    const first = messages.findIndex(message => message.role === 'user');
    if (first >= 0) messages = messages.map((message, index) => {
      if (index !== first) return message;
      const suffix = `\n\nEarlier attachments:\n${missing.join('\n')}`;
      return { ...message, content: typeof message.content === 'string' ? message.content + suffix : [...message.content, { type: 'text' as const, text: suffix }] };
    });
  }
  const clean = (text: string): string => {
    let result = text.replaceAll('[File media omitted from saved context; use Read with the same range to inspect it again.]', '[Earlier attachment media was omitted from saved context.]');
    for (const path of markers.values()) {
      const name = basename(path).replace(/[\r\n\0]/g, ' ');
      result = result.replaceAll(`[attached file: ${path}]`, `[attached file: ${name}]`).replaceAll(`[attached file: ${path}; use Read to inspect again]`, `[attached file: ${name}]`);
    }
    return result;
  };
  for (const message of messages) {
    const blocks: AnyContentBlock[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    const chunks: AnyContentBlock[] = [];
    for (const block of blocks) {
      if (block.type !== 'text') { chunks.push(block); continue; }
      let remaining = clean(block.text);
      while (remaining) {
        let match: { index: number; marker: string; path: string } | undefined;
        for (const [marker, path] of markers) {
          const index = remaining.indexOf(marker);
          if (index >= 0 && (!match || index < match.index)) match = { index, marker, path };
        }
        if (!match) { chunks.push({ type: 'text', text: remaining }); break; }
        if (match.index) chunks.push({ type: 'text', text: remaining.slice(0, match.index) });
        remaining = remaining.slice(match.index + match.marker.length);
        const name = basename(match.path).replace(/[\r\n\0]/g, ' ');
        try {
          const path = managedUploadPath(match.path);
          if (!path || (await lstat(path)).size > MAX_FILE_CONTENT_BYTES) throw new Error('Upload unavailable');
          const decoded = await readFileContent(path, { attachmentOnly: true, limits: { images: true, documents: false } });
          if (decoded.truncated || decoded.isError) throw new Error('Upload unavailable');
          const outcome = nativeFileOutcome(decoded);
          const admitted = await admitImageResult(restored, chunks, outcome, 'attachment');
          if (admitted.isError || admitted.text !== outcome.text) throw new Error('Upload unavailable');
          chunks.push({ type: 'text', text: `[Earlier attachment: ${name}]` }, ...(admitted.content ?? [{ type: 'text' as const, text: admitted.text }]));
        } catch { chunks.push({ type: 'text', text: `[Earlier attachment ${name} is no longer available; attach it again]` }); }
      }
    }
    restored.push({ role: message.role, content: chunks });
  }
  return restored;
}
