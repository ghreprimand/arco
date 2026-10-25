import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkerConfig } from '@arco/shared';
import { CodexAppServerWorker } from './worker.js';

test('STOP during interrupt shares one RPC and waits for interrupted completion', async () => {
  const worker = new CodexAppServerWorker('interrupt-test', {} as WorkerConfig, 'thread-test');
  const internals = worker as any;
  let calls = 0;
  Object.assign(internals, { rpc: { request: async () => { calls++; return {}; } }, threadId: 'thread-test' });
  Object.assign(internals.current, { turnId: 'turn-test', startedAt: Date.now() });
  const first = worker.cancelCurrentTurn();
  const second = worker.cancelCurrentTurn();
  assert.equal(first, second);
  let settled = false;
  void first.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'RPC acknowledgement is not turn completion');
  assert.equal(calls, 1);
  internals.onNotification({ method: 'turn/completed', params: { threadId: 'thread-test',
    turn: { id: 'turn-test', status: 'interrupted', error: null } } });
  await Promise.all([first, second]);
  assert(settled);
});
