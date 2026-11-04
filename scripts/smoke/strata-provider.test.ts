import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StrataProvider, probeStrata } from '../../server/src/providers/strata.js';
import { CHAT_PROVIDERS, INCOGNITO_CHAT_PROVIDERS, chatWebArmed } from '../../server/src/chatMode.js';
import type { WorkerConfig } from '@arco/shared';

process.env.ARCO_STRATA_PROFILES = join(tmpdir(), `arco-no-strata-profiles-${process.pid}.json`);

const model = 'qwen3.8-flash-next-iq3_xxs-262k';
const discovery = (vision = true) => new Response(JSON.stringify({ data: [{ id: model,
  meta: { n_ctx: 262144 }, architecture: { input_modalities: vision ? ['text', 'image'] : ['text'] },
}] }));
function sse(chunks: unknown[]) {
  // Split bytes across SSE frames, including inside UTF-8 and JSON.
  const bytes = new TextEncoder().encode(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join('') + 'data: [DONE]\n\n');
  return new Response(new ReadableStream({ start(c) {
    for (let i = 0; i < bytes.length; i += 13) c.enqueue(bytes.slice(i, i + 13));
    c.close();
  } }));
}
function finish(text = 'Found it ✓') {
  return { choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 345, completion_tokens: 9 } };
}
async function run(config: Partial<WorkerConfig>) {
  const worker = StrataProvider.create('strata-test', { provider: 'strata', model, effort: 'medium', cwd: '/tmp', ...config });
  let text = '', thinking = '';
  return await new Promise<{ text: string; thinking: string; result: any }>((resolve, reject) => {
    worker.on('text', (t) => { text += t; });
    worker.on('thinking', (t) => { thinking += t; });
    worker.once('result', (result) => resolve({ text, thinking, result }));
    worker.once('error', reject);
    worker.spawn('Answer using the available tools.');
  });
}

test('Strata discovers actual modalities and context; saved Chat supports web, incognito is rejected', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => discovery(false));
  assert.deepEqual((await probeStrata()).capabilities?.[model], { tools: true, thinking: true, vision: false, numCtx: 262144 });
  assert(CHAT_PROVIDERS.has('strata'));
  assert(!INCOGNITO_CHAT_PROVIDERS.has('strata'));
  assert(chatWebArmed({ kind: 'chat' }, 'strata'));
  assert(!chatWebArmed({ kind: 'chat', chatWebAccess: false }, 'strata'));
});

test('Strata streaming reasoning + fragmented tool round trip executes only Chat web tools', async (t) => {
  const bodies: any[] = [];
  let searches = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) return discovery();
    if (url.includes('/search?')) { searches++; return new Response(JSON.stringify({ results: [{ title: 'Strata', url: 'https://example.com/strata', content: 'Search evidence' }] })); }
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    return bodies.length === 1 ? sse([
      { choices: [{ delta: { reasoning_content: 'Check the web first.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'WebSearch', arguments: '{"que' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'search-real-id', function: { arguments: 'ry":"Strata"}' } }] }, finish_reason: 'tool_calls' }], timings: { predicted_n: 40, predicted_ms: 200, prompt_n: 200, prompt_ms: 500 } },
    ]) : sse([{ ...finish(), timings: { predicted_n: 60, predicted_ms: 800, prompt_n: 50, prompt_ms: 500 } }]);
  });
  const out = await run({ interactionMode: 'chat', chatWebAccess: true, skipPermissions: false });
  assert.equal(searches, 1);
  assert.equal(out.text, 'Found it ✓');
  assert.equal(out.thinking, 'Check the web first.');
  assert.deepEqual(bodies[0].tools.map((x: any) => x.function.name), ['WebSearch', 'WebFetch']);
  assert.equal(bodies[0].reasoning_effort, 'medium');
  const assistant = bodies[1].messages.find((x: any) => x.tool_calls);
  assert.equal(assistant.reasoning_content, out.thinking);
  assert.equal(assistant.tool_calls[0].id, 'search-real-id');
  assert.match(bodies[1].messages.at(-1).content, /Search evidence/);
  assert.equal(bodies[1].messages.at(-1).tool_call_id, 'search-real-id');
  assert.equal(out.result.modelContextWindow, 262144);
  assert.equal(out.result.lastPromptTokens, 345);
  assert.equal(out.result.usage.output_tokens, 9);
  assert.deepEqual(out.result.genSpeed, { decodeTokens: 100, decodeMs: 1000, prefillTokens: 250, prefillMs: 1000 });
});

test('Chat rejects hallucinated project tools even with web and AUTO, and offline omits tools', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-strata-boundary-'));
  const file = join(dir, 'must-not-exist.txt');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const armed of [false, true]) {
    const bodies: any[] = [];
    const mocked = t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (url.endsWith('/models')) return discovery();
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      return bodies.length === 1 ? sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'evil', function: { name: 'Write', arguments: JSON.stringify({ file_path: file, content: 'bad' }) } }] }, finish_reason: 'tool_calls' }] }]) : sse([finish('Rejected safely')]);
    });
    await run({ cwd: dir, interactionMode: 'chat', chatWebAccess: armed, skipPermissions: true });
    assert.equal(existsSync(file), false);
    assert.match(bodies[1].messages.at(-1).content, /not enabled/);
    if (!armed) assert.equal(bodies[0].tools, undefined);
    mocked.mock.restore();
  }
});

test('Strata forwards image data and Agent tools while honoring restricted primitive tools', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-strata-image-'));
  const file = join(dir, 'sample.png'); writeFileSync(file, Buffer.from('test-image'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) return discovery();
    bodies.push(JSON.parse(String(init?.body))); return sse([finish()]);
  });
  await run({ attachments: [file], effort: 'none', skipPermissions: true });
  assert.equal(bodies[0].reasoning_effort, 'none');
  assert.match(bodies[0].messages.at(-1).content[1].image_url.url, /^data:image\/png;base64,/);
  for (const name of ['Read', 'Write', 'WebSearch', 'WebFetch']) assert(bodies[0].tools.some((x: any) => x.function.name === name));
  await run({ tools: ['Read'], skipPermissions: true });
  assert.deepEqual(bodies[1].tools.map((x: any) => x.function.name), ['Read']);
});

test('Strata cancel aborts an active request and settles without a result', async (t) => {
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  let aborted = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) return discovery();
    requestStarted();
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  });
  const worker = StrataProvider.create('strata-cancel', { model, effort: 'medium', cwd: '/tmp' });
  let results = 0;
  worker.on('result', () => { results++; });
  const error = new Promise<string>((resolve) => worker.once('error', resolve));
  worker.spawn('A slow request');
  await started;
  worker.kill();
  assert.equal(await error, 'Worker killed');
  assert(aborted);
  assert.equal(results, 0);
  assert.equal(worker.status, 'failed');
});

test('Strata retains Read middle lines and Bash output beyond the LM Studio compact limits', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-strata-tool-results-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.txt');
  const content = Array.from({ length: 400 }, (_, i) => `line ${i}: ${'detail '.repeat(6)}`).join('\n');
  writeFileSync(file, content);
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) return discovery();
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1 ? sse([{ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'read-full', function: { name: 'Read', arguments: JSON.stringify({ file_path: file }) } },
      { index: 1, id: 'bash-full', function: { name: 'Bash', arguments: JSON.stringify({ command: "node -e 'process.stdout.write(\"b\".repeat(9000))'" }) } },
    ] }, finish_reason: 'tool_calls' }] }]) : sse([finish()]);
  });
  await run({ cwd: dir, skipPermissions: true });
  const results = bodies[1].messages.filter((m: any) => m.role === 'tool');
  assert.equal(results[0].content, content);
  assert(results[1].content.includes('b'.repeat(9000)));
  for (const result of results) assert.doesNotMatch(result.content, /elided by Arco/);
});

test('Strata still honors the shared runtime Read cap', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-strata-read-cap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'large.txt');
  writeFileSync(file, 'r'.repeat(40 * 1024));
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) return discovery();
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1 ? sse([{ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'read-capped', function: { name: 'Read', arguments: JSON.stringify({ file_path: file }) } },
    ] }, finish_reason: 'tool_calls' }] }]) : sse([finish()]);
  });
  await run({ cwd: dir, skipPermissions: true });
  const result = bodies[1].messages.find((m: any) => m.role === 'tool').content;
  assert(result.startsWith('r'.repeat(32 * 1024)));
  assert.match(result, /truncated at 32768 bytes/);
  assert.doesNotMatch(result, /elided by Arco/);
});


test('Strata exposes all native efforts and leaves timing absent when the engine supplies none', async (t) => {
  const efforts: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) return discovery();
    efforts.push(JSON.parse(String(init?.body)).reasoning_effort);
    return sse([finish()]);
  });
  for (const effort of ['none', 'low', 'medium', 'high'] as const) {
    const out = await run({ effort });
    assert.equal(out.result.genSpeed, undefined);
  }
  assert.deepEqual(efforts, ['none', 'low', 'medium', 'high']);
});
