// Destructive image optimization is confined to Arco-managed uploads. Read
// tools use fileContent instead, which never writes beside a project file.
import fs from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { UPLOADS_DIR } from './server/constants.js';
import { decodeImage, imageType, resizePixels } from './fileContent/images.js';
import { withFileDecodeSlot } from './fileContent/decodeSlots.js';

export const UPLOAD_IMAGE_MAX_BYTES = 1024 * 1024;
export const UPLOAD_IMAGE_MAX_EDGE = 2000;

/** Allow aliases above uploads, but reject links at or inside the uploads root. */
export function managedUploadPath(path: string): string | null {
  try {
    const root = resolve(UPLOADS_DIR), absolute = resolve(path);
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const canonicalRoot = fs.realpathSync(root);
    const relativeTo = (base: string) => {
      const child = relative(base, absolute);
      return child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`) ? child : null;
    };
    const child = relativeTo(root) ?? relativeTo(canonicalRoot);
    if (!child) return null;
    let current = canonicalRoot;
    const parts = child.split(sep);
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) return null;
    }
    if (fs.realpathSync(current) !== current) return null;
    return current;
  } catch { return null; }
}

// Re-encoding must not silently discard frames or reduce sample precision.
function canRewritePng(bytes: Buffer): boolean {
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return false;
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (kind === 'acTL') return false;
    if (kind === 'IHDR' && (length !== 13 || bytes[offset + 16] === 16)) return false;
    if (kind === 'IEND') return true;
    offset += length + 12;
  }
  return false;
}

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Keep the stored path; atomically replace the larger upload only on success. */
export async function shrinkUploadedImage(path: string): Promise<boolean> {
  return withFileDecodeSlot(async () => {
    let temp: string | undefined, tempIdentity: fs.Stats | undefined;
    try {
      const target = managedUploadPath(path);
      if (!target) return false;
      const initial = fs.lstatSync(target);
      if (initial.nlink !== 1 || initial.size > 512 * 1024 * 1024) return false;
      const input = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      let original: Buffer;
      try {
        if (!sameFile(initial, fs.fstatSync(input))) return false;
        original = fs.readFileSync(input);
      } finally { fs.closeSync(input); }
      const type = imageType(original);
      // Source format distinguishes photos from screenshots. Other formats
      // retain their existing model conversion without destructive rewriting.
      if (type !== 'image/jpeg' && type !== 'image/png') return false;
      if (type === 'image/png' && !canRewritePng(original)) return false;
      const source = await decodeImage(original, type, UPLOAD_IMAGE_MAX_EDGE);
      const width = source.originalWidth ?? source.width;
      const height = source.originalHeight ?? source.height;
      if (initial.size <= UPLOAD_IMAGE_MAX_BYTES && Math.max(width, height) <= UPLOAD_IMAGE_MAX_EDGE) return false;
      const pixels = resizePixels(source, UPLOAD_IMAGE_MAX_EDGE);
      const photo = { width: pixels.width, height: pixels.height, data: Buffer.from(pixels.data),
        exifBuffer: (source as typeof source & { exifBuffer?: Uint8Array }).exifBuffer };
      const candidate = type === 'image/jpeg'
        ? Buffer.from(jpeg.encode(photo, 90).data)
        : PNG.sync.write({ width: pixels.width, height: pixels.height, data: Buffer.from(pixels.data) } as PNG);
      if (candidate.length >= original.length) return false;
      // No asynchronous gap between validating the target and creating its
      // private sibling. O_EXCL prevents an existing link/file being opened.
      if (managedUploadPath(target) !== target || !sameFile(initial, fs.lstatSync(target))) return false;
      temp = join(dirname(target), `.upload-image-${randomUUID()}.tmp`);
      const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try {
        tempIdentity = fs.fstatSync(fd);
        fs.writeFileSync(fd, candidate);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      if (managedUploadPath(temp) !== temp) return false;
      const stored = fs.readFileSync(temp);
      if (!stored.equals(candidate)) return false;
      const verified = await decodeImage(stored, type, UPLOAD_IMAGE_MAX_EDGE);
      if (verified.width !== pixels.width || verified.height !== pixels.height) return false;
      // Recheck both paths and file identities after decoding. No await occurs
      // between these checks and the rename. Never unlink the original first.
      if (managedUploadPath(target) !== target || managedUploadPath(temp) !== temp) return false;
      const currentTemp = fs.lstatSync(temp);
      if (!sameFile(initial, fs.lstatSync(target)) || currentTemp.ino !== tempIdentity.ino || currentTemp.dev !== tempIdentity.dev
        || !fs.readFileSync(target).equals(original) || !fs.readFileSync(temp).equals(candidate)) return false;
      fs.renameSync(temp, target);
      temp = undefined;
      return true;
    } catch { return false; }
    finally {
      // Never follow a changed parent or remove a replacement file on failure.
      if (temp && tempIdentity && managedUploadPath(temp) === temp) {
        try {
          const current = fs.lstatSync(temp);
          if (current.ino === tempIdentity.ino && current.dev === tempIdentity.dev) fs.unlinkSync(temp);
        } catch { /* The original upload remains usable. */ }
      }
    }
  });
}
