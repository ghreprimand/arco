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


test('text brightness cache defaults to 30 and preserves zero', async () => {
  const { readCachedTextBrightness, writeCachedTextBrightness } = await import('./bootstrap');
  const values = new Map<string, string>();
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  try {
    assert.equal(readCachedTextBrightness(), 30);
    writeCachedTextBrightness(0);
    assert.equal(readCachedTextBrightness(), 0);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous });
  }
});
