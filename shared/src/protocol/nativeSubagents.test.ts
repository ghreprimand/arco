import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNativeSubagents, sanitizeNativeSubagents } from './settings.js';

test('old installs receive finite limits while Agent choice remains unchanged', () => {
  assert.deepEqual(resolveNativeSubagents(), { maxRunning: 4, maxStarts: 8, model: '' });
  assert.deepEqual(resolveNativeSubagents({ maxRunning: 2, maxStarts: 6, model: 'haiku' }, { maxRunning: 1, model: '' }), { maxRunning: 1, maxStarts: 6, model: '' });
  assert.deepEqual(resolveNativeSubagents({ model: 'haiku' }, {}), { maxRunning: 4, maxStarts: 8, model: 'haiku' });
});
test('invalid limits cannot become unlimited or bypass default enforcement', () => {
  for (const v of [0, -1, NaN, Infinity, 1.5, '4', null]) {
    assert.deepEqual(sanitizeNativeSubagents({ maxRunning: v, maxStarts: v }), {});
  }
  assert.deepEqual(sanitizeNativeSubagents({ maxRunning: 33, maxStarts: 129 }), {});
  assert.deepEqual(sanitizeNativeSubagents({ maxRunning: 32, maxStarts: 128, model: ' haiku ' }), { maxRunning: 32, maxStarts: 128, model: 'haiku' });
});
