// Server Fold (on-demand compaction, `compact-2026-09-04`) — request shape,
// cut selection, stream parsing, fallback classification, live/replay seed
// identity, and the worker's swap + fallback wiring.
//
// Run with: node --conditions development --import tsx --test src/providers/claude-native/serverFold.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVER_FOLD_BETA,
  activeToolKeysAfterServerFold,
  buildServerFoldRequest,
  chooseServerFoldCut,
  classifyServerFoldError,
  compactionUsageFrom,
  consumeServerFoldStream,
  demoteLeadingServerFoldBlock,
  hasLeadingServerFoldBlock,
  historyHasThresholdCompactionBlock,
  serverFoldSeed,
  supportsServerFold,
  type ServerCompactionBlock,
} from './serverFold.js';
import { buildMessagesFromReplayEvents, compactSummarySeed } from './resumeSummary.js';
import type { MessageParam } from './contentBlocks.js';
import { ClaudeNativeWorker } from './worker.js';

const BLOCK: ServerCompactionBlock = { type: 'compaction', content: 'Summary: user builds a recipe app.', signature: 'EuYBsig' };

// Two finished operator turns, the second with a tool round-trip + thinking.
function history(): MessageParam[] {
  return [
    { role: 'user', content: 'name the entities' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's1' }, { type: 'text', text: 'Recipe, Step.' }] },
    { role: 'user', content: 'read schema.ts' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's2' }, { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'schema.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export type Recipe = {}' }] } as unknown as MessageParam,
    { role: 'assistant', content: [{ type: 'text', text: 'It defines Recipe.' }] },
    { role: 'user', content: 'add Ingredient' },
    { role: 'assistant', content: [{ type: 'text', text: 'Added.' }] },
  ];
}

async function* events(list: unknown[]): AsyncIterable<unknown> {
  for (const e of list) yield e;
}

const OK_STREAM = [
  { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 0, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { ...BLOCK } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'compaction' }, usage: { input_tokens: 0, output_tokens: 0, iterations: [{ type: 'compaction', input_tokens: 132, output_tokens: 416, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 }] } },
  { type: 'message_stop' },
];

test('model gate covers the documented list and rejects Haiku', () => {
  assert.ok(supportsServerFold('claude-opus-5-5'));
  assert.ok(supportsServerFold('claude-fable-5-1'));
  assert.ok(supportsServerFold('claude-opus-4-8[1m]'));
  assert.ok(supportsServerFold('claude-sonnet-5'));
  assert.ok(!supportsServerFold('claude-haiku-4-5'));
  assert.ok(!supportsServerFold('claude-sonnet-4-5'));
});

test('cut keeps the last N operator turns, never splits a tool pair, and starts on a user turn', () => {
  const h = history();
  const two = chooseServerFoldCut(h, 2);
  assert.deepEqual(two && { cut: two.cut, keptTurns: two.keptTurns }, { cut: 2, keptTurns: 2 });
  const one = chooseServerFoldCut(h, 1);
  assert.equal(one?.cut, 6);
  // index 4 (tool_result user message) is never a cut point
  for (let k = 1; k <= 5; k++) assert.notEqual(chooseServerFoldCut(h, k)?.cut, 4);
});

test('cut shrinks the kept tail under the byte cap, down to summarizing everything', () => {
  const h = history();
  const tiny = chooseServerFoldCut(h, 2, 10);
  assert.deepEqual(tiny, { cut: h.length, keptTurns: 0, tailBytes: 0 });
  assert.equal(chooseServerFoldCut([], 2), null);
  // A lone existing block has nothing new to summarize.
  assert.equal(chooseServerFoldCut(serverFoldSeed(BLOCK), 2), null);
  // Compact again: block + new turns → the block is summarized along with them.
  const again = [...serverFoldSeed(BLOCK), { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
  assert.equal(chooseServerFoldCut(again, 1)?.cut, again.length);
});

test('request carries compaction + same system/tools/thinking and drops the fields the API rejects', () => {
  const body = buildServerFoldRequest({
    model: 'claude-opus-5-5',
    system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    tools: [{ name: 'Read', input_schema: {} }],
    thinkingParams: {
      thinking: { type: 'adaptive', display: 'omitted' },
      output_config: { effort: 'high', format: { type: 'json_schema' }, task_budget: { type: 'tokens', total: 1, remaining: 1 } },
      context_management: { edits: [{ type: 'compact_20260112' }] },
      tool_choice: { type: 'any' },
      stop_sequences: ['x'],
    },
    messages: [{ role: 'user', content: 'x' }, { role: 'system', content: [{ type: 'text', text: 'd' }], arco: 'system_delta' }],
  });
  assert.deepEqual(body.compaction, { type: 'summarize' });
  assert.equal(body.stream, true);
  assert.equal((body.system as Array<{ text: string }>)[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.equal((body.tools as unknown[]).length, 1);
  assert.deepEqual(body.output_config, { effort: 'high', task_budget: { type: 'tokens', total: 1 } });
  assert.ok(!('context_management' in body) && !('tool_choice' in body) && !('stop_sequences' in body));
  // Arco-private marker stripped for the wire.
  assert.ok(!('arco' in ((body.messages as unknown[])[1] as object)));
});

test('stream parse returns the block verbatim and bills from usage.iterations', async () => {
  const r = await consumeServerFoldStream(events(OK_STREAM));
  assert.equal(r.stopReason, 'compaction');
  assert.deepEqual(r.block, BLOCK);
  assert.deepEqual(r.usage, { input: 132, output: 416, cacheRead: 9000, cacheCreate: 0 });
  // Absent iterations → top-level fallback.
  assert.deepEqual(compactionUsageFrom({ input_tokens: 5, output_tokens: 7 }), { input: 5, output: 7, cacheRead: 0, cacheCreate: 0 });
});

test('missing summary (non-compaction stop) yields no block', async () => {
  const r = await consumeServerFoldStream(events([
    { type: 'message_start', message: { usage: {} } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { iterations: [{ type: 'compaction', input_tokens: 10, output_tokens: 20 }] } },
  ]));
  assert.equal(r.block, null);
  assert.equal(r.stopReason, 'max_tokens');
  assert.equal(r.usage.output, 20);
});

test('error classification: 4xx naming the feature is unsupported; 429/5xx/other are failed', () => {
  const e = (status: number, message: string) => Object.assign(new Error(message), { status });
  assert.equal(classifyServerFoldError(e(400, 'compaction: Extra inputs are not permitted')).kind, 'unsupported');
  assert.equal(classifyServerFoldError(e(400, `the compaction parameter requires anthropic-beta: ${SERVER_FOLD_BETA}`)).kind, 'unsupported');
  assert.equal(classifyServerFoldError(e(403, 'beta compact-2026-09-04 not enabled for this organization')).kind, 'unsupported');
  assert.equal(classifyServerFoldError(e(429, 'compaction rate limited')).kind, 'failed');
  assert.equal(classifyServerFoldError(e(529, 'overloaded compaction_unavailable')).kind, 'failed');
  assert.equal(classifyServerFoldError(e(400, 'messages: tool_use ids without tool_result')).kind, 'failed');
  assert.equal(classifyServerFoldError(new Error('ECONNRESET')).kind, 'failed');
});

test('block position separates on-demand from threshold compaction', () => {
  const lead = serverFoldSeed(BLOCK, [{ role: 'user', content: 'q' }]);
  assert.ok(hasLeadingServerFoldBlock(lead));
  assert.ok(!historyHasThresholdCompactionBlock(lead));
  const threshold = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'compaction', content: 's' }] }];
  assert.ok(!hasLeadingServerFoldBlock(threshold));
  assert.ok(historyHasThresholdCompactionBlock(threshold));
});

test('live seed and replay reseed are byte-identical (raw kept turns included)', () => {
  const h = history();
  const kept = h.slice(2);
  const live = serverFoldSeed(BLOCK, kept);
  const replayed = buildMessagesFromReplayEvents([
    { type: 'user_message_echo', content: 'old', seq: 1 },
    { type: 'primary_text', text: 'old reply', seq: 2 },
    { type: 'primary_complete', seq: 3 },
    { type: 'context_folded', summary: BLOCK.content, compactionBlock: BLOCK, keptMessages: kept, seq: 4 },
  ] as never);
  assert.equal(JSON.stringify(replayed), JSON.stringify(live));
  // Seed is a deep copy: mutating it can't reach the persisted event payload.
  (live[1] as { content: unknown }).content = 'mutated';
  assert.equal(kept[0].content, 'read schema.ts');
});

test('later turns replay on top of the server-fold seed', () => {
  const replayed = buildMessagesFromReplayEvents([
    { type: 'context_folded', summary: BLOCK.content, compactionBlock: BLOCK, seq: 1 },
    { type: 'user_message_echo', content: 'next', seq: 2 },
    { type: 'primary_text', text: 'ok', seq: 3 },
    { type: 'primary_complete', seq: 4 },
  ] as never);
  assert.equal(replayed.length, 3);
  assert.ok(hasLeadingServerFoldBlock(replayed));
});

test('COMPACT/Fold demote a leading block to plain summary text', () => {
  const msgs = serverFoldSeed(BLOCK, [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]);
  assert.ok(demoteLeadingServerFoldBlock(msgs, (t) => compactSummarySeed(t) as MessageParam[]));
  assert.ok(!hasLeadingServerFoldBlock(msgs));
  assert.equal(msgs[0].role, 'user');
  assert.match(String(msgs[0].content), /Summary: user builds a recipe app\./);
  assert.equal(msgs.length, 4);
  assert.equal(demoteLeadingServerFoldBlock(msgs, (t) => compactSummarySeed(t) as MessageParam[]), false);
});

test('tool changes: summarized additions drop out, kept ones survive', () => {
  const frozen = [{ name: 'Read' }, { name: 'Bash' }, { name: 'WebFetch', defer_loading: true }];
  assert.deepEqual([...activeToolKeysAfterServerFold(frozen, [])].sort(), ['Bash', 'Read']);
  const kept = [{ role: 'system', arco: 'tool_set_change', content: [
    { type: 'tool_addition', tool: { type: 'tool_reference', name: 'WebFetch' } },
    { type: 'tool_removal', tool: { type: 'tool_reference', name: 'Bash' } },
  ] }];
  assert.deepEqual([...activeToolKeysAfterServerFold(frozen, kept)].sort(), ['Read', 'WebFetch']);
});

// ── worker wiring (no network: probe seam + fake client) ──

type FakeCall = { body: Record<string, unknown>; headers: Record<string, string> };
type TestWorker = {
  messages: MessageParam[];
  client: unknown;
  serverFoldInPlace(): Promise<{ ok: boolean; fallback?: string; usage?: unknown; keptTurns?: number; error?: string }>;
  buildBetaHeader(): string;
  setWorkflowEventBroadcast(fn: (m: Record<string, unknown>) => void): void;
  __debugSeedForCompactProbe(m: MessageParam[]): void;
};

function makeWorker(respond: (call: FakeCall) => unknown): { w: TestWorker; calls: FakeCall[]; events: Array<Record<string, unknown>> } {
  process.env.ARCO_TEST = '1';
  const w = new ClaudeNativeWorker({
    workflowId: 'wf-test-server-fold',
    config: { model: 'claude-opus-5-5', effort: 'high' },
  } as never) as unknown as TestWorker;
  w.__debugSeedForCompactProbe(history());
  const calls: FakeCall[] = [];
  w.client = {
    messages: {
      create: async (body: Record<string, unknown>, opts: { headers: Record<string, string> }) => {
        const call = { body, headers: opts.headers };
        calls.push(call);
        return respond(call);
      },
    },
  };
  const evs: Array<Record<string, unknown>> = [];
  w.setWorkflowEventBroadcast((m) => evs.push(m));
  return { w, calls, events: evs };
}

test('worker: success swaps in block + verbatim tail, persists the marker, and keeps the beta on', async () => {
  const { w, calls, events: evs } = makeWorker(() => events(OK_STREAM));
  const before = history();
  const res = await w.serverFoldInPlace();
  assert.equal(res.ok, true);
  assert.equal(res.keptTurns, 2);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].headers['anthropic-beta'].split(',').includes(SERVER_FOLD_BETA));
  assert.deepEqual(calls[0].body.compaction, { type: 'summarize' });
  assert.equal((calls[0].body.messages as unknown[]).length, 2, 'only the older turn is summarized');
  // Live history = block first, then the kept turns unchanged (thinking kept).
  assert.equal(JSON.stringify(w.messages), JSON.stringify(serverFoldSeed(BLOCK, before.slice(2))));
  const marker = evs.find((e) => e.type === 'context_folded');
  assert.ok(marker);
  assert.equal(marker.engine, 'server');
  assert.deepEqual(marker.compactionUsage, { input: 132, output: 416, cacheRead: 9000, cacheCreate: 0 });
  assert.ok(typeof marker.originalBytes === 'number' && typeof marker.foldedBytes === 'number');
  // Replay from the persisted marker lands on the same messages.
  const replayed = buildMessagesFromReplayEvents([{ ...marker, seq: 1 }] as never);
  assert.equal(JSON.stringify(replayed), JSON.stringify(w.messages));
  // Every later request carries the block → the beta must ride along.
  assert.ok(w.buildBetaHeader().split(',').includes(SERVER_FOLD_BETA));
  assert.ok(!w.buildBetaHeader().includes('compact-2026-01-12'));
});

test('worker: a 400 naming the parameter returns an unsupported fallback and leaves history untouched', async () => {
  const { w } = makeWorker(() => { throw Object.assign(new Error('compaction: Extra inputs are not permitted'), { status: 400 }); });
  const res = await w.serverFoldInPlace();
  assert.equal(res.ok, false);
  assert.equal(res.fallback, 'unsupported');
  assert.equal(JSON.stringify(w.messages), JSON.stringify(history()));
});

test('worker: missing summary is a billed failure that still falls back', async () => {
  const { w } = makeWorker(() => events([
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { iterations: [{ type: 'compaction', input_tokens: 50, output_tokens: 5 }] } },
  ]));
  const res = await w.serverFoldInPlace();
  assert.equal(res.ok, false);
  assert.equal(res.fallback, 'failed');
  assert.deepEqual(res.usage, { input: 50, output: 5, cacheRead: 0, cacheCreate: 0 });
  assert.equal(JSON.stringify(w.messages), JSON.stringify(history()));
});
