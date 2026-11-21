import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { applyTheme } from './apply';
import { getTheme } from './registry';

function themedFg(url: string): string {
  const dom = new JSDOM('<div></div>', { url });
  const g = globalThis as Record<string, unknown>;
  const keys = ['window', 'document', 'Event', 'CustomEvent'];
  const saved = Object.fromEntries(keys.map((k) => [k, g[k]]));
  Object.assign(g, { window: dom.window, document: dom.window.document, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent });
  try {
    applyTheme(getTheme('solar-paper'), null, null, null, { text: 25 });
    return dom.window.document.documentElement.style.getPropertyValue('--color-fg');
  } finally {
    Object.assign(g, saved);
    dom.window.close();
  }
}

test('the mobile view keeps the theme text colour; the workbench applies text brightness', () => {
  assert.equal(themedFg('http://localhost/mobile'), '#3d3520');
  assert.notEqual(themedFg('http://localhost/'), '#3d3520');
});
