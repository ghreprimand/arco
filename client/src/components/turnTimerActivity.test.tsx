import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { TurnTimer, turnElapsed } from './TurnTimer';

test('turn elapsed uses the supplied start without inventing a time', () => {
  assert.equal(turnElapsed(1000, 3000), '2s');
  assert.equal(turnElapsed(1000, 162000), '2m 41s');
  assert.equal(turnElapsed(1000, 3901000), '1h 5m');
  assert.equal(turnElapsed(2000, 1000), '0s');
});

test('turn timer follows busy state and the supplied start time', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const names = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'];
  const prior = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'IS_REACT_ACT_ENVIRONMENT' ? true : (dom.window as any)[name] });
  const host = dom.window.document.createElement('div'); dom.window.document.body.append(host); const root = createRoot(host);
  const at = Date.now() - 5000;
  try {
    await act(async () => root.render(createElement(TurnTimer, { busy: true, startedAt: at })));
    assert.match(host.querySelector('[data-testid="turn-timer"]')?.textContent ?? '', /^TURN [56]s$/);
    await act(async () => root.render(createElement(TurnTimer, { busy: false, startedAt: at })));
    assert.equal(host.querySelector('[data-testid="turn-timer"]'), null);
    await act(async () => root.render(createElement(TurnTimer, { busy: true })));
    assert.equal(host.querySelector('[data-testid="turn-timer"]'), null);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [name, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
  }
});
