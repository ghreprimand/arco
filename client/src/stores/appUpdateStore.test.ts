import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { isUpdateStatus, releaseCheckError, useAppUpdateStore } from './appUpdateStore.js';
import { JSDOM } from 'jsdom';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { UpdateAction } from '../components/UpdateAction.js';
import { UpdateResultNotice } from '../components/UpdateResultNotice.js';
const notice = { type: 'app_update_available' as const, current: '0.1.0', latest: 'v0.2.0', url: 'https://github.com/ghreprimand/arco/releases/tag/v0.2.0', publishedAt: '2026-10-27T12:00:00Z' };
afterEach(() => useAppUpdateStore.setState({ status: null, notice: null }));
test('invalid status and unsafe release links cannot create an update notice', () => {
  assert.equal(isUpdateStatus({}), false);
  assert.equal(isUpdateStatus({ current: '0.1.0', enabled: true, updateAvailable: true, latest: {} }), false);
  useAppUpdateStore.getState().receive({ ...notice, url: 'javascript:alert(1)' });
  assert.equal(useAppUpdateStore.getState().notice, null);
});
test('a version is deduplicated and a newer message replaces it', () => {
  useAppUpdateStore.getState().receive(notice);
  const first = useAppUpdateStore.getState().notice;
  useAppUpdateStore.getState().receive({ ...notice });
  assert.equal(useAppUpdateStore.getState().notice, first);
  useAppUpdateStore.getState().receive({ ...notice, latest: 'v0.3.0' });
  assert.equal(useAppUpdateStore.getState().notice?.latest, 'v0.3.0');
});
test('cached GET and explicit POST use only the local API; opt-out clears a notice', async (t) => {
  let enabled = true;
  const methods: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, '/api/update-check'); methods.push(options.method!);
    return Response.json({ ...notice, checkedAt: null, updateAvailable: true, enabled });
  });
  await useAppUpdateStore.getState().refresh();
  assert.equal(useAppUpdateStore.getState().notice?.latest, 'v0.2.0');
  enabled = false; await useAppUpdateStore.getState().refresh(true);
  assert.deepEqual(methods, ['GET', 'POST']); assert.equal(useAppUpdateStore.getState().notice, null);
});
test('a failed npm check keeps the old tag as stale and withdraws its update notice', async (t) => {
  const known = { ...notice, publishedAt: null, checkedAt: null, enabled: true, updateAvailable: true };
  t.mock.method(globalThis, 'fetch', async () => Response.json(known));
  await useAppUpdateStore.getState().refresh();
  assert.equal(useAppUpdateStore.getState().notice?.latest, known.latest);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...known, updateAvailable: false, checkFailure: 'npm' }));
  await useAppUpdateStore.getState().refresh(true);
  const { status, notice: updateNotice } = useAppUpdateStore.getState();
  assert.equal(status?.latest, known.latest);
  assert.equal(releaseCheckError(status), 'Could not check npm for updates.');
  assert.equal(updateNotice, null);
});

test('failed refresh preserves known release information', async (t) => {
  useAppUpdateStore.getState().receive(notice);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(useAppUpdateStore.getState().refresh());
  assert.equal(useAppUpdateStore.getState().notice?.latest, 'v0.2.0');
});

test('an update failure appears once beside its button, falling back to a notice when closed', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  const before = useAppUpdateStore.getState();
  let result: { outcome: string; message?: string; finishedAt?: number; attemptId: string } | null = null;
  const failure = 'Cannot locate npm-cli.js. Fixture update failed.';
  const values = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') {
        result = { outcome: 'running', attemptId: 'fixture-attempt' };
        return Response.json({ attemptId: 'fixture-attempt' });
      }
      return Response.json({ mode: 'service', packaged: true, result });
    },
  };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.mock.timers.enable({ apis: ['setInterval'] });
  useAppUpdateStore.setState({ resultSurfaces: [], updating: false });
  const root = createRoot(document.getElementById('root')!);
  const render = async (count: number) => act(async () => root.render(createElement(Fragment, null,
    createElement(UpdateResultNotice),
    ...Array.from({ length: count }, (_, i) => createElement('section', { id: `action-${i}`, key: i }, createElement(UpdateAction, { latest: 'v0.2.0', url: null }))))));
  const occurrences = () => document.body.textContent!.split(failure).length - 1;
  try {
    await render(2);
    const second = document.querySelector('#action-1')!;
    await act(async () => second.querySelector('button')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === 'UPDATE AND RESTART')!.click());
    result = { outcome: 'failed', message: failure, finishedAt: 1, attemptId: 'fixture-attempt' };
    await act(async () => t.mock.timers.tick(30_000));
    assert.equal(occurrences(), 1);
    assert.ok(second.textContent?.includes(failure), 'the pressed button owns the result');
    assert.equal(document.querySelector('[data-help="settings.update-result"]'), null);
    await render(1);
    assert.equal(occurrences(), 1, 'another open control takes over when the initiating control closes');
    await render(0);
    assert.equal(occurrences(), 1, 'the fallback notice keeps the result available');
    assert.ok(document.querySelector('[data-help="settings.update-result"]'));
  } finally {
    await act(async () => root.unmount());
    useAppUpdateStore.setState(before, true);
    for (const key of Object.keys(values)) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]); else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});


test('an open update confirmation closes when its offered version disappears or changes', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  const before = useAppUpdateStore.getState();
  const values = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true, fetch: async () => Response.json({ mode: 'service', packaged: true, result: null }) };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(document.getElementById('root')!);
  const render = async (latest: string | null) => act(async () => root.render(createElement(UpdateAction, { latest, url: null })));
  const open = async () => act(async () => document.querySelector<HTMLButtonElement>('[data-help="settings.update-action"] button')!.click());
  try {
    await render('v0.2.0');
    await open();
    assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes('v0.2.0'));
    await render(null);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await render('v0.2.0');
    assert.equal(document.querySelector('[role="dialog"]'), null, 'the old confirmation does not reopen');
    await open();
    await render('v0.3.0');
    assert.equal(document.querySelector('[role="dialog"]'), null, 'a different version needs a new confirmation');
    await open();
    assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes('v0.3.0'));
  } finally {
    await act(async () => root.unmount());
    useAppUpdateStore.setState(before, true);
    for (const key of Object.keys(values)) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]); else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
