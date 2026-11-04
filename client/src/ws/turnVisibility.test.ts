import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage, WorkflowConfig } from '@arco/shared';
import { handleServerMessage } from './handleServerMessage.js';
import { useAppStore } from '../stores/appStore.js';
import { turnStep } from '../utils/turnStep.js';

useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
const deps = { wsRef: { current: null }, scheduleReconnect: () => {} };
let count = 0;
function fixture() {
  const id = `turn-visibility-${++count}`;
  useAppStore.getState().createJob(id, { name: 'Fixture', primaryProvider: 'codex', primaryModel: 'fixture', primaryEffort: 'low' } as unknown as WorkflowConfig, undefined, undefined);
  const emit = (type: string, fields: object = {}) => handleServerMessage({ type, workflowId: id, ...fields } as ServerMessage, deps);
  const state = () => useAppStore.getState().jobs[id].turnMessages ?? {};
  emit('primary_turn_started', { startedAt: 1000 });
  const queue = () => emit('queue_update', { steering: [{ clientMessageId: 'a', content: 'Proceed' }], followUp: [] });
  return { id, emit, state, queue };
}

test('message remains queued until delivery, then clears on subsequent reply', () => {
  const f = fixture(); f.queue();
  assert.equal(f.state().a.state, 'queued');
  f.emit('queue_update', { steering: [], followUp: [] });
  assert.equal(f.state().a.state, 'queued');
  f.emit('turn_messages_delivered', { clientMessageIds: ['a'] });
  assert.equal(f.state().a.state, 'delivered');
  f.emit('primary_text', { text: 'Reply', phase: 'passthrough' });
  assert.equal(f.state().a, undefined);
});

test('unconfirmed and requeued messages remain queued until turn ends', () => {
  const f = fixture(); f.queue();
  f.emit('queue_update', { steering: [], followUp: [] });
  f.emit('primary_text', { text: 'Unrelated', phase: 'passthrough' });
  assert.equal(f.state().a.state, 'queued');
  f.emit('turn_messages_delivered', { clientMessageIds: ['a'] });
  f.queue();
  assert.equal(f.state().a.state, 'queued');
  f.emit('primary_turn_ended', { endedAt: 2000 });
  assert.equal(f.state().a, undefined);
});

test('current tool uses first command line and marks duration after one minute', () => {
  const activity = [{ id: 'tool', kind: 'tool_use' as const, tool: 'Bash', input: JSON.stringify({ command: 'npm test\nother' }), status: 'started' as const, at: 1000 }];
  assert.deepEqual(turnStep(activity, 500, 61_000), { label: 'Bash: npm test', time: '1m 0s', longRunning: false });
  assert.deepEqual(turnStep(activity, 500, 62_000), { label: 'Bash: npm test', time: '1m 1s', longRunning: true });
  assert.deepEqual(turnStep([{ ...activity[0], status: 'completed', updatedAt: 61_000 }], 500, 62_000), { label: 'Working', time: '1s', longRunning: false });
});


test('an idle reconnect or cancellation clears transient delivery state', () => {
  const f = fixture(); f.queue();
  useAppStore.getState().applyWorkflowSnapshot(f.id, {}, false, []);
  assert.equal(f.state().a, undefined);
  f.emit('primary_turn_started', { startedAt: 1000 }); f.queue();
  f.emit('turn_cancelled', { reason: 'operator-stop' });
  assert.equal(f.state().a, undefined);
});
