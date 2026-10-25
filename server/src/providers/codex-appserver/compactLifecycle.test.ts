import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkerConfig } from '@arco/shared';
import { CodexAppServerWorker } from './worker.js';

type TestWorkerInternals = {
  rpc: { request: (method: string, params: unknown) => Promise<unknown>; close: (reason: string) => void } | null;
  threadId: string | null;
  bootstrapped: boolean;
  compacting: boolean;
  compactTimeoutMs: number;
  onNotification: (notification: { method: string; params: unknown }) => void;
};

function readyWorker(rpc: TestWorkerInternals['rpc']): { worker: CodexAppServerWorker; internals: TestWorkerInternals } {
  const worker = new CodexAppServerWorker('wf-compact-lifecycle', {} as WorkerConfig, 'thread-test');
  const internals = worker as unknown as TestWorkerInternals;
  Object.assign(internals, { rpc, threadId: 'thread-test', bootstrapped: true });
  return { worker, internals };
}

function notify(internals: TestWorkerInternals, method: string, turnId = 'compact-turn'): void {
  internals.onNotification({
    method,
    params: method === 'thread/compacted'
      ? { threadId: 'thread-test' }
      : { threadId: 'thread-test', turn: { id: turnId } },
  });
}

test('thread/compacted does not unlock before the compact turn completes', async () => {
  const { worker, internals } = readyWorker({
    request: async () => ({}),
    close: () => {},
  });
  const compact = worker.compactThread();
  await Promise.resolve();

  notify(internals, 'turn/started');
  notify(internals, 'thread/compacted');
  await Promise.resolve();
  assert.equal(internals.compacting, true);

  notify(internals, 'turn/completed');
  assert.deepEqual(await compact, { ok: true });
  assert.equal(internals.compacting, false);
});

test('compact completion cannot race ahead of the RPC response waiter', async () => {
  let acknowledge!: (value: unknown) => void;
  const { worker, internals } = readyWorker({
    request: () => new Promise((resolve) => { acknowledge = resolve; }),
    close: () => {},
  });
  const compact = worker.compactThread();
  notify(internals, 'turn/started');
  notify(internals, 'turn/completed');
  acknowledge({});

  assert.deepEqual(await compact, { ok: true });
});

test('a genuine compact timeout is a visible failure that recycles the worker', async () => {
  let closeReason = '';
  const { worker, internals } = readyWorker({
    request: async () => ({}),
    close: (reason) => { closeReason = reason; },
  });
  internals.compactTimeoutMs = 5;

  const result = await worker.compactThread();

  assert.equal(result.ok, false);
  assert.equal(result.recycle, true);
  assert.match(result.error ?? '', /did not complete/);
  assert.equal(closeReason, 'worker teardown');
  assert.equal(internals.compacting, false);
});
