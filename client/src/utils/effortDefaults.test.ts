// New work never starts above HIGH; saved tuning choices stay as saved.
// Run: node --conditions development --import tsx --test src/utils/effortDefaults.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CodexCatalogSnapshot } from '@arco/shared';
import { capDefaultEffort, effortAfterModelChange, initialCreatorDefaults, EFFORT_RESET_NOTE } from './effortDefaults.js';

test('fresh home starts at HIGH with conservative tool filter and lite output', () => {
  assert.deepEqual(initialCreatorDefaults(undefined), { effort: 'high', efficiencyToolFilter: 'conservative', outputStyle: 'lite' });
  assert.deepEqual(initialCreatorDefaults({ primaryProvider: 'claude' }), { effort: 'high', efficiencyToolFilter: 'conservative', outputStyle: 'lite' });
});

test('saved off/normal tuning and saved efforts at or below HIGH are kept', () => {
  assert.deepEqual(initialCreatorDefaults({ primaryEffort: 'medium', efficiencyToolFilter: 'off', outputStyle: 'normal' }), { effort: 'medium', efficiencyToolFilter: 'off', outputStyle: 'normal' });
  assert.deepEqual(initialCreatorDefaults({ primaryEffort: 'low', efficiencyToolFilter: 'aggressive', outputStyle: 'terse' }), { effort: 'low', efficiencyToolFilter: 'aggressive', outputStyle: 'terse' });
});

test('a saved default above HIGH loads as HIGH', () => {
  for (const e of ['xhigh', 'max', 'ultra'] as const) assert.equal(initialCreatorDefaults({ primaryEffort: e }).effort, 'high');
});

test('preset or template effort above HIGH is capped and fits the model', () => {
  assert.equal(capDefaultEffort('max', 'claude', 'opus'), 'high');
  assert.equal(capDefaultEffort('medium', 'claude', 'opus'), 'medium');
  const low: CodexCatalogSnapshot = { models: [{ id: 'mini', label: 'mini', supportedReasoningEfforts: ['low', 'medium'] }] } as unknown as CodexCatalogSnapshot;
  assert.equal(capDefaultEffort('max', 'codex', 'mini' as never, null, low), 'medium');
});

test('explicit MAX resets to HIGH with a note after a model switch; ultracode keeps XHIGH', () => {
  assert.deepEqual(effortAfterModelChange('max', { explicit: true, ultracode: false, provider: 'claude', model: 'sonnet' }), { effort: 'high', note: EFFORT_RESET_NOTE });
  assert.deepEqual(effortAfterModelChange('high', { explicit: true, ultracode: false, provider: 'claude', model: 'sonnet' }), { effort: 'high', note: null });
  assert.equal(effortAfterModelChange('xhigh', { explicit: true, ultracode: true, provider: 'claude', model: 'opus' }).effort, 'xhigh');
});
