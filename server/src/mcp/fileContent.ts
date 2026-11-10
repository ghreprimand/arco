import { fileContentFromBytes, MAX_FILE_CONTENT_BYTES, type FileContentBlock } from '../fileContent.js';
export interface McpToolResult { text: string; isError: boolean; blocks?: FileContentBlock[]; pdfReceipt?: string }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export async function normalizeMcpFileContent(raw: unknown, signal?: AbortSignal): Promise<McpToolResult> {
  const result = record(raw) ? raw : {};
  if (!Array.isArray(result.content)) return { text: JSON.stringify(result.structuredContent ?? result).slice(0, 256 * 1024), isError: result.isError === true };
  const blocks: FileContentBlock[] = []; let media = 0; let pdfReceipt: string | undefined;
  for (const entry of result.content.slice(0,100)) {
    signal?.throwIfAborted();
    if (!record(entry)) continue;
    if (entry.type === 'text' && typeof entry.text === 'string') { blocks.push({ type:'text',text:entry.text.slice(0,256*1024) }); continue; }
    const resource = entry.type === 'resource' && record(entry.resource) ? entry.resource : undefined;
    const source = record(entry.source) ? entry.source : undefined;
    const encoded = typeof entry.data === 'string' ? entry.data : typeof resource?.blob === 'string' ? resource.blob : source?.type === 'base64' && typeof source.data === 'string' ? source.data : undefined;
    const name = typeof resource?.uri === 'string' ? resource.uri.split('/').pop() || 'tool-result' : typeof entry.name === 'string' ? entry.name : 'tool-result';
    if (encoded && (entry.type === 'image' || entry.type === 'document' || resource)) {
      if (encoded.length > Math.ceil(MAX_FILE_CONTENT_BYTES / 3) * 4) { blocks.push({type:'text',text:'[Tool media exceeded the response decoding budget; request a smaller result.]'});continue; }
      const parsed = await fileContentFromBytes(Buffer.from(encoded,'base64'), name, { signal, limits:{images:true,documents:false,maxImages:20,maxDocumentPages:100} });
      if (parsed.kind === 'pdf') pdfReceipt = `PDF ${name} decoded to text; re-run the source tool to inspect it again`;
      for (const block of parsed.blocks) {
        if (block.type === 'text') { blocks.push(block); continue; }
        if (media >= 20) {
          blocks.push({ type: 'text', text: '[Tool media exceeded the response decoding budget; request a smaller result.]' });
        } else { blocks.push(block); media++; }
      }
      continue;
    }
    if (typeof resource?.text === 'string') { blocks.push({type:'text',text:resource.text.slice(0,256*1024)});continue; }
    blocks.push({type:'text',text:`[Tool ${String(entry.type ?? 'content')} result${typeof entry.mimeType === 'string' ? ` (${entry.mimeType})` : ''}: binary payload omitted or resource referenced${typeof entry.uri === 'string' ? ` at ${entry.uri.slice(0,1000)}` : ''}.]`});
  }
  if (!blocks.length) blocks.push({type:'text',text:'(no output)'});
  return { text:blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n'),blocks,isError:result.isError===true,...(pdfReceipt ? {pdfReceipt} : {}) };
}
