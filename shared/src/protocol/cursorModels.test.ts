// Phase 8 — robustness-by-construction proof for the Cursor model-id parser.
//
// The picker's safety guarantee is that it never *synthesizes* an id: it looks
// up the exact catalog id via buildCursorModelIndex. That only holds if
//   (a) parse is INJECTIVE over the real catalog (no two distinct ids collapse
//       to the same selection key — otherwise one would shadow the other), and
//   (b) every catalog id ROUND-TRIPS (index.resolve(parse(id)) === id).
// Both are asserted below against a captured live snapshot (189 rows) plus a
// battery of the known irregular ids (grok mid-id -fast, gpt-5.5 -extra-high,
// sonnet-4.6 trailing -thinking, bare-default families, gpt-5.1-codex-max).
//
// Run: node --conditions development --import tsx --test shared/src/protocol/cursorModels.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCursorModelId,
  buildCursorModelIndex,
  resolveCursorModelId,
  cursorSelectionKey,
  cursorEffortsFor,
  type CursorCatalogModel,
} from './models.js';
import { CURSOR_CATALOG_FIXTURE } from './__fixtures__/cursorCatalog.fixture.js';

const CATALOG = CURSOR_CATALOG_FIXTURE as CursorCatalogModel[];

test('parser handles the known-irregular ids exactly', () => {
  assert.deepEqual(parseCursorModelId('auto'), { family: 'auto', effort: null, fast: false, thinking: false });
  // effort trailing
  assert.deepEqual(parseCursorModelId('claude-opus-4-8-high'), { family: 'claude-opus-4-8', effort: 'high', fast: false, thinking: false });
  // grok: -fast sits MID-id
  assert.deepEqual(parseCursorModelId('grok-4.5-fast-xhigh'), { family: 'grok-4.5', effort: 'xhigh', fast: true, thinking: false });
  assert.deepEqual(parseCursorModelId('grok-4.5-xhigh'), { family: 'grok-4.5', effort: 'xhigh', fast: false, thinking: false });
  // gpt-5.5: extra-high is TWO tokens => xhigh
  assert.deepEqual(parseCursorModelId('gpt-5.5-extra-high'), { family: 'gpt-5.5', effort: 'xhigh', fast: false, thinking: false });
  assert.deepEqual(parseCursorModelId('gpt-5.5-extra-high-fast'), { family: 'gpt-5.5', effort: 'xhigh', fast: true, thinking: false });
  // thinking BEFORE effort (opus-4-8) and AFTER effort (sonnet-4.6)
  assert.deepEqual(parseCursorModelId('claude-opus-4-8-thinking-high'), { family: 'claude-opus-4-8', effort: 'high', fast: false, thinking: true });
  assert.deepEqual(parseCursorModelId('claude-4.6-sonnet-medium-thinking'), { family: 'claude-4.6-sonnet', effort: 'medium', fast: false, thinking: true });
  // family name that ends in an effort-looking word: only ONE trailing token strips
  assert.deepEqual(parseCursorModelId('gpt-5.1-codex-max-low'), { family: 'gpt-5.1-codex-max', effort: 'low', fast: false, thinking: false });
  assert.deepEqual(parseCursorModelId('gpt-5.1-codex-max-medium-fast'), { family: 'gpt-5.1-codex-max', effort: 'medium', fast: true, thinking: false });
  // bare-default family (no effort token)
  assert.deepEqual(parseCursorModelId('gpt-5.1'), { family: 'gpt-5.1', effort: null, fast: false, thinking: false });
  assert.deepEqual(parseCursorModelId('gpt-5.3-codex'), { family: 'gpt-5.3-codex', effort: null, fast: false, thinking: false });
  assert.deepEqual(parseCursorModelId('composer-2.5'), { family: 'composer-2.5', effort: null, fast: false, thinking: false });
});

test('parse is injective across the full live catalog (no key collisions)', () => {
  const keyToId = new Map<string, string>();
  for (const m of CATALOG) {
    const p = parseCursorModelId(m.id);
    const key = cursorSelectionKey(p.family, p.effort, p.fast, p.thinking);
    const clash = keyToId.get(key);
    assert.equal(clash, undefined, `key collision: "${m.id}" and "${clash}" both map to ${key}`);
    keyToId.set(key, m.id);
  }
  assert.equal(keyToId.size, CATALOG.length);
});

test('every catalog id round-trips through the index', () => {
  const index = buildCursorModelIndex(CATALOG);
  for (const m of CATALOG) {
    const p = parseCursorModelId(m.id);
    const resolved = resolveCursorModelId(index, p.family, p.effort, p.fast, p.thinking);
    assert.equal(resolved, m.id, `round-trip failed for ${m.id} (resolved ${resolved})`);
  }
});

test('family index groups the whole catalog and produces sane labels', () => {
  const index = buildCursorModelIndex(CATALOG);
  // every id is accounted for
  assert.equal(index.byId.size, CATALOG.length);
  // 'auto' leads and is the default
  assert.equal(index.families[0].family, 'auto');
  assert.equal(index.families[0].isDefault, true);
  assert.equal(index.families[0].label, 'Auto');
  const byFamily = new Map(index.families.map((f) => [f.family, f]));
  // opus-4-8: full effort ladder, has fast + thinking variants, ZDR ok
  const opus = byFamily.get('claude-opus-4-8')!;
  assert.ok(opus, 'claude-opus-4-8 family present');
  assert.equal(opus.label, 'Opus 4.8 1M');
  assert.deepEqual(opus.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(opus.hasFast, true);
  assert.equal(opus.hasThinking, true);
  assert.equal(opus.noZdr, false);
  // grok label survives the offset-display bug (label from common prefix, not effort words)
  const grok = byFamily.get('grok-4.5')!;
  assert.equal(grok.label, 'Cursor Grok 4.5');
  // fable is NO ZDR across every member
  const fable = byFamily.get('claude-fable-5')!;
  assert.equal(fable.noZdr, true);
});

test('effortsFor narrows to real flag combinations', () => {
  const index = buildCursorModelIndex(CATALOG);
  // opus-4-8 non-thinking, non-fast has the full ladder
  assert.deepEqual(cursorEffortsFor(index, 'claude-opus-4-8', false, false), ['low', 'medium', 'high', 'xhigh', 'max']);
  // toggling thinking still resolves the full ladder for opus-4-8
  assert.deepEqual(cursorEffortsFor(index, 'claude-opus-4-8', false, true), ['low', 'medium', 'high', 'xhigh', 'max']);
  // an impossible combo yields nothing rather than throwing
  assert.deepEqual(cursorEffortsFor(index, 'composer-2.5', false, true), []);
});

test('unknown / edge ids degrade gracefully (never throw)', () => {
  // a non-effort trailing token stays part of the family (no strip)
  assert.deepEqual(parseCursorModelId('some-future-model-v9-ultra'), { family: 'some-future-model-v9-ultra', effort: null, fast: false, thinking: false });
  // a real effort token on an unknown family still parses
  assert.deepEqual(parseCursorModelId('some-future-model-high'), { family: 'some-future-model', effort: 'high', fast: false, thinking: false });
  assert.deepEqual(parseCursorModelId(''), { family: '', effort: null, fast: false, thinking: false });
  assert.deepEqual(parseCursorModelId('max'), { family: '', effort: 'max', fast: false, thinking: false });
});
