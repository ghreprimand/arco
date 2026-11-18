import type { IncomingMessage } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { shrinkUploadedImage } from '../uploadImages.js';
import { queueModelImage } from '../providers/attachments.js';
import { UPLOADS_DIR, UPLOAD_IMAGE_EXT } from '../server/constants.js';
import { ensureStorageRoot } from '../storageRoot.js';

export interface StoredAttachment {
  fileId: string;
  filename: string;
  path: string;
}

export class UploadTooLarge extends Error {}

export async function readAttachmentBody(req: IncomingMessage, limit?: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (limit !== undefined && size > limit) throw new UploadTooLarge();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

export async function storeAttachment(
  body: Buffer,
  rawFilename: string,
  contentType: string,
  reservation?: { fileId: string; beforeWrite: (file: StoredAttachment) => Promise<void> },
): Promise<StoredAttachment> {
  const inferredExt = !extname(rawFilename) ? UPLOAD_IMAGE_EXT[contentType] : undefined;
  const filename = basename(rawFilename) + (inferredExt ?? '');
  const fileId = reservation?.fileId ?? randomUUID().slice(0, 8);
  const root = await ensureStorageRoot(UPLOADS_DIR);
  const path = join(root, `${fileId}-${filename}`);
  const stored = { fileId, filename, path };
  await reservation?.beforeWrite(stored);
  await writeFile(path, body, { flag: 'wx', mode: 0o600 });
  if (!reservation) console.log(`[arco] File uploaded: ${filename} -> ${path}`);
  // Finish any replacement before publishing the stable path.
  await shrinkUploadedImage(path);
  queueModelImage(path);
  return stored;
}
