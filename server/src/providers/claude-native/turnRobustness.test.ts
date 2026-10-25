// Regression guards for the 2026-09-25 Native turn-robustness pass:
//   1. a 3rd consecutive 429/529/500 must END the turn with an error — the
//      old 'retry' on the last attempt made streamOneRound return null
//      without emitting, leaving the tab busy forever;
//   2. message_delta.usage is cumulative per message (overwrite, not sum);
//      only rounds are summed, numbers only;
//   3. a mid-stream overload retry retracts the partial attempt's text;
//   4. cancel() during startup (ensureStarted / MCP reconcile) stops the turn
//      before any request is made;
//   5. model_context_window_exceeded stops the tool loop like max_tokens;
//   6. images: magic-byte media type, 5 MB base64 cap, scrub repair;
//   7/8. hooks: chat tabs get none; untrusted repos get user-level only.
//
// Run: node --conditions development --import tsx --test src/providers/claude-native/turnRobustness.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeNativeWorker } from './worker.js';
import { mergeUsage, applyUsageDelta } from './workerHelpers.js';
import {
  shouldContinueNativeToolLoop,
  buildUserMessageContent,
  sniffImageMediaType,
  repairImageBlock,
  MAX_IMAGE_BASE64_BYTES,
  MAX_IMAGE_RAW_BYTES,
  type SkippedImage,
  type MessageParam,
  type AnyContentBlock,
} from './contentBlocks.js';
import { discoverHooks } from './hooks.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Internals = {
  on(event: string, fn: (...args: any[]) => void): unknown;
  cancel(): void;
  runTurn(prompt: string): Promise<void>;
  messages: MessageParam[];
  client: unknown;
  handleApiError(err: unknown, attempt: number): Promise<'retry' | 'fatal'>;
  streamOneRound(): Promise<null | { text: string }>;
  ensureStarted(): Promise<void>;
  reconcileMcpSessions(): Promise<void>;
  hydrateContextManagementCapabilities(): Promise<void>;
  scrubEmptyTextContent(): { droppedImageBlocks: number; replacedOversizedImages: number; retypedImages: number };
};

// Structural view of the private internals (an intersection with the class
// collapses to never because `client` is private there).
function makeWorker(): Internals {
  return new ClaudeNativeWorker({
    workflowId: 'wf-test-turn-robustness',
    config: { model: 'claude-opus-4-8', effort: 'high' },
  }) as unknown as Internals;
}

function capture(w: Internals, event: string): unknown[] {
  const out: unknown[] = [];
  w.on(event, (x: unknown) => out.push(x));
  return out;
}

// retry-after: 0 keeps the backoff ladder instant in tests.
function overloaded(): Error {
  return Object.assign(new Error('Overloaded'), { status: 529, type: 'overloaded_error', headers: { 'retry-after': '0' } });
}

// ── 1. rate-limit ladder ─────────────────────────────────────────────────────

test('rate limit on the last attempt is fatal AND emits an error (no silent hang)', async () => {
  const w = makeWorker();
  const errors = capture(w, 'error');
  assert.equal(await w.handleApiError(overloaded(), 0), 'retry');
  assert.equal(errors.length, 0);
  assert.equal(await w.handleApiError(overloaded(), 2), 'fatal');
  assert.equal(errors.length, 1, 'turn-ending error emitted');
});

// ── 2. usage accounting ──────────────────────────────────────────────────────

test('message_delta usage overwrites message_start (cumulative), keeps omitted keys', () => {
  const start = { input_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200, output_tokens: 1 };
  const delta = { input_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200, output_tokens: 750, server_tool_use: { web_search_requests: 2 } };
  assert.deepEqual(applyUsageDelta(start, delta), { input_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200, output_tokens: 750 });
  // A delta carrying only output_tokens (older API shape) or nulls keeps the start counts.
  assert.deepEqual(applyUsageDelta(start, { output_tokens: 42, input_tokens: null } as Record<string, unknown>), { ...start, output_tokens: 42 });
});

test('mergeUsage sums numbers across rounds and never string-concatenates nested objects', () => {
  const a = { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 }, service_tier: 'standard' } as unknown as Record<string, number>;
  const b = { input_tokens: 20, output_tokens: 7, server_tool_use: { web_search_requests: 1 } } as unknown as Record<string, number>;
  assert.deepEqual(mergeUsage(mergeUsage(undefined, a), b), { input_tokens: 30, output_tokens: 12 });
});

// ── 3 + 1 end-to-end through streamOneRound with a fake client ───────────────

async function* partialThenThrow(): AsyncGenerator<unknown> {
  yield { type: 'message_start', message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 1 } } };
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello par' } };
  throw overloaded();
}

async function* full(): AsyncGenerator<unknown> {
  yield { type: 'message_start', message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 1 } } };
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello world' } };
  yield { type: 'content_block_stop', index: 0 };
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 30 } };
  yield { type: 'message_stop' };
}

function fakeClient(streams: Array<() => AsyncGenerator<unknown>>): { calls: number } & Record<string, unknown> {
  const state = { calls: 0 } as { calls: number } & Record<string, unknown>;
  state.messages = {
    create: async () => {
      const s = streams[Math.min(state.calls, streams.length - 1)];
      state.calls++;
      return s();
    },
  };
  return state;
}

test('mid-stream overload retry retracts the partial attempt text (text_discard)', async () => {
  const w = makeWorker();
  w.hydrateContextManagementCapabilities = async () => {};
  const fc = fakeClient([partialThenThrow, full]);
  w.client = fc;
  w.messages = [{ role: 'user', content: 'hi' }];
  let output = '';
  w.on('text', (t: string) => { output += t; });
  w.on('text_discard', (n: number) => { output = output.slice(0, output.length - n); });
  const round = await w.streamOneRound();
  assert.equal(fc.calls, 2);
  assert.equal(round?.text, 'Hello world');
  assert.equal(output, 'Hello world', 'partial "Hello par" was retracted, not duplicated');
  assert.deepEqual((round as { usage?: Record<string, number> }).usage, { input_tokens: 10, output_tokens: 30 });
});

test('three consecutive overloads end the round with an emitted error', async () => {
  const w = makeWorker();
  w.hydrateContextManagementCapabilities = async () => {};
  const fc = fakeClient([partialThenThrow]);
  w.client = fc;
  w.messages = [{ role: 'user', content: 'hi' }];
  const errors = capture(w, 'error');
  assert.equal(await w.streamOneRound(), null);
  assert.equal(fc.calls, 3);
  assert.equal(errors.length, 1);
});

// ── 4. cancel during startup ─────────────────────────────────────────────────

test('cancel() during ensureStarted stops the turn before any request', async () => {
  const w = makeWorker();
  const fc = fakeClient([full]);
  w.ensureStarted = async () => { w.client = fc; w.cancel(); };
  w.reconcileMcpSessions = async () => {};
  const errors = capture(w, 'error');
  const results = capture(w, 'result');
  await w.runTurn('do things');
  assert.equal(fc.calls, 0, 'no messages.create after cancel');
  assert.deepEqual(errors, ['Worker killed']);
  assert.equal(results.length, 0);
});

test('cancel() between turns does not poison the next turn', async () => {
  const w = makeWorker();
  w.cancel();
  const fc = fakeClient([full]);
  w.ensureStarted = async () => { w.client = fc; };
  w.reconcileMcpSessions = async () => {};
  w.hydrateContextManagementCapabilities = async () => {};
  const errors = capture(w, 'error');
  // End-of-turn countTokens is best-effort; the fake client lacks it → falls back.
  await w.runTurn('hello');
  assert.equal(fc.calls, 1);
  assert.deepEqual(errors, []);
});

// ── 5. context-window stop ───────────────────────────────────────────────────

test('model_context_window_exceeded stops the tool loop even with a tool_use', () => {
  assert.equal(shouldContinueNativeToolLoop([{ type: 'tool_use' }], 'model_context_window_exceeded'), false);
  assert.equal(shouldContinueNativeToolLoop([{ type: 'tool_use' }], 'tool_use'), true);
});

// ── 6. image guard ───────────────────────────────────────────────────────────

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946000101', 'hex');

test('sniffImageMediaType recognizes PNG / JPEG / GIF / WEBP and rejects junk', () => {
  assert.equal(sniffImageMediaType(PNG), 'image/png');
  assert.equal(sniffImageMediaType(JPEG), 'image/jpeg');
  assert.equal(sniffImageMediaType(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(sniffImageMediaType(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1')), 'image/webp');
  assert.equal(sniffImageMediaType(Buffer.from('hello world')), null);
});

test('buildUserMessageContent: real type from bytes, oversized + unrecognized fold to text refs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-img-guard-'));
  try {
    const mislabeled = join(dir, 'shot.png');
    writeFileSync(mislabeled, JPEG);
    const big = join(dir, 'big.png');
    writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_RAW_BYTES + 1)]));
    const junk = join(dir, 'junk.webp');
    writeFileSync(junk, 'not an image');
    const skipped: SkippedImage[] = [];
    const content = buildUserMessageContent('look', [mislabeled, big, junk], skipped) as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(content));
    const images = content.filter((b) => b.type === 'image') as Array<{ source: { media_type: string } }>;
    assert.equal(images.length, 1);
    assert.equal(images[0].source.media_type, 'image/jpeg', 'sniffed, not the .png extension');
    const text = content.find((b) => b.type === 'text') as { text: string };
    assert.ok(text.text.includes(`[attached file: ${big}]`));
    assert.ok(text.text.includes(`[attached file: ${junk}]`));
    assert.deepEqual(skipped.map((s) => s.reason).sort(), ['oversized', 'unrecognized']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repairImageBlock: oversized → replace, mistyped → retyped, unknown payload → keep', () => {
  const huge = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(MAX_IMAGE_BASE64_BYTES + 4) } };
  assert.equal(repairImageBlock(huge).action, 'replace');
  const mistyped = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: JPEG.toString('base64') } };
  assert.equal(repairImageBlock(mistyped).action, 'retyped');
  assert.equal(mistyped.source.media_type, 'image/jpeg');
  const unknown = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } };
  assert.equal(repairImageBlock(unknown).action, 'keep');
});

test('scrub replaces an already-persisted oversized image (live worker self-heals)', () => {
  const w = makeWorker();
  w.messages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(MAX_IMAGE_BASE64_BYTES + 4) } } as AnyContentBlock,
      { type: 'text', text: 'see this' },
    ],
  }];
  const res = w.scrubEmptyTextContent();
  assert.equal(res.replacedOversizedImages, 1);
  const content = w.messages[0].content as Array<{ type: string; text?: string }>;
  assert.equal(content.length, 2);
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text ?? '', /image omitted by Arco/);
});

// ── 7/8. hook discovery gating ───────────────────────────────────────────────

function hookFile(dir: string, cmd: string): void {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd }] }] },
  }));
}

test('discoverHooks: untrusted repo loads user-level only; $HOME file read once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arco-hooks-'));
  try {
    const home = join(root, 'home');
    const repo = join(home, 'repo');
    hookFile(home, 'user-hook');
    hookFile(repo, 'repo-hook');
    const trusted = await discoverHooks(repo, { homeDir: home });
    assert.deepEqual(trusted.byEvent.UserPromptSubmit?.map((s) => s.hooks[0].command), ['repo-hook', 'user-hook'], 'user hook not duplicated');
    const untrusted = await discoverHooks(repo, { homeDir: home, includeProject: false });
    assert.deepEqual(untrusted.byEvent.UserPromptSubmit?.map((s) => s.hooks[0].command), ['user-hook']);
    assert.deepEqual(untrusted.suppressedProjectFiles, [join(repo, '.claude', 'settings.json')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('chat-mode worker discovers no hooks at all', async () => {
  const w = new ClaudeNativeWorker({
    workflowId: 'wf-test-chat-hooks',
    config: { model: 'claude-opus-4-8', effort: 'high', interactionMode: 'chat', cwd: tmpdir() },
  }) as unknown as { discoverTrustedHooks(): Promise<{ byEvent: Record<string, unknown> }> };
  assert.deepEqual((await w.discoverTrustedHooks()).byEvent, {});
});
