import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'arco-upload-shrink-')));
installIsolatedTestHome(root);
const uploads = join(root, 'uploads'); fs.mkdirSync(uploads);
process.env.ARCO_UPLOADS_DIR = uploads;
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { shrinkUploadedImage } = await import('./uploadImages.js');
function png(width: number, height: number) {
  const image = new PNG({ width, height });
  image.data.fill(255); return PNG.sync.write(image);
}
const wide = png(3000, 1000);
function put(name: string, bytes = wide) { const path = join(uploads, name); fs.writeFileSync(path, bytes); return path; }

test('large uploaded PNG replaces bytes at the same path and leaves no larger sibling', async () => {
  const path = put('wide.png');
  const refs = { attachment: path, event: { path }, fileContext: path, replay: [path] };
  assert.equal(await shrinkUploadedImage(path), true);
  assert.ok(fs.statSync(path).size < wide.length);
  const image = PNG.sync.read(fs.readFileSync(path));
  assert.deepEqual([image.width, image.height], [2000, 667]);
  for (const ref of [refs.attachment, refs.event.path, refs.fileContext, ...refs.replay]) assert.equal(fs.realpathSync(ref), path);
  assert.deepEqual(fs.readdirSync(uploads).filter(n => n.startsWith('wide')), ['wide.png']);
});

test('threshold is strict; byte-only PNG shrinking preserves all pixels', async () => {
  const small = png(2000, 10);
  const atLimit = Buffer.concat([small, Buffer.alloc(1024 * 1024 - small.length)]);
  const path = put('threshold.png', atLimit);
  assert.equal(await shrinkUploadedImage(path), false);
  assert.deepEqual(fs.readFileSync(path), atLimit);
  const over = put('byte-only.png', Buffer.concat([atLimit, Buffer.from([0])]));
  assert.equal(await shrinkUploadedImage(over), true);
  const decoded = PNG.sync.read(fs.readFileSync(over));
  assert.deepEqual([decoded.width, decoded.height], [2000, 10]);
  assert.deepEqual(decoded.data, PNG.sync.read(small).data);
});

test('JPEG uses JPEG without upscaling; keep the original when output is larger', async () => {
  const pixels = { width: 100, height: 100, data: Buffer.alloc(100 * 100 * 4, 255) };
  const original = jpeg.encode(pixels, 90).data;
  const path = put('photo.jpg', Buffer.concat([original, Buffer.alloc(1024 * 1024)]));
  assert.equal(await shrinkUploadedImage(path), true);
  const out = fs.readFileSync(path); assert.equal(out[0], 255); assert.equal(out[1], 216);
  const decoded = jpeg.decode(out); assert.deepEqual([decoded.width, decoded.height], [100, 100]);
  // A highly compressed tall image can be smaller than its resized encoding.
  const noisy = Buffer.alloc(2100 * 4, 255);
  for (let i = 0; i < noisy.length; i += 4) { noisy[i] = i % 255; noisy[i + 1] = (i * 13) % 255; noisy[i + 2] = (i * 71) % 255; }
  const compact = jpeg.encode({ width: 2100, height: 1, data: noisy }, 1).data;
  const compactPath = put('compact.jpg', compact);
  assert.equal(await shrinkUploadedImage(compactPath), false);
  assert.deepEqual(fs.readFileSync(compactPath), compact);
});

test('outside paths, file links, directory links, root links and realpath escapes are refused', async () => {
  const external = join(root, 'external.png'); fs.writeFileSync(external, wide);
  assert.equal(await shrinkUploadedImage(external), false);
  const { deriveModelImage } = await import('./providers/attachments.js');
  assert.equal(await deriveModelImage(external), null);
  assert.equal(fs.existsSync(external + '.model.png'), false);
  const link = join(uploads, 'link.png'); fs.symlinkSync(external, link);
  assert.equal(await shrinkUploadedImage(link), false);
  const linkedDir = join(uploads, 'escape'); fs.symlinkSync(root, linkedDir, 'junction');
  assert.equal(await shrinkUploadedImage(join(linkedDir, 'external.png')), false);
  const alias = join(root, 'alias'); fs.symlinkSync(uploads, alias, 'junction');
  assert.equal(await shrinkUploadedImage(join(alias, 'wide.png')), false);
  const moved = join(root, 'original-uploads'); fs.renameSync(uploads, moved); fs.symlinkSync(moved, uploads, 'junction');
  try { assert.equal(await shrinkUploadedImage(join(uploads, 'wide.png')), false); }
  finally { fs.unlinkSync(uploads); fs.renameSync(moved, uploads); }
  assert.deepEqual(fs.readFileSync(external), wide);
});

test('non-images and corrupt images are untouched', async () => {
  for (const [name, data] of [['document.pdf', '%PDF-fixture'], ['report.docx', 'PK-fixture'], ['fake.png', 'not an image']] as const) {
    const bytes = Buffer.from(data); const path = put(name, bytes);
    assert.equal(await shrinkUploadedImage(path), false); assert.deepEqual(fs.readFileSync(path), bytes);
  }
});

test('write, verification and replace failures retain original bytes and clean temporary files', async t => {
  const path = put('failure.png');
  const before = fs.readdirSync(uploads).sort();
  for (const failure of ['write', 'sync', 'verify', 'rename']) {
    const write = fs.writeFileSync;
    if (failure === 'sync') t.mock.method(fs, 'fsyncSync', () => { throw new Error('sync failure'); });
    else if (failure === 'rename') t.mock.method(fs, 'renameSync', () => { throw new Error('rename failure'); });
    else t.mock.method(fs, 'writeFileSync', (...args: any[]) => {
      if (failure === 'write') throw new Error('write failure');
      return (write as any)(args[0], Buffer.from('invalid candidate'), args[2]);
    });
    try { assert.equal(await shrinkUploadedImage(path), false); }
    finally { t.mock.restoreAll(); }
    assert.deepEqual(fs.readFileSync(path), wide);
    assert.deepEqual(fs.readdirSync(uploads).sort(), before);
  }
});

test('Native Read of a large project image leaves bytes and neighboring files unchanged', async () => {
  const project = join(root, 'project'); fs.mkdirSync(project);
  const path = join(project, 'large.png'); fs.writeFileSync(path, wide);
  const { executeNativeToolResult } = await import('./providers/claude-native/tools.js');
  const result = await executeNativeToolResult('Read', { file_path: 'large.png' }, {
    cwd: project, abortSignal: new AbortController().signal, shells: { byId: new Map(), mintId: () => 'fixture' }, readSet: new Set(), planMode: false, onTodos: () => {},
  });
  assert.ok(result.content?.some(b => b.type === 'image'));
  assert.deepEqual(fs.readFileSync(path), wide);
  assert.deepEqual(fs.readdirSync(project), ['large.png']);
});


test('JPEG replacement preserves EXIF orientation metadata', async () => {
  const exifBuffer = Buffer.from([0, 73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
  const photo = { width: 100, height: 200, data: Buffer.alloc(100 * 200 * 4, 255), exifBuffer };
  const original = jpeg.encode(photo, 90).data;
  const path = put('oriented.jpg', Buffer.concat([original, Buffer.alloc(1024 * 1024)]));
  assert.equal(await shrinkUploadedImage(path), true);
  const decoded = jpeg.decode(fs.readFileSync(path)) as ReturnType<typeof jpeg.decode> & { exifBuffer?: Uint8Array };
  assert.deepEqual(Buffer.from(decoded.exifBuffer ?? []), exifBuffer);
});


test('other image formats retain their uploaded bytes', async () => {
  for (const [name, signature] of [['animation.gif', 'GIF89a'], ['animation.webp', 'RIFF0000WEBP'], ['pages.tiff', 'II*\0']] as const) {
    const bytes = Buffer.concat([Buffer.from(signature), Buffer.alloc(1024 * 1024)]);
    const path = put(name, bytes);
    assert.equal(await shrinkUploadedImage(path), false);
    assert.deepEqual(fs.readFileSync(path), bytes);
  }
});

test('a target changed to a link during conversion is never replaced', async t => {
  const path = put('race.png'); const external = join(root, 'race-external.png'); fs.writeFileSync(external, wide);
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (...args: any[]) => {
    const result = (write as any)(...args);
    fs.unlinkSync(path); fs.symlinkSync(external, path);
    return result;
  });
  try { assert.equal(await shrinkUploadedImage(path), false); }
  finally { t.mock.restoreAll(); }
  assert.ok(fs.lstatSync(path).isSymbolicLink());
  assert.deepEqual(fs.readFileSync(external), wide);
  assert.ok(!fs.readdirSync(uploads).some(name => name.startsWith('.upload-image-')));
});

function pngChunk(name: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(name), data]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

test('animated PNG uploads retain every original byte', async () => {
  const base = png(3000, 10);
  const control = Buffer.alloc(8); control.writeUInt32BE(1);
  const frame = Buffer.alloc(26); frame.writeUInt32BE(3000, 4); frame.writeUInt32BE(10, 8); frame.writeUInt16BE(1, 20); frame.writeUInt16BE(10, 22);
  const original = Buffer.concat([base.subarray(0, 33), pngChunk('acTL', control), pngChunk('fcTL', frame), base.subarray(33), Buffer.alloc(1024 * 1024)]);
  const path = put('animated.png', original);
  assert.equal(await shrinkUploadedImage(path), false);
  assert.deepEqual(fs.readFileSync(path), original);
});

test('16-bit PNG uploads retain every original byte', async () => {
  const { deflateSync } = await import('node:zlib');
  const header = Buffer.alloc(13); header.writeUInt32BE(3000); header.writeUInt32BE(1, 4); header[8] = 16;
  const row = Buffer.alloc(6001, 255); row[0] = 0;
  const original = Buffer.concat([wide.subarray(0, 8), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(row)), pngChunk('IEND', Buffer.alloc(0)), Buffer.alloc(1024 * 1024)]);
  const path = put('sixteen-bit.png', original);
  assert.equal(await shrinkUploadedImage(path), false);
  assert.deepEqual(fs.readFileSync(path), original);
});

test('hard-linked uploads leave both names byte-identical', async () => {
  const path = put('hardlink.png'); const alias = join(uploads, 'hardlink-alias.png'); fs.linkSync(path, alias);
  assert.equal(await shrinkUploadedImage(path), false);
  assert.equal(await shrinkUploadedImage(alias), false);
  assert.deepEqual(fs.readFileSync(path), wide);
  assert.deepEqual(fs.readFileSync(alias), wide);
});
