// Pure header geometry shared by provider context estimates. Fitted payloads
// use these formats; unknown headers receive the conservative maximum cost.
function imageKind(b: Buffer): string | null {
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return 'image/gif';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Header parsing does not need an external converter. Unknown or incomplete
// headers fail closed rather than submitting a block with unknown dimensions.
export function imagePixelSize(b: Buffer): { width: number; height: number } | null {
  const type = imageKind(b);
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

export const MAX_IMAGE_PIXEL_TOKENS = 4784;

/** Same bounded pixel cost used by Native context management. */
export function imageBase64TokenCost(data: string): number {
  // Generated PNG/JPEG headers fit well within this prefix. Truncated or
  // unknown legacy headers use the maximum, never their encoded byte length.
  const size = imagePixelSize(Buffer.from(data.slice(0, 256 * 1024), 'base64'));
  return size ? Math.min(MAX_IMAGE_PIXEL_TOKENS, Math.ceil(size.width / 28) * Math.ceil(size.height / 28)) : MAX_IMAGE_PIXEL_TOKENS;
}
