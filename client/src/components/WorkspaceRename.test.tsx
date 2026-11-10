import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';

test('rename contains Tab and Shift+Tab, including while saving, and restores focus', async () => {
  const dom = new JSDOM('<!doctype html><body><button id="background">Background</button><div id="root"></div></body>', { url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { WorkspaceRename } = await import('./WorkspaceRename');
  const root = createRoot(document.getElementById('root')!);
  const tab = (shiftKey = false) => {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(event);
    return event;
  };
  let requestId = '';
  try {
    await act(async () => root.render(createElement(WorkspaceRename, { workflowId: 'fixture', name: 'Fixture', onRename: (_id, _name, request) => { requestId = request; return true; } })));
    const trigger = document.querySelector<HTMLButtonElement>('button[title="Rename workspace"]')!;
    trigger.focus();
    await act(async () => trigger.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    const controls = () => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
    const first = controls()[0];
    const last = controls().at(-1)!;
    last.focus();
    assert.equal(tab().defaultPrevented, true);
    assert.equal(document.activeElement, first);
    first.focus();
    assert.equal(tab(true).defaultPrevented, true);
    assert.equal(document.activeElement, last);
    document.getElementById('background')!.focus();
    tab();
    assert.equal(document.activeElement, first);
    await act(async () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    const pendingLast = controls().at(-1)!;
    pendingLast.focus(); tab();
    assert.equal(document.activeElement, controls()[0]);
    await act(async () => { window.dispatchEvent(new dom.window.CustomEvent('arco:workflow-rename-result', { detail: { workflowId: 'fixture', requestId } })); });
    assert.equal(document.activeElement, trigger);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete (globalThis as any)[key];
    }
  }
});
