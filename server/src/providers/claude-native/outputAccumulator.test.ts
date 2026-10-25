// Unit tests for DD2 — the bounded-tail output accumulator.
//
// Contracts:
//  • small output passes through verbatim, no spill, not truncated;
//  • large output keeps a bounded TAIL (most-recent bytes) and spills the
//    COMPLETE stream (from byte 0) to the injected sink;
//  • a multibyte char split across chunk boundaries decodes cleanly (no
//    mojibake / no stray replacement char) — the whole reason for the rewrite;
//  • line cap trims to the last N lines;
//  • truncatedBy reports the dominant reason.
//
// Run: node --import tsx --test src/providers/claude-native/outputAccumulator.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutputAccumulator, type SpillSink } from './outputAccumulator.js';

function memSink(): SpillSink & { buf: () => Buffer } {
  const chunks: Buffer[] = [];
  return {
    path: '/tmp/fake-spill.txt',
    write: (b: Buffer) => { chunks.push(Buffer.from(b)); },
    buf: () => Buffer.concat(chunks),
  };
}

test('small output: verbatim, no spill, not truncated', () => {
  const acc = new OutputAccumulator({ tailByteBudget: 1024, maxLines: 100, spillThresholdBytes: 1024 });
  acc.push(Buffer.from('hello\nworld\n'));
  const r = acc.result();
  assert.equal(r.text, 'hello\nworld\n');
  assert.equal(r.truncated, false);
  assert.equal(r.truncatedBy, null);
  assert.equal(r.spillPath, undefined);
  assert.equal(r.totalLines, 2);
});

test('large output: bounded tail + complete spill from byte 0', () => {
  const sink = memSink();
  const acc = new OutputAccumulator({ tailByteBudget: 100, maxLines: 10_000, spillThresholdBytes: 100, openSpill: () => sink });
  const full = Buffer.from('A'.repeat(500) + 'TAILMARKER');
  // Feed in several chunks.
  for (let i = 0; i < full.length; i += 64) acc.push(full.subarray(i, i + 64));
  const r = acc.result();
  assert.equal(r.truncated, true);
  assert.equal(r.truncatedBy, 'bytes');
  assert.ok(r.text.length <= 100, `tail bounded: ${r.text.length}`);
  assert.ok(r.text.endsWith('TAILMARKER'), 'tail holds the most-recent bytes');
  assert.equal(r.totalBytes, full.length);
  // Spill is the COMPLETE output, byte-identical from byte 0.
  assert.equal(sink.buf().length, full.length);
  assert.equal(sink.buf().toString('utf8'), full.toString('utf8'));
  assert.equal(r.spillPath, '/tmp/fake-spill.txt');
});

test('no spill sink: large output still bounded, no spillPath', () => {
  const acc = new OutputAccumulator({ tailByteBudget: 50, maxLines: 10_000, spillThresholdBytes: 50 });
  acc.push(Buffer.from('B'.repeat(300)));
  const r = acc.result();
  assert.equal(r.truncated, true);
  assert.equal(r.spillPath, undefined);
  assert.ok(r.text.length <= 50);
});

test('multibyte char split across chunk boundary decodes cleanly', () => {
  // "café" repeated; é is 2 bytes (0xC3 0xA9). Split mid-é to stress the decoder.
  const s = 'café '.repeat(40);
  const full = Buffer.from(s, 'utf8');
  const acc = new OutputAccumulator({ tailByteBudget: 1_000_000, maxLines: 10_000, spillThresholdBytes: 1_000_000 });
  // Push 5 bytes at a time so é straddles boundaries.
  for (let i = 0; i < full.length; i += 5) acc.push(full.subarray(i, i + 5));
  const r = acc.result();
  assert.equal(r.text, s, 'no mojibake from a split multibyte char');
  assert.ok(!r.text.includes('�'), 'no replacement char');
});

test('tail trim does not leave a leading partial multibyte char', () => {
  // Fill with multibyte content, tiny tail budget, so the front is cut inside a char.
  const s = 'αβγδε'.repeat(50); // each Greek letter is 2 bytes
  const acc = new OutputAccumulator({ tailByteBudget: 11, maxLines: 10_000, spillThresholdBytes: 1_000_000 });
  acc.push(Buffer.from(s, 'utf8'));
  const r = acc.result();
  assert.ok(!r.text.startsWith('�'), 'no leading replacement char from a mid-char cut');
  assert.ok(r.truncated);
});

test('line cap trims to the last N lines', () => {
  const acc = new OutputAccumulator({ tailByteBudget: 1_000_000, maxLines: 3, spillThresholdBytes: 1_000_000 });
  acc.push(Buffer.from('l1\nl2\nl3\nl4\nl5\nl6'));
  const r = acc.result();
  const lines = r.text.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[lines.length - 1], 'l6');
  assert.equal(r.truncatedBy, 'lines');
  assert.equal(r.totalLines, 5); // 5 newline chars
});

test('exactly at budget: not truncated', () => {
  const acc = new OutputAccumulator({ tailByteBudget: 10, maxLines: 100, spillThresholdBytes: 10 });
  acc.push(Buffer.from('0123456789')); // exactly 10 bytes
  const r = acc.result();
  assert.equal(r.truncated, false);
  assert.equal(r.text, '0123456789');
});
