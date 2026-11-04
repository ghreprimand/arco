// Unit tests for the orphan-tool-use wedge recovery (2026-06-24).
//
// Regression guard for a Native-transport wedge: an aborted/interrupted turn
// could leave an assistant message ending in a server_tool_use (web_search /
// web_fetch) with no matching *_tool_result in the same message. Anthropic
// then 400s EVERY later request ("web_search tool use ... was found without a
// corresponding web_search_tool_result block"), and the old pruneOrphanToolUse
// only looked for client `tool_use`, so the orphan was never dropped and the
// long-lived worker stayed wedged until it replayed from disk.
//
// Two layers of coverage:
//   1. the pure detector `orphanToolUseIds` (reports unpaired client + server
//      ids; keeps a well-formed paired server-tool turn);
//   2. the worker methods that USE it — `pruneOrphanToolUse` (top-of-turn
//      recovery, Fix 1) and `scrubServerToolEvidenceOnAbort` (early-return
//      scrub, Fix 2) — driven against a synthetic wedged history. The Native
//      worker constructor is inert (no network / no spawn), so this is
//      deterministic and spends zero quota — unlike the live
//      `smoke:web-search-tool-loop`, which can't hit the interrupt window
//      reliably.
//
// Run with: node --import tsx --test src/providers/claude-native/orphanToolUse.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orphanToolUseIds, ClaudeNativeWorker } from './worker.js';
import { fullListOrphanToolUseIds } from './contentBlocks.js';
import type { MessageParam, AnyContentBlock } from './contentBlocks.js';

// The two recovery methods + the messages array are private; reach them
// structurally for the test (runtime is untyped, tsc stays happy via the cast).
type TestableWorker = {
  messages: MessageParam[];
  pruneOrphanToolUse(): { droppedAssistantMessages: number; droppedIds: string[] };
  scrubServerToolEvidenceOnAbort(turnMessageStart: number): void;
};

function makeWorker(messages: MessageParam[]): TestableWorker {
  const w = new ClaudeNativeWorker({
    workflowId: 'wf-test-orphan',
    config: { model: 'claude-opus-4-8', effort: 'high' },
  }) as unknown as TestableWorker;
  w.messages = messages;
  return w;
}

const ORPHAN_ASSISTANT: AnyContentBlock[] = [
  { type: 'text', text: 'Let me confirm the download URL is live.' },
  { type: 'server_tool_use', id: 'srvtoolu_01K1A5', name: 'web_search', input: {} },
];

const PAIRED_ASSISTANT: AnyContentBlock[] = [
  { type: 'server_tool_use', id: 'srvtoolu_01K1A5', name: 'web_search', input: {} },
  { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_01K1A5', content: [] },
  { type: 'text', text: 'The URL is live.' },
];

function hasServerToolUse(messages: MessageParam[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => (b as { type?: string }).type === 'server_tool_use'),
  );
}

test('unpaired server_tool_use (the wedge): id reported as orphan', () => {
  const content = [
    { type: 'text', text: 'Let me confirm the download URL.' },
    { type: 'server_tool_use', id: 'srvtoolu_01ABC', name: 'web_search', input: {} },
  ];
  assert.deepEqual(orphanToolUseIds(content), ['srvtoolu_01ABC']);
});

test('paired server_tool_use + result: NOT an orphan (must be kept)', () => {
  const content = [
    { type: 'server_tool_use', id: 'srvtoolu_01ABC', name: 'web_search', input: {} },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_01ABC', content: [] },
    { type: 'text', text: 'Here is what I found.' },
  ];
  assert.deepEqual(orphanToolUseIds(content), []);
});

test('trailing client tool_use: reported (result would live in a later user msg)', () => {
  const content = [
    { type: 'text', text: 'Reading the file.' },
    { type: 'tool_use', id: 't1', name: 'Read', input: {} },
  ];
  assert.deepEqual(orphanToolUseIds(content), ['t1']);
});

test('mixed: unpaired client tool_use + unpaired server tool, both reported', () => {
  const content = [
    { type: 'tool_use', id: 't1', name: 'Read', input: {} },
    { type: 'server_tool_use', id: 'srvtoolu_02', name: 'web_fetch', input: {} },
  ];
  assert.deepEqual(orphanToolUseIds(content), ['t1', 'srvtoolu_02']);
});

test('paired server tool alongside an unpaired client tool: only the client id', () => {
  const content = [
    { type: 'server_tool_use', id: 'srvtoolu_03', name: 'web_search', input: {} },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_03', content: [] },
    { type: 'tool_use', id: 't9', name: 'Bash', input: {} },
  ];
  assert.deepEqual(orphanToolUseIds(content), ['t9']);
});

test('plain text answer (completed turn): no orphans', () => {
  const content = [{ type: 'text', text: 'Done.' }];
  assert.deepEqual(orphanToolUseIds(content), []);
});

// ── Fix 1: pruneOrphanToolUse (top-of-turn recovery) drops the wedge ──

test('pruneOrphanToolUse: pops a trailing assistant with an orphan server_tool_use', () => {
  const w = makeWorker([
    { role: 'user', content: 'update the nvidia driver' },
    { role: 'assistant', content: ORPHAN_ASSISTANT },
  ]);
  const res = w.pruneOrphanToolUse();
  assert.equal(res.droppedAssistantMessages, 1);
  assert.deepEqual(res.droppedIds, ['srvtoolu_01K1A5']);
  assert.equal(w.messages.length, 1, 'only the operator user message remains');
  assert.equal(w.messages[0].role, 'user');
});

test('pruneOrphanToolUse: KEEPS a trailing assistant whose server tool is paired', () => {
  const w = makeWorker([
    { role: 'user', content: 'is the URL live?' },
    { role: 'assistant', content: PAIRED_ASSISTANT },
  ]);
  const res = w.pruneOrphanToolUse();
  assert.equal(res.droppedAssistantMessages, 0, 'a completed server-tool turn must not be dropped');
  assert.equal(w.messages.length, 2);
});

// ── Fix 2: scrubServerToolEvidenceOnAbort (early-return paths) clears it ──

test('scrubServerToolEvidenceOnAbort: strips the orphan so re-validation cannot 400', () => {
  const w = makeWorker([
    { role: 'user', content: 'update the nvidia driver' },
    { role: 'assistant', content: ORPHAN_ASSISTANT },
  ]);
  assert.ok(hasServerToolUse(w.messages), 'precondition: the orphan is present');
  w.scrubServerToolEvidenceOnAbort(0);
  assert.ok(!hasServerToolUse(w.messages), 'no server_tool_use block survives the abort scrub');
  // The assistant message stays (text preserved + a retained-history note), so
  // the turn boundary is intact — only the unpairable tool block is gone.
  assert.equal(w.messages.length, 2);
});

// ── §2.1 delta 1: fullListOrphanToolUseIds (mid-list, not just trailing) ──

test('fullList: well-formed paired client tool_use across messages → no orphans', () => {
  const messages = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ];
  assert.deepEqual(fullListOrphanToolUseIds(messages), []);
});

test('fullList: MID-LIST orphan (the splice/25bffd1 class) is caught — trailing-only pruner would miss it', () => {
  // A history splice cut between the tool_use and its result: the FOLLOWING
  // message is a plain user turn, not the tool_result. The orphan is mid-list,
  // so pruneOrphanToolUse (trailing-only) never sees it.
  const messages = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    { role: 'user', content: 'next operator turn (the tool_result was spliced away)' },
    { role: 'assistant', content: [{ type: 'text', text: 'huh' }] },
  ];
  assert.deepEqual(fullListOrphanToolUseIds(messages), ['t1']);
});

test('fullList: in-message server_tool_use orphan caught anywhere in the list', () => {
  const messages = [
    { role: 'user', content: 'search' },
    { role: 'assistant', content: [{ type: 'server_tool_use', id: 'srv1' }] }, // no *_tool_result
    { role: 'user', content: 'and then' },
  ];
  assert.deepEqual(fullListOrphanToolUseIds(messages), ['srv1']);
});

test('fullList: tool_use answered by tool_result in the next message, mid-list → clean', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'ok' }] },
  ];
  assert.deepEqual(fullListOrphanToolUseIds(messages), []);
});

test('fullList: clean reseed shape (text-only user/assistant) has no orphans', () => {
  // This is exactly the compactSummarySeed shape the Fold produces.
  const messages = [
    { role: 'user', content: 'Summary of the conversation so far: …' },
    { role: 'assistant', content: [{ type: 'text', text: "Understood. I'll continue." }] },
    { role: 'user', content: 'recent ask' },
    { role: 'assistant', content: [{ type: 'text', text: 'recent reply' }] },
  ];
  assert.deepEqual(fullListOrphanToolUseIds(messages), []);
});
