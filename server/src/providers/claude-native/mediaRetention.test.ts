import assert from 'node:assert/strict';
import test from 'node:test';
import { retainNewestMedia } from './mediaRetention.js';
import { admitImageResult } from './imageRead.js';
import { nativeMediaLimits } from './mediaLimits.js';
const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' } };
const result = { text: 'image: newest.png', content: [image], isError: false };
const limits = { images: 2, pdfPages: 100, encodedBytes: 20 * 1024 * 1024 };
test('under-limit history remains the same object and byte-identical', async () => {
  const history = [{ role: 'user', content: [image] }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'reason', signature: 'bound' }, { type: 'text', text: 'answer' }] }];
  const before = JSON.stringify(history);
  const retained = await retainNewestMedia(history, [], result, limits);
  assert.equal(retained.history, history); assert.equal(retained.imagesReplaced, 0);
  assert.equal(JSON.stringify(history), before);
});
test('oldest media becomes a receipt, tool pairing survives and affected thinking is removed', async () => {
  const history = [
    { role: 'user', content: [{ type: 'text', text: '[attached file: oldest.png]' }, image] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'reason', signature: 'bound' }, { type: 'tool_use', id: 'read-one', name: 'Read', input: { file_path: 'old.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-one', content: [{ type: 'text', text: 'image: old.png' }, image] }] },
  ];
  const before = JSON.stringify(history);
  const retained = await retainNewestMedia(history, [], result, limits);
  assert.equal(retained.imagesReplaced, 1);
  const text = JSON.stringify(retained.history);
  assert.match(text, /oldest.png/); assert.match(text, /omitted/);
  assert.match(text, /read-one/); assert.doesNotMatch(text, /bound|thinking/);
  assert.equal(JSON.stringify(history), before, 'replacement must not mutate accepted request objects');
  assert.ok((await admitImageResult(retained.history, [], result, 'tool', limits)).content);
});
test('a new result that exceeds limits by itself does not erase old history', async () => {
  const history = [{ role: 'user', content: [image] }];
  const retained = await retainNewestMedia(history, [], { ...result, content: [image, image, image] }, limits);
  assert.equal(retained.history, history); assert.equal(retained.imagesReplaced, 0);
});
test('model limits admit 101 images and 101 PDF pages independently on a 1M endpoint', async () => {
  const policy = nativeMediaLimits(1_000_000, 'https://api.anthropic.com');
  const document = { type: 'document' as const, arcoPages: 101, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: 'JVBERi0=' } };
  assert.ok((await admitImageResult([...Array(100).fill(image), document], [], result, 'tool', policy)).content);
  const small = nativeMediaLimits(200_000, 'https://api.anthropic.com');
  assert.equal((await admitImageResult(Array(100).fill(image), [], result, 'tool', small)).content, undefined);
  assert.equal((await admitImageResult([document], [], result, 'tool', small)).content, undefined);
});

test('a fetched base64 PDF counts its real pages while fetched text does not', async () => {
  const fetched = { type: 'web_fetch_tool_result', content: { type: 'document', arcoPages: 101, source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } } };
  assert.equal((await admitImageResult([fetched], [], result, 'tool', limits)).content, undefined);
  const fetchedText = { type: 'web_fetch_tool_result', content: { type: 'document', source: { type: 'text', data: 'x'.repeat(25 * 1024 * 1024) } } };
  assert.ok((await admitImageResult([fetchedText], [], result, 'tool', limits)).content);
});

test('worker retirement resets prefix tracking and emits actionable visible counts', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { installIsolatedTestHome } = await import('../../testSupport/isolatedHome.js');
  const home = await mkdtemp(join(tmpdir(), 'arco-media-worker-')); installIsolatedTestHome(home);
  const { ClaudeNativeWorker } = await import('./worker.js');
  const worker = new ClaudeNativeWorker({ workflowId: 'wf-media-retention', config: { cwd: home, model: 'unknown-fixture', effort: 'low' } as any }) as any;
  try {
    worker.client = { baseURL: 'https://api.anthropic.com' };
    worker.messages = [{ role: 'user', content: Array(100).fill(image) }];
    const original = worker.messages;
    worker.sentThrough = 1; worker.frozenSystem = [{ type: 'text', text: 'old prefix' }];
    const notices: string[] = []; worker.on('system_notice', (text: string) => notices.push(text));
    const admitted = await worker.admitMedia([], result, 'attachment');
    assert.ok(admitted.content);
    assert.equal(worker.sentThrough, 0); assert.equal(worker.frozenSystem, undefined);
    assert.notEqual(worker.messages, original);
    assert.equal(original[0].content.filter((block: any) => block.type === 'image').length, 100);
    assert.equal(notices.length, 1); assert.match(notices[0], /Replaced 1 old images/); assert.match(notices[0], /Attach or request a file again/); assert.doesNotMatch(notices[0], /COMPACT|HANDOFF/);
    const before = JSON.stringify(worker.messages), reference = worker.messages;
    await worker.admitMedia([], { ...result, content: [] }, 'attachment');
    assert.equal(worker.messages, reference); assert.equal(JSON.stringify(worker.messages), before);
  } finally { worker.client = null; await worker.dispose(); await rm(home, { recursive: true, force: true }); }
});

test('tool input JSON resembling a media block is not API media', async () => {
  const tool = { type: 'tool_use', id: 'fixture', name: 'fixture', input: { type: 'document', arcoPages: 999, source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } } };
  assert.ok((await admitImageResult([{ role: 'assistant', content: [tool] }], [], result, 'tool', limits)).content);
});

test('first-party encoded-byte allowance is larger than the custom-endpoint guard', async () => {
  const heavy = { ...image, source: { ...image.source, data: image.source.data.padEnd(5 * 1024 * 1024, 'A') } };
  assert.ok((await admitImageResult(Array(4).fill(heavy), [], { ...result, content: [heavy] }, 'tool', nativeMediaLimits(1_000_000, 'https://api.anthropic.com'))).content);
  const omitted = await admitImageResult(Array(4).fill(heavy), [], { ...result, content: [heavy] }, 'tool', nativeMediaLimits(1_000_000, 'https://example.com'));
  assert.equal(omitted.content, undefined); assert.match(omitted.text, /20 MiB.*5 images.*COMPACT or HANDOFF/);
});
test('retired fetched PDF keeps a valid document envelope with a text source', async () => {
  const history = [{ role: 'user', content: [{ type: 'web_fetch_tool_result', tool_use_id: 'fetch-one', content: { type: 'web_fetch_result', content: { type: 'document', title: 'old.pdf', arcoPages: 2, source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } } } }] }];
  const pdfResult = { text: 'document: new.pdf', content: [{ type: 'document' as const, arcoPages: 2, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: 'JVBERi0=' } }], isError: false };
  const retained = await retainNewestMedia(history, [], pdfResult, { ...limits, pdfPages: 2 });
  assert.equal(retained.documentsReplaced, 1);
  const fetched = retained.history[0].content[0];
  assert.equal(fetched.tool_use_id, 'fetch-one'); assert.equal(fetched.content.content.type, 'document');
  assert.equal(fetched.content.content.source.type, 'text');
  assert.ok((await admitImageResult(retained.history, [], pdfResult, 'tool', { ...limits, pdfPages: 2 })).content);
});

test('Read result retirement mid-loop keeps the current thinking-bearing tool-use round raw', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ClaudeNativeWorker } = await import('./worker.js');
  const { executeNativeToolResult } = await import('./tools.js');
  const home = await mkdtemp(join(tmpdir(), 'arco-media-read-loop-'));
  const worker = new ClaudeNativeWorker({ workflowId: 'wf-read-loop', config: { cwd: home, model: 'unknown-fixture', effort: 'high' } as any }) as any;
  try {
    const file = join(home, 'tiny.png'); await writeFile(file, Buffer.from(image.source.data, 'base64'));
    const current = { role: 'assistant', content: [{ type: 'thinking', thinking: 'current reasoning', signature: 'keep-current-signature' }, { type: 'tool_use', id: 'read-current', name: 'Read', input: { file_path: file } }] };
    worker.client = { baseURL: 'https://api.anthropic.com' };
    worker.messages = [{ role: 'user', content: Array(100).fill(image) }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'older reasoning', signature: 'drop-old-signature' }, { type: 'text', text: 'Earlier answer' }] }, { role: 'user', content: 'Read the new image' }, current];
    const before = JSON.stringify(worker.messages);
    const read = await executeNativeToolResult('Read', { file_path: file }, { cwd: home, abortSignal: new AbortController().signal, shells: { byId: new Map(), mintId: () => 'fixture' }, readSet: new Set(), planMode: false, onTodos: () => {} });
    const original = worker.messages;
    const admitted = await worker.admitMedia([], read, 'tool');
    assert.ok(admitted.content?.some((block: any) => block.type === 'image'));
    assert.equal(worker.messages.at(-1), current, 'keep the in-progress assistant group raw, as in-turn compaction does');
    assert.match(JSON.stringify(worker.messages.at(-1)), /keep-current-signature/);
    assert.doesNotMatch(JSON.stringify(worker.messages.slice(0, -1)), /drop-old-signature/);
    assert.equal(current.content[1].id, 'read-current');
    assert.equal(JSON.stringify(original), before);
  } finally { worker.client = null; await worker.dispose(); await rm(home, { recursive: true, force: true }); }
});

test('pending Read results retire older images without changing the active assistant group', async () => {
  const current = { role: 'assistant', content: [{ type: 'thinking', thinking: 'current', signature: 'current-signature' }, { type: 'tool_use', id: 'read-last', name: 'Read', input: {} }] };
  const history = [current];
  const pending = [{ type: 'tool_result', tool_use_id: 'read-first', content: [image, image] }];
  const retained = await retainNewestMedia(history, pending, result, limits, 0);
  assert.equal(retained.imagesReplaced, 1);
  assert.equal(retained.history, history);
  assert.equal(retained.history[0], current);
  assert.ok((await admitImageResult(retained.history, (retained as any).pending, result, 'tool', limits)).content);
  assert.equal(pending[0].content.filter(block => block.type === 'image').length, 2, 'original pending objects are not edited by planning');
});
