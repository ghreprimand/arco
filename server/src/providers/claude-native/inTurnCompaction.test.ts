// Claude Native in-turn auto-compaction: when one request of a long turn
// crosses the threshold, the worker compacts at the next clean boundary (tool
// results appended, next request not sent) and the same turn continues.
//
// Run: node --conditions development --import tsx --test src/providers/claude-native/inTurnCompaction.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeNativeWorker } from './worker.js';
import type { MessageParam } from './contentBlocks.js';
import { buildMessagesFromReplayEvents } from './resumeSummary.js';
import { splitSummaryParts, inTurnCompactedHistory, keptRequestText, keptRequestFits } from './workerHelpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type W = {
  on(event: string, fn: (...args: any[]) => void): unknown;
  runTurn(prompt: string): Promise<void>;
  cancel(): void;
  dispose(): Promise<void>;
  messages: MessageParam[];
  client: unknown;
  workflowEventBroadcast: (m: Record<string, unknown>) => void;
  ensureStarted(): Promise<void>;
  reconcileMcpSessions(): Promise<void>;
  hydrateContextManagementCapabilities(): Promise<void>;
  hooksLoaded: boolean;
};

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
const WINDOW = 1_000_000; // claude-opus-4-8

// One streamed assistant message; `prompt` is the request's prompt size.
// `passes` makes it a server-tool response: the API sampled that many times
// (web search, web fetch, code execution), the top-level usage is the SUM of
// the passes' prompts, and `usage.iterations` (when `withIterations`) lists
// each pass; `prompt` is then the last pass's prompt size.
type ServerPasses = { passes: number[]; withIterations: boolean };
function reply(blocks: Block[], prompt: number, model = 'claude-opus-4-8', server?: ServerPasses) {
  const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  const passes = server ? [...server.passes, prompt] : [prompt];
  const summed = passes.reduce((a, b) => a + b, 0);
  const iterations = server?.withIterations ? passes.map((p) => ({ type: 'message', input_tokens: p, output_tokens: 20 })) : undefined;
  const usage = (output: number) => ({ input_tokens: summed, output_tokens: output, ...(iterations ? { iterations } : {}) });
  return async function* (): AsyncGenerator<unknown> {
    yield { type: 'message_start', message: { model, usage: usage(1) } };
    let index = 0;
    if (server) {
      yield { type: 'content_block_start', index, content_block: { type: 'server_tool_use', id: 'srv-1', name: 'web_search', input: { query: 'x' } } };
      yield { type: 'content_block_stop', index };
      index++;
      yield { type: 'content_block_start', index, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv-1', content: [] } };
      yield { type: 'content_block_stop', index };
      index++;
    }
    for (const b of blocks) {
      if (b.type === 'text') {
        yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
        yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } };
      } else {
        yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } };
        yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } };
      }
      yield { type: 'content_block_stop', index };
      index++;
    }
    yield { type: 'message_delta', delta: { stop_reason: stop }, usage: usage(20) };
    yield { type: 'message_stop' };
  };
}
const searchTool = (id: string, lastPass: number, server: ServerPasses, text = `step ${id}`) =>
  reply([{ type: 'text', text }, { type: 'tool_use', id, name: 'Bash', input: { command: `echo ${id}` } }], lastPass, 'claude-opus-4-8', server);
const tool = (id: string, prompt: number, text = `step ${id}`, model?: string) => reply([{ type: 'text', text }, { type: 'tool_use', id, name: 'Bash', input: { command: `echo ${id}` } }], prompt, model);
const done = (prompt: number, model?: string) => reply([{ type: 'text', text: 'all done' }], prompt, model);
function summaryStream(text: string) {
  return async function* (): AsyncGenerator<unknown> {
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
  };
}

interface Setup {
  w: W; cwd: string; requests: MessageParam[][]; summaries: MessageParam[][];
  events: Array<Record<string, unknown>>; notices: string[]; errors: string[]; results: unknown[];
  done(): Promise<void>;
}

function setup(replies: Array<() => AsyncGenerator<unknown>>, opts: {
  config?: Record<string, unknown>;
  summary?: (messages: MessageParam[], w: W) => Promise<AsyncGenerator<unknown>>;
  countTokens?: number;
  steer?: () => Array<{ content: string }>;
} = {}): Setup {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'arco-in-turn-compact-')));
  const w = new ClaudeNativeWorker({
    workflowId: 'wf-in-turn-compact',
    config: { model: 'claude-opus-4-8', effort: 'high', cwd, skipPermissions: true, claudeNativeInTurnCompactPercent: 70, ...(opts.steer ? { drainSteer: opts.steer } : {}), ...opts.config },
  }) as unknown as W;
  const requests: MessageParam[][] = [];
  const summaries: MessageParam[][] = [];
  const client = {
    messages: {
      create: async (body: { system?: unknown; messages: MessageParam[] }) => {
        const system = JSON.stringify(body.system ?? '');
        if (system.includes('compacting the conversation')) {
          summaries.push(JSON.parse(JSON.stringify(body.messages)));
          return opts.summary ? opts.summary(body.messages, w) : summaryStream('Summary: the operator asked for a long task; steps a and b ran.')();
        }
        requests.push(JSON.parse(JSON.stringify(body.messages)));
        return replies[Math.min(requests.length - 1, replies.length - 1)]();
      },
      ...(opts.countTokens ? { countTokens: async () => ({ input_tokens: opts.countTokens }) } : {}),
    },
  };
  w.hooksLoaded = true;
  w.ensureStarted = async () => { w.client = client; };
  w.reconcileMcpSessions = async () => {};
  w.hydrateContextManagementCapabilities = async () => {};
  const events: Array<Record<string, unknown>> = [];
  w.workflowEventBroadcast = (m) => events.push(m);
  const notices: string[] = []; const errors: string[] = []; const results: unknown[] = [];
  w.on('system_notice', (n: string) => notices.push(n));
  w.on('error', (e: string) => errors.push(e));
  w.on('result', (r: unknown) => results.push(r));
  return { w, cwd, requests, summaries, events, notices, errors, results, done: async () => { await w.dispose(); rmSync(cwd, { recursive: true, force: true }); } };
}

// Every tool_use in a request has its tool_result in the following message.
function assertPairsIntact(messages: MessageParam[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const ids = (m.content as Array<{ type: string; id?: string }>).filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (ids.length === 0) continue;
    const next = messages[i + 1];
    assert.ok(next && next.role === 'user' && Array.isArray(next.content), `tool_use at ${i} is followed by a user message`);
    const results = (next.content as Array<{ type: string; tool_use_id?: string }>).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
    for (const id of ids) assert.ok(results.includes(id), `tool_use ${id} has its result`);
  }
  for (let i = 1; i < messages.length; i++) assert.notEqual(messages[i].role === 'assistant' && messages[i - 1].role === 'assistant', true, `no two assistant messages in a row at ${i}`);
}
const textOf = (m: MessageParam | undefined): string => {
  const c = m?.content;
  if (typeof c === 'string') return c;
  return (Array.isArray(c) ? c : []).map((b) => (b as { text?: string }).text ?? '').join('\n');
};

test('a request past the threshold compacts between requests and the same turn continues', async () => {
  const s = setup([tool('a', 300_000), tool('b', 720_000), tool('c', 150_000), done(160_000)], { countTokens: 120_000 });
  try {
    await s.w.runTurn('do the long task');
    assert.deepEqual(s.errors, []);
    assert.equal(s.results.length, 1, 'the turn completed');
    assert.equal(s.summaries.length, 1, 'one summary request');
    assert.equal(s.requests.length, 4, 'no request was repeated or dropped');
    // The summary saw the operator's instruction.
    assert.match(JSON.stringify(s.summaries[0]), /do the long task/);
    // The request after the compaction: seed, note, then the in-progress round raw.
    const after = s.requests[2];
    assert.match(textOf(after[0]), /Summary of the conversation so far/);
    assert.ok(after.some((m) => m.role === 'user' && textOf(m).includes('compacted automatically in the middle of this turn')), 'the automatic note is there');
    const lastAssistant = after[after.length - 2];
    assert.ok(JSON.stringify(lastAssistant.content).includes('"id":"b"'), 'the tool call that crossed the threshold is kept');
    assert.ok(JSON.stringify(after[after.length - 1].content).includes('"tool_use_id":"b"'), 'its result is kept');
    assertPairsIntact(after);
    assert.ok(!JSON.stringify(after).includes('"id":"a"'), 'older rounds are summarized');
    for (const r of s.requests) assertPairsIntact(r);
    // Visible: events with the reason, chat notices, CTX after.
    const compacting = s.events.find((e) => e.type === 'native_compacting');
    assert.equal(compacting?.trigger, 'auto-in-turn');
    assert.equal(compacting?.percent, 72);
    assert.equal(compacting?.thresholdPercent, 70);
    const compacted = s.events.find((e) => e.type === 'native_compacted');
    assert.equal(compacted?.inTurn, true);
    assert.equal(compacted?.promptTokensAfter, 120_000);
    assert.equal(compacted?.contextWindow, WINDOW);
    assert.ok(s.notices.includes('Compacting automatically (context 72%)'));
    assert.ok(s.notices.some((n) => n.startsWith('Compacted, continuing')));
  } finally { await s.done(); }
});

test('a compaction that leaves usage above the threshold warns once and does not loop', async () => {
  const s = setup([tool('a', 300_000), tool('b', 750_000), tool('c', 760_000), tool('d', 770_000), done(780_000)]);
  try {
    await s.w.runTurn('go');
    assert.deepEqual(s.errors, []);
    assert.equal(s.summaries.length, 1, 'no second compaction');
    assert.equal(s.notices.filter((n) => n.includes('still at')).length, 1, 'one warning');
    assert.equal(s.results.length, 1);
  } finally { await s.done(); }
});

test('a failed summary leaves the history unchanged, warns and the turn continues', async () => {
  const s = setup([tool('a', 300_000), tool('b', 750_000), done(760_000)], { summary: async () => { throw new Error('summary service down'); } });
  try {
    await s.w.runTurn('go');
    assert.deepEqual(s.errors, []);
    assert.equal(s.results.length, 1);
    assert.ok(s.notices.some((n) => /Automatic compaction in this turn failed: summary service down/.test(n)));
    assert.ok(!s.events.some((e) => e.type === 'native_compacted'));
    const last = s.requests[2];
    assert.equal(last[0].role, 'user');
    assert.equal(textOf(last[0]), 'go', 'history starts with the original prompt');
    assert.ok(JSON.stringify(last).includes('"id":"a"') && JSON.stringify(last).includes('"id":"b"'));
    assertPairsIntact(last);
  } finally { await s.done(); }
});

test('cancel during the summary ends the turn cleanly with history intact', async () => {
  const s = setup([tool('a', 300_000), tool('b', 750_000), done(100_000)], {
    summary: async (_m, w) => { w.cancel(); throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }); },
  });
  try {
    await s.w.runTurn('go');
    assert.deepEqual(s.errors, ['Worker killed']);
    assert.equal(s.results.length, 0);
    assert.equal(s.requests.length, 2, 'no request after the cancel');
    assert.ok(!s.events.some((e) => e.type === 'native_compacted'));
    assertPairsIntact(s.w.messages);
    assert.ok(JSON.stringify(s.w.messages).includes('"tool_use_id":"b"'));
  } finally { await s.done(); }
});

test('Off, or the Claude API compaction beta, means no in-turn compaction', async () => {
  for (const config of [{ claudeNativeInTurnCompactPercent: undefined }, { claudeNativeCompact: true }]) {
    const s = setup([tool('a', 300_000), tool('b', 900_000), done(950_000)], { config });
    try {
      await s.w.runTurn('go');
      assert.deepEqual(s.errors, []);
      assert.equal(s.summaries.length, 0, JSON.stringify(config));
      assert.equal(s.results.length, 1);
    } finally { await s.done(); }
  }
});

test('a steer queued during the compaction is delivered after the compacted history', async () => {
  let drains = 0;
  const s = setup([tool('a', 300_000), tool('b', 750_000), done(100_000)], {
    steer: () => (++drains === 2 ? [{ content: 'also update the README' }] : []),
  });
  try {
    await s.w.runTurn('go');
    assert.deepEqual(s.errors, []);
    const after = s.requests[2];
    assert.equal(textOf(after[after.length - 1]), 'also update the README');
    assertPairsIntact(after);
    assert.match(textOf(after[0]), /Summary of the conversation so far/);
  } finally { await s.done(); }
});

test('replay rebuilds the in-turn note so the rest of the turn pairs with it', () => {
  const note = 'Note from Arco: compacted automatically.';
  const messages = buildMessagesFromReplayEvents([
    { type: 'user_message_echo', content: 'do the long task' },
    { type: 'primary_text', text: 'step a' },
    { type: 'native_compacted', summary: 'S', inTurn: true, continueNote: note, keptTail: [{ role: 'user', content: 'do the long task' }, { role: 'assistant', content: [{ type: 'text', text: 'step a' }] }] },
    { type: 'primary_text', text: 'all done' },
    { type: 'primary_complete' },
    { type: 'user_message_echo', content: 'next' },
    { type: 'primary_text', text: 'ok' },
    { type: 'primary_complete' },
  ] as never);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.equal(messages[4].content, note);
  assert.equal(textOf(messages[5] as MessageParam), 'all done');
  // A tail that ends on the operator's message carries the note in it.
  const joined = buildMessagesFromReplayEvents([
    { type: 'native_compacted', summary: 'S', inTurn: true, continueNote: note, keptTail: [{ role: 'user', content: 'task' }] },
    { type: 'primary_text', text: 'done' },
    { type: 'primary_complete' },
  ] as never);
  assert.deepEqual(joined.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(joined[2].content, `task\n\n${note}`);
});

test('the compacted history keeps roles alternating whichever way the tail ends', () => {
  const round = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }] as MessageParam[];
  const seedEndsAssistant = [{ role: 'user', content: 'S' }, { role: 'assistant', content: [{ type: 'text', text: 'ack' }] }] as never;
  const a = inTurnCompactedHistory(seedEndsAssistant, 'NOTE', round);
  assert.deepEqual(a.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  const seedEndsUser = [{ role: 'user', content: 'S' }, { role: 'assistant', content: [{ type: 'text', text: 'ack' }] }, { role: 'user', content: 'task' }] as never;
  const b = inTurnCompactedHistory(seedEndsUser, 'NOTE', round);
  assert.deepEqual(b.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(b[2].content, 'task\n\nNOTE');
});

test('a prefix too large for one summary request is split into parts', () => {
  const big = 'x'.repeat(30_000); // ~10k estimated tokens each
  const msgs = Array.from({ length: 6 }, (_, i) => (i % 2 === 0 ? { role: 'user' as const, content: big } : { role: 'assistant' as const, content: [{ type: 'text' as const, text: big }] }));
  const parts = splitSummaryParts(msgs, 25_000);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.equal(p[0].role, 'user', 'parts break before user messages');
  assert.equal(parts.flat().length, 6);
  // One message larger than the budget (a long turn's narration) is cut into
  // consecutive slices; nothing is left out.
  const body = `HEAD${'y'.repeat(200_000)}TAIL`;
  const sliced = splitSummaryParts([{ role: 'user', content: 'task' }, { role: 'assistant', content: [{ type: 'text', text: body }] }], 10_000);
  assert.ok(sliced.length >= 7);
  assert.equal(sliced[0][0].content, 'task');
  const joined = sliced.slice(1).map((p) => (p[0].content as Array<{ text: string }>)[0].text.replace(/^\[part \d+ of \d+ of one long message\]\n/, '')).join('');
  assert.equal(joined, body);
  assert.equal(splitSummaryParts([{ role: 'user', content: 'small' }], 25_000).length, 1);
});

test('a summary request that would not fit the window is made in parts, oldest first', async () => {
  const long = 'n'.repeat(700_000); // ~233k estimated tokens of narration, over a 200k window
  const H = 'claude-haiku-4-5';
  const s = setup([tool('a', 30_000, `A ${long}`, H), tool('b', 60_000, 'B', H), tool('c', 150_000, 'C', H), done(20_000, H)]);
  try {
    await s.w.runTurn('go');
    assert.deepEqual(s.errors, []);
    assert.ok(s.summaries.length >= 2, `summarized in ${s.summaries.length} parts`);
    assert.match(textOf(s.summaries[1][0]), /^Summary of the earlier part of this conversation:/);
    for (const req of s.summaries) assert.equal(req[0].role, 'user');
    assert.equal(s.results.length, 1);
  } finally { await s.done(); }
});

test('a PreCompact hook that blocks skips the in-turn compaction and the turn continues', async () => {
  const s = setup([tool('a', 300_000), tool('b', 750_000), done(760_000)]);
  (s.w as unknown as { preCompactBlock: (t: string) => Promise<string | null> }).preCompactBlock = async (t) => (t === 'auto' ? '[hook]: keep everything' : null);
  try {
    await s.w.runTurn('go');
    assert.deepEqual(s.errors, []);
    assert.equal(s.summaries.length, 0);
    assert.ok(s.notices.some((n) => /PreCompact hook blocked the compaction/.test(n)));
    assert.equal(s.results.length, 1);
  } finally { await s.done(); }
});

test('B86: cancelling a finished response settles a stalled token count', async () => {
  const s = setup([done(321)], { config: { claudeNativeInTurnCompactPercent: undefined } });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: (value: { input_tokens: number }) => void;
  const count = new Promise<{ input_tokens: number }>((resolve) => { release = resolve; });
  const start = s.w.ensureStarted;
  s.w.ensureStarted = async () => {
    await start();
    (s.w.client as { messages: { countTokens: () => Promise<{ input_tokens: number }> } }).messages.countTokens = () => { entered(); return count; };
  };
  const turn = s.w.runTurn('A fixture response');
  try {
    await started;
    s.w.cancel();
    const settled = await Promise.race([turn.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200))]);
    assert.equal(settled, true, 'STOP must not wait for optional count_tokens telemetry');
  } finally {
    release({ input_tokens: 321 });
    await turn;
    await s.done();
  }
});

test('B86: token-count telemetry expires without STOP and preserves completion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup([done(321)], { config: { claudeNativeInTurnCompactPercent: undefined } });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: (value: { input_tokens: number }) => void;
  const count = new Promise<{ input_tokens: number }>(resolve => { release = resolve; });
  const start = s.w.ensureStarted;
  s.w.ensureStarted = async () => {
    await start();
    (s.w.client as { messages: { countTokens: () => Promise<{ input_tokens: number }> } }).messages.countTokens = () => { entered(); return count; };
  };
  const turn = s.w.runTurn('A fixture response');
  try {
    await started;
    t.mock.timers.tick(5_000);
    await turn;
    assert.equal(s.results.length, 1);
    assert.equal(s.errors.length, 0);
  } finally { release({ input_tokens: 321 }); await turn; await s.done(); }
});

test('replay keeps the live-preserved round narration exactly once', async () => {
  const fact='RETAINED_FACT: the fixture checksum is cobalt-47.';
  const s=setup([tool('a',300000,'older narration'),tool('b',750000,fact),done(100000)],{summary:async()=>summaryStream('Earlier task context.')()});
  const recorded:Array<Record<string,unknown>>=[{type:'user_message_echo',content:'Complete the interrupted fixture task',seq:1}];
  const broadcast=s.w.workflowEventBroadcast;
  s.w.workflowEventBroadcast=event=>{broadcast(event);recorded.push({...event,seq:recorded.length+1});};
  s.w.on('text',(text:string)=>recorded.push({type:'primary_text',text,seq:recorded.length+1}));
  s.w.on('result',()=>recorded.push({type:'primary_complete',seq:recorded.length+1}));
  try {
    await s.w.runTurn('Complete the interrupted fixture task');
    assert.deepEqual(s.errors,[]);
    const marker=recorded.find(event=>event.type==='native_compacted')!;
    const live=JSON.stringify(s.requests[2]);
    const replay=buildMessagesFromReplayEvents(recorded as never);
    assert.equal(live.split(fact).length-1,1,'live history retains the raw round once');
    assert.equal(JSON.stringify(replay).split(fact).length-1,1,'rebuilt history retains narration once');
    assert.equal(String(marker.summary).split(fact).length-1,1,'the persisted summary contains the round');
    assert.ok(!JSON.stringify(marker.keptTail??[]).includes(fact),'the round is not also in the kept tail');
    assert.match(JSON.stringify(replay),/Complete the interrupted fixture task/);
    assert.match(JSON.stringify(replay),/compacted automatically in the middle/);
    assert.match(JSON.stringify(replay),/all done/);
    assertPairsIntact(replay as MessageParam[]);
    const {summarizeClaudeNativePriorTurns}=await import('./resumeSummary.js');
    assert.match(summarizeClaudeNativePriorTurns(recorded as never).summary,/RETAINED_FACT/);
  } finally {await s.done();}
});

test('a preserved tool-only round adds no fabricated narration to the persisted summary',async()=>{
  const s=setup([tool('a',300000),tool('b',750000,''),done(100000)],{summary:async()=>summaryStream('Earlier task context.')()});
  try {
    await s.w.runTurn('Fixture task');
    assert.deepEqual(s.errors,[]);
    assert.equal(s.events.find(event=>event.type==='native_compacted')?.summary,'Earlier task context.');
  } finally {await s.done();}
});

// The context size a decision reads is the real prompt size, never the sum
// over a server-tool response's passes (the operator's rc.7 turn read 97%
// while the prompt was under 30%).
test('a server-tool round whose passes sum past the threshold does not compact when the last pass is small', async () => {
  // Three passes of 300k, 310k, 200k: the sum (810k) is 81% of the window, the last pass is 20%.
  const s = setup([tool('a', 100_000), searchTool('b', 200_000, { passes: [300_000, 310_000], withIterations: true }), done(210_000)]);
  try {
    await s.w.runTurn('research the question');
    assert.deepEqual(s.errors, []);
    assert.equal(s.summaries.length, 0, 'no compaction from the summed usage');
    assert.ok(!s.events.some((e) => e.type === 'native_compacting'));
    assert.equal(s.results.length, 1);
    const result = s.results[0] as { usage?: Record<string, number>; lastPromptTokens?: number };
    // Billing keeps the sum; the context figure is the last pass.
    assert.equal(result.usage?.input_tokens, 100_000 + 810_000 + 210_000);
    assert.equal(result.lastPromptTokens, 210_000);
  } finally { await s.done(); }
});

test('a server-tool round without usage.iterations falls back to the counted size and does not compact', async () => {
  const s = setup([tool('a', 100_000), searchTool('b', 200_000, { passes: [300_000, 310_000], withIterations: false }), done(210_000)], { countTokens: 205_000 });
  try {
    await s.w.runTurn('research the question');
    assert.deepEqual(s.errors, []);
    assert.equal(s.summaries.length, 0, 'the counted size (20%) decides, not the summed usage (81%)');
    assert.equal(s.results.length, 1);
  } finally { await s.done(); }
});

test('a server-tool round without usage.iterations and no token count skips the decision', async () => {
  const s = setup([tool('a', 100_000), searchTool('b', 200_000, { passes: [300_000, 310_000], withIterations: false }), done(210_000)]);
  try {
    await s.w.runTurn('research the question');
    assert.deepEqual(s.errors, []);
    assert.equal(s.summaries.length, 0, 'an unmeasured round never compacts');
    const result = s.results[0] as { lastPromptTokens?: number };
    assert.equal(result.lastPromptTokens, 210_000, 'the final single-pass round still reports its prompt size');
  } finally { await s.done(); }
});

test('a server-tool round whose last pass is genuinely past the threshold compacts', async () => {
  const s = setup([tool('a', 100_000), searchTool('b', 750_000, { passes: [100_000, 120_000], withIterations: true }), tool('c', 150_000), done(160_000)], { countTokens: 120_000 });
  try {
    await s.w.runTurn('research the question');
    assert.deepEqual(s.errors, []);
    assert.equal(s.summaries.length, 1);
    assert.equal(s.events.find((e) => e.type === 'native_compacting')?.percent, 75);
  } finally { await s.done(); }
});

test('the operator case: eleven server-tool passes of about 90k each on a 1M window never compact', async () => {
  const passes = Array.from({ length: 10 }, (_, i) => 88_000 + i * 1_000);
  const s = setup([tool('a', 80_000), searchTool('b', 98_000, { passes, withIterations: true }), tool('c', 101_000), done(102_000)]);
  try {
    await s.w.runTurn('research the question');
    assert.deepEqual(s.errors, []);
    assert.equal(s.summaries.length, 0);
    assert.ok(!s.notices.some((n) => n.startsWith('Compacting automatically')));
    const result = s.results[0] as { usage?: Record<string, number> };
    assert.ok((result.usage?.input_tokens ?? 0) > 1_000_000, 'USAGE totals still sum every pass');
  } finally { await s.done(); }
});

test('a final server-tool round without iterations and no count leaves the context figure out rather than inflating it', async () => {
  const s = setup([tool('a', 100_000), reply([{ type: 'text', text: 'all done' }], 200_000, 'claude-opus-4-8', { passes: [300_000, 310_000], withIterations: false })], { config: { claudeNativeInTurnCompactPercent: undefined } });
  try {
    await s.w.runTurn('research the question');
    assert.deepEqual(s.errors, []);
    const result = s.results[0] as { lastPromptTokens?: number };
    assert.equal(result.lastPromptTokens, undefined);
  } finally { await s.done(); }
});

// The request that started the turn survives an in-turn compaction word for
// word, even when the model wrote no text between its tool calls (so no
// narration carried it into the kept tail).
test('in-turn compaction keeps the request that started the turn verbatim', async () => {
  const request = 'ASSIGNMENT rc.8: fix the compaction trigger.\n\nRules: one commit, tests first, report to the Director.';
  const quiet = (id: string, prompt: number) => tool(id, prompt, '');
  const s = setup([quiet('a', 300_000), quiet('b', 400_000), quiet('c', 720_000), tool('d', 150_000), done(160_000)], {
    countTokens: 120_000,
    steer: (() => { let n = 0; return () => (++n === 1 ? [{ content: 'also note the board id' }] : []); })(),
    summary: async () => summaryStream('Summary: the operator gave an assignment; steps ran.')(),
  });
  try {
    await s.w.runTurn(request);
    assert.deepEqual(s.errors, []);
    assert.equal(s.summaries.length, 1);
    const after = s.requests[3];
    assert.match(textOf(after[0]), /Summary of the conversation so far/);
    const kept = after.find((m) => m.role === 'user' && textOf(m).includes(request));
    assert.ok(kept, 'the opening request is in the history sent next, word for word');
    assert.ok(textOf(kept).includes('compacted automatically in the middle of this turn'), 'the note rides with it');
    assert.equal(after.map(textOf).join('\n').split(request).length - 1, 1, 'kept once');
    assertPairsIntact(after);
    // Replay rebuilds the same request from the persisted marker.
    const marker = s.events.find((e) => e.type === 'native_compacted') as Record<string, unknown>;
    assert.equal(marker.keptRequest, request);
    const replay = buildMessagesFromReplayEvents([
      { type: 'user_message_echo', content: request },
      marker,
      { type: 'primary_text', text: 'all done' },
      { type: 'primary_complete' },
    ] as never);
    assert.equal((replay as MessageParam[]).map(textOf).join('\n').split(request).length - 1, 1, 'replay keeps it once');
    assertPairsIntact(replay as MessageParam[]);
  } finally { await s.done(); }
});

test('a kept request lists attachments as references', async () => {
  const quiet = (id: string, prompt: number) => tool(id, prompt, '');
  const s = setup([quiet('a', 300_000), quiet('b', 720_000), done(100_000)], {
    config: { attachments: ['notes.txt', 'shot.png'] },
    steer: (() => { let n = 0; return () => (++n === 1 ? [{ content: 'carry on' }] : []); })(),
    summary: async () => summaryStream('Summary.')(),
  });
  try {
    await s.w.runTurn('check the attached notes');
    assert.deepEqual(s.errors, []);
    const after = s.requests[2];
    const kept = after.find((m) => m.role === 'user' && textOf(m).includes('kept word for word'));
    assert.ok(kept, 'the request is kept');
    const text = textOf(kept);
    assert.ok(text.includes('check the attached notes'));
    assert.ok(text.includes('[attached file: notes.txt]') && text.includes('[attached file: shot.png]'), 'attachments as references');
    assertPairsIntact(after);
  } finally { await s.done(); }
  const whole = keptRequestText('short', ['a.txt']);
  assert.equal(whole.text, 'short\n\n[attached file: a.txt]');
  assert.equal(whole.prompt, 'short');
  assert.equal(whole.bytes, Buffer.byteLength(whole.text, 'utf8'));
  assert.equal(keptRequestFits({ prompt: 'x', text: 'x', bytes: 128_000 }), true);
  assert.equal(keptRequestFits({ prompt: 'x', text: 'x', bytes: 128_001 }), false);
  assert.equal(keptRequestFits(null), true);
});

test('a request larger than the kept-request cap defers the in-turn compaction with one notice, never a cut', async () => {
  const long = `BEGIN ${'L'.repeat(130_000)} END`;
  const s = setup([tool('a', 300_000), tool('b', 720_000), tool('c', 730_000), done(100_000)]);
  try {
    await s.w.runTurn(long);
    assert.deepEqual(s.errors, []);
    assert.equal(s.summaries.length, 0, 'no compaction while the opening request cannot be kept whole');
    assert.ok(!s.events.some((e) => e.type === 'native_compacting'));
    const deferrals = s.notices.filter((n) => n.includes('larger than the 125 KB Arco keeps word for word'));
    assert.equal(deferrals.length, 1, 'said once per crossing');
    assert.equal(s.results.length, 1);
    const last = s.requests[3];
    assert.equal(textOf(last[0]), long, 'the request is in the history untouched');
  } finally { await s.done(); }
});

test('an in-turn compaction with no narration still keeps the request once when the tail already has it', async () => {
  const s = setup([tool('a', 300_000), tool('b', 720_000), tool('c', 150_000), done(160_000)], { countTokens: 120_000 });
  try {
    await s.w.runTurn('do the long task');
    assert.deepEqual(s.errors, []);
    const after = s.requests[2];
    assert.equal(after.filter((m) => m.role === 'user' && textOf(m).includes('do the long task')).length, 1, 'the tail copy is not doubled');
    assertPairsIntact(after);
  } finally { await s.done(); }
});
