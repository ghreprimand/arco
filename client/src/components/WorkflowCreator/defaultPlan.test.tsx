import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkflowCreator } from './index.js';
import { useAppStore } from '../../stores/appStore.js';

test('cluster creator starts with the optional director draft unticked', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const previous = new Map(['window', 'document', 'localStorage', 'navigator', 'React'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of ['window', 'document', 'localStorage', 'navigator'] as const) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
  try {
    useAppStore.setState({ creatorPrefill: { mode: 'cluster', workDir: '/fixture' } });
    const html = renderToStaticMarkup(createElement(WorkflowCreator, { onCreate: () => {}, onCreateCluster: () => {} }));
    const doc = new JSDOM(html).window.document;
    const label = [...doc.querySelectorAll('label')].find((el) => el.textContent?.includes('Have the director draft a plan for review'));
    assert.ok(label, 'draft option is present');
    assert.equal(label.querySelector('input')?.checked, false);
  } finally {
    useAppStore.persist.clearStorage();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
    dom.window.close();
  }
});
