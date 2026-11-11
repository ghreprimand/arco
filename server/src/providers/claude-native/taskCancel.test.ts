// Task rows settle when the parent turn is cancelled. Cancelling the parent
// must report every unsettled Task child as cancelled before the turn's own
// "Worker killed" error, so the status still belongs to the running turn, and
// must not report it twice when the child's promise later rejects.
//
// Run: node --conditions development --import tsx --test src/providers/claude-native/taskCancel.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeNativeWorker } from './worker.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
function taskRound(ids: string[]) {
  return async function* (): AsyncGenerator<unknown> {
    yield { type: 'message_start', message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 1 } } };
    let index = 0;
    for (const id of ids) {
      yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'Task', input: {} } };
      yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ description: `task ${id}`, prompt: 'work' }) } };
      yield { type: 'content_block_stop', index };
      index++;
    }
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 10, output_tokens: 5 } };
    yield { type: 'message_stop' };
  };
}

function setup() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'arco-task-cancel-')));
  const w: any = new ClaudeNativeWorker({ workflowId: 'wf-task-cancel', config: { model: 'claude-opus-4-8', effort: 'high', cwd, skipPermissions: true } });
  const client = { messages: { create: async () => taskRound(['tu-1', 'tu-2', 'tu-3'])() } };
  w.hooksLoaded = true;
  w.ensureStarted = async () => { w.client = client; };
  w.reconcileMcpSessions = async () => {};
  w.hydrateContextManagementCapabilities = async () => {};
  w.workflowEventBroadcast = () => {};
  const handles: Array<{ resolve(text: string): void; cancelled: number }> = [];
  w.setTaskHandler(async () => {
    let resolve!: (text: string) => void; let reject!: (err: Error) => void;
    const finalText = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    const n = handles.length + 1;
    const record = { resolve, cancelled: 0 };
    handles.push(record);
    return {
      taskId: `task-${n}`, childWorkflowId: `child-${n}`, finalText,
      read: () => ({ output: '', settled: false }),
      // Like the real handler: the rejection settles in a later microtask.
      cancel: () => { record.cancelled++; reject(new Error('AbortError: parent cancelled')); },
    };
  });
  const order: string[] = [];
  const statuses: any[] = [];
  w.on('task_status', (d: any) => { order.push(`status ${d.taskId} ${d.phase}`); statuses.push(d); });
  w.on('error', (e: string) => order.push(`error ${e}`));
  return { w, cwd, handles, order, statuses, done: async () => { await w.dispose(); rmSync(cwd, { recursive: true, force: true }); } };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), 'condition reached');
}

test('parent cancel reports each unsettled Task child as cancelled synchronously, once, before the turn error', async () => {
  const s = setup();
  try {
    const run = s.w.runTurn('start three tasks');
    await waitFor(() => s.handles.length === 3);
    // One child finishes before the cancel; it keeps its done status.
    s.handles[0].resolve('child one answer');
    await waitFor(() => s.statuses.length === 1);
    s.w.cancel();
    // Reported inside cancel(), before any microtask can revoke the turn.
    assert.deepEqual(s.order, ['status task-1 done', 'status task-2 cancelled', 'status task-3 cancelled']);
    await run;
    assert.deepEqual(s.order, ['status task-1 done', 'status task-2 cancelled', 'status task-3 cancelled', 'error Worker killed']);
    assert.equal(s.handles[1].cancelled, 1);
    assert.equal(s.handles[2].cancelled, 1);
    for (const st of s.statuses.slice(1)) {
      assert.equal(st.phase, 'cancelled');
      assert.equal(typeof st.elapsedMs, 'number');
      assert.match(st.toolUseId, /^tu-[23]$/);
    }
    // A second cancel (STOP pressed twice, or dispose) adds nothing.
    s.w.cancel();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.statuses.length, 3);
  } finally { await s.done(); }
});
