import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage, WorkflowConfig } from '@arco/shared';
import { handleServerMessage, type WsDeps } from './handleServerMessage.js';
import { useAppStore } from '../stores/appStore.js';
import { streamingMsgs } from './streamState.js';

// Cursor streams reasoning and tool updates between chunks of one reply.
// Reasoning and tool updates close the open segment: the next chunk starts a new
// message instead of running on ("fix.While"), and only the newest segment
// shows the streaming cursor.

const deps: WsDeps = { wsRef: { current: null }, scheduleReconnect: () => {} };
const send = (msg: Record<string, unknown>) => handleServerMessage(msg as unknown as ServerMessage, deps);

function fresh(wfid: string, provider: string): void {
  streamingMsgs.delete(wfid);
  useAppStore.getState().createJob(wfid, { name: wfid, primaryModel: 'auto', primaryEffort: 'high', primaryProvider: provider } as unknown as WorkflowConfig, undefined, undefined);
}
const replies = (wfid: string) => useAppStore.getState().jobs[wfid].messages.filter((m) => m.role === 'assistant' && !m.toolUse);

test('Cursor reasoning between chunks ends the segment; every earlier segment stops streaming', () => {
  const wf = 'wf-cursor-seg-1';
  fresh(wf, 'cursor');
  let seq = 0;
  const text = (t: string) => send({ type: 'primary_text', workflowId: wf, phase: 'passthrough', text: t, seq: ++seq });
  const think = () => send({ type: 'primary_thinking', workflowId: wf, text: 'considering', seq: ++seq });
  const tool = (status: string) => send({ type: 'primary_tool_use', workflowId: wf, tool: 'Read', input: '{}', status, toolUseId: 't1', provider: 'cursor', seq: ++seq });
  send({ type: 'primary_turn_started', workflowId: wf, startedAt: 1000 });
  text('I will fix.'); think(); text('While here'); tool('started'); text('Then'); tool('completed'); text('Done');
  const rows = replies(wf);
  assert.deepEqual(rows.map((m) => m.content), ['I will fix.', 'While here', 'Then', 'Done']);
  assert.deepEqual(rows.map((m) => m.isStreaming), [false, false, false, true]);
  send({ type: 'primary_complete', workflowId: wf, phase: 'passthrough', seq: ++seq });
  assert.equal(replies(wf).filter((m) => m.isStreaming).length, 0);
});

test('other providers keep reasoning inside the open segment', () => {
  const wf = 'wf-cursor-seg-2';
  fresh(wf, 'claude');
  let seq = 0;
  send({ type: 'primary_turn_started', workflowId: wf, startedAt: 1000 });
  send({ type: 'primary_text', workflowId: wf, phase: 'passthrough', text: 'One ', seq: ++seq });
  send({ type: 'primary_thinking', workflowId: wf, text: 'x', seq: ++seq });
  send({ type: 'primary_text', workflowId: wf, phase: 'passthrough', text: 'reply', seq: ++seq });
  assert.deepEqual(replies(wf).map((m) => m.content), ['One reply']);
});

test('a segment left streaming is closed when a newer one starts', () => {
  const wf = 'wf-cursor-seg-3';
  fresh(wf, 'cursor');
  send({ type: 'primary_turn_started', workflowId: wf, startedAt: 1000 });
  useAppStore.getState().addMessage(wf, { id: 'stale', role: 'assistant', content: 'old', isStreaming: true, phase: 'passthrough', timestamp: 1 });
  send({ type: 'primary_text', workflowId: wf, phase: 'passthrough', text: 'new', seq: 1 });
  const rows = replies(wf);
  assert.equal(rows.filter((m) => m.isStreaming).length, 1);
  assert.equal(rows.find((m) => m.id === 'stale')?.isStreaming, false);
});

test('Cursor text before a tool stays separate from text after its completion', () => {
  const wf = 'wf-cursor-seg-4';
  fresh(wf, 'cursor');
  send({ type: 'primary_turn_started', workflowId: wf, startedAt: 1000, seq: 1 });
  send({ type: 'primary_text', workflowId: wf, phase: 'passthrough', text: 'I will fix.', seq: 2 });
  send({ type: 'primary_tool_use', workflowId: wf, tool: 'Read', input: '{}', status: 'started', toolUseId: 'read', provider: 'cursor', seq: 3 });
  send({ type: 'primary_tool_use', workflowId: wf, tool: 'Read', input: '{}', status: 'completed', toolUseId: 'read', provider: 'cursor', seq: 4 });
  send({ type: 'primary_text', workflowId: wf, phase: 'passthrough', text: 'While here', seq: 5 });
  assert.deepEqual(replies(wf).map(m => m.content), ['I will fix.', 'While here']);
  assert.deepEqual(replies(wf).map(m => m.isStreaming), [false, true]);
});

for (const replay of [false, true]) {
  test(`Cursor tool completion preserves its reply boundary (${replay ? 'cold replay' : 'live'})`, () => {
    const wf = `wf-cursor-boundary-${replay}`;
    fresh(wf, 'cursor');
    const events = [
      { type: 'primary_turn_started', workflowId: wf, startedAt: 1000, seq: 1 },
      { type: 'primary_tool_use', workflowId: wf, tool: 'Read', input: '{}', status: 'started', toolUseId: 'read', provider: 'cursor', seq: 2 },
      { type: 'primary_text', workflowId: wf, phase: 'passthrough', text: 'Then', seq: 3 },
      { type: 'primary_tool_use', workflowId: wf, tool: 'Read', input: '{}', status: 'completed', toolUseId: 'read', provider: 'cursor', seq: 4 },
      { type: 'primary_text', workflowId: wf, phase: 'passthrough', text: 'Done', seq: 5 },
    ];
    if (replay) send({ type: 'replay_batch', workflowId: wf, events });
    else events.forEach(send);
    assert.deepEqual(replies(wf).map(m => [m.content, m.isStreaming]), [['Then', false], ['Done', true]]);
    const card = useAppStore.getState().jobs[wf].activity.find(a => a.toolUseId === 'read')!;
    assert.equal(card.eventSeq, 2);
    assert.equal(card.eventEndSeq, 4);
  });
}

test('Cursor completion boundary survives reload without moving its tool card', () => {
  const wf = 'wf-cursor-boundary-reload';
  fresh(wf, 'cursor');
  send({ type: 'primary_turn_started', workflowId: wf, startedAt: 1000, seq: 1 });
  send({ type: 'primary_tool_use', workflowId: wf, tool: 'Read', input: '{}', status: 'started', toolUseId: 'read', provider: 'cursor', seq: 2 });
  send({ type: 'primary_text', workflowId: wf, phase: 'passthrough', text: 'Then', seq: 3 });
  send({ type: 'primary_tool_use', workflowId: wf, tool: 'Read', input: '{}', status: 'completed', toolUseId: 'read', provider: 'cursor', seq: 4 });
  const cached = structuredClone(useAppStore.getState().jobs[wf]);
  streamingMsgs.delete(wf);
  useAppStore.setState(s => ({ jobs: { ...s.jobs, [wf]: cached } }));
  send({ type: 'primary_text', workflowId: wf, phase: 'passthrough', text: 'Done', seq: 5 });
  assert.deepEqual(replies(wf).map(m => [m.content, m.isStreaming]), [['Then', false], ['Done', true]]);
});
