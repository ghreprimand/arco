import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeOnce } from './previewAutoDetect.js';

test('a candidate accepting a connection without headers cannot hold a probe tick', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const owner = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => new Promise((_, reject) => {
    if (init.signal?.aborted) reject(init.signal.reason);
    else init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  }));
  let settled = false;
  const pending = probeOnce(5173, owner.signal).then((result) => { settled = true; return result; });
  try {
    t.mock.timers.tick(501);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, true);
    assert.equal(await pending, false);
  } finally {
    owner.abort();
    await pending;
  }
});
