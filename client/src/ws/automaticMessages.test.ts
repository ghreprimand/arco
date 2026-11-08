import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerMessage, WorkflowConfig } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { narrativeEventFromMessage } from '../utils/historyEvents';
import { projectChatMessages } from '../utils/displayMessages';
import { handleServerMessage, type WsDeps } from './handleServerMessage';

test('automatic message markers survive event replay and remain distinguishable from typed text', () => {
  const id = 'automatic-message-fixture';
  useAppStore.getState().createJob(id, { name: 'fixture', primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium', workingDirectory: '/fixture', skipPermissions: false } as WorkflowConfig);
  const deps: WsDeps = { wsRef: { current: null }, scheduleReconnect: () => {} };
  const automatic = { type: 'user_message_echo', workflowId: id, content: '(nudge) full synthetic reminder', automaticKind: 'nudge', seq: 1, timestamp: 1 } as unknown as ServerMessage;
  const typed = { type: 'user_message_echo', workflowId: id, content: '(nudge) typed by hand', seq: 2, timestamp: 2 } as unknown as ServerMessage;
  handleServerMessage(automatic, deps);
  handleServerMessage(typed, deps);
  const messages = useAppStore.getState().jobs[id].messages;
  assert.equal((messages.find(m => m.content === '(nudge) full synthetic reminder') as { automaticKind?: string })?.automaticKind, 'nudge');
  assert.equal((messages.find(m => m.content === '(nudge) typed by hand') as { automaticKind?: string })?.automaticKind, undefined);
  const history = narrativeEventFromMessage(automatic) as { automaticKind?: string; automaticContent?: string } | null;
  assert.equal(history?.automaticKind, 'nudge');
  assert.equal(history?.automaticContent, '(nudge) full synthetic reminder');
  const job = useAppStore.getState().jobs[id];
  const sessionChat = [{ id: 'session-auto', role: 'user', content: '(nudge) full synthetic reminder', isStreaming: false, timestamp: 1 }, { id: 'session-typed', role: 'user', content: '(nudge) typed by hand', isStreaming: false, timestamp: 2 }] as typeof job.messages;
  const projected = projectChatMessages({ ...job, sessionChat });
  assert.equal(projected.find(m => m.id === 'session-auto')?.automaticKind, 'nudge');
  assert.equal(projected.find(m => m.id === 'session-typed')?.automaticKind, undefined);
});

test('identical typed and automatic prompts retain their own markers in CLI transcript overlays', () => {
  const id = 'automatic-identical-fixture';
  useAppStore.getState().createJob(id, { name: 'fixture', primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium', workingDirectory: '/fixture', skipPermissions: false } as WorkflowConfig);
  const job = useAppStore.getState().jobs[id];
  const text = '(nudge) same synthetic content';
  const messages = [
    { id: 'auto-event', role: 'user', content: text, automaticKind: 'nudge', isStreaming: false, timestamp: 1000 },
    { id: 'typed-event', role: 'user', content: text, isStreaming: false, timestamp: 2000 },
    { id: 'later-event', role: 'user', content: text, isStreaming: false, timestamp: 10000 },
  ] as typeof job.messages;
  const sessionChat = [
    { id: 'auto-cli', role: 'user', content: text, isStreaming: false, timestamp: 1001 },
    { id: 'typed-cli', role: 'user', content: text, isStreaming: false, timestamp: 2001 },
    { id: 'later-cli', role: 'user', content: text, isStreaming: false, timestamp: 10001 },
  ] as typeof job.messages;
  const rows = projectChatMessages({ ...job, messages, sessionChat });
  assert.equal(rows.find(row => row.id === 'auto-cli')?.automaticKind, 'nudge');
  assert.equal(rows.find(row => row.id === 'typed-cli')?.automaticKind, undefined);
  assert.equal(rows.find(row => row.id === 'later-cli')?.automaticKind, undefined);
});

test('a merged CLI queue keeps an automatic reminder folded without hiding typed text', () => {
  const id = 'automatic-merged-fixture';
  useAppStore.getState().createJob(id, { name: 'fixture', primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium', workingDirectory: '/fixture', skipPermissions: false } as WorkflowConfig);
  const job = useAppStore.getState().jobs[id];
  const automatic = '(nudge) full synthetic reminder';
  const typed = '(nudge) typed by hand';
  const messages = [
    { id: 'auto-event', role: 'user', content: automatic, automaticKind: 'nudge', isStreaming: false, timestamp: 1000 },
    { id: 'typed-event', role: 'user', content: typed, isStreaming: false, timestamp: 1001 },
  ] as typeof job.messages;
  const sessionChat = [{ id: 'merged-cli', role: 'user', content: `${automatic}\n\n${typed}`, isStreaming: false, timestamp: 1002 }] as typeof job.messages;
  const rows = projectChatMessages({ ...job, messages, sessionChat }).filter(row => row.role === 'user');
  assert.equal(rows.filter(row => row.automaticKind === 'nudge' && row.content === automatic).length, 1);
  assert.equal(rows.filter(row => !row.automaticKind && row.content.includes(typed)).length, 1);
  assert.equal(rows.filter(row => !row.automaticKind && row.content.includes(automatic)).length, 0);
});

test('CLI queue replay keeps a marked reminder when a session row joins it with typed text', () => {
  const id = 'automatic-queued-fixture';
  useAppStore.getState().createJob(id, { name: 'fixture', primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium', workingDirectory: '/fixture', skipPermissions: false } as WorkflowConfig);
  const deps: WsDeps = { wsRef: { current: null }, scheduleReconnect: () => {} };
  const automatic = '(nudge) full synthetic reminder';
  const typed = '(nudge) typed separately';
  for (const event of [
    { type: 'user_message_echo', workflowId: id, content: automatic, clientMessageId: 'auto', automaticKind: 'nudge', kind: 'steer', seq: 1, timestamp: 1000 },
    { type: 'user_message_echo', workflowId: id, content: typed, clientMessageId: 'typed', kind: 'steer', seq: 2, timestamp: 1001 },
    { type: 'session_entry', workflowId: id, entry: { kind: 'message', role: 'user', content: `${automatic}\n\n${typed}`, timestamp: 1002, uuid: 'cli-merged' } },
  ]) handleServerMessage(event as unknown as ServerMessage, deps);
  const job = useAppStore.getState().jobs[id];
  const rows = projectChatMessages(job).filter(row => row.role === 'user');
  assert.equal(rows.filter(row => row.automaticKind === 'nudge' && row.content === automatic).length, 1);
  assert.equal(rows.filter(row => !row.automaticKind && row.content.includes(typed)).length, 1);
  assert.equal(rows.filter(row => !row.automaticKind && row.content.includes(automatic)).length, 0);
});

test('a typed prompt identical to an automatic reminder stays visible when CLI joins the queue', () => {
  const id = 'automatic-identical-queue';
  useAppStore.getState().createJob(id, { name: 'fixture', primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium', workingDirectory: '/fixture', skipPermissions: false } as WorkflowConfig);
  const deps: WsDeps = { wsRef: { current: null }, scheduleReconnect: () => {} };
  const text = '(nudge) same complete synthetic reminder';
  for (const event of [
    { type: 'user_message_echo', workflowId: id, content: text, clientMessageId: 'typed-first', kind: 'steer', seq: 1, timestamp: 1000 },
    { type: 'user_message_echo', workflowId: id, content: text, clientMessageId: 'auto-second', automaticKind: 'nudge', kind: 'steer', seq: 2, timestamp: 1001 },
    { type: 'session_entry', workflowId: id, entry: { kind: 'message', role: 'user', content: `${text}\n\n${text}`, timestamp: 1002, uuid: 'cli-same' } },
  ]) handleServerMessage(event as unknown as ServerMessage, deps);
  const rows = projectChatMessages(useAppStore.getState().jobs[id]).filter(row => row.role === 'user');
  assert.deepEqual(rows.map(row => [row.content, row.automaticKind]), [[text, undefined], [text, 'nudge']]);
});
