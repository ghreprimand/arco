import assert from 'node:assert/strict';
import test from 'node:test';
import { useAppStore } from '../stores/appStore.js';
import { handleServerMessage } from './handleServerMessage.js';

const stored = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) } });

test('file-context metadata advances replay sequence without creating chat rows', () => {
  const id = 'wf-file-context-ui';
  useAppStore.getState().createJob(id, { name: 'fixture', primaryProvider: 'ollama', primaryModel: 'fixture', primaryEffort: 'medium' } as any);
  const before = useAppStore.getState().jobs[id].messages.length;
  handleServerMessage({ type: 'file_context', workflowId: id, origin: 'attachment', receipt: 'Saved image', files: [], seq: 12 } as any, { wsRef: { current: null }, scheduleReconnect: () => {} });
  assert.equal(useAppStore.getState().jobs[id].messages.length, before);
  assert.equal(useAppStore.getState().jobs[id].lastSeq, 12);
});
