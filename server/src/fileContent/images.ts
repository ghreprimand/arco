import decodeAvif, { init as initAvif } from '@jsquash/avif/decode.js';
import { iconPayload, iconBitmap } from './icons.js';
import { externalImage } from './externalImage.js';
import { decodePngRows } from './pngRows.js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { parseGIF, decompressFrame } from 'gifuct-js';
import bmp from 'bmp-js';
import UTIF from 'utif';
import decodeWebp, { init as initWebp } from '@jsquash/webp/decode.js';
import { positive, textResult, type FileContentBlock, type FileContentOptions, type FileContentResult } from './types.js';
const require = createRequire(import.meta.url);
const MAX_PIXELS = 250_000_000;
export interface Pixels { width: number; height: number; originalWidth?: number; originalHeight?: number; data: Uint8Array | Uint8ClampedArray }

export function imageType(b: Uint8Array): string | null {
  const p = Buffer.from(b.buffer, b.byteOffset, Math.min(b.byteLength, 256));
  if (p.length >= 6 && p.readUInt32LE(0) === 65536 && p.readUInt16LE(4) > 0) return 'image/x-icon';
  if (p.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (p[0] === 255 && p[1] === 216 && p[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(p.toString('ascii', 0, 6))) return 'image/gif';
  if (p.toString('ascii', 0, 4) === 'RIFF' && p.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (p[0] === 66 && p[1] === 77 && p.length >= 26 && [12,40,52,56,108,124].includes(p.readUInt32LE(14))) return 'image/bmp';
  if (p.subarray(0, 4).equals(Buffer.from([73,73,42,0])) || p.subarray(0, 4).equals(Buffer.from([77,77,0,42]))) return 'image/tiff';
  if (p.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(p.toString('ascii', 8))) return 'image/avif';
  if (p.toString('ascii', 4, 8) === 'ftyp' && /heic|heix|hevc|hevx|mif1|msf1/.test(p.toString('ascii', 8))) return 'image/heic';
  return null;
}
function checkSize(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > MAX_PIXELS) throw new Error('Image dimensions exceed the bounded decoder capacity (250 megapixels); crop or export a smaller image.');
}
export async function decodeImage(bytes: Buffer, type = imageType(bytes), edge = 2000): Promise<Pixels> {
  let pixels: Pixels;
  if (type === 'image/x-icon') {
    const payload=iconPayload(bytes);
    return imageType(payload)==='image/png'?decodeImage(payload,'image/png',edge):iconBitmap(payload);
  } else if (type === 'image/png') {
    if (bytes.length < 24) throw new Error('Incomplete PNG');
    const streamed = await decodePngRows(bytes, edge);
    if (streamed) return streamed;
    checkSize(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    pixels = PNG.sync.read(bytes);
  } else if (type === 'image/jpeg') {
    pixels = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 250, maxMemoryUsageInMB: 1536 });
  } else if (type === 'image/gif') {
    const gif = parseGIF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    checkSize(gif.lsd.width, gif.lsd.height);
    const frame = gif.frames.find((f): f is Parameters<typeof decompressFrame>[0] => 'image' in f);
    if (!frame) throw new Error('GIF has no image frame');
    const decoded = decompressFrame(frame, gif.gct, true);
    const data = new Uint8Array(gif.lsd.width * gif.lsd.height * 4);
    for (let y = 0; y < decoded.dims.height; y++) {
      if (y + decoded.dims.top >= gif.lsd.height) break;
      const width = Math.min(decoded.dims.width, gif.lsd.width - decoded.dims.left);
      if (width > 0) data.set(decoded.patch!.subarray(y * decoded.dims.width * 4, (y * decoded.dims.width + width) * 4), ((y + decoded.dims.top) * gif.lsd.width + decoded.dims.left) * 4);
    }
    pixels = { width: gif.lsd.width, height: gif.lsd.height, data };
  } else if (type === 'image/avif') {
    await initAvif({ wasmBinary: Uint8Array.from(readFileSync(require.resolve('@jsquash/avif/codec/dec/avif_dec.wasm'))).buffer });
    const decoded = await decodeAvif(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    if (!decoded) throw new Error('Invalid AVIF pixels');
    pixels = decoded;
  } else if (type === 'image/webp') {
    const module = await WebAssembly.compile(readFileSync(require.resolve('@jsquash/webp/codec/dec/webp_dec.wasm')));
    await initWebp(module);
    pixels = await decodeWebp(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  } else if (type === 'image/tiff') {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const ifd = UTIF.decode(buffer)[0];
    if (!ifd) throw new Error('TIFF has no image');
    checkSize(Number((ifd.t256 as number[] | undefined)?.[0]), Number((ifd.t257 as number[] | undefined)?.[0]));
    UTIF.decodeImage(buffer, ifd);
    pixels = { width: ifd.width, height: ifd.height, data: UTIF.toRGBA8(ifd) };
  } else if (type === 'image/bmp') {
    if (bytes.length < 26) throw new Error('Incomplete BMP');
    checkSize(bytes.readInt32LE(18), Math.abs(bytes.readInt32LE(22)));
    const decoded = bmp.decode(bytes);
    const data = new Uint8Array(decoded.data.length);
    for (let i = 0; i < data.length; i += 4) { data[i] = decoded.data[i + 3]; data[i + 1] = decoded.data[i + 2]; data[i + 2] = decoded.data[i + 1]; data[i + 3] = 255; }
    pixels = { width: decoded.width, height: decoded.height, data };
  } else if (type === 'image/heic') {
    const decode = require('heic-decode') as (o: { buffer: Buffer }) => Promise<Pixels>;
    pixels = await decode({ buffer: bytes });
  } else throw new Error('Unsupported image format');
  checkSize(pixels.width, pixels.height);
  if (pixels.data.length !== pixels.width * pixels.height * 4) throw new Error('Incomplete decoded pixels');
  return pixels;
}

export function resizePixels(source: Pixels, edge: number): Pixels {
  const scale = Math.min(1, edge / Math.max(source.width, source.height));
  if (scale === 1) return source;
  const width = Math.max(1, Math.round(source.width * scale)), height = Math.max(1, Math.round(source.height * scale));
  const data = new Uint8Array(width * height * 4);
  // Bilinear sampling keeps an entire tall screenshot; no region is cropped.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.min(source.width - 1, (x + .5) / scale - .5), sy = Math.min(source.height - 1, (y + .5) / scale - .5);
    const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
    const x1 = Math.min(source.width - 1, x0 + 1), y1 = Math.min(source.height - 1, y0 + 1), dx = sx - x0, dy = sy - y0;
    for (let c = 0; c < 4; c++) data[(y * width + x) * 4 + c] = Math.round(
      source.data[(y0 * source.width + x0) * 4 + c] * (1 - dx) * (1 - dy)
      + source.data[(y0 * source.width + x1) * 4 + c] * dx * (1 - dy)
      + source.data[(y1 * source.width + x0) * 4 + c] * (1 - dx) * dy
      + source.data[(y1 * source.width + x1) * 4 + c] * dx * dy);
  }
  return { width, height, data };
}

export function fittedImage(source: Pixels, name: string, options: FileContentOptions): Extract<FileContentBlock, { type: 'image' }> {
  const max = positive(options.limits?.maxImageBase64Bytes, 5 * 1024 * 1024, 5 * 1024 * 1024);
  let pixels = resizePixels(source, positive(options.limits?.maxImageEdge, 2000, 2000));
  for (let attempt = 0; attempt < 12; attempt++) {
    const pngImage = new PNG({ width: pixels.width, height: pixels.height });
    pngImage.data = Buffer.from(pixels.data);
    const png = PNG.sync.write(pngImage);
    if (Math.ceil(png.length / 3) * 4 <= max) return { type: 'image', mediaType: 'image/png', data: png.toString('base64'), width: pixels.width, height: pixels.height, name };
    const flat = Buffer.from(pixels.data);
    for (let i = 0; i < flat.length; i += 4) { const alpha = flat[i + 3] / 255; for (let c = 0; c < 3; c++) flat[i + c] = Math.round(flat[i + c] * alpha + 255 * (1 - alpha)); flat[i + 3] = 255; }
    for (const quality of [85, 65, 45]) {
      const jpg = jpeg.encode({ width: pixels.width, height: pixels.height, data: flat }, quality).data;
      if (Math.ceil(jpg.length / 3) * 4 <= max) return { type: 'image', mediaType: 'image/jpeg', data: Buffer.from(jpg).toString('base64'), width: pixels.width, height: pixels.height, name };
    }
    const edge = Math.floor(Math.max(pixels.width, pixels.height) * .7);
    if (edge < 1) break;
    pixels = resizePixels(pixels, edge);
  }
  throw new Error('Image cannot fit the requested byte limit');
}
export async function imageResult(bytes: Buffer, name: string, options: FileContentOptions): Promise<FileContentResult> {
  const type = imageType(bytes)!;
  if (options.limits?.images === false) return textResult('image', `image: ${name}, ${type}, ${bytes.length} bytes; this model does not accept images.`, options);
  const edge = positive(options.limits?.maxImageEdge, 2000, 2000);
  const original = (type === 'image/x-icon' ? null : await externalImage(bytes, type, edge)) ?? await decodeImage(bytes, type, edge);
  const originalWidth = original.originalWidth ?? original.width, originalHeight = original.originalHeight ?? original.height;
  const image = fittedImage(original, name, options);
  const text = `image: ${name}, ${image.width}x${image.height} (${image.mediaType}, ${bytes.length} source bytes)${image.width !== originalWidth || image.height !== originalHeight ? `; scaled from ${originalWidth}x${originalHeight}, original unchanged` : ''}`;
  return textResult('image', text, options, [{ type: 'text', text }, image]);
}
