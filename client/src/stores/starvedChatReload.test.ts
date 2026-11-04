import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '@arco/shared';
import { useAppStore } from './appStore.js';

// P6.93: a tab whose saved chat is only system rows and tool cards reloads its
// tail once. A later reload, after that tail contains a user or assistant
// row, must not clear the chat or zero lastSeq again.

const KEY = 'arco-jobs';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

function row(id: string, role: ChatMessage['role'], timestamp: number): ChatMessage {
  return { id, role, content: id, isStreaming: false, timestamp };
}

function saved(job: Record<string, unknown>) {
  return JSON.stringify({
    state: {
      jobs: {
        'job-1': {
          config: {},
          workers: {},
          reviews: [],
          research: [],
          handoffs: [],
          activity: [],
          historyEvents: [],
          ...job,
        },
      },
      activeJobId: 'job-1',
    },
    version: 0,
  });
}

test('a starved saved chat is cleared once, and a recovered tail is kept on the next reload', async () => {
  const storage = memoryStorage();
  Object.assign(globalThis, { localStorage: storage });
  const starved = Array.from({ length: 120 }, (_, i) => row(`s-${i}`, 'system', i));
  storage.setItem(KEY, saved({ id: 'job-1', messages: starved, lastSeq: 900 }));
  await useAppStore.persist.rehydrate();
  const first = useAppStore.getState().jobs['job-1'] as { messages: ChatMessage[]; lastSeq?: number };
  assert.ok(first, 'the saved job was restored');
  assert.equal(first.messages.length, 0);
  assert.equal(first.lastSeq, 0);

  const tail = [
    ...Array.from({ length: 40 }, (_, i) => row(`tail-s-${i}`, 'system', 1000 + i)),
    row('tail-user', 'user', 1100),
    row('tail-assistant', 'assistant', 1101),
  ];
  storage.setItem(KEY, saved({ id: 'job-1', messages: tail, lastSeq: 940 }));
  await useAppStore.persist.rehydrate();
  const second = useAppStore.getState().jobs['job-1'] as { messages: ChatMessage[]; lastSeq?: number };
  assert.equal(second.lastSeq, 940);
  assert.equal(second.messages.filter((m) => m.id === 'tail-user').length, 1);
  assert.equal(second.messages.filter((m) => m.id === 'tail-assistant').length, 1);
  const count = second.messages.length;
  await useAppStore.persist.rehydrate();
  const third = useAppStore.getState().jobs['job-1'] as { messages: ChatMessage[]; lastSeq?: number };
  assert.equal(third.lastSeq, 940);
  assert.equal(third.messages.length, count);
  assert.equal(third.messages.filter((m) => m.id === 'tail-user').length, 1);
});
