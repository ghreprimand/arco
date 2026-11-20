import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage, WorkflowConfig } from '@arco/shared';
import { handleServerMessage, type WsDeps } from './handleServerMessage.js';
import { useAppStore } from '../stores/appStore.js';
import { streamingMsgs } from './streamState.js';
import { projectChatMessages } from '../utils/displayMessages.js';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const deps: WsDeps = { wsRef: { current: null }, scheduleReconnect: () => {} };
const send = (msg: Record<string, unknown>) => handleServerMessage(msg as unknown as ServerMessage, deps);
useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
let serial = 0;
function fixture() {
  const id = `tool-status-${++serial}`;
  streamingMsgs.delete(id);
  useAppStore.getState().createJob(id, { name: 'tool status fixture', primaryProvider: 'codex', primaryModel: 'fixture', primaryEffort: 'low' } as WorkflowConfig);
  const event = (type: string, seq: number, fields: object = {}) => ({ type, workflowId: id, seq, timestamp: 1000 + seq, ...fields });
  const text = (seq: number, value: string) => event('primary_text', seq, { phase: 'passthrough', text: value });
  const tool = (seq: number, status: string, identity: object) => event('primary_tool_use', seq, { tool: 'command_execution', provider: 'codex', itemType: 'command_execution', input: '{}', status, ...identity });
  const job = () => useAppStore.getState().jobs[id];
  const replies = () => job().messages.filter(m => m.role === 'assistant' && !m.toolUse);
  return { id, event, text, tool, job, replies };
}
const left = 'The fixture has free';
const right = ' memory and disk space.';

for (const status of ['completed', 'failed', 'in_progress']) {
  for (const replay of [false, true]) {
    test(`${status} updates preserve one reply and its tool anchor (${replay ? 'cold event replay' : 'live'})`, () => {
      const f = fixture();
      const identity = { itemId: 'command-1', toolUseId: 'tool-1' };
      const events = [
        f.event('primary_turn_started', 1, { startedAt: 1000 }),
        f.tool(2, 'started', identity),
        f.text(3, left),
        f.tool(4, status, { ...identity, output: 'fixture output', exitCode: status === 'failed' ? 1 : 0 }),
        f.text(5, right),
      ];
      if (replay) send({ type: 'replay_batch', workflowId: f.id, events });
      else events.forEach(send);
      assert.deepEqual(f.replies().map(m => m.content), [left + right]);
      assert.equal(f.replies()[0].isStreaming, true);
      const cards = f.job().activity.filter(a => a.kind === 'tool_use');
      assert.equal(cards.length, 1);
      assert.equal(cards[0].status, status);
      assert.equal(cards[0].output, 'fixture output');
      assert.equal(cards[0].eventSeq, 2, 'status updates leave the card where it started');
      send(f.event('primary_complete', 6, { phase: 'passthrough' }));
      assert.equal(f.replies()[0].isStreaming, false);
      const store = useAppStore.getState();
      store.upsertSessionChat(f.id, { kind: 'tool_use', tool: 'command_execution', toolUseId: 'tool-1', input: {}, timestamp: 1002 });
      store.upsertSessionChat(f.id, { kind: 'message', role: 'assistant', content: left + right, timestamp: 1003, uuid: 'session-reply' });
      const rows = projectChatMessages(f.job()).filter(m => m.role === 'assistant');
      assert.deepEqual(rows.map(m => m.toolUse?.tool ?? m.content), ['command_execution', left + right], 'session overlay keeps one reply after the original tool card');
    });
  }
}

test('an item-id-only update also keeps text open; a newly encountered tool splits it', () => {
  const f = fixture();
  [f.event('primary_turn_started', 1, { startedAt: 1000 }), f.tool(2, 'started', { itemId: 'one' }), f.text(3, left), f.tool(4, 'completed', { itemId: 'one' }), f.text(5, right), f.tool(6, 'started', { itemId: 'two' }), f.text(7, 'Next reply')].forEach(send);
  assert.deepEqual(f.replies().map(m => m.content), [left + right, 'Next reply']);
  assert.deepEqual(f.replies().map(m => m.isStreaming), [false, true]);
});

test('a tool-use-id-only update preserves the segment after an operator steer', () => {
  const f = fixture();
  [f.event('primary_turn_started', 1, { startedAt: 1000 }), f.tool(2, 'started', { toolUseId: 'one' }), f.text(3, 'Before steer'), f.event('user_message_echo', 4, { kind: 'steer', content: 'Keep going', clientMessageId: 'steer' }), f.text(5, left), f.tool(6, 'completed', { toolUseId: 'one' }), f.text(7, right)].forEach(send);
  assert.deepEqual(f.replies().map(m => m.content), ['Before steer', left + right]);
  assert.deepEqual(f.replies().map(m => m.isStreaming), [false, true]);
});

test('reload between text deltas keeps the persisted segment open across tool completion', () => {
  const f = fixture();
  [f.event('primary_turn_started', 1, { startedAt: 1000 }), f.tool(2, 'started', { itemId: 'command' }), f.text(3, left)].forEach(send);
  const cached = structuredClone(f.job());
  streamingMsgs.delete(f.id);
  useAppStore.setState(s => ({ jobs: { ...s.jobs, [f.id]: { ...cached, messages: cached.messages.map(m => ({ ...m, isStreaming: false })) } } }));
  [f.tool(4, 'completed', { itemId: 'command' }), f.text(5, right), f.event('primary_complete', 6, { phase: 'passthrough' })].forEach(send);
  assert.deepEqual(f.replies().map(m => m.content), [left + right]);
  assert.equal(f.job().activity.find(a => a.itemId === 'command')?.eventSeq, 2);
});

// The persisted completion carries elapsed time so cold replay renders the same row.
test('held command completion shows its exit and elapsed time in ACTIVITY live and after replay', async () => {
  const fixtures: Record<string, string> = { '../FileViewerModal': 'exports.FileViewerModal = () => null;', './FilesTab': 'exports.EmptyState = () => null;' };
  const built = await build({ entryPoints: [fileURLToPath(new URL('../components/RightPanel/ActivityTab.tsx', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', plugins: [{ name: 'activity-fixtures', setup(build) {
    build.onResolve({ filter: /.*/ }, args => args.path in fixtures ? { path: args.path, namespace: 'fixture' } : undefined);
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path] }));
  } }] });
  const mod = { exports: {} as { ActivityTab: React.ComponentType<any> } };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  for (const replay of [false, true]) {
    const f = fixture();
    const events = [
      f.tool(1, 'started', { itemId: 'held', input: JSON.stringify({ command: 'fixture check' }) }),
      f.tool(2, 'completed', { itemId: 'held', input: JSON.stringify({ command: 'fixture check' }), exitCode: 0, lateCommand: { state: 'finished', startedAt: 1000, waitingUntil: 300000, elapsedMs: 62000 } }),
    ];
    if (replay) send({ type: 'replay_batch', workflowId: f.id, events });
    else events.forEach(send);
    const html = renderToStaticMarkup(React.createElement(mod.exports.ActivityTab, { job: f.job() }));
    assert.match(html, /fixture check/);
    assert.match(html, /exit 0/);
    assert.match(html, /62s/);
  }
});
