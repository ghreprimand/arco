// Unit tests for stripTrailingThinkingFromContent (2026-05-30).
//
// Anthropic rejects an assistant message whose content array ends with a
// `thinking` / `redacted_thinking` block ("messages.N: The final block in an
// assistant message cannot be 'thinking'"). With interleaved thinking, Opus 4.8
// emits rounds ending in a thinking block; pushed verbatim into history they
// become a landmine that 400s a later resend. These tests pin the trailing-run
// strip: drop the trailing thinking, keep mid-message thinking (signatures),
// and never leave an empty assistant message.
//
// Run with: node --import tsx --test src/providers/claude-native/stripTrailingThinking.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTrailingThinkingFromContent, THINKING_ONLY_PLACEHOLDER } from './worker.js';

test('content ending in a thinking block: trailing thinking stripped', () => {
  const content = [
    { type: 'thinking', thinking: 'reasoning A' },
    { type: 'text', text: 'I will search.' },
    { type: 'tool_use', id: 't1', name: 'web_search', input: {} },
    { type: 'thinking', thinking: 'reasoning B (trailing)' },
  ];
  const res = stripTrailingThinkingFromContent(content);
  assert.equal(res.stripped, 1);
  assert.equal(res.content.length, 3);
  assert.equal(res.content[res.content.length - 1].type, 'tool_use', 'last block is now the tool_use');
  // The mid-message thinking block (index 0) is preserved.
  assert.equal(res.content[0].type, 'thinking');
});

test('content NOT ending in thinking: returned unchanged by reference', () => {
  const content = [
    { type: 'thinking', thinking: 'reasoning' },
    { type: 'tool_use', id: 't1', name: 'Read', input: {} },
  ];
  const res = stripTrailingThinkingFromContent(content);
  assert.equal(res.stripped, 0);
  assert.equal(res.content, content, 'same array reference when nothing changed');
});

test('multiple contiguous trailing thinking blocks: all stripped', () => {
  const content = [
    { type: 'text', text: 'answer' },
    { type: 'thinking', thinking: 'one' },
    { type: 'redacted_thinking', data: 'two' },
    { type: 'thinking', thinking: 'three' },
  ];
  const res = stripTrailingThinkingFromContent(content);
  assert.equal(res.stripped, 3);
  assert.equal(res.content.length, 1);
  assert.equal(res.content[0].type, 'text');
});

test('redacted_thinking as the final block is also stripped', () => {
  const content = [
    { type: 'text', text: 'answer' },
    { type: 'redacted_thinking', data: 'xyz' },
  ];
  const res = stripTrailingThinkingFromContent(content);
  assert.equal(res.stripped, 1);
  assert.equal(res.content.length, 1);
  assert.equal(res.content[0].type, 'text');
});

test('thinking only in the MIDDLE (followed by content): preserved', () => {
  const content = [
    { type: 'thinking', thinking: 'a' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
    { type: 'thinking', thinking: 'b' },
    { type: 'tool_use', id: 't2', name: 'Bash', input: {} },
  ];
  const res = stripTrailingThinkingFromContent(content);
  assert.equal(res.stripped, 0, 'no trailing thinking — both thinking blocks precede a tool_use');
  assert.equal(res.content, content);
});

test('pure-thinking message: replaced with a placeholder text block (never empty)', () => {
  const content = [
    { type: 'thinking', thinking: 'just musing' },
    { type: 'thinking', thinking: 'more musing' },
  ];
  const res = stripTrailingThinkingFromContent(content);
  assert.equal(res.stripped, 2);
  assert.equal(res.content.length, 1);
  assert.equal(res.content[0].type, 'text');
  assert.equal((res.content[0] as { text?: string }).text, THINKING_ONLY_PLACEHOLDER);
});

test('empty content: unchanged, nothing stripped', () => {
  const res = stripTrailingThinkingFromContent([]);
  assert.equal(res.stripped, 0);
  assert.equal(res.content.length, 0);
});
