import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../../testSupport/isolatedHome.js';
import type { WorkerConfig } from '@arco/shared';
const temp = mkdtempSync(join(tmpdir(), 'arco-codex-compact-'));
installIsolatedTestHome(temp);
const { CodexAppServerWorker } = await import('./worker.js');
after(() => rmSync(temp, { recursive:true, force:true }));

type TestWorkerInternals = {
  rpc: { request: (method: string, params: unknown) => Promise<unknown>; close: (reason: string) => void } | null;
  threadId: string | null;
  bootstrapped: boolean;
  compacting: boolean;
  compactTimeoutMs: number;
  onNotification: (notification: { method: string; params: unknown }) => void;
};

function readyWorker(rpc: TestWorkerInternals['rpc']): { worker: InstanceType<typeof CodexAppServerWorker>; internals: TestWorkerInternals } {
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

test('fresh compaction window comes from this turn, not a sticky prior reading', async () => {
  let turnNo = 0;
  const {worker,internals} = readyWorker({request:async()=>({turn:{id:`turn-${++turnNo}`}}),close:()=>{}});
  const results: Array<{result?: {modelContextWindow?:number; freshContextWindow?:number; lastPromptTokens?:number}}> = [];
  worker.on('turn_settled',(value)=>results.push(value));
  const usage = { inputTokens:800, outputTokens:10, cachedInputTokens:0, reasoningOutputTokens:0, totalTokens:810 };
  await worker.beginTurn('first',undefined);
  internals.onNotification({method:'thread/tokenUsage/updated',params:{threadId:'thread-test',turnId:'turn-1',tokenUsage:{last:usage,total:usage,modelContextWindow:1000}}});
  internals.onNotification({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-1',status:'completed'}}});
  await worker.beginTurn('second',undefined);
  internals.onNotification({method:'thread/tokenUsage/updated',params:{threadId:'thread-test',turnId:'turn-2',tokenUsage:{last:usage,total:usage,modelContextWindow:null}}});
  internals.onNotification({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-2',status:'completed'}}});
  assert.equal(results[0].result?.freshContextWindow,1000);
  assert.equal(results[1].result?.modelContextWindow,1000);
  assert.equal(results[1].result?.freshContextWindow,undefined);
  assert.equal(results[1].result?.lastPromptTokens,800);
});

test('cancelling an in-flight compact settles it as failure', async () => {
  const {worker} = readyWorker({request:async()=>({}),close:()=>{}});
  const compact = worker.compactThread();
  await Promise.resolve();
  const extended = worker as unknown as {cancelCompaction:()=>boolean};
  assert.equal(extended.cancelCompaction(),true);
  const result = await compact;
  assert.equal(result.ok,false);
  assert.equal(result.recycle,true);
});

test('timeout retirement waits for the old process to exit before reuse', async () => {
  const {EventEmitter}=await import('node:events');
  const {worker,internals}=readyWorker({request:async()=>({}),close:()=>{}});
  const proc=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null,stdin:{end(){}}});
  Object.assign(internals,{proc,compactTimeoutMs:5});
  assert.equal((await worker.compactThread()).ok,false);
  let finished=false;
  const retirement=worker.dispose().then(()=>{finished=true;});
  await new Promise(resolve=>setImmediate(resolve));
  const finishedBeforeExit=finished;
  proc.emit('exit');
  assert.equal(finishedBeforeExit,false);
  await retirement;
  assert.equal(finished,true);
});
