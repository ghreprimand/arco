import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '@arco/shared';
import { capMessages, capSessionChat } from './appStore.js';
import { isStarvedChat } from './memoryTrim.js';

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

test('capMessages keeps user and assistant rows on a long chat full of system rows', () => {
  const rows: ChatMessage[] = [];
  for (let t = 0; t < 300; t++) {
    rows.push(msg(`u-${t}`, t * 4, { role: 'user' }));
    rows.push(msg(`s-${t}-a`, t * 4 + 1, { role: 'system' }));
    rows.push(msg(`a-${t}`, t * 4 + 2));
    rows.push(msg(`s-${t}-b`, t * 4 + 3, { role: 'system' }));
  }
  const capped = capMessages(rows);
  assert.equal(capped.length, 500);
  const ids = new Set(capped.map((m) => m.id));
  assert.ok(ids.has('u-299') && ids.has('a-299'));
  assert.ok(capped.filter((m) => m.role !== 'system').length >= 200);
});

test('capMessages keeps user and assistant rows when every turn also has a tool card', () => {
  const rows: ChatMessage[] = [];
  for (let t = 0; t < 300; t++) {
    rows.push(msg(`u-${t}`, t * 5, { role: 'user', content: `question ${t}` }));
    rows.push(msg(`s-${t}-a`, t * 5 + 1, { role: 'system' }));
    rows.push(msg(`a-${t}`, t * 5 + 2, { content: `answer ${t}` }));
    rows.push(msg(`s-${t}-b`, t * 5 + 3, { role: 'system' }));
    rows.push(msg(`t-${t}`, t * 5 + 4, {
      toolUse: { tool: 'Bash', input: { command: 'echo hi' }, toolUseId: `tool-${t}` },
    }));
  }
  const capped = capMessages(rows);
  assert.equal(capped.length, 500);
  const ids = new Set(capped.map((m) => m.id));
  assert.ok(ids.has('u-299') && ids.has('a-299'));
  assert.ok(capped.filter((m) => m.role !== 'system').length >= 200);
  const userAndAssistant = capped.filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.toolUse));
  assert.ok(userAndAssistant.length >= 100);
});

test('isStarvedChat flags only long chats without user or assistant rows', () => {
  const sys = (n: number) => Array.from({ length: n }, (_, i) => msg(`s-${i}`, i, { role: 'system' }));
  assert.equal(isStarvedChat(sys(120)), true);
  assert.equal(isStarvedChat(sys(20)), false);
  assert.equal(isStarvedChat([...sys(120), msg('a', 999)]), false);
});
