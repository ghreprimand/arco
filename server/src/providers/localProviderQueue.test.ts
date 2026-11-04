import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueLocalProvider } from './localProviderQueue.js';

test('a utility job and worker share the same per-provider serial queue', async () => {
  const events: string[] = []; let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const worker = queueLocalProvider('strata', async () => { events.push('worker-start'); await barrier; events.push('worker-end'); });
  const utility = queueLocalProvider('strata', async () => { events.push('utility'); return 'ok'; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['worker-start']);
  release(); await worker; assert.equal(await utility, 'ok');
  assert.deepEqual(events, ['worker-start', 'worker-end', 'utility']);
});
