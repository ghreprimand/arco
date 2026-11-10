import { PNG } from 'pngjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeNativeToolResult, type NativeToolContext } from './tools.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
export function imageReadContext(cwd: string): NativeToolContext {
  return { cwd, abortSignal: new AbortController().signal, shells: { byId: new Map(), mintId: () => 'fixture' }, readSet: new Set(), planMode: false, onTodos: () => {} };
}
test('Native Read returns PNG bytes as an image even with a misleading extension', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-image-read-'));
  try {
    await writeFile(join(cwd, 'picture.txt'), png);
    const result = await executeNativeToolResult('Read', { file_path: 'picture.txt' }, imageReadContext(cwd));
    const blocks = (result as unknown as { content?: Array<{ type: string; source?: { data: string; media_type: string } }> }).content;
    const data = blocks?.find(b => b.type === 'image')?.source?.data;
    assert.ok(data);
    assert.deepEqual(PNG.sync.read(Buffer.from(data,'base64')).data, PNG.sync.read(png).data);
    assert.match(result.text, /image: picture.txt, 1x1/);
    assert.doesNotMatch(result.text, /IHDR|IDAT/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

import { readFile, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { imagePixelSize, imageReceipts, admitImageResult } from './imageRead.js';
import { readFileContent } from '../../fileContent.js';
import { planTurnSpill } from './toolResultEviction.js';
import { buildFoldDigest } from './foldDigest.js';
import { projectCompactSummaryMessages } from './workerHelpers.js';
import type { MessageParam } from './contentBlocks.js';

function crc32(b: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of b) { crc ^= byte; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function tallPng(): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), data]), head = Buffer.alloc(4), tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(body)); return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(100, 0); header.writeUInt32BE(10000, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([png.subarray(0, 8), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(301 * 10000))), chunk('IEND', Buffer.alloc(0))]);
}

test('tall screenshot is decoded without a system converter; no project siblings', async () => {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'arco-image-tall-')));
  try {
    const file = join(cwd, 'page.png'), original = tallPng(); await writeFile(file, original);
    const result = await readFileContent(file, { externalPrograms: false });
    assert.ok(result.blocks.some(b => b.type === 'image')); assert.match(result.text, /20x2000/);
    assert.deepEqual(await readFile(file), original); assert.deepEqual(await readdir(cwd), ['page.png']);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('tall full-page screenshot scales down in a private copy when a converter is available', async t => {
  try { execFileSync('convert', ['-size', '2x3', 'xc:white', 'png:-'], { stdio: 'ignore' }); } catch { t.skip('ImageMagick is unavailable; missing-converter fallback is tested separately'); return; }
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'arco-image-scale-')));
  try {
    const original = tallPng(), file = join(cwd, 'page.png'); await writeFile(file, original);
    const result = await executeNativeToolResult('Read', { file_path: file }, imageReadContext(cwd));
    const image = result.content?.find(b => b.type === 'image'); assert.ok(image?.type === 'image');
    const dims = imagePixelSize(Buffer.from(image.source.data, 'base64')); assert.ok(dims && dims.height <= 2000 && dims.width <= 2000);
    assert.match(result.text, /20x2000/); assert.deepEqual(await readFile(file), original); assert.deepEqual(await readdir(cwd), ['page.png']);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('invalid image headers produce an explanation and text reads retain line slicing', async () => {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'arco-image-invalid-')));
  try {
    await writeFile(join(cwd, 'bad.png'), png.subarray(0, 12));
    const bad = await executeNativeToolResult('Read', { file_path: 'bad.png' }, imageReadContext(cwd));
    assert.equal(bad.content, undefined); assert.match(bad.text, /unable to decode|not sent/);
    await writeFile(join(cwd, 'text.txt'), 'first\nsecond\nthird');
    assert.equal((await executeNativeToolResult('Read', { file_path: 'text.txt', offset: 2, limit: 1 }, imageReadContext(cwd))).text, 'second');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('image results survive wire serialization and become receipts in summaries and saved context', async () => {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'arco-image-context-')));
  try {
    await writeFile(join(cwd, 'picture.png'), png);
    const result = await executeNativeToolResult('Read', { file_path: 'picture.png' }, imageReadContext(cwd));
    const messages = [{ role: 'user', content: 'Inspect the image' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: 'picture.png' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read1', content: result.content }] }] as unknown as MessageParam[];
    const saved = JSON.stringify(imageReceipts(messages)); assert.ok(!saved.includes(png.toString('base64'))); assert.match(saved, /picture.png/);
    assert.match(JSON.stringify(projectCompactSummaryMessages(messages)), /picture.png/);
    assert.ok(!JSON.stringify(projectCompactSummaryMessages(messages)).includes(png.toString('base64')));
    assert.match(buildFoldDigest(messages), /Images read.*\n- image: picture.png/);
    const spill = planTurnSpill([{ toolUseId: 'read1', toolName: 'Read', content: [...result.content!, { type: 'text', text: 'x'.repeat(10000) }] }], 100);
    assert.equal(spill.spill.length, 1); assert.match(spill.spill[0].summary, /image: picture.png/);
    const many = Array.from({ length: 100 }, () => result.content);
    assert.equal((await admitImageResult(many, [], result)).content, undefined);
    assert.match((await admitImageResult(many, [], result)).text, /image.*budget/);
    assert.deepEqual((await admitImageResult([], [], result)), result);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

import { buildMessagesFromReplayEvents } from './resumeSummary.js';
test('normal event replay retains an image receipt without reconstructing pixels', () => {
  const replay = buildMessagesFromReplayEvents([
    { type: 'user_message_echo', content: 'Inspect the screenshot', seq: 1 },
    { type: 'primary_tool_use', tool: 'Read', status: 'completed', output: 'image: shot.png, 20x2000 (image/png)', seq: 2 },
    { type: 'primary_text', text: 'The screenshot has a heading.', seq: 3 },
    { type: 'primary_complete', seq: 4 },
  ]);
  assert.match(JSON.stringify(replay), /Read image receipt: image: shot.png/);
  assert.doesNotMatch(JSON.stringify(replay), /base64/);
});

import { open } from 'node:fs/promises';
test('oversized source and malformed extension produce bounded notes, never byte text', async () => {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'arco-image-bounds-')));
  try {
    const file = join(cwd, 'huge.png'); await writeFile(file, png);
    const h = await open(file, 'r+'); try { await h.truncate(512 * 1024 * 1024 + 1); } finally { await h.close(); }
    const big = await executeNativeToolResult('Read', { file_path: file }, imageReadContext(cwd));
    assert.equal(big.content, undefined); assert.match(big.text, /512 MB/); assert.ok(big.text.length < 300);
    await writeFile(file, Buffer.from([0, 1, 2, 3]));
    const bad = await executeNativeToolResult('Read', { file_path: file }, imageReadContext(cwd));
    assert.equal(bad.content, undefined); assert.match(bad.text, /binary|unrecognized/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('JPEG, GIF and WebP are identified from bytes and reach structured results', async () => {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'arco-image-formats-')));
  try {
    const fixtures = [
      ['image/jpeg', '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAADAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=='],
      ['image/gif', 'R0lGODlhAgADAPAAAP///wAAACH5BAAAAAAALAAAAAACAAMAAAIChF8AOw=='],
      ['image/webp', 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAMAAgA0JaQAA3AA/vuUAAA='],
    ];
    for (const [media, encoded] of fixtures) {
      const file = join(cwd, 'fixture.data');
      await writeFile(file, Buffer.from(encoded, 'base64'));
      const result = await executeNativeToolResult('Read', { file_path: file }, imageReadContext(cwd));
      const image = result.content?.find(b => b.type === 'image'); assert.ok(image?.type === 'image');
      assert.equal(image.source.media_type, 'image/png', `normalized ${media}`); assert.match(result.text, /2x3/);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('aggregate image bytes and older large attachments prevent an invalid many-image request', async () => {
  const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: png.toString('base64') } };
  const result = { text: 'image: current.png, 1x1', content: [{ type: 'text' as const, text: 'image: current.png, 1x1' }, image], isError: false };
  const large = { ...image, source: { ...image.source, data: tallPng().toString('base64') } };
  assert.equal((await admitImageResult([large, ...Array(19).fill(image)], [], result)).content, undefined);
  assert.ok((await admitImageResult(Array(19).fill(image), [], result)).content);
  const heavy = { ...image, source: { ...image.source, data: png.toString('base64').padEnd(5 * 1024 * 1024, 'A') } };
  assert.equal((await admitImageResult(Array(4).fill(heavy), [], result)).content, undefined);
});
