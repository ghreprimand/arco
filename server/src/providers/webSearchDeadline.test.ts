import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeOllamaTool } from './ollamaTools.js';

for (const cause of ['owner', 'deadline']) {
  test(`WebSearch keeps ${cause} cancellation active while reading JSON`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let release!: (value: unknown) => void;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => ({
      ok: true,
      json: () => new Promise((resolve, reject) => {
        release = resolve;
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
    }));
    const owner = new AbortController();
    let settled = false;
    const pending = executeOllamaTool('WebSearch', { query: 'fixture' }, { cwd: '.', abortSignal: owner.signal })
      .then((result) => { settled = true; return result; });
    await new Promise((resolve) => setImmediate(resolve));
    try {
      if (cause === 'owner') owner.abort();
      else t.mock.timers.tick(10_001);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, true);
      assert.match(await pending, /error/);
    } finally {
      release({ results: [] });
      await pending;
    }
  });
}

test('WebSearch with an already stopped owner makes no request or unhandled rejection', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected fetch'); });
  const owner = new AbortController();
  owner.abort();
  const result = await executeOllamaTool('WebSearch', { query: 'fixture' }, { cwd: '.', abortSignal: owner.signal });
  assert.match(result, /error/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetch.mock.callCount(), 0);
});
