// Unit tests for the empty-image poisoning fixes (2026-08-07).
//
// Regression guard for a Native-transport wedge: a 0-byte upload (an empty
// laptop paste that /upload accepted) read fine in buildImageBlock and encoded
// to `source.data: ''`. Anthropic 400s that ("image cannot be empty"), and
// because the message was pushed into the long-lived messages[] BEFORE the
// request, EVERY later turn failed at the same index until a worker respawn.
//
// Three layers of coverage:
//   1. buildUserMessageContent skips a 0-byte image file and falls back to the
//      `[attached file: ...]` text reference (buildImageBlock guard);
//   2. the pre-request scrubber drops an already-poisoned empty image block so
//      a live worker self-heals without a restart;
//   3. non-empty images and nested tool_result images survive the scrub.
//
// Run with: node --import tsx --test src/providers/claude-native/emptyImageScrub.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeNativeWorker } from './worker.js';
import { buildUserMessageContent } from './contentBlocks.js';
import type { MessageParam, AnyContentBlock } from './contentBlocks.js';

// The scrubber + messages array are private; reach them structurally for the
// test (runtime is untyped, tsc stays happy via the cast).
type TestableWorker = {
  messages: MessageParam[];
  scrubEmptyTextContent(): { droppedTextBlocks: number; droppedImageBlocks: number; patchedEmptyMessages: number; patchedToolResults: number };
};

function makeWorker(messages: MessageParam[]): TestableWorker {
  const w = new ClaudeNativeWorker({
    workflowId: 'wf-test-empty-image',
    config: { model: 'claude-opus-4-8', effort: 'high' },
  }) as unknown as TestableWorker;
  w.messages = messages;
  return w;
}

const EMPTY_IMAGE: AnyContentBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: '' },
} as AnyContentBlock;

const REAL_IMAGE: AnyContentBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
} as AnyContentBlock;

// ── Fix: buildImageBlock rejects 0-byte files (via buildUserMessageContent) ──

test('0-byte image attachment falls back to a text reference, not an empty image block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-empty-img-'));
  try {
    const p = join(dir, 'empty-image.png');
    writeFileSync(p, '');
    const content = buildUserMessageContent('do you see this?', [p]);
    assert.equal(typeof content, 'string', 'no image block → simple text shape');
    assert.ok((content as string).includes(`[attached file: ${p}]`), 'path preserved as a text ref');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-empty image attachment still becomes an image block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-real-img-'));
  try {
    const p = join(dir, 'real-image.png');
    writeFileSync(p, Buffer.from('89504e47', 'hex'));
    const content = buildUserMessageContent('see this', [p]);
    assert.ok(Array.isArray(content), 'image attachment → content[] shape');
    const blocks = content as Array<{ type?: string; source?: { data?: string } }>;
    assert.equal(blocks[0]?.type, 'image');
    assert.ok((blocks[0]?.source?.data ?? '').length > 0, 'base64 data is non-empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Fix: the pre-request scrubber drops an already-poisoned empty image ──

test('scrub drops an empty image block, keeps the sibling text (live worker self-heals)', () => {
  const w = makeWorker([
    { role: 'user', content: [EMPTY_IMAGE, { type: 'text', text: 'first image is from my laptop' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'looking…' }] },
  ]);
  const res = w.scrubEmptyTextContent();
  assert.equal(res.droppedImageBlocks, 1);
  const content = w.messages[0].content as AnyContentBlock[];
  assert.equal(content.length, 1, 'only the text block survives');
  assert.equal((content[0] as { type?: string }).type, 'text');
});

test('scrub of an image-ONLY empty message patches it to the omitted-message placeholder', () => {
  const w = makeWorker([{ role: 'user', content: [EMPTY_IMAGE] }]);
  const res = w.scrubEmptyTextContent();
  assert.equal(res.droppedImageBlocks, 1);
  assert.equal(res.patchedEmptyMessages, 1);
  assert.equal(w.messages[0].content, '[empty message omitted by Arco]');
});

test('scrub KEEPS a non-empty image block', () => {
  const w = makeWorker([
    { role: 'user', content: [REAL_IMAGE, { type: 'text', text: 'see this' }] },
  ]);
  const res = w.scrubEmptyTextContent();
  assert.equal(res.droppedImageBlocks, 0);
  assert.equal((w.messages[0].content as AnyContentBlock[]).length, 2);
});

test('scrub drops an empty image nested in a tool_result content array', () => {
  const w = makeWorker([
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [EMPTY_IMAGE, { type: 'text', text: 'read the file' }],
        } as unknown as AnyContentBlock,
      ],
    },
  ]);
  const res = w.scrubEmptyTextContent();
  assert.equal(res.droppedImageBlocks, 1);
  const tr = (w.messages[0].content as Array<{ content?: unknown }>)[0];
  assert.ok(Array.isArray(tr.content) && tr.content.length === 1, 'only the text sub-block survives');
});

test('scrub of a tool_result whose ONLY content was an empty image patches to (no output)', () => {
  const w = makeWorker([
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: [EMPTY_IMAGE] } as unknown as AnyContentBlock,
      ],
    },
  ]);
  const res = w.scrubEmptyTextContent();
  assert.equal(res.droppedImageBlocks, 1);
  assert.equal(res.patchedToolResults, 1);
  const tr = (w.messages[0].content as Array<{ content?: unknown }>)[0];
  assert.equal(tr.content, '(no output)');
});
