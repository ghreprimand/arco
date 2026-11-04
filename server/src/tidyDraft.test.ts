import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTidyMaterial } from './tidyDraft.js';
import { buildUtilityPrompt } from './utilityJob.js';
import { UTILITY_JOB_INPUT_MAX_CHARS } from '@arco/shared';

test('tidy input keeps the original, current proposal and every directive', () => {
  const input = { original: 'Keep this list', proposal: 'A proposal', directives: ['shorter', 'retain the file list'] };
  const built = buildTidyMaterial(input); assert.ok(built); assert.deepEqual(JSON.parse(built.material), input);
  const prompt = buildUtilityPrompt([{ label: 'Draft characters', value: '14' }], built.material);
  assert.equal(prompt.truncated, false); assert.ok(prompt.prompt.length <= UTILITY_JOB_INPUT_MAX_CHARS);
  assert.match(prompt.prompt, /retain the file list/);
});
test('tidy rejects input that would be truncated or is malformed', () => {
  assert.equal(buildTidyMaterial({ original: ' ', proposal: '', directives: [] }), null);
  assert.equal(buildTidyMaterial({ original: 'x'.repeat(18_000), proposal: '', directives: [] }), null);
  assert.equal(buildTidyMaterial({ original: 'x', proposal: '', directives: Array(17).fill('short') }), null);
  assert.equal(buildTidyMaterial({ original: 'x', proposal: '', directives: ['x'.repeat(501)] }), null);
  assert.equal(buildTidyMaterial({ original: 'x', proposal: '', directives: [''] }), null);
});
