import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { UPLOADS_DIR } from '../server/constants.js';
import { ensureStorageRoot } from '../storageRoot.js';
import { writeCheckedFile } from '../checkedFile.js';
import { readFileContent, type FileContentBlock } from '../fileContent.js';

export type ProviderImage = Extract<FileContentBlock, { type: 'image' }>;
export interface PreparedAttachments { text: string; images: ProviderImage[] }
const MAX_REQUEST_IMAGES = 16;
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;

// Paths here come from the operator's already-authorized attachment list.
// Tool reads authorize against the workflow separately before calling the decoder.
export async function prepareProviderAttachments(paths: string[] | undefined, images = true, signal?: AbortSignal): Promise<PreparedAttachments> {
  const texts: string[] = [];
  const media: ProviderImage[] = [];
  let imageBytes = 0;
  for (const path of paths ?? []) {
    if (signal?.aborted) break;
    try {
      const result = await readFileContent(await realpath(path), { signal, limits: { images, documents: false, maxTextBytes: 32 * 1024, maxImages: Math.max(1,MAX_REQUEST_IMAGES-media.length), maxImageBase64Bytes: 2 * 1024 * 1024 } });
      texts.push(`[attached file: ${path}]\n${result.text}`);
      const decoded = result.blocks.filter((b): b is ProviderImage => b.type === 'image');
      for (const image of decoded) {
        if (media.length >= MAX_REQUEST_IMAGES || imageBytes + image.data.length > MAX_REQUEST_IMAGE_BYTES) {
          texts.push(`[Image ${image.name} omitted: this message reached its image budget. Attach fewer files.]`);
        } else { media.push(image); imageBytes += image.data.length; }
      }
    } catch (error) {
      texts.push(`[attached file: ${path}]\n[error] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { text: texts.join('\n\n'), images: media };
}

export function openAiImageMessage(images: ProviderImage[]) {
  return { role: 'user' as const, content: [
    { type: 'text' as const, text: 'Images returned by the preceding tool calls. File labels identify each result.' },
    ...images.flatMap((image) => [
      { type: 'text' as const, text: image.name },
      { type: 'image_url' as const, image_url: { url: `data:${image.mediaType};base64,${image.data}` } },
    ]),
  ] };
}

export const FILE_READ_GUIDANCE = 'Use Arco read_file for local files and fetch_file for public URLs containing images, PDFs, Word, Excel, PowerPoint, OpenDocument, RTF or notebooks when available. It fits images and decodes documents without extra software. Use its pages range for large documents. Never decode a binary file as text.';

export function ollamaVisionMessages<T extends {content:string;images?:string[]}>(messages: T[], vision: boolean): T[] {
  let count=0,bytes=0;
  return messages.map((message) => {
    if (!message.images?.length) return message;
    const accepted=vision ? message.images.filter(image=>{
      if(count>=MAX_REQUEST_IMAGES||bytes+image.length>MAX_REQUEST_IMAGE_BYTES)return false;
      count++;bytes+=image.length;return true;
    }) : [];
    if(accepted.length===message.images.length)return message;
    const {images: omitted,...rest}=message;
    const reason=vision?'this request reached its image budget':'the selected model did not report vision support';
    return {...rest,...(accepted.length?{images:accepted}:{}),content:message.content+`\n[Image not sent: ${reason}.]`} as T;
  });
}
export function openAiVisionMessages<T extends {content:string | Array<{type:string}>}>(messages:T[], vision:boolean):T[] {
  let count=0,bytes=0;
  return messages.map((message) => {
    if (!Array.isArray(message.content) || !message.content.some(p => p.type === 'image_url')) return message;
    let omitted=false;
    const accepted=message.content.filter(part=>{
      if(part.type!=='image_url')return true;
      const url=(part as {type:string;image_url?:{url?:string}}).image_url?.url ?? '';
      if(!vision||count>=MAX_REQUEST_IMAGES||bytes+url.length>MAX_REQUEST_IMAGE_BYTES){omitted=true;return false;}
      count++;bytes+=url.length;return true;
    });
    if(!omitted)return message;
    const reason=vision?'this request reached its image budget':'the selected model did not report vision support';
    return {...message,content:[...accepted,{type:'text',text:`[Image not sent: ${reason}.]`}]} as T;
  });
}

// Local-image CLI inputs must point at exactly the fitted bytes. Keep derived
// copies with uploads for provider session replay; never write project siblings
// and never fall back to an original file after a failed conversion.
export async function persistProviderImages(images:ProviderImage[]):Promise<string[]> {
  if (!images.length) return [];
  const root = await ensureStorageRoot(UPLOADS_DIR);
  const paths:string[] = [];
  for (const image of images) {
    const path = join(root,`${randomUUID()}.model.${image.mediaType === 'image/jpeg'?'jpg':'png'}`);
    await writeCheckedFile(path,Buffer.from(image.data,'base64'),false,0o600);
    paths.push(path);
  }
  return paths;
}
