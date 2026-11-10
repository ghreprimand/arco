// Unit tests for H8 — the aggregate `@`-ref budget gate.
//
// The per-ref 64 KB cap already bounds one ref; H8 adds the AGGREGATE ceiling so
// stacked pastes can't bury the operator's instruction. Contracts:
//  • under budget → all refs expand, no budget notices;
//  • crossing the soft-warn fraction → a one-time [budget] warning, still expands;
//  • a ref that would cross the hard-refuse fraction is REFUSED (not expanded),
//    and so is every ref after it;
//  • the estimate helper is deterministic.
//
// Run: node --import tsx --test src/contextRefs.test.ts

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { zipSync, strToU8 } from 'fflate';
import { prepareProviderAttachments } from './providers/providerFileContent.js';
import { nativeAttachmentContent } from './providers/claude-native/fileContent.js';
import {
  expandContextRefs,
  estimateRefTokens,
  CONTEXT_REF_HARD_REFUSE_FRACTION,
} from './contextRefs.js';

const fixtures: string[] = [];
after(async () => { for (const dir of fixtures) { await fs.rm(`${dir}-link`, { force: true }); await fs.rm(dir, { recursive: true, force: true }); } });

async function tmpProject(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'arco-refs-'));
  fixtures.push(dir);
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(join(dir, name), body, 'utf8');
  }
  return dir;
}

test('a project reached through a symlinked path still expands its files', async () => {
  // macOS tmpdir() is /var/..., a symlink to /private/var/...; any project
  // folder opened through a symlink has the same shape.
  const real = await tmpProject({ 'a.txt': 'hello' });
  const link = `${real}-link`;
  await fs.symlink(real, link, 'dir');
  const r = await expandContextRefs(link, 'see @file:a.txt', { windowSize: 200_000 });
  assert.equal(r.expandedCount, 1);
  assert.ok(!r.notices.some((n) => n.includes('refused')), 'nothing refused');
});

test('a symlink inside the project that points outside it is still refused', async () => {
  const outside = await tmpProject({ 'secret.txt': 'outside' });
  const dir = await tmpProject({});
  await fs.symlink(join(outside, 'secret.txt'), join(dir, 'leak.txt'));
  const r = await expandContextRefs(dir, '@file:leak.txt', { windowSize: 200_000 });
  assert.equal(r.expandedCount, 0);
  assert.ok(r.notices.some((n) => n.includes('symlink escapes')), 'refused as a symlink escape');
});

test('estimateRefTokens: bytes/4, deterministic', () => {
  assert.equal(estimateRefTokens('a'.repeat(400)), 100);
  assert.equal(estimateRefTokens('x'), estimateRefTokens('x'));
});

test('under budget: all refs expand, no budget notices', async () => {
  const dir = await tmpProject({ 'a.txt': 'hello', 'b.txt': 'world' });
  const r = await expandContextRefs(dir, 'see @file:a.txt and @file:b.txt', { windowSize: 200_000 });
  assert.equal(r.expandedCount, 2);
  assert.ok(!r.notices.some((n) => n.includes('refused')), 'nothing refused');
  assert.ok(!r.notices.some((n) => n.includes('[budget]')), 'no soft warn');
});

test('hard-refuse: a ref that would cross the ceiling is refused + not in the block', async () => {
  // window 1000 → hard ceiling 500 tokens ≈ 2000 bytes. Two ~1500-byte files:
  // first fits, second would push over → refused.
  const big = 'x'.repeat(1500);
  const dir = await tmpProject({ 'one.txt': big, 'two.txt': big });
  const r = await expandContextRefs(dir, '@file:one.txt @file:two.txt', { windowSize: 1000 });
  assert.equal(r.expandedCount, 1, 'only the first expanded');
  assert.ok(r.notices.some((n) => n.includes('two.txt') && n.includes('refused')), 'second refused with a clear notice');
  assert.ok(!r.block.includes('two.txt') || r.block.split('two.txt').length === 1, 'refused content not in block');
});

test('once over the ceiling, every later ref is refused too', async () => {
  const big = 'y'.repeat(1500);
  const dir = await tmpProject({ 'a.txt': big, 'b.txt': big, 'c.txt': big });
  const r = await expandContextRefs(dir, '@file:a.txt @file:b.txt @file:c.txt', { windowSize: 1000 });
  assert.equal(r.expandedCount, 1);
  const refused = r.notices.filter((n) => n.includes('refused —')).length;
  assert.equal(refused, 2, 'b and c both refused');
});

test('soft-warn fires once when crossing ~25% but still expands', async () => {
  // window 2000 → soft warn 500 tok (2000 B), hard 1000 tok (4000 B).
  // One ~2200-byte file crosses soft-warn but not hard-refuse.
  const dir = await tmpProject({ 'm.txt': 'z'.repeat(2200) });
  const r = await expandContextRefs(dir, '@file:m.txt', { windowSize: 2000 });
  assert.equal(r.expandedCount, 1, 'still expanded');
  assert.ok(r.notices.some((n) => n.includes('[budget]')), 'soft-warn emitted');
});

test('hard-refuse fraction is the documented 50%', () => {
  assert.equal(CONTEXT_REF_HARD_REFUSE_FRACTION, 0.5);
});

test('no refs: empty expansion, no gate', async () => {
  const dir = await tmpProject({});
  const r = await expandContextRefs(dir, 'plain message, no refs', { windowSize: 1000 });
  assert.equal(r.expandedCount, 0);
  assert.equal(r.notices.length, 0);
});

test('@file references deliver an image separately and explain binary data', async () => {
  const dir = await tmpProject({});
  try {
    await fs.writeFile(join(dir, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));
    await fs.writeFile(join(dir, 'data.bin'), Buffer.from([0xff, 0x00, 0xfe]));
    const image = await expandContextRefs(dir, '@file:image.png', {windowSize: 200000}) as any;
    assert.deepEqual(image.attachments, [await fs.realpath(join(dir, 'image.png'))]);
    assert.doesNotMatch(image.block, /\uFFFD|\x00/);
    const binary = await expandContextRefs(dir, '@file:data.bin', {windowSize: 200000});
    assert.match(binary.block, /binary|unsupported/i);
    assert.doesNotMatch(binary.block, /\uFFFD|\x00/);
  } finally { await fs.rm(dir, {recursive:true, force:true}); }
});

test('context references extract notebooks by content and preserve media budgets', async () => {
  const dir = await tmpProject({});
  try {
    const notebook = {nbformat:4,cells:[{cell_type:'code',source:['print("fixture")'],outputs:[{text:'fixture output'}]}]};
    await fs.writeFile(join(dir,'notebook.data'), JSON.stringify(notebook));
    const decoded = await expandContextRefs(dir, '@file:notebook.data', {windowSize:200000});
    assert.match(decoded.block, /Cell 1 \(code\)/);
    assert.match(decoded.block, /fixture output/);
    await fs.writeFile(join(dir,'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64'));
    const refused = await expandContextRefs(dir, '@file:image.png', {windowSize:10});
    assert.equal(refused.attachments, undefined);
    assert.equal(refused.expandedCount, 0);
    assert.match(refused.notices.join(' '), /refused/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('context references extract and attach PDFs identified by content', async () => {
  const dir = await tmpProject({});
  try {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([200, 200]).drawText('Document fixture', {x:10,y:100,font});
    await fs.writeFile(join(dir,'document.data'), await pdf.save());
    const result = await expandContextRefs(dir, '@file:document.data', {windowSize:200000});
    assert.match(result.block, /Document fixture/);
    assert.deepEqual(result.attachments, [await fs.realpath(join(dir,'document.data'))]);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('context references decode UTF-16 without replacement characters', async () => {
  const dir = await tmpProject({});
  try {
    await fs.writeFile(join(dir,'unicode.txt'), Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('Example text','utf16le')]));
    const result = await expandContextRefs(dir, '@file:unicode.txt', {windowSize:200000});
    assert.match(result.block, /Example text/);
    assert.doesNotMatch(result.block, /\uFFFD|\x00/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('context references extract office documents by bytes', async () => {
  const dir = await tmpProject({});
  try {
    const xml = '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Synthetic heading</w:t></w:r></w:p></w:body></w:document>';
    await fs.writeFile(join(dir,'document.txt'), zipSync({'word/document.xml':strToU8(xml)}));
    const result = await expandContextRefs(dir, '@file:document.txt', {windowSize:200000});
    assert.match(result.block, /Synthetic heading/);
    assert.doesNotMatch(result.block, /PK\u0003|\uFFFD/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});


test('context references handle incomplete UTF-8 at the end of a file', async () => {
  const dir = await tmpProject({});
  try {
    await fs.writeFile(join(dir, 'incomplete.txt'), Buffer.concat([Buffer.from('Readable prefix '), Buffer.from([0xc3])]));
    const result = await expandContextRefs(dir, '@file:incomplete.txt', {windowSize:200000});
    assert.match(result.block + result.notices.join(' '), /invalid|binary|unsupported|Readable prefix/i);
    assert.doesNotMatch(result.block, /\uFFFD|\x00/);
  } finally { await fs.rm(dir, {recursive:true, force:true}); }
});


test('SVG context references retain source and attach the rendered image by content', async () => {
  const dir = await tmpProject({});
  try {
    await fs.writeFile(join(dir, 'diagram.data'), '<?xml version="1.0"?>' + ' '.repeat(5000) + '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="red"/></svg>');
    const result = await expandContextRefs(dir, '@file:diagram.data', {windowSize:200000});
    assert.match(result.block, /<svg/);
    assert.deepEqual(result.attachments, [await fs.realpath(join(dir, 'diagram.data'))]);
    const local = await prepareProviderAttachments(result.attachments);
    assert.match(local.text, /<svg/);
    assert.equal(local.images.length, 1);
    const native = await nativeAttachmentContent('Inspect', result.attachments, []);
    assert.ok(Array.isArray(native.content));
    assert.ok(native.content.some(block => block.type === 'image'));
    const refused = await expandContextRefs(dir, '@file:diagram.data', {windowSize:10});
    assert.equal(refused.attachments, undefined);
    assert.match(refused.notices.join(' '), /refused/);
  } finally { await fs.rm(dir, {recursive:true, force:true}); }
});
