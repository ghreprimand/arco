// Context size from a Claude response's usage: a response that ran server
// tools (web search, web fetch, code execution) samples several times, and
// its top-level usage is the sum over those passes, not the prompt size.
//
// Run: node --conditions development --import tsx --test src/providers/claude-native/usageContext.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billableRoundUsage, lastPassPromptTokens, roundPromptTokens, roundUsedServerTools } from './usageContext.js';

const pass = (input: number, cacheRead = 0, cacheCreate = 0, output = 100) => ({
  type: 'message', input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate,
});

test('the last message pass gives the prompt size; the top-level sum does not', () => {
  const iterations = [pass(10, 80_000, 5_000), pass(10, 85_000, 6_000), pass(10, 91_000, 7_000)];
  assert.equal(lastPassPromptTokens(iterations), 98_010);
  // A compaction pass after the message passes is not a prompt size.
  assert.equal(lastPassPromptTokens([...iterations, { type: 'compaction', input_tokens: 900_000, output_tokens: 3_000 }]), 98_010);
  assert.equal(lastPassPromptTokens(undefined), undefined);
  assert.equal(lastPassPromptTokens([]), undefined);
  assert.equal(lastPassPromptTokens([{ type: 'compaction', input_tokens: 5 }]), undefined);
  assert.equal(lastPassPromptTokens([{ input_tokens: 0 }]), undefined);
});

test('server tool blocks in the response mark a multi-pass round', () => {
  assert.equal(roundUsedServerTools([{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'a', name: 'Bash', input: {} }]), false);
  assert.equal(roundUsedServerTools([{ type: 'server_tool_use', id: 's', name: 'web_search', input: {} }]), true);
  assert.equal(roundUsedServerTools([{ type: 'web_search_tool_result', tool_use_id: 's', content: [] }]), true);
  assert.equal(roundUsedServerTools([]), false);
});

test('roundPromptTokens: iterations first, then single-pass usage, never a multi-pass sum', () => {
  const usage = { input_tokens: 30, cache_read_input_tokens: 256_000, cache_creation_input_tokens: 18_000, output_tokens: 300 };
  const search = [{ type: 'server_tool_use', id: 's', name: 'web_search', input: {} }];
  // Single pass: the top-level usage is the prompt.
  assert.deepEqual(roundPromptTokens({ usage, contentBlocks: [{ type: 'text', text: 'x' }] }), { tokens: 274_030, source: 'usage' });
  // Iterations present: the last message pass wins over the sum.
  assert.deepEqual(roundPromptTokens({ usage, contentBlocks: search, usageIterations: [pass(10, 80_000, 5_000), pass(20, 86_000, 6_000)] }), { tokens: 92_020, source: 'iterations' });
  // Multi-pass without iterations: no number; the caller counts instead.
  assert.deepEqual(roundPromptTokens({ usage, contentBlocks: search }), { tokens: undefined, source: 'multi-pass' });
  // No usage at all.
  assert.deepEqual(roundPromptTokens({ usage: undefined, contentBlocks: [] }), { tokens: undefined, source: 'none' });
});

test('the operator case: 11 server-tool passes of about 90k each on a 1M window is under 30%, not 97%', () => {
  const iterations = Array.from({ length: 11 }, (_, i) => pass(50, 85_000 + i * 1_000, 4_000));
  const top = iterations.reduce((acc, it) => ({
    input_tokens: acc.input_tokens + it.input_tokens,
    cache_read_input_tokens: acc.cache_read_input_tokens + it.cache_read_input_tokens,
    cache_creation_input_tokens: acc.cache_creation_input_tokens + it.cache_creation_input_tokens,
    output_tokens: acc.output_tokens + it.output_tokens,
  }), { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 });
  const summed = top.input_tokens + top.cache_read_input_tokens + top.cache_creation_input_tokens;
  assert.ok(summed / 1_000_000 > 0.9, `the summed usage reads ${Math.round(summed / 10_000)}%`);
  const measured = roundPromptTokens({ usage: top, contentBlocks: [{ type: 'server_tool_use', id: 's', name: 'web_fetch', input: {} }], usageIterations: iterations });
  assert.equal(measured.source, 'iterations');
  assert.ok((measured.tokens as number) / 1_000_000 < 0.3);
});

test('billing keeps the sum and adds a compaction pass the top-level fields leave out', () => {
  const usage = { input_tokens: 23_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  // No iterations: unchanged.
  assert.deepEqual(billableRoundUsage(usage, undefined), usage);
  // Message passes only: the top-level already sums them.
  assert.deepEqual(billableRoundUsage(usage, [pass(11_000, 0, 0, 500), pass(12_000, 0, 0, 500)]), usage);
  // A compaction pass is billed but excluded from the top-level fields.
  assert.deepEqual(
    billableRoundUsage(usage, [{ type: 'compaction', input_tokens: 180_000, output_tokens: 3_500 }, pass(23_000, 0, 0, 1_000)]),
    { input_tokens: 203_000, output_tokens: 4_500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  );
  assert.equal(billableRoundUsage(undefined, [{ type: 'compaction', input_tokens: 5, output_tokens: 1 }])?.input_tokens, 5);
});
