import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlanLibraryEntry } from '@arco/shared';
import { probablyFinished, foldVersions } from './plansGrouping';

const now = 1800000000000;
const plan = (changes: Partial<PlanLibraryEntry> = {}): PlanLibraryEntry => ({ id: 'a', title: 'Plan', createdAt: now, updatedAt: now, refCount: 0, attached: false, clusters: [], ...changes });
test('probably finished requires checked boxes or age and excludes attached plans', () => {
  assert.equal(probablyFinished(plan({ checkboxTotal: 2, checkboxDone: 2 }), now), true);
  assert.equal(probablyFinished(plan({ checkboxTotal: 0, checkboxDone: 0 }), now), false);
  assert.equal(probablyFinished(plan({ updatedAt: now - 30 * 86400000 }), now), true);
  assert.equal(probablyFinished(plan({ attached: true, checkboxTotal: 1, checkboxDone: 1, updatedAt: 0 }), now), false);
  assert.equal(probablyFinished(plan({ completedAt: now, checkboxTotal: 1, checkboxDone: 1 }), now), false);
});
test('folds trimmed case insensitive titles without merging entries', () => {
  const groups = foldVersions([plan(), plan({ id: 'b', title: ' PLAN ' }), plan({ id: 'c', title: 'Other' })]);
  assert.deepEqual(groups.map((g) => g.map((p) => p.id)), [['a', 'b'], ['c']]);
});
