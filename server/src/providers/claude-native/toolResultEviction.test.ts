// Unit tests for §2.2 — tool-result eviction (pure substrate).
//
// Contracts:
//  • summarizeToolResultLine produces an informative, single-line, marked
//    digest — never a bare deletion (the "without clear_tool_uses' regression"
//    requirement). Tool-aware naming where it helps recall.
//  • planTurnSpill is the per-turn AGGREGATE spill: under budget ⇒ nothing;
//    over budget ⇒ largest-first until retained is back under budget; never
//    spills a result whose 1-liner wouldn't actually shrink it.
//  • planTailEviction keeps a token-budget tail verbatim and spills older
//    results (the cross-turn mechanism §2.1 Fold reuses).
//
// Run: node --import tsx --test src/providers/claude-native/toolResultEviction.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeToolResultLine,
  planTurnSpill,
  planTailEviction,
  estimateResultTokens,
  type EvictableResult,
} from './toolResultEviction.js';

const big = (n: number): string => 'x'.repeat(n);

function r(id: string, toolName: string, content: string, inputJson?: string, isError?: boolean): EvictableResult {
  return { toolUseId: id, toolName, content, inputJson, isError };
}

test('summary: never bare — always single line with the evicted marker', () => {
  const s = summarizeToolResultLine('Bash', JSON.stringify({ command: 'npm test' }), big(5000));
  assert.match(s, /Arco evicted/);
  assert.ok(!s.includes('\n'), 'summary is a single line');
  assert.match(s, /npm test/);
});

test('summary: Bash carries command + ok/error + line count', () => {
  const ok = summarizeToolResultLine('Bash', JSON.stringify({ command: 'ls -la' }), 'a\nb\nc\n');
  assert.match(ok, /\[Bash\] ls -la → ok/);
  assert.match(ok, /3 lines/);
  const err = summarizeToolResultLine('Bash', JSON.stringify({ command: 'false' }), 'boom', true);
  assert.match(err, /→ error/);
  assert.match(err, /was error/);
});

test('summary: Read/Grep name their target', () => {
  assert.match(summarizeToolResultLine('Read', JSON.stringify({ file_path: 'src/a.ts' }), big(100)), /\[Read\] src\/a\.ts/);
  assert.match(summarizeToolResultLine('Grep', JSON.stringify({ pattern: 'TODO' }), 'm1\nm2'), /\[Grep\] TODO/);
});

test('summary: unknown tool + missing input degrades gracefully', () => {
  const s = summarizeToolResultLine('', undefined, big(40));
  assert.match(s, /\[Tool\]/);
  assert.match(s, /B|KB/); // byte metric when no lines
});

test('planTurnSpill: under budget ⇒ no spill', () => {
  const plan = planTurnSpill([r('1', 'Read', big(400))], 100_000);
  assert.equal(plan.spill.length, 0);
  assert.equal(plan.savedTokens, 0);
});

test('planTurnSpill: over budget ⇒ spills largest first until under', () => {
  const items = [
    r('small', 'Read', big(4_000)),     // ~1000 tok
    r('huge', 'Bash', big(400_000), JSON.stringify({ command: 'big' })), // ~100k tok
    r('mid', 'Read', big(40_000)),      // ~10k tok
  ];
  // Budget below huge alone ⇒ huge must be spilled; small+mid may survive.
  const plan = planTurnSpill(items, 20_000);
  assert.ok(plan.spill.some((d) => d.toolUseId === 'huge'), 'huge spilled');
  // Largest-first: huge is the first spilled.
  assert.equal(plan.spill[0].toolUseId, 'huge');
  assert.ok(plan.keptTokens <= 20_000 || plan.spill.length === items.filter((i) => estimateResultTokens(i.content) > 0).length,
    'retained back under budget (or everything spillable spilled)');
});

test('planTurnSpill: tiny results never spilled (no benefit)', () => {
  // Many tiny results whose 1-liner is as big as the content — spilling saves
  // nothing, so even "over budget" leaves them alone.
  const items = Array.from({ length: 50 }, (_, i) => r(`t${i}`, 'Read', 'ok'));
  const plan = planTurnSpill(items, 1);
  assert.equal(plan.spill.length, 0, 'no tiny result spilled');
});

test('planTurnSpill: budget 0 ⇒ no spill (disabled)', () => {
  const plan = planTurnSpill([r('1', 'Bash', big(400_000))], 0);
  assert.equal(plan.spill.length, 0);
});

test('planTailEviction: keeps the recent tail verbatim, spills older', () => {
  // oldest → newest. Each ~10k tokens.
  const items = [
    r('old1', 'Read', big(40_000)),
    r('old2', 'Read', big(40_000)),
    r('recent1', 'Read', big(40_000)),
    r('recent2', 'Read', big(40_000)),
  ];
  // Tail budget fits ~2 recent results.
  const plan = planTailEviction(items, 21_000);
  const spilled = new Set(plan.spill.map((d) => d.toolUseId));
  assert.ok(spilled.has('old1') && spilled.has('old2'), 'old results spilled');
  assert.ok(!spilled.has('recent1') && !spilled.has('recent2'), 'recent tail kept verbatim');
});

test('planTailEviction: everything fits the tail ⇒ no spill', () => {
  const items = [r('a', 'Read', big(4_000)), r('b', 'Read', big(4_000))];
  const plan = planTailEviction(items, 1_000_000);
  assert.equal(plan.spill.length, 0);
});

test('savedTokens accounting is consistent (original = kept + saved)', () => {
  const items = [
    r('huge', 'Bash', big(400_000), JSON.stringify({ command: 'x' })),
    r('mid', 'Read', big(40_000)),
  ];
  const plan = planTurnSpill(items, 5_000);
  assert.equal(plan.keptTokens, plan.originalTokens - plan.savedTokens);
});
