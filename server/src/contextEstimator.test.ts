// Claude CLI context reading from the session JSONL: the latest assistant
// entry's usage is the prompt size only for a single-pass response.
//
// Run: node --conditions development --import tsx --test src/contextEstimator.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestUsageTokensFromJsonl } from './contextEstimator.js';

const line = (obj: unknown) => JSON.stringify(obj);
const assistant = (id: string, usage: Record<string, unknown>, content: unknown[] = [{ type: 'text', text: 'ok' }], timestamp = '2026-11-10T10:00:00.000Z') =>
  line({ type: 'assistant', timestamp, message: { id, role: 'assistant', content, usage } });

test('a single-pass response gives cache_read + cache_creation + input as ground truth', () => {
  const text = [
    line({ type: 'user', message: { role: 'user', content: 'hi' } }),
    assistant('m1', { input_tokens: 10, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000, output_tokens: 50, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } }),
  ].join('\n');
  assert.deepEqual(latestUsageTokensFromJsonl(text), { tokens: 42_010, timestamp: Date.parse('2026-11-10T10:00:00.000Z') });
});

test('usage.iterations wins over the summed top-level fields', () => {
  const text = assistant('m2', {
    input_tokens: 60, cache_read_input_tokens: 900_000, cache_creation_input_tokens: 30_000, output_tokens: 900,
    server_tool_use: { web_search_requests: 7, web_fetch_requests: 4 },
    iterations: [
      { type: 'message', input_tokens: 5, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 3_000, output_tokens: 80 },
      { type: 'message', input_tokens: 5, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 5_000, output_tokens: 80 },
    ],
  });
  assert.equal(latestUsageTokensFromJsonl(text)?.tokens, 95_005);
});

test('a server-tool response without iterations is not ground truth', () => {
  const summed = { input_tokens: 60, cache_read_input_tokens: 900_000, cache_creation_input_tokens: 30_000, output_tokens: 900 };
  // Counted in usage.server_tool_use.
  assert.equal(latestUsageTokensFromJsonl(assistant('m3', { ...summed, server_tool_use: { web_search_requests: 3 } })), null);
  // Or visible as a server_tool_use block on a sibling line of the same message.
  const text = [
    assistant('m4', summed, [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: {} }]),
    assistant('m4', summed, [{ type: 'web_search_tool_result', tool_use_id: 's1', content: [] }]),
    assistant('m4', summed, [{ type: 'text', text: 'answer' }]),
  ].join('\n');
  assert.equal(latestUsageTokensFromJsonl(text), null);
  // A plain response later in the file is read as usual.
  const later = text + '\n' + assistant('m5', { input_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0, output_tokens: 1 });
  assert.equal(latestUsageTokensFromJsonl(later)?.tokens, 100_010);
});

test('malformed and non-assistant lines are skipped', () => {
  const text = ['not json', line({ type: 'user' }), assistant('m6', { input_tokens: 0 }), assistant('m7', { input_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }), '{broken'].join('\n');
  assert.equal(latestUsageTokensFromJsonl(text)?.tokens, 7);
  assert.equal(latestUsageTokensFromJsonl(''), null);
});
