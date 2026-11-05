import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memberSettingsFrom, memberTuning } from './memberSettings.js';

const config = { outputStyle: 'terse', efficiencyToolFilter: 'aggressive', fastMode: true, autoCompaction: { enabled: true, thresholdPercent: 70 } } as const;

test('ADD WORKERS starts from the template without tier, focus or own auto-compaction', () => {
  assert.deepEqual(memberSettingsFrom(config), { tier: '', focus: '', outputStyle: 'terse', efficiencyToolFilter: 'aggressive', fastMode: true, autoCompaction: null });
  assert.deepEqual(memberSettingsFrom(undefined), { tier: '', focus: '', outputStyle: 'normal', efficiencyToolFilter: 'off', fastMode: false, autoCompaction: null });
});

test('REPLACE starts from the old member, auto-compaction included', () => {
  assert.deepEqual(memberSettingsFrom(config, { tier: 'heavy', focus: 'docs', keepAutoCompaction: true }),
    { tier: 'heavy', focus: 'docs', outputStyle: 'terse', efficiencyToolFilter: 'aggressive', fastMode: true, autoCompaction: { enabled: true, thresholdPercent: 70 } });
});

test('the request carries every value; settings a provider does not use are sent as off', () => {
  const v = memberSettingsFrom(config, { tier: 'heavy', focus: ' docs ', keepAutoCompaction: true });
  assert.deepEqual(memberTuning(v, 'claude'), { tier: 'heavy', focus: 'docs', outputStyle: 'terse', efficiencyToolFilter: 'aggressive', fastMode: true, autoCompaction: { enabled: true, thresholdPercent: 70 } });
  assert.deepEqual(memberTuning(v, 'codex'), { tier: 'heavy', focus: 'docs', outputStyle: 'terse', efficiencyToolFilter: 'off', fastMode: false, autoCompaction: { enabled: true, thresholdPercent: 70 } });
  assert.deepEqual(memberTuning({ ...v, tier: '', focus: '', autoCompaction: null }, 'ollama'), { tier: null, focus: '', outputStyle: 'normal', efficiencyToolFilter: 'off', fastMode: false, autoCompaction: null });
});
