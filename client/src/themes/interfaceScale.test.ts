import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readCachedUiScale, writeCachedUiScale, applyUiScale } from './bootstrap';

test('fresh browser fallback is 110% and cached choices including 100% stay intact', () => {
  const dom = new JSDOM('', { url: 'http://localhost/' });
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  const values = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  try {
    assert.equal(readCachedUiScale(), 1.1);
    for (const size of [0.9, 1, 1.1, 1.2, 1.3, 1.5]) {
      writeCachedUiScale(size);
      assert.equal(readCachedUiScale(), size);
    }
    applyUiScale(1);
    assert.equal(document.documentElement.style.zoom, '1', 'resolved legacy settings replace the fresh bootstrap fallback');
  } finally {
    for (const key of Object.keys(values)) { if (saved[key]) Object.defineProperty(globalThis, key, saved[key]); else Reflect.deleteProperty(globalThis, key); }
    dom.window.close();
  }
});
