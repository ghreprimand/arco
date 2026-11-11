import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { zipSync, strToU8 } from 'fflate';
import * as XLSX from 'xlsx';
const home = await mkdtemp(join(tmpdir(), 'arco-chat-home-'));
process.env.ARCO_HOME = home;
process.env.ARCO_UPLOADS_DIR = join(home, 'uploads');
test.after(async () => { await rm(home, { recursive: true, force: true }); });
const { ClaudeNativeWorker } = await import('./worker.js');

async function* response() {
  yield { type: 'message_start', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 1 } } };
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } };
  yield { type: 'content_block_stop', index: 0 };
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } };
  yield { type: 'message_stop' };
}

test('Native Chat sends attached text as content without its local path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arco-chat-attachment-'));
  try {
    const path = join(dir, 'fixture.txt');
    await writeFile(path, 'fixture marker');
    const worker = new ClaudeNativeWorker({ workflowId: 'fixture', config: { model: 'claude-opus-4-8', effort: 'high', interactionMode: 'chat', cwd: dir, attachments: [path] } }) as any;
    let outbound: unknown;
    worker.client = { messages: { create: async (request: unknown) => { outbound = request; return response(); } } };
    worker.ensureStarted = async () => {};
    worker.reconcileMcpSessions = async () => {};
    worker.hydrateContextManagementCapabilities = async () => {};
    worker.on('error', () => {});
    await worker.runTurn('Read the attachment');
    const request = JSON.stringify(outbound);
    assert.match(request, /fixture marker/);
    assert.match(request, /fixture\.txt/);
    const blocks = (outbound as any).messages[0].content;
    const content = blocks.map((block: any) => block.text ?? '').join('\n');
    assert.match(content, /\[Attached file: fixture\.txt\]\n\[Begin attachment content\]\nfixture marker\n\[End attachment content\]/);
    assert.ok(!request.includes(path), 'Chat must not expose the attachment path');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const present of [true, false]) {
  test(`Native Chat replay ${present ? 'restores an uploaded attachment' : 'reports a missing attachment'}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arco-chat-replay-'));
    const upload = join(home, 'uploads', `replay-${present}.txt`);
    try {
      await mkdir(join(home, 'uploads'), { recursive: true });
      if (present) await writeFile(upload, 'earlier fixture marker');
      const logDir = join(dir, '.arco', 'workflows', 'fixture');
      await mkdir(logDir, { recursive: true });
      const events = [
        { seq: 1, type: 'user_message_echo', content: 'Earlier question', attachments: [upload] },
        { seq: 2, type: 'primary_text', text: 'Earlier answer' },
        { seq: 3, type: 'primary_complete' },
      ];
      await writeFile(join(logDir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
      const worker = new ClaudeNativeWorker({ workflowId: 'fixture', config: { model: 'claude-opus-4-8', effort: 'high', interactionMode: 'chat', cwd: dir } }) as any;
      let outbound: unknown;
      worker.client = { messages: { create: async (request: unknown) => { outbound = request; return response(); } } };
      worker.ensureStarted = async () => { await worker.restoreSavedHistory(); };
      worker.reconcileMcpSessions = async () => {};
      worker.hydrateContextManagementCapabilities = async () => {};
      worker.on('error', () => {});
      await worker.runTurn('What did I attach?');
      const request = JSON.stringify(outbound);
      if (present) {
        assert.match(request, /earlier fixture marker/);
        const content = (outbound as any).messages.flatMap((message: any) => typeof message.content === 'string' ? [message.content] : message.content.map((block: any) => block.text ?? '')).join('\n');
        assert.match(content, /\[Attached file: replay-true\.txt\]\n\[Begin attachment content\]\nearlier fixture marker\n\[End attachment content\]/);
      }
      else assert.match(request, /attach it again/i);
      assert.ok(!request.includes(upload));
      assert.doesNotMatch(request, /use Read to inspect again/);
    } finally { await rm(dir, { recursive: true, force: true }); await rm(upload, { force: true }); }
  });
}

test('Native Chat sends document and image attachments on the outbound request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arco-chat-kinds-'));
  try {
    const text = join(dir, 'fixture.txt'), image = join(dir, 'fixture.png');
    const word = join(dir, 'fixture.docx'), sheet = join(dir, 'fixture.xlsx'), pdf = join(dir, 'fixture.pdf');
    await writeFile(text, 'text fixture marker');
    await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));
    await writeFile(word, zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>word fixture marker</w:t></w:r></w:p></w:body></w:document>') }));
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['sheet fixture marker']]), 'Sheet1');
    await writeFile(sheet, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
    const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica);
    document.addPage().drawText('pdf fixture marker', { font }); await writeFile(pdf, await document.save());
    const worker = new ClaudeNativeWorker({ workflowId: 'kinds', config: { model: 'claude-opus-4-8', effort: 'high', interactionMode: 'chat', cwd: dir, attachments: [text, image, word, sheet, pdf] } }) as any;
    let outbound: unknown;
    worker.client = { messages: { create: async (request: unknown) => { outbound = request; return response(); } } };
    worker.ensureStarted = async () => {}; worker.reconcileMcpSessions = async () => {}; worker.hydrateContextManagementCapabilities = async () => {}; worker.on('error', () => {});
    await worker.runTurn('Inspect these');
    const request = JSON.stringify(outbound);
    for (const marker of ['text fixture marker', 'word fixture marker', 'sheet fixture marker', 'pdf fixture marker']) assert.ok(request.includes(marker), marker);
    assert.match(request, /"type":"image"/);
    assert.ok(!request.includes(dir));
    assert.doesNotMatch(request, /pdf_mode|use Read/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Native replay refuses paths outside uploads and symlinks, and over-limit uploads', async () => {
  const { symlink } = await import('node:fs/promises');
  const { restoreChatAttachments } = await import('./fileContent.js');
  const uploads = join(home, 'uploads'); await mkdir(uploads, { recursive: true });
  const outside = join(home, 'outside.txt'), link = join(uploads, 'link.txt'), large = join(uploads, 'large.txt');
  await writeFile(outside, 'PRIVATE_FIXTURE'); await symlink(outside, link); await writeFile(large, 'x'.repeat(300_000));
  const markers = new Map([['markerA', outside], ['markerB', link], ['markerC', large]]);
  const result = await restoreChatAttachments([{ role: 'user', content: 'markerA markerB markerC' }], markers);
  const wire = JSON.stringify(result);
  assert.doesNotMatch(wire, /PRIVATE_FIXTURE|x{100}/); assert.ok(!wire.includes(home));
  assert.equal((wire.match(/attach it again/g) ?? []).length, 3);
});

test('Native Chat restores earlier attachments through bounded summary replay', async () => {
  const { replayMessagesWithResumePolicy } = await import('./resumeSummary.js');
  const { restoreChatAttachments } = await import('./fileContent.js');
  const dir = await mkdtemp(join(tmpdir(), 'arco-chat-summary-')), upload = join(home, 'uploads', 'summary.txt');
  try {
    await mkdir(join(home, 'uploads'), { recursive: true }); await writeFile(upload, 'summary fixture marker');
    const log = join(dir, '.arco', 'workflows', 'fixture'); await mkdir(log, { recursive: true });
    const events = [
      { seq: 1, type: 'user_message_echo', content: 'old', attachments: [upload] },
      { seq: 2, type: 'primary_text', text: 'answer' }, { seq: 3, type: 'primary_complete' },
      ...Array.from({ length: 8 }, (_, i) => [
        { seq: 4 + i * 3, type: 'user_message_echo', content: 'recent ' + 'x'.repeat(80) },
        { seq: 5 + i * 3, type: 'primary_text', text: 'recent answer' }, { seq: 6 + i * 3, type: 'primary_complete' },
      ]).flat(),
    ];
    await writeFile(join(log, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
    const markers = new Map<string, string>();
    const replay = await replayMessagesWithResumePolicy(dir, 'fixture', undefined, { exactReplayBytes: 100, recentTailBytes: 200, attachmentMarkers: markers } as any);
    assert.equal(replay.mode, 'summary_tail');
    const restored = JSON.stringify(await restoreChatAttachments(replay.messages as any, markers));
    assert.match(restored, /summary fixture marker/); assert.ok(!restored.includes(upload));
  } finally { await rm(dir, { recursive: true, force: true }); await rm(upload, { force: true }); }
});

test('Native Chat restores attachments retained before a compacted replay', async () => {
  const { buildMessagesFromReplayEvents } = await import('./resumeSummary.js');
  const { restoreChatAttachments } = await import('./fileContent.js');
  const upload = join(home, 'uploads', 'compact.txt'); await mkdir(join(home, 'uploads'), { recursive: true }); await writeFile(upload, 'compact fixture marker');
  const markers = new Map<string, string>();
  const events: any[] = [
    { seq: 1, type: 'user_message_echo', content: 'old', attachments: [upload] }, { seq: 2, type: 'primary_text', text: 'answer' }, { seq: 3, type: 'primary_complete' },
    { seq: 4, type: 'native_compacted', summary: 'Prior context', keptTail: [] },
  ];
  const replay = buildMessagesFromReplayEvents(events, [], undefined, undefined, [], markers);
  const wire = JSON.stringify(await restoreChatAttachments(replay as any, markers));
  assert.match(wire, /compact fixture marker/); assert.ok(!wire.includes(upload));
  await rm(upload, { force: true });
});

test('Native Chat replaces old compacted media receipts without retaining paths or reader instructions', async () => {
  const { restoreChatAttachments } = await import('./fileContent.js');
  const upload = join(home, 'uploads', 'old.png'); await mkdir(join(home, 'uploads'), { recursive: true });
  await writeFile(upload, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));
  try {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '[File media omitted from saved context; use Read with the same range to inspect it again.]' }, { type: 'text', text: `[attached file: ${upload}]` }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Seen.' }] },
    ];
    const result = await restoreChatAttachments(messages as any, new Map([['old-marker', upload]]));
    const text = JSON.stringify(result); assert.ok(!text.includes(upload)); assert.doesNotMatch(text, /use Read/); assert.match(text, /"type":"image"/);
  } finally { await rm(upload, { force: true }); }
});

test('Native Chat replay retains web media receipts and web counts', async () => {
  const { buildMessagesFromReplayEvents, summarizeClaudeNativePriorTurns } = await import('./resumeSummary.js');
  const events: any[] = [
    { seq: 1, type: 'user_message_echo', content: 'Inspect a public URL' },
    { seq: 2, type: 'primary_tool_use', tool: 'read_url', status: 'completed', input: '{"url":"https://example.invalid/report.pdf"}', mediaReceipt: 'document: public.pdf (2 pages)' },
    { seq: 3, type: 'primary_tool_use', tool: 'Read', status: 'completed', input: '{"file_path":"private.txt"}', mediaReceipt: 'image: private.png' },
    { seq: 4, type: 'primary_tool_use', tool: 'fetch_file', status: 'completed', input: '{"file_path":"secret-fetch.txt"}', mediaReceipt: 'image: secret-fetch.png' },
    { seq: 5, type: 'primary_tool_use', tool: 'mcp__arco__fetch_file', status: 'completed', input: '{"file_path":"secret-mcp.txt"}', mediaReceipt: 'image: secret-mcp.png' },
    { seq: 6, type: 'primary_text', text: 'Finished.' }, { seq: 7, type: 'primary_complete' },
  ];
  const replay = JSON.stringify(buildMessagesFromReplayEvents(events, [], undefined, undefined, [], new Map()));
  assert.match(replay, /read_url media receipt/); assert.match(replay, /public.pdf/); assert.doesNotMatch(replay, /private.png|secret-fetch.png|secret-mcp.png/);
  const summary = summarizeClaudeNativePriorTurns(events, [], true).summary;
  assert.match(summary, /read_urlx1/); assert.doesNotMatch(summary, /Readx1|fetch_filex1|private.txt|secret-fetch.txt|secret-mcp.txt/);
});

test('Native Chat sends a restored web receipt on the next request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arco-chat-web-replay-'));
  try {
    const log = join(dir, '.arco', 'workflows', 'fixture'); await mkdir(log, { recursive: true });
    const events = [
      { seq: 1, type: 'user_message_echo', content: 'Inspect a public URL' },
      { seq: 2, type: 'primary_tool_use', tool: 'read_url', status: 'completed', input: '{"url":"https://example.invalid/report.pdf"}', mediaReceipt: 'document: public.pdf (2 pages)' },
      { seq: 3, type: 'primary_text', text: 'Finished.' }, { seq: 4, type: 'primary_complete' },
    ];
    await writeFile(join(log, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
    const worker = new ClaudeNativeWorker({ workflowId: 'fixture', config: { model: 'claude-opus-4-8', effort: 'high', interactionMode: 'chat', chatWebAccess: true, cwd: dir } }) as any;
    let outbound: unknown;
    worker.client = { messages: { create: async (request: unknown) => { outbound = request; return response(); } } };
    worker.ensureStarted = async () => { await worker.restoreSavedHistory(); };
    worker.reconcileMcpSessions = async () => {}; worker.hydrateContextManagementCapabilities = async () => {}; worker.on('error', () => {});
    await worker.runTurn('Continue');
    assert.match(JSON.stringify(outbound), /read_url media receipt/); assert.match(JSON.stringify(outbound), /public.pdf/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
