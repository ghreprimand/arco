// Unit tests for H8 — the aggregate `@`-ref budget gate.
//
// The per-ref 64 KB cap already bounds one ref; H8 adds the AGGREGATE ceiling so
// stacked pastes can't bury the operator's instruction. Contracts:
//  • under budget → all refs expand, no budget notices;
//  • crossing the soft-warn fraction → a one-time [budget] warning, still expands;
//  • a ref that would cross the hard-refuse fraction is REFUSED (not expanded),
//    and so is every ref after it;
//  • the estimate helper is deterministic.
//
// Run: node --import tsx --test src/contextRefs.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  expandContextRefs,
  estimateRefTokens,
  CONTEXT_REF_HARD_REFUSE_FRACTION,
} from './contextRefs.js';

async function tmpProject(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'arco-refs-'));
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(join(dir, name), body, 'utf8');
  }
  return dir;
}

test('a project reached through a symlinked path still expands its files', async () => {
  // macOS tmpdir() is /var/..., a symlink to /private/var/...; any project
  // folder opened through a symlink has the same shape.
  const real = await tmpProject({ 'a.txt': 'hello' });
  const link = `${real}-link`;
  await fs.symlink(real, link, 'dir');
  const r = await expandContextRefs(link, 'see @file:a.txt', { windowSize: 200_000 });
  assert.equal(r.expandedCount, 1);
  assert.ok(!r.notices.some((n) => n.includes('refused')), 'nothing refused');
});

test('a symlink inside the project that points outside it is still refused', async () => {
  const outside = await tmpProject({ 'secret.txt': 'outside' });
  const dir = await tmpProject({});
  await fs.symlink(join(outside, 'secret.txt'), join(dir, 'leak.txt'));
  const r = await expandContextRefs(dir, '@file:leak.txt', { windowSize: 200_000 });
  assert.equal(r.expandedCount, 0);
  assert.ok(r.notices.some((n) => n.includes('symlink escapes')), 'refused as a symlink escape');
});

test('estimateRefTokens: bytes/4, deterministic', () => {
  assert.equal(estimateRefTokens('a'.repeat(400)), 100);
  assert.equal(estimateRefTokens('x'), estimateRefTokens('x'));
});

test('under budget: all refs expand, no budget notices', async () => {
  const dir = await tmpProject({ 'a.txt': 'hello', 'b.txt': 'world' });
  const r = await expandContextRefs(dir, 'see @file:a.txt and @file:b.txt', { windowSize: 200_000 });
  assert.equal(r.expandedCount, 2);
  assert.ok(!r.notices.some((n) => n.includes('refused')), 'nothing refused');
  assert.ok(!r.notices.some((n) => n.includes('[budget]')), 'no soft warn');
});

test('hard-refuse: a ref that would cross the ceiling is refused + not in the block', async () => {
  // window 1000 → hard ceiling 500 tokens ≈ 2000 bytes. Two ~1500-byte files:
  // first fits, second would push over → refused.
  const big = 'x'.repeat(1500);
  const dir = await tmpProject({ 'one.txt': big, 'two.txt': big });
  const r = await expandContextRefs(dir, '@file:one.txt @file:two.txt', { windowSize: 1000 });
  assert.equal(r.expandedCount, 1, 'only the first expanded');
  assert.ok(r.notices.some((n) => n.includes('two.txt') && n.includes('refused')), 'second refused with a clear notice');
  assert.ok(!r.block.includes('two.txt') || r.block.split('two.txt').length === 1, 'refused content not in block');
});

test('once over the ceiling, every later ref is refused too', async () => {
  const big = 'y'.repeat(1500);
  const dir = await tmpProject({ 'a.txt': big, 'b.txt': big, 'c.txt': big });
  const r = await expandContextRefs(dir, '@file:a.txt @file:b.txt @file:c.txt', { windowSize: 1000 });
  assert.equal(r.expandedCount, 1);
  const refused = r.notices.filter((n) => n.includes('refused —')).length;
  assert.equal(refused, 2, 'b and c both refused');
});

test('soft-warn fires once when crossing ~25% but still expands', async () => {
  // window 2000 → soft warn 500 tok (2000 B), hard 1000 tok (4000 B).
  // One ~2200-byte file crosses soft-warn but not hard-refuse.
  const dir = await tmpProject({ 'm.txt': 'z'.repeat(2200) });
  const r = await expandContextRefs(dir, '@file:m.txt', { windowSize: 2000 });
  assert.equal(r.expandedCount, 1, 'still expanded');
  assert.ok(r.notices.some((n) => n.includes('[budget]')), 'soft-warn emitted');
});

test('hard-refuse fraction is the documented 50%', () => {
  assert.equal(CONTEXT_REF_HARD_REFUSE_FRACTION, 0.5);
});

test('no refs: empty expansion, no gate', async () => {
  const dir = await tmpProject({});
  const r = await expandContextRefs(dir, 'plain message, no refs', { windowSize: 1000 });
  assert.equal(r.expandedCount, 0);
  assert.equal(r.notices.length, 0);
});
