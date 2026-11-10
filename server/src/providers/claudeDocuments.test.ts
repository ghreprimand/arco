import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { WorkerConfig } from '@arco/shared';
import { ClaudeProvider } from './claude.js';

async function pdf(pages: number) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) document.addPage([200, 200]).drawText(`Fixture page ${i}`, { x: 10, y: 100, size: 10, font });
  return document.save();
}

test('Claude CLI stream input carries bounded PDF document blocks and keeps other document text', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-cli-pdf-'));
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let input = '', args: string[] = [];
  child.stdin.on('data', chunk => { input += String(chunk); });
  const started = new Promise<void>(resolve => {
    t.mock.method(childProcess, 'spawn', ((_command: string, argv: string[]) => { args = argv; resolve(); return child; }) as any);
    syncBuiltinESMExports();
  });
  try {
    await writeFile(join(cwd, 'report.data'), await pdf(101));
    await writeFile(join(cwd, 'memo.rtf'), '{\\rtf1\\ansi Fixture memo}');
    const worker = ClaudeProvider.create('fixture', {
      provider: 'claude', cwd, model: 'fixture', effort: 'medium', interactionMode: 'chat', tools: [],
      attachments: [join(cwd, 'report.data'), join(cwd, 'memo.rtf')],
    } as WorkerConfig);
    worker.on('error', () => {});
    worker.spawn('Inspect the report');
    await started;
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(args.includes('--input-format'), 'PDF-only attachment must select stream-json');
    const content = JSON.parse(input).message.content;
    const block = content.find((b: any) => b.type === 'document');
    assert.ok(block, 'PDF must reach Claude as a document');
    assert.equal(block.source.type, 'base64');
    assert.equal(block.source.media_type, 'application/pdf');
    const sent = await PDFDocument.load(Buffer.from(block.source.data, 'base64'));
    assert.equal(sent.getPageCount(), 100);
    const text = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    assert.match(text, /Inspect the report/);
    assert.match(text, /Fixture memo/);
    assert.match(text, /Other pages omitted/);
    assert.doesNotMatch(text, /Fixture page 1\b/, 'native PDF is not duplicated as extracted text');
    child.emit('close', 0, null);
    child.emit('exit', 0, null);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('PDF attachment preparation shares the page budget and keeps text fallback for later files', async () => {
  const { prepareProviderAttachments } = await import('./providerFileContent.js');
  const cwd = await mkdtemp(join(tmpdir(), 'arco-cli-pdf-'));
  try {
    const paths = [join(cwd, 'first.pdf'), join(cwd, 'second.pdf'), join(cwd, 'last.pdf')];
    await writeFile(paths[0], await pdf(60));
    await writeFile(paths[1], await pdf(70));
    await writeFile(paths[2], await pdf(1));
    const prepared = await prepareProviderAttachments(paths, true, undefined, true);
    assert.deepEqual(prepared.documents.map(document => document.pages), [60, 40]);
    assert.match(prepared.text, /Other pages omitted/);
    assert.match(prepared.text, /last.pdf\]\n[\s\S]*Fixture page 1/);
    assert.ok(prepared.documents.reduce((bytes, document) => bytes + document.data.length, 0) <= 20 * 1024 * 1024);
    const textOnly = await prepareProviderAttachments([paths[2]]);
    assert.equal(textOnly.documents.length, 0);
    assert.match(textOnly.text, /Fixture page 1/);
    const { readFileContent } = await import('../fileContent.js');
    const limited = await readFileContent(await realpath(paths[2]), { limits: { documents: true, maxDocumentBase64Bytes: 1 } });
    assert.ok(!limited.blocks.some(block => block.type === 'document'));
    assert.match(limited.text, /document byte limit/);
    assert.match(limited.text, /Fixture page 1/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('images and PDFs share one message byte budget regardless of attachment order', async () => {
  const { PNG } = await import('pngjs');
  const { prepareProviderAttachments } = await import('./providerFileContent.js');
  const cwd = await mkdtemp(join(tmpdir(), 'arco-cli-media-budget-'));
  try {
    const noise = new PNG({ width: 600, height: 600 });
    let seed = 123456789;
    for (let i = 0; i < noise.data.length; i += 4) {
      for (let channel = 0; channel < 3; channel++) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        noise.data[i + channel] = seed & 255;
      }
      noise.data[i + 3] = 255;
    }
    const png = PNG.sync.write(noise);
    const imagePath = join(cwd, 'noise.png'), pdfPath = join(cwd, 'large.pdf');
    await writeFile(imagePath, png);
    const document = await PDFDocument.create();
    const page = document.addPage([600, 600]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 3; i++) page.drawImage(await document.embedPng(png), { x: i * 10, y: 0, width: 100, height: 100 });
    page.drawText('Fixture budget fallback text', { x: 10, y: 500, size: 10, font });
    await writeFile(pdfPath, await document.save());
    const imagePaths = Array.from({ length: 14 }, () => imagePath);
    const imageOnly = await prepareProviderAttachments(imagePaths);
    for (const paths of [[...imagePaths, pdfPath], [pdfPath, ...imagePaths]]) {
      const prepared = await prepareProviderAttachments(paths, true, undefined, true);
      const imageBytes = prepared.images.reduce((bytes, image) => bytes + image.data.length, 0);
      const documentBytes = prepared.documents.reduce((bytes, pdf) => bytes + pdf.data.length, 0);
      assert.ok(imageBytes > 18 * 1024 * 1024, 'fixture must approach the image budget');
      assert.ok(imageBytes + documentBytes <= 20 * 1024 * 1024, 'combined media must fit one 20 MiB message budget');
      assert.equal(prepared.images.length, imageOnly.images.length, 'PDFs must not displace fitted images');
      assert.equal(prepared.documents.length, 0);
      assert.match(prepared.text, /PDF.*media byte limit/);
      assert.match(prepared.text, /Fixture budget fallback text/);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('PDF attachments work through linked project and home upload parents', async () => {
  const { prepareProviderAttachments } = await import('./providerFileContent.js');
  const { ensureStorageRoot } = await import('../storageRoot.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arco-linked-pdf-')));
  try {
    const home = join(root, 'home'), linkedHome = join(root, 'linked-home');
    await mkdir(join(home, 'project'), { recursive: true });
    await mkdir(join(home, '.arco'), { recursive: true });
    await symlink(home, linkedHome, process.platform === 'win32' ? 'junction' : 'dir');
    const uploads = await ensureStorageRoot(join(linkedHome, '.arco', 'uploads'));
    const projectPdf = join(linkedHome, 'project', 'report.pdf');
    const uploadPdf = join(linkedHome, '.arco', 'uploads', 'report.pdf');
    const bytes = await pdf(1);
    await writeFile(projectPdf, bytes);
    await writeFile(join(uploads, 'report.pdf'), bytes);
    for (const path of [projectPdf, uploadPdf]) {
      const prepared = await prepareProviderAttachments([path], true, undefined, true);
      assert.equal(prepared.documents.length, 1, 'linked attachment must reach the model as a PDF');
      assert.equal(prepared.documents[0].pages, 1);
      assert.doesNotMatch(prepared.text, /\[error\]|outside the permitted roots/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
