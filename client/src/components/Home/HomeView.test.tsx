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
  assert.match(html, /<h1 id="home-title"[^>]*>Welcome back<\/h1>/);
  for (const label of ['New session', 'Start a chat', 'New cluster']) assert.ok(html.includes(`aria-label="${label}"`));
  assert.match(html, /New idea \(Genesis\)/);
  assert.match(html, /<label for="home-search"[^>]*>Search folders \(press \/\)<\/label>/);
  assert.doesNotMatch(html, /id="home-add"/);
  assert.match(html, />Add project location<\/button>/);
  assert.match(html, /id="home-open"/);
  assert.ok(html.indexOf('home.start') < html.indexOf('home.open-work'));
  assert.match(html, /aria-label="Open session Visible work"/);
  assert.doesNotMatch(html, /Private draft/, 'Incognito tabs are never listed on Home');
  assert.match(html, /Loading folders.../);
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

test('open work renders two rows of cards with a Show all toggle that announces the total', async () => {
  const { useAppStore } = await import('../../stores/appStore.js');
  const { HomeView } = await import('./HomeView.js');
  const render = (count: number) => {
    useAppStore.setState({ jobs: {}, clusters: {} });
    for (let i = 0; i < count; i++) useAppStore.getState().createJob(`work-${i}`, config(`Work ${i}`), undefined, undefined, true);
    const initial = useAppStore.getInitialState();
    const before = initial.jobs;
    try { initial.jobs = useAppStore.getState().jobs; return renderToStaticMarkup(<HomeView />); } finally { initial.jobs = before; }
  };
  const many = render(20);
  // Before layout measurement the grid assumes three columns: two rows of three.
  assert.equal(many.split('aria-label="Open session Work ').length - 1, 6);
  assert.match(many, /<h2 id="home-open">Continue <span class="home-count">\(20\)<\/span><\/h2>/);
  assert.match(many, /<button type="button" class="home-show-all" aria-expanded="false" aria-controls="home-open-list">Show all 20<\/button>/);
  assert.match(many, /<div class="home-work-probe" aria-hidden="true"><\/div>/);
  const few = render(2);
  assert.equal(few.split('aria-label="Open session Work ').length - 1, 2);
  assert.doesNotMatch(few, /home-show-all/);
});

test('project grid is bounded to two rows with Show all, and search shows every match', async () => {
  const { boundProjects } = await import('../../utils/homeModel.js');
  const make = (n: number) => Array.from({ length: n }, (_, i) => i);
  for (const [count, shown, toggle] of [[3, 3, false], [6, 6, false], [7, 6, true], [30, 6, true]] as const) {
    const r = boundProjects(make(count), 3, false, false);
    assert.equal(r.shown.length, shown, `${count} projects`);
    assert.equal(r.toggle, toggle);
    assert.equal(r.scrolls, false);
  }
  const open = boundProjects(make(30), 3, true, false);
  assert.equal(open.shown.length, 30);
  assert.equal(open.scrolls, true);
  assert.equal(boundProjects(make(30), 4, false, false).shown.length, 8, 'rows follow the column count');
  const searching = boundProjects(make(30), 3, false, true);
  assert.equal(searching.shown.length, 30);
  assert.equal(searching.toggle, false);
  assert.equal(searching.scrolls, true);
  assert.equal(boundProjects(make(2), 0, false, false).shown.length, 2);
});

test('Getting started step 3 counts any started conversation, and the card can be hidden', async () => {
  const { conversationStarted } = await import('../../utils/homeModel.js');
  const none = { openWork: 0, savedChats: 0, savedClusters: 0, savedSessions: 0, remembered: false };
  assert.equal(conversationStarted(none), false);
  for (const key of ['openWork', 'savedChats', 'savedClusters', 'savedSessions'] as const) assert.equal(conversationStarted({ ...none, [key]: 1 }), true, key);
  assert.equal(conversationStarted({ ...none, remembered: true }), true);
  const { useAppStore } = await import('../../stores/appStore.js');
  const { HomeView } = await import('./HomeView.js');
  useAppStore.setState({ jobs: {}, clusters: {} });
  persisted.set('arco-home-guide-hidden', '1');
  try {
    assert.doesNotMatch(renderToStaticMarkup(<HomeView />), /Hide the getting started guide/);
  } finally { persisted.delete('arco-home-guide-hidden'); }
});
