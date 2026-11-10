import { realpath } from 'node:fs/promises';
import { readFileContent, type FileContentBlock, type FileContentResult } from '../../fileContent.js';
import { admitImageResult, type ToolResultContent } from './imageRead.js';
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

export async function nativeAttachmentContent(prompt: string, paths: readonly string[] | undefined, history: unknown, signal?: AbortSignal): Promise<{ content: string | AnyContentBlock[]; notices: string[] }> {
  if (!paths?.length) return { content: prompt || '[empty message]', notices: [] };
  const blocks: AnyContentBlock[] = []; const notices: string[] = [];
  if (prompt) blocks.push({ type: 'text', text: prompt });
  for (const path of paths) {
    signal?.throwIfAborted();
    try {
      const result = nativeFileOutcome(await readFileContent(await realpath(path), { signal, limits: { images: true, documents: true } }));
      const admitted = admitImageResult(history, blocks, result);
      blocks.push(...(admitted.content ?? [{ type: 'text' as const, text: admitted.text }]));
      blocks.push({ type: 'text', text: `[attached file: ${path}]` });
      if (admitted.isError || admitted.text !== result.text) notices.push(admitted.text);
    } catch (error) {
      signal?.throwIfAborted();
      const text = `[Attached file unavailable: ${path}; ${error instanceof Error ? error.message : 'read failed'}]`;
      blocks.push({ type: 'text', text }); notices.push(text);
    }
  }
  return { content: blocks, notices };
}
