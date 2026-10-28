import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME_ID, getTheme } from './registry';

test('default and copied phosphor theme resolve to Electric Blue', () => {
  const legacy = ['ody', 'ssey'].join('');
  assert.equal(DEFAULT_THEME_ID, 'phosphor:arco:electric');
  assert.equal(getTheme(undefined).id, DEFAULT_THEME_ID);
  assert.equal(getTheme(`phosphor:${legacy}:electric`).id, DEFAULT_THEME_ID);
  assert.equal(getTheme('matrix').id, 'matrix');
});
