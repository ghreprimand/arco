import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  attachmentDirs, loadImages, splitAttachmentPaths, withAttachmentRefs, IMAGE_MAX_BYTES,
  deriveModelImage, modelImagePath, awaitModelImage, queueModelImage, __resetModelImageStateForTests,
  MODEL_IMAGE_MAX_EDGE, MODEL_IMAGE_MAX_RAW_BYTES,
} from './attachments.js';

test('split + refs: images by extension, refs fold in the shared shape', () => {
  const s = splitAttachmentPaths(['/u/a.PNG', '/u/b.md', '/u/c.jpeg']);
  assert.deepEqual(s, { imagePaths: ['/u/a.PNG', '/u/c.jpeg'], nonImagePaths: ['/u/b.md'] });
  assert.equal(withAttachmentRefs('hi', []), 'hi');
  assert.equal(withAttachmentRefs('hi', ['/u/b.md']), 'hi\n\n[attached file: /u/b.md]');
  assert.deepEqual(attachmentDirs(['/u/a.png', '/u/b.md', '/v/c.gif']), ['/u', '/v']);
});

test('loadImages: base64 + mime; empty, oversized and missing files skipped with a reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-att-'));
  try {
    const ok = join(dir, 'ok.png');
    const empty = join(dir, 'empty.png');
    const big = join(dir, 'big.png');
    writeFileSync(ok, Buffer.from([1, 2, 3]));
    writeFileSync(empty, Buffer.alloc(0));
    writeFileSync(big, Buffer.alloc(IMAGE_MAX_BYTES + 1));
    const { images, skipped } = loadImages([ok, empty, big, join(dir, 'missing.png')]);
    assert.deepEqual(images, [{ path: ok, mimeType: 'image/png', data: 'AQID' }]);
    assert.equal(skipped.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Model-side downscaling. Needs ImageMagick (the Linux path); skipped
// cleanly on a box without it. The sips (macOS) branch is not covered here.
function findMagick(): { bin: string; identify: string[] } | null {
  for (const bin of ['magick', join(homedir(), '.local/bin/magick'), '/opt/homebrew/bin/magick', '/usr/local/bin/magick']) {
    try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return { bin, identify: [bin, 'identify'] }; } catch { /* next */ }
  }
  for (const bin of ['convert', '/usr/bin/convert']) {
    try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return { bin, identify: ['identify'] }; } catch { /* next */ }
  }
  return null;
}
const MAGICK = findMagick();
const skipNoMagick = MAGICK ? false : 'no ImageMagick on this box';

function gen(out: string, args: string[]): void {
  execFileSync(MAGICK!.bin, [...args, out], { stdio: 'ignore' });
}
function dims(path: string): [number, number] {
  const [bin, ...pre] = MAGICK!.identify;
  const out = execFileSync(bin, [...pre, '-format', '%w %h', `${path}[0]`]).toString().trim().split(' ');
  return [Number(out[0]), Number(out[1])];
}

test('deriveModelImage: 3000x1000 PNG -> .model.png sibling fitted to 2000px; original untouched', { skip: skipNoMagick }, async () => {
  __resetModelImageStateForTests();
  const dir = mkdtempSync(join(tmpdir(), 'arco-att-'));
  try {
    // ':' in the name — ImageMagick must not read it as a format prefix.
    // Windows forbids ':' in file names (it names an NTFS stream), so there
    // the name keeps only the spaces.
    const name = process.platform === 'win32' ? 'shot at 10 00.png' : 'shot at 10:00.png';
    const src = join(dir, name);
    gen(src, ['-size', '3000x1000', 'gradient:red-blue']);
    const before = statSync(src).size;
    const out = await deriveModelImage(src);
    assert.equal(out, `${src}.model.png`);
    const [w, h] = dims(out!);
    assert.ok(Math.max(w, h) <= MODEL_IMAGE_MAX_EDGE, `${w}x${h}`);
    assert.equal(w, 2000);
    assert.deepEqual(dims(src), [3000, 1000]);
    assert.equal(statSync(src).size, before);
    assert.equal(modelImagePath(src), out);
    // Derived copies never derive again; no tmp files left behind.
    assert.equal(await deriveModelImage(out!), null);
    assert.deepEqual(readdirSync(dir).sort(), [name, `${name}.model.png`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deriveModelImage: small PNG needs no copy; modelImagePath falls back to the original', { skip: skipNoMagick }, async () => {
  __resetModelImageStateForTests();
  const dir = mkdtempSync(join(tmpdir(), 'arco-att-'));
  try {
    const src = join(dir, 'small.png');
    gen(src, ['-size', '400x300', 'xc:white']);
    assert.equal(await deriveModelImage(src), null);
    assert.equal(modelImagePath(src), src);
    assert.equal(existsSync(`${src}.model.png`), false);
    // GIFs are left alone regardless of size.
    const gif = join(dir, 'wide.gif');
    gen(gif, ['-size', '3000x100', 'xc:white']);
    assert.equal(await deriveModelImage(gif), null);
    assert.equal(modelImagePath(gif), gif);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deriveModelImage: over-cap PNG within 2000px re-encodes to JPEG; loadImages sends it as image/jpeg', { skip: skipNoMagick }, async () => {
  __resetModelImageStateForTests();
  const dir = mkdtempSync(join(tmpdir(), 'arco-att-'));
  try {
    const src = join(dir, 'noisy.png');
    gen(src, ['-size', '1900x1900', 'xc:', '+noise', 'Random']);
    assert.ok(statSync(src).size > MODEL_IMAGE_MAX_RAW_BYTES, 'fixture must be over the raw cap');
    const out = await deriveModelImage(src);
    assert.equal(out, `${src}.model.jpg`);
    assert.ok(statSync(out!).size <= MODEL_IMAGE_MAX_RAW_BYTES);
    const { images, skipped } = loadImages([src]);
    assert.equal(skipped.length, 0);
    assert.equal(images[0].path, src);
    assert.equal(images[0].mimeType, 'image/jpeg');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queueModelImage + awaitModelImage: awaits the in-flight derivation', { skip: skipNoMagick }, async () => {
  __resetModelImageStateForTests();
  const dir = mkdtempSync(join(tmpdir(), 'arco-att-'));
  try {
    const src = join(dir, 'tall.jpg');
    gen(src, ['-size', '800x2600', 'gradient:white-black']);
    queueModelImage(src);
    assert.equal(await awaitModelImage(src, 20_000), `${src}.model.jpg`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deriveModelImage: failure paths return null, never throw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-att-'));
  try {
    __resetModelImageStateForTests();
    // Not an image by content / missing file.
    const bogus = join(dir, 'bogus.png');
    writeFileSync(bogus, Buffer.from('not a png'));
    assert.equal(await deriveModelImage(bogus), null);
    assert.equal(await deriveModelImage(join(dir, 'missing.png')), null);
    assert.equal(modelImagePath(bogus), bogus);
    // No binary available.
    __resetModelImageStateForTests({ disableTool: true });
    assert.equal(await deriveModelImage(bogus), null);
    // Outside ./uploads: no on-demand derivation, original comes back.
    assert.equal(await awaitModelImage(bogus, 100), bogus);
    assert.deepEqual(readdirSync(dir).sort(), ['bogus.png']);
  } finally {
    __resetModelImageStateForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
