import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { JobState } from '../../stores/appStore.js';
import { GenesisTab } from './GenesisTab.js';

const seed = { title: 'Fixture', spark: '', concept: '', theCase: '', buildDirection: '', creative: true };

function render(job: Partial<JobState>): Document {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const previous = new Map(['window', 'document', 'localStorage', 'navigator', 'React'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of ['window', 'document', 'localStorage', 'navigator'] as const) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
  try {
    const html = renderToStaticMarkup(createElement(GenesisTab, { job: { id: 'genesis-fixture', config: { workingDirectory: '/fixture/project' }, ...job } as JobState }));
    return new JSDOM(html).window.document;
  } finally {
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
    dom.window.close();
  }
}

const disarm = (doc: Document) => [...doc.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'DISARM');

test('armed Creative mode offers DISARM without an established-codebase warning', () => {
  // A small project (no warning) and any armed tab after a reload (the
  // assessment is not stored) both arrive here without a warning.
  const doc = render({ genesisSeed: seed });
  assert.ok(disarm(doc), 'DISARM is shown');
  assert.match(doc.querySelector('[data-testid="genesis-creative-armed"]')?.textContent ?? '', /CREATIVE MODE ARMED/);
  assert.doesNotMatch(doc.body.textContent ?? '', /ESTABLISHED CODEBASE/);
});

test('armed Creative mode on an established codebase shows the warning and DISARM', () => {
  const doc = render({ genesisSeed: seed, genesisCodebase: { fileCount: 120, established: true, warning: 'Fixture warning text.' } });
  assert.ok(disarm(doc), 'DISARM is shown');
  assert.match(doc.body.textContent ?? '', /ESTABLISHED CODEBASE/);
  assert.match(doc.body.textContent ?? '', /Fixture warning text\./);
});

test('an unarmed real-folder tab shows the arm panel, not DISARM', () => {
  const doc = render({});
  assert.equal(disarm(doc), undefined);
  assert.match(doc.body.textContent ?? '', /GENESIS · CREATIVE MODE/);
});
