import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import type { WorkerConfig } from '@arco/shared';
const home = mkdtempSync(join(tmpdir(), 'arco-http-deadline-'));
installIsolatedTestHome(home);
after(() => rmSync(home, { recursive: true, force: true }));
process.env.ARCO_LMSTUDIO_STALL_TIMEOUT_MS = '1000';
const { OpenAIHttpWorkerProcess, probeLmstudio } = await import('./lmstudio.js');

test('generation stall deadline covers waiting for response headers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  }));
  const worker = new OpenAIHttpWorkerProcess('header-deadline-test', {} as WorkerConfig);
  const internals = worker as any;
  internals.abortController = new AbortController();
  const errors: string[] = [];
  worker.on('error', (message) => errors.push(String(message)));
  let settled = false;
  const pending = internals.streamOneTurn('http://fixture.invalid', 'fixture', [], undefined).then(() => { settled = true; });
  try {
    t.mock.timers.tick(1001);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, true);
    assert.equal(errors.length, 1);
  } finally {
    internals.abortController.abort();
    await pending;
  }
});

test('model discovery deadline covers the response JSON body', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: (value: unknown) => void;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => ({
    ok: true,
    json: () => new Promise((resolve, reject) => {
      release = resolve;
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }),
  }));
  let settled = false;
  const pending = probeLmstudio().then((result) => { settled = true; return result; });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  try {
    t.mock.timers.tick(3001);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, true);
    assert.equal((await pending).up, false);
  } finally {
    release({ data: [] });
    await pending;
  }
});

test('completed SSE sentinel settles without waiting for body EOF', async (t) => {
  let finish!: () => void;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
      finish = () => { try { controller.close(); } catch { /* reader already cancelled */ } };
    },
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(body));
  const worker = new OpenAIHttpWorkerProcess('done-sentinel-test', {} as WorkerConfig);
  const internals = worker as any;
  internals.abortController = new AbortController();
  worker.on('error', () => {});
  let settled = false;
  const pending = internals.streamOneTurn('http://fixture.invalid', 'fixture', [], undefined)
    .then((result: any) => { settled = true; return result; });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, true);
    assert.equal((await pending).stalled, false);
  } finally {
    finish();
    await pending;
  }
});
