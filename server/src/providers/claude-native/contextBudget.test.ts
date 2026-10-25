// Unit tests for §2.3 — the token-budget meter's pure arithmetic.
//
// The load-bearing contract: pct is computed against the EFFECTIVE window
// (window − reservedOutput), not the raw window, so it reads higher than a
// raw-window percent for the same prompt size — that gap is the whole point
// (reserved output tokens aren't usable for input). Plus: clamping, junk-input
// safety, and the warn/auto/fold threshold-crossing logic.
//
// Run with: node --import tsx --test src/providers/claude-native/contextBudget.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeContextBudget, crossedThresholds } from './contextBudget.js';

test('effective window = window − reservedOutput', () => {
  const b = computeContextBudget(500_000, 1_000_000, 64_000);
  assert.equal(b.windowSize, 1_000_000);
  assert.equal(b.reservedOutput, 64_000);
  assert.equal(b.effectiveWindow, 936_000);
});

test('pct is against the effective window and reads higher than raw', () => {
  const used = 842_400; // 90% of 936,000
  const b = computeContextBudget(used, 1_000_000, 64_000);
  assert.equal(b.pct, 90);
  // The raw-window percent for the same prompt would be lower — the meter's
  // whole reason to exist.
  const rawPct = Math.round((used / 1_000_000) * 100);
  assert.ok(b.pct > rawPct, `effective ${b.pct}% should exceed raw ${rawPct}%`);
});

test('pct clamps to 100 when the prompt overflows the effective window', () => {
  const b = computeContextBudget(2_000_000, 1_000_000, 64_000);
  assert.equal(b.pct, 100);
});

test('zero / junk used → 0 pct, never NaN', () => {
  assert.equal(computeContextBudget(0, 1_000_000, 64_000).pct, 0);
  assert.equal(computeContextBudget(Number.NaN, 1_000_000, 64_000).pct, 0);
  assert.equal(computeContextBudget(-5, 1_000_000, 64_000).pct, 0);
});

test('zero / junk window → 0 pct, effectiveWindow floored at 1, never divide-by-zero', () => {
  const b = computeContextBudget(100, 0, 64_000);
  assert.equal(b.pct, 0);
  assert.equal(b.effectiveWindow, 1);
  assert.ok(Number.isFinite(b.pct));
});

test('degenerate reserved ≥ window keeps effectiveWindow ≥ 1 (no zero denominator)', () => {
  const b = computeContextBudget(100, 1000, 5000);
  assert.equal(b.effectiveWindow, 1);
  assert.equal(b.pct, 100); // 100 / 1, clamped
  assert.ok(Number.isFinite(b.pct));
});

test('reservedOutput 0 → effective window equals raw window', () => {
  const b = computeContextBudget(500_000, 1_000_000, 0);
  assert.equal(b.effectiveWindow, 1_000_000);
  assert.equal(b.pct, 50);
});

test('haiku 200K window', () => {
  const b = computeContextBudget(90_000, 200_000, 8_000);
  assert.equal(b.effectiveWindow, 192_000);
  assert.equal(b.pct, Math.round((90_000 / 192_000) * 100));
});

test('crossedThresholds: warn/auto fire at or above their level', () => {
  const t = { warnAt: 75, autoAt: 90 };
  assert.deepEqual(crossedThresholds(74, t), { warn: false, auto: false, fold: false });
  assert.deepEqual(crossedThresholds(75, t), { warn: true, auto: false, fold: false });
  assert.deepEqual(crossedThresholds(90, t), { warn: true, auto: true, fold: false });
});

test('crossedThresholds: fold only fires when foldAt is configured', () => {
  assert.equal(crossedThresholds(80, { warnAt: 75, autoAt: 90 }).fold, false);
  assert.equal(crossedThresholds(80, { warnAt: 75, autoAt: 90, foldAt: 70 }).fold, true);
  assert.equal(crossedThresholds(60, { warnAt: 75, autoAt: 90, foldAt: 70 }).fold, false);
});

test('foldAt sits below warnAt → fold crosses before warn', () => {
  const t = { warnAt: 75, autoAt: 90, foldAt: 60 };
  const c = crossedThresholds(65, t);
  assert.deepEqual(c, { warn: false, auto: false, fold: true });
});
