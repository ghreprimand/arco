// Regression guard for the Codex effort surface (docs/GOTCHAS.md § Codex).
//
// GPT-6 Astra (2026-09-03) added two reasoning efforts above `xhigh` — `max`
// and then `ultra`. Arco dropped both on release day: `effortsForModel`
// carried a hard-coded `low|medium|high|xhigh` allowlist, so the live catalog
// could advertise six levels and the picker would still show four. The failure
// is silent in both directions — an operator picking MAX on Astra was quietly
// downgraded — so the allowlist is pinned here.
//
// The second half guards the opposite error: widening the surface for models
// that genuinely stop lower. Offering `ultra` on gpt-5.5 would 400 the turn.
//
// Run: node --conditions development --import tsx --test src/utils/codexEfforts.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CodexCatalogSnapshot } from '@arco/shared';
import { EFFORT_RANK } from '@arco/shared';
import { effortsForModel, effortsForProvider, clampEffortForModel } from './format.js';

// Shape mirrors what codex-appserver/catalog.ts distils from `model/list`.
// Efforts arrive sorted ascending by EFFORT_RANK.
const catalog = {
  fetchedAt: Date.now(),
  fresh: true,
  models: [
    { id: 'gpt-6-astra', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { id: 'gpt-5.5', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gpt-5.4-mini', supportedReasoningEfforts: ['low', 'medium', 'high'] },
  ],
} as unknown as CodexCatalogSnapshot;

test('Astra surfaces all six efforts, including max and ultra', () => {
  assert.deepEqual(
    effortsForModel('codex', 'gpt-6-astra' as never, null, catalog),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
});

test('models that stop lower are not widened', () => {
  // The bug in the other direction: offering an effort the model will reject.
  assert.deepEqual(effortsForModel('codex', 'gpt-5.5' as never, null, catalog), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(effortsForModel('codex', 'gpt-5.4-mini' as never, null, catalog), ['low', 'medium', 'high']);
});

test('the no-catalog fallback stays conservative', () => {
  // Cold start must not assume Astra's surface for an unknown model.
  assert.deepEqual(effortsForProvider('codex'), ['low', 'medium', 'high']);
});

test('clamping lands on the highest effort the model really supports', () => {
  // Depends on the catalog array being sorted ascending — an unranked effort
  // would sort to position 0 and make `last` the wrong answer.
  assert.equal(clampEffortForModel('ultra', 'codex', 'gpt-5.5' as never, null, catalog), 'xhigh');
  assert.equal(clampEffortForModel('ultra', 'codex', 'gpt-6-astra' as never, null, catalog), 'ultra');
  assert.equal(clampEffortForModel('max', 'codex', 'gpt-5.4-mini' as never, null, catalog), 'high');
});

test('ultra ranks above max, and every level is ranked', () => {
  assert.ok(EFFORT_RANK.ultra > EFFORT_RANK.max);
  assert.ok(EFFORT_RANK.max > EFFORT_RANK.xhigh);
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const) {
    assert.equal(typeof EFFORT_RANK[level], 'number', `${level} must be ranked`);
  }
});

test('non-Codex providers are unaffected by the widening', () => {
  // 'ultra' is Codex-only. Claude's surface must still top out at 'max'.
  const claude = effortsForModel('claude', 'claude-opus-5' as never, null, null);
  assert.ok(!claude.includes('ultra' as never));
  assert.ok(claude.includes('max'));
});

test('GPT-6 Sol / Luna cold-catalog fallback: Sol gets ultra, Luna stops at max', () => {
  // Before the live catalog lands, CODEX_MODEL_INFO is the only source. Luna
  // has no `ultra` in Codex's catalog; offering it would ride to the wire.
  assert.deepEqual(effortsForModel('codex', 'gpt-6-sol' as never, null, null), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(effortsForModel('codex', 'gpt-6-luna' as never, null, null), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(effortsForModel('codex', 'gpt-6.1-sol' as never, null, null), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(clampEffortForModel('ultra', 'codex', 'gpt-6-luna' as never, null, null), 'max');
});
