import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkflowConfig } from '@arco/shared';

// Static render: effects (project fetch, focus) do not run, so this checks the
// structure and what Home shows from local state. Synthetic data only.
const persisted = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return persisted.size; },
    clear: () => persisted.clear(),
    getItem: (key: string) => persisted.get(key) ?? null,
    key: (index: number) => [...persisted.keys()][index] ?? null,
    removeItem: (key: string) => persisted.delete(key),
    setItem: (key: string, value: string) => persisted.set(key, value),
  } satisfies Storage,
});
(globalThis as Record<string, unknown>).React = React;

const config = (name: string, extra: Partial<WorkflowConfig> = {}) =>
  ({ name, primaryModel: 'm', primaryEffort: 'high', primaryProvider: 'codex', workingDirectory: '/projects/app', ...extra }) as unknown as WorkflowConfig;

test('Home is a labelled landmark with Start, Open work and project search; Incognito never appears', async () => {
  const { useAppStore } = await import('../../stores/appStore.js');
  const { HomeView } = await import('./HomeView.js');
  // Server rendering reads the store's initial state (as in deepseek-ui.test.tsx).
  useAppStore.setState({ jobs: {}, clusters: {} });
  useAppStore.getState().createJob('visible', config('Visible work'), undefined, undefined, true);
  useAppStore.getState().createJob('hidden', config('Private draft', { incognito: true }), undefined, undefined, true);
  const initial = useAppStore.getInitialState();
  const before = initial.jobs;
  let html = '';
  try {
    initial.jobs = useAppStore.getState().jobs;
    html = renderToStaticMarkup(<HomeView />);
  } finally { initial.jobs = before; }
  assert.match(html, /<main aria-labelledby="home-title"/);
  assert.match(html, /<h1 id="home-title"[^>]*>HOME<\/h1>/);
  for (const label of ['New session', 'Start a chat', 'New cluster', 'New idea \\(Genesis\\)']) {
    assert.match(html, new RegExp(`<button type="button"[^>]*>${label}</button>`));
  }
  assert.match(html, /<label for="home-search"[^>]*>Search projects \(press \/\)<\/label>/);
  assert.doesNotMatch(html, /id="home-add"/);
  assert.match(html, />Add project<\/button>/);
  assert.match(html, /id="home-open"/);
  assert.ok(html.indexOf('home.open-work') < html.indexOf('home.start'));
  assert.match(html, /aria-label="Open session Visible work"/);
  assert.doesNotMatch(html, /Private draft/, 'Incognito tabs are never listed on Home');
  assert.match(html, /Loading projects.../);
  assert.doesNotMatch(html, /<div[^>]*onClick/, 'actions are buttons, not clickable divs');
  for (const key of ['home.start', 'home.open-work', 'home.projects']) {
    assert.equal(html.split(`data-help=${JSON.stringify(key)}`).length - 1, 1, `contextual help ${key} is bound once`);
  }
});

test('project cards offer organization only when the server can store it, and relocation for a missing folder', async () => {
  const { ProjectCard } = await import('./ProjectCard.js');
  const noop = () => undefined;
  const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const render = (project: Record<string, unknown>, organization: boolean) => renderToStaticMarkup(
    <ProjectCard project={{ path: '/projects/app', name: 'app', source: 'registered', exists: true, ...project }} label="app"
      work={[]} organization={organization} onOpen={noop} onStart={noop} onList={noop} announce={noop} />);
  const live = render({ id, pinned: true, displayName: 'Budget', derivedName: 'app' }, true);
  assert.match(live, /aria-label="Unpin app"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="Unpin app"/);
  assert.match(live, /aria-label="Manage app"/);
  assert.match(live, /Folder name: app/);
  assert.match(live, />Pinned</);
  const unavailable = render({ id }, false);
  assert.doesNotMatch(unavailable, /Pin app|Manage app/, 'no organization controls without a record store');
  const missing = render({ id, exists: false, previousPaths: ['/old/app'] }, true);
  assert.match(missing, /aria-label="Relocate or manage app"[^>]*>Relocate...</);
  assert.match(missing, /Folder not found/);
  assert.match(missing, /Moved from \/old\/app/);
  assert.match(missing, /<button type="button"[^>]*disabled=""[^>]*aria-label="New session in app"/);
  assert.doesNotMatch(missing, /<div[^>]*onClick/);
});
