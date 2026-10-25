import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '@archon/shared';
import { capMessages, capSessionChat } from './appStore.js';

function msg(id: string, timestamp: number, patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: id,
    isStreaming: false,
    timestamp,
    ...patch,
  };
}

test('capMessages keeps newest rows under the configured limit', () => {
  const rows = Array.from({ length: 10 }, (_, i) => msg(`m-${i}`, i));
  const capped = capMessages(rows, { limit: 5 });
  assert.deepEqual(capped.map((m) => m.id), ['m-5', 'm-6', 'm-7', 'm-8', 'm-9']);
});

test('capMessages preserves current-turn and synthetic rows even when older than the window', () => {
  const rows = Array.from({ length: 10 }, (_, i) => msg(`m-${i}`, i));
  rows[0] = msg('streaming', 0, { isStreaming: true });
  rows[1] = msg('queued', 1, { role: 'user', queued: true });
  rows[2] = msg('system', 2, { role: 'system' });
  rows[3] = msg('task', 3, { toolUse: { tool: 'Task', input: {}, toolUseId: 'tool-1' } });
  const capped = capMessages(rows, { limit: 6 });
  assert.deepEqual(capped.map((m) => m.id), ['streaming', 'queued', 'system', 'task', 'm-8', 'm-9']);
});

test('capMessages keeps an explicitly prepended history page visible', () => {
  const older = Array.from({ length: 3 }, (_, i) => msg(`older-${i}`, i));
  const recent = Array.from({ length: 10 }, (_, i) => msg(`recent-${i}`, 100 + i));
  const capped = capMessages([...older, ...recent], { limit: 6, preserveStartCount: older.length });
  assert.deepEqual(capped.map((m) => m.id), ['older-0', 'older-1', 'older-2', 'recent-7', 'recent-8', 'recent-9']);
});

test('capSessionChat keeps the newest JSONL-derived rows by default', () => {
  const rows = Array.from({ length: 10 }, (_, i) => msg(`s-${i}`, i));
  const capped = capSessionChat(rows, { limit: 4 });
  assert.deepEqual(capped.map((m) => m.id), ['s-6', 's-7', 's-8', 's-9']);
});

test('capSessionChat can preserve the oldest loaded page while bounding the hot set', () => {
  const rows = Array.from({ length: 10 }, (_, i) => msg(`s-${i}`, i));
  const capped = capSessionChat(rows, { limit: 6, preserveOldestCount: 2 });
  assert.deepEqual(capped.map((m) => m.id), ['s-0', 's-1', 's-6', 's-7', 's-8', 's-9']);
});

test('capMessages bounds oversized chat message content', () => {
  const giant = 'x'.repeat(400 * 1024);
  const capped = capMessages([msg('giant', 1, { content: giant })]);
  assert.equal(capped.length, 1);
  assert.ok(capped[0]!.content.length < giant.length);
  assert.match(capped[0]!.content, /client-side chat message truncated/);
});

test('capSessionChat bounds large tool-use input fields', () => {
  const giant = 'x'.repeat(100 * 1024);
  const capped = capSessionChat([
    msg('tool', 1, {
      content: '',
      toolUse: {
        tool: 'Write',
        toolUseId: 'tool-1',
        filePath: '/tmp/a.txt',
        input: { file_path: '/tmp/a.txt', content: giant },
      },
    }),
  ]);
  const input = capped[0]!.toolUse!.input as { content: string };
  assert.ok(input.content.length < giant.length);
  assert.match(input.content, /client-side tool input field truncated/);
});
