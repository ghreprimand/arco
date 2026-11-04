// Server-side compaction (`compact_20260112`) block capture + pass-back.
//
// Regression guard (2026-09-25): the stream parser had no branch for
// `content_block_start {type:'compaction'}` / `compaction_delta`, so the
// summary was dropped, every later request resent the full history, and the
// server re-compacted every round. The API contract: the compaction block must
// come back verbatim in the assistant message; content before it is ignored.
//
// Run with: node --conditions development --import tsx --test src/providers/claude-native/serverCompaction.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeNativeWorker } from './worker.js';
import { toWireMessages } from './appendOnlyPrefix.js';
import {
  historyHasCompactionBlock,
  shouldSendCompactBeta,
  summarizeCompactionIterations,
  stripTrailingThinkingFromContent,
  type AnyContentBlock,
  type MessageParam,
} from './contentBlocks.js';

type Round = { stopReason: string | null; text: string; contentBlocks: AnyContentBlock[] };
type TestableWorker = {
  messages: MessageParam[];
  on(event: string, fn: (arg: string) => void): unknown;
  consumeStream(stream: AsyncIterable<unknown>): Promise<Round>;
  buildBetaHeader(): string;
};

function makeWorker(claudeNativeCompact = false): TestableWorker {
  return new ClaudeNativeWorker({
    workflowId: 'wf-test-server-compaction',
    config: { model: 'claude-opus-4-8', effort: 'high', claudeNativeCompact },
  } as never) as unknown as TestableWorker;
}

async function* events(list: unknown[]): AsyncIterable<unknown> {
  for (const e of list) yield e;
}

const SUMMARY = 'Summary of the conversation: the user is building a web scraper...';

const COMPACTING_STREAM = [
  { type: 'message_start', message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'compaction' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content: SUMMARY } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'sig' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Here is the rate limiter.' } },
  { type: 'content_block_stop', index: 2 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: {
      input_tokens: 23000,
      output_tokens: 1000,
      iterations: [
        { type: 'compaction', input_tokens: 180000, output_tokens: 3500 },
        { type: 'message', input_tokens: 23000, output_tokens: 1000 },
      ],
    },
  },
  { type: 'message_stop' },
];

test('compaction block is captured in stream order with its full content', async () => {
  const w = makeWorker(true);
  const round = await w.consumeStream(events(COMPACTING_STREAM));
  assert.deepEqual(round.contentBlocks.map((b) => b.type), ['compaction', 'thinking', 'text']);
  assert.deepEqual(round.contentBlocks[0], { type: 'compaction', content: SUMMARY });
  assert.equal(round.stopReason, 'end_turn');
});

test('the summary never reaches the transcript as assistant text; one notice names the token counts', async () => {
  const w = makeWorker(true);
  const texts: string[] = [];
  const notices: string[] = [];
  w.on('text', (t: string) => texts.push(t));
  w.on('system_notice', (n: string) => notices.push(n));
  const round = await w.consumeStream(events(COMPACTING_STREAM));
  assert.equal(round.text, 'Here is the rate limiter.');
  assert.deepEqual(texts, ['Here is the rate limiter.']);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /180,000 earlier tokens/);
  assert.ok(!notices[0].includes(SUMMARY), 'notice must not carry the raw summary');
});

test('no compaction block ⇒ no notice', async () => {
  const w = makeWorker(true);
  const notices: string[] = [];
  w.on('system_notice', (n: string) => notices.push(n));
  await w.consumeStream(events([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ]));
  assert.equal(notices.length, 0);
});

test('captured block is passed back verbatim on the next request (wire projection keeps it)', async () => {
  const w = makeWorker(true);
  const round = await w.consumeStream(events(COMPACTING_STREAM));
  w.messages = [
    { role: 'user', content: 'build a scraper' },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    { role: 'user', content: 'add rate limiting' },
    { role: 'assistant', content: round.contentBlocks },
    { role: 'user', content: 'now error handling' },
  ];
  const wire = toWireMessages(w.messages) as MessageParam[];
  const assistant = wire[3].content as AnyContentBlock[];
  assert.deepEqual(assistant[0], { type: 'compaction', content: SUMMARY });
  // Prior turns stay in place (append-only); the API ignores content before the block.
  assert.equal(wire.length, 5);
});

test('compact beta stays on while history holds a compaction block, even with the toggle off', async () => {
  const on = makeWorker(true);
  const round = await on.consumeStream(events(COMPACTING_STREAM));
  const off = makeWorker(false);
  assert.ok(!off.buildBetaHeader().includes('compact-2026-01-12'));
  off.messages = [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: round.contentBlocks },
  ];
  assert.ok(off.buildBetaHeader().includes('compact-2026-01-12'));
});

test('pure helpers', () => {
  assert.equal(historyHasCompactionBlock([{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }]), false);
  assert.equal(historyHasCompactionBlock([{ role: 'assistant', content: [{ type: 'compaction', content: 's' }] }]), true);
  assert.equal(shouldSendCompactBeta(null, false, true), true);
  assert.equal(shouldSendCompactBeta({ supportsClearThinking: false, supportsClearToolUses: false, supportsCompact: true }, true), true);
  assert.equal(shouldSendCompactBeta({ supportsClearThinking: false, supportsClearToolUses: false, supportsCompact: true }, false), false);
  assert.deepEqual(summarizeCompactionIterations([{ type: 'message', input_tokens: 5 }]), null);
  assert.deepEqual(summarizeCompactionIterations(undefined), null);
  // A compaction-only assistant message is not a trailing-thinking case.
  const r = stripTrailingThinkingFromContent([{ type: 'compaction' }]);
  assert.equal(r.stripped, 0);
});
