// WORKBENCH_EXPANSION_PLAN.md A1 — retention invariants.
//
// Two guards: (1) trimJobMemory caps every hot array regardless of input size
// (the store's append paths apply the same caps, so this proves the policy);
// (2) getRetentionStats counts the live footprint correctly so the dev
// MemoryHud and any soak harness report real numbers. Both run headlessly with
// `node --import tsx --test` (getRetentionStats only touches array lengths +
// the optional Chrome `performance.memory`, so it is node-safe).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, WorkerState } from '@archon/shared';
import { trimJobMemory, MAX_ACTIVITY_ENTRIES, TURN_TOKEN_USAGE_CAP } from './memoryTrim.js';
import type { JobState } from './appStore.types';
import { useAppStore } from './appStore.js';

function msg(id: string): ChatMessage {
  return { id, role: 'assistant', content: id, isStreaming: false, timestamp: Number(id.split('-')[1]) || 0 };
}

function bigJob(id: string): JobState {
  const workers: Record<string, WorkerState> = {};
  for (let i = 0; i < 300; i++) {
    workers[`w-${i}`] = { status: 'settled', output: '', thinking: '', toolCalls: [], spawnedAt: i } as unknown as WorkerState;
  }
  return {
    id,
    // Fields the persist partialize reads when setState fires (slice/serialize).
    currentSessionId: 'sess',
    config: {} as JobState['config'],
    totalCost: 0,
    totalTokens: {} as JobState['totalTokens'],
    totalWorkers: 0,
    reviews: [],
    handoffs: [],
    messages: Array.from({ length: 5000 }, (_, i) => msg(`m-${i}`)),
    sessionChat: Array.from({ length: 5000 }, (_, i) => msg(`s-${i}`)),
    activity: Array.from({ length: 5000 }, (_, i) => ({ id: `a-${i}`, kind: 'tool', label: 'x' })),
    historyEvents: Array.from({ length: 5000 }, (_, i) => ({ seq: i })),
    turnTokenUsage: Array.from({ length: 5000 }, (_, i) => ({ seq: i })),
    workers,
    toolFiltered: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`t-${i}`, {}])),
  } as unknown as JobState;
}

test('trimJobMemory caps every hot array no matter how oversized the input', () => {
  const trimmed = trimJobMemory(bigJob('job-a'));
  assert.ok(trimmed.messages.length <= 500, `messages ${trimmed.messages.length}`);
  assert.ok(trimmed.sessionChat.length <= 500, `sessionChat ${trimmed.sessionChat.length}`);
  assert.ok(trimmed.activity.length <= MAX_ACTIVITY_ENTRIES, `activity ${trimmed.activity.length}`);
  assert.ok((trimmed.historyEvents?.length ?? 0) <= 1000, `historyEvents ${trimmed.historyEvents?.length}`);
  assert.ok((trimmed.turnTokenUsage?.length ?? 0) <= TURN_TOKEN_USAGE_CAP, `turnTokenUsage ${trimmed.turnTokenUsage?.length}`);
  assert.ok(Object.keys(trimmed.workers).length <= 80, `workers ${Object.keys(trimmed.workers).length}`);
  assert.ok(Object.keys(trimmed.toolFiltered ?? {}).length <= 500, `toolFiltered ${Object.keys(trimmed.toolFiltered ?? {}).length}`);
});

test('getRetentionStats reports live counts, blob URLs, and tab count', () => {
  const job = trimJobMemory(bigJob('job-b'));
  useAppStore.setState({
    jobs: { 'job-b': job },
    attachments: {
      'job-b': [
        { filename: 'a.png', path: '/x/a.png', previewUrl: 'blob:1', isImage: true },
        { filename: 'b.txt', path: '/x/b.txt', isImage: false }, // no blob URL
        { filename: 'c.png', path: '/x/c.png', previewUrl: 'blob:2', isImage: true },
      ],
    },
    notifications: [
      { id: 'n1', level: 'info', message: 'x', createdAt: 0 },
      { id: 'n2', level: 'error', message: 'y', createdAt: 0 },
    ],
  });

  const stats = useAppStore.getState().getRetentionStats();
  assert.equal(stats.jobs, 1);
  assert.equal(stats.attachmentUrls, 2, 'only previewUrl-bearing attachments count');
  assert.equal(stats.notifications, 2);
  assert.equal(stats.perJob.length, 1);
  const pj = stats.perJob[0]!;
  assert.equal(pj.id, 'job-b');
  assert.equal(pj.messages, job.messages.length);
  assert.equal(pj.activity, job.activity.length);
  assert.equal(pj.workers, Object.keys(job.workers).length);
  // heap is Chrome-only; in node it must be undefined, not a crash.
  assert.equal(stats.heap, undefined);
});
