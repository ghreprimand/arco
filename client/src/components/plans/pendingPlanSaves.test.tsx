import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { registerHooks } from 'node:module';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage, React, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout };
const previous = new Map([...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
dom.window.HTMLElement.prototype.scrollTo = () => {};
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;
const css = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: 'export default {};', shortCircuit: true } : next(url, context); } });
const { createRoot } = await import('react-dom/client');
const { PlanRefViewer } = await import('./PlanRefsSection');
const { PlansLens } = await import('../../explorer/PlansLens');
const { ClusterPlanTab } = await import('../ClusterPlanTab');
const { LlamacppCatalogEditor } = await import('../LlamacppCatalogEditor');
const { PlanTab } = await import('../RightPanel/PlanTab');
const { RecallView } = await import('../Recall/RecallView');
const { useAppStore } = await import('../../stores/appStore');
const { useRecallStore } = await import('../../stores/recallStore');
css.deregister();
const app = useAppStore.getState(), recall = useRecallStore.getState();
after(async () => {
  useAppStore.setState(app, true); useRecallStore.setState(recall, true);
  await new Promise((resolve) => setTimeout(resolve, 1100)); dom.window.close();
  clearInterval((dom.window as any).__ARCO_TRIM_MEMORY_TIMER__);
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});
const plan = { id: 'plan-fixture', title: 'Fixture', body: '# Fixture\n- [ ] Task\n', updatedAt: 1, createdAt: 1, completedAt: null, attachments: [] };
const job = (attached: boolean) => ({ id: 'worker-fixture', config: { workingDirectory: '/fixture/project', name: 'Fixture', primaryProvider: 'claude', primaryModel: 'fixture' }, plan: attached ? plan : undefined, messages: [], workers: {} });
let finish: ((response: Response) => void) | undefined;
let gets: string[] = [];
let writes: Array<{ url: string; body: any }> = [];
function fixtureFetch(deferMethod: string) {
  finish = undefined; gets = []; writes = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const address = String(url), method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push({ url: address, body: JSON.parse(String(init?.body ?? '{}')) });
    if (address.startsWith('/api/public-project/choice')) return Response.json({ choice: false });
    if (address.startsWith('/api/public-project/remote')) return Response.json({ state: 'none' });
    if (method === deferMethod) return new Promise<Response>((resolve) => { finish = resolve; });
    gets.push(address);
    if (method === 'PATCH' && address.startsWith('/api/plans?')) return Response.json({ plan: { ...plan, body: JSON.parse(String(init?.body)).body } });
    if (address === '/api/explorer/plans') return Response.json({ projects: [{ cwd: '/fixture/project', name: 'Fixture project', plans: [{ ...plan, updatedAt: Date.now(), refCount: 0, attached: true, clusters: [] }] }] });
    if (address === '/api/llamacpp/catalog') return Response.json({ revision: 'review-fixture', models: method === 'POST' ? JSON.parse(String(init?.body)).models : [{ alias: 'one', ggufPath: '/fixture/one.gguf' }, { alias: 'two', ggufPath: '/fixture/two.gguf' }] });
    if (address.includes('/api/plans/refs/body')) return Response.json({ ref: { slug: 'details', title: 'Accepted details', body: '# Accepted details\n', updatedAt: 1, bytes: 19 } });
    if (address.includes('/api/plans/refs')) return Response.json({ refs: [] });
    if (address.includes('/api/plans/body')) return Response.json({ plan });
    if (address.startsWith('/api/plans?')) return Response.json({ plans: [] });
    return Response.json({ error: 'Fixture unavailable' }, { status: 404 });
  }) as typeof fetch;
  useAppStore.setState({ jobs: {}, clusters: {}, settings: { enabledProviders: {} } as never, pushNotification() {} });
}
async function mounted(element: React.ReactNode, check: (container: HTMLElement) => Promise<void>) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try { await act(async () => root.render(element)); await check(container); }
  finally {
    await act(async () => { finish?.(Response.json({ plan, article: { id: 'article-fixture' } })); });
    await act(async () => root.unmount()); container.remove();
  }
}
const button = (container: ParentNode, label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
async function fill(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = element.tagName === 'INPUT' ? dom.window.HTMLInputElement.prototype : dom.window.HTMLTextAreaElement.prototype;
    element.focus();
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    element.dispatchEvent(new dom.window.KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
  });
}

test('B186: a reference marked missing still fetches its accepted body before offering creation', async () => {
  fixtureFetch('PUT');
  await mounted(React.createElement(PlanRefViewer, { cwd: '/fixture/project', planId: plan.id, slug: 'details', exists: false, onClose() {}, onChanged() {} }), async (container) => {
    assert.ok(gets.some((url) => url.includes('/api/plans/refs/body')));
    assert.match(container.textContent!, /Accepted details/);
    assert.equal(container.querySelector('textarea'), null);
  });
});

test('B168: a reference cannot accept new text while its submitted save is pending', async () => {
  fixtureFetch('PUT');
  await mounted(React.createElement(PlanRefViewer, { cwd: '/fixture/project', planId: plan.id, slug: 'details', exists: true, onClose() {}, onChanged() {} }), async (container) => {
    await act(async () => button(container, 'EDIT').click());
    await act(async () => button(container, 'SAVE').click());
    assert.ok(finish);
    assert.ok(container.querySelector('textarea')!.matches(':disabled'));
    assert.ok(button(container, 'CANCEL').matches(':disabled'));
  });
});

for (const attached of [false, true]) {
  test(`B168: ${attached ? 'existing plan' : 'CREATE & ATTACH'} fields wait for the submitted save`, async () => {
    fixtureFetch(attached ? 'PATCH' : 'POST');
    await mounted(React.createElement(PlanTab, { job: job(attached) as never, onAttach() {} }), async (container) => {
      await act(async () => button(container, attached ? 'EDIT' : '+ NEW PLAN').click());
      if (!attached) await fill(container.querySelector('input[placeholder="Plan title"]')!, 'New plan');
      await act(async () => button(container, attached ? 'SAVE' : 'CREATE & ATTACH').click());
      assert.ok(finish);
      assert.ok(container.querySelector('textarea')!.matches(':disabled'));
      assert.ok([...container.querySelectorAll('input')].some((input) => input.matches(':disabled')));
      assert.ok(button(container, 'CANCEL').matches(':disabled'));
    });
  });
}

test('B163: completing a distillation save preserves edits made after submission', async () => {
  fixtureFetch('POST');
  useRecallStore.setState({ hits: [{ wfid: 'recall-fixture', title: 'Fixture', cwd: '/fixture/project', provider: 'claude', model: 'fixture', summaryRef: 'summary.md', project: 'Fixture project', matchedIn: 'title', tags: [], links: [], matches: [], score: 1, lastActiveAt: 1 }] as never, runSearch: async () => {}, fetchSummary: async () => 'Submitted summary', addLink: async () => null, searching: false, searchError: null });
  await mounted(React.createElement(RecallView, { onClose() {}, requestRecallSummary: () => false }), async () => {
    await act(async () => (document.querySelector('[data-help="recall.action.distill-kb"]') as HTMLButtonElement).click());
    await act(async () => button(document, 'SAVE TO KB').click());
    assert.ok(finish);
    const input = document.querySelector('[data-help="recall.distill-kb.body"]') as HTMLTextAreaElement;
    await fill(input, 'Later unsaved edit');
    await act(async () => finish!(Response.json({ article: { id: 'article-fixture' } })));
    const current = document.querySelector('[data-help="recall.distill-kb.body"]') as HTMLTextAreaElement | null;
    assert.ok(current); assert.equal(current.value, 'Later unsaved edit');
  });
});

for (const surface of ['workflow', 'library', 'cluster']) {
  test(`B71: ${surface} checkbox writes carry the displayed body revision`, async () => {
    fixtureFetch('PUT');
    const cluster = { clusterId: 'cluster-fixture', name: 'Fixture cluster', cwd: '/fixture/project', plan, members: [{ workflowId: 'worker-fixture', role: 'director', displayName: 'Director', provider: 'claude', model: 'fixture' }], taskBoardMode: 'none' };
    const element = surface === 'workflow' ? React.createElement(PlanTab, { job: job(true) as never })
      : surface === 'library' ? React.createElement(PlansLens, { focusTick: 0 })
      : React.createElement(ClusterPlanTab, { cluster: cluster as never, onSetPlan() {} });
    await mounted(element, async (container) => {
      if (surface === 'library') {
        const project = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Fixture project'))!;
        if (project.getAttribute('aria-expanded') !== 'true') await act(async () => project.click());
        const row = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Fixture') && !b.textContent?.includes('Fixture project'))!;
        await act(async () => row.click());
      }
      const checkbox = container.querySelector('button[title="Mark as done"]') as HTMLButtonElement;
      assert.ok(checkbox);
      await act(async () => checkbox.click());
      const request = writes.find((r) => r.url.startsWith('/api/plans?'));
      assert.ok(request, 'a checkbox must use a version-checked plan mutation');
      assert.equal(request.body.expectedBody, plan.body);
    });
  });
}

test('B158: editing a loadout cannot rename it onto an existing alias', async () => {
  fixtureFetch('PUT');
  await mounted(React.createElement(LlamacppCatalogEditor), async (container) => {
    const edit = [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'EDIT')[1];
    await act(async () => edit.click());
    await fill(container.querySelector('input[placeholder="e.g. qwen3.6"]')!, 'one');
    await act(async () => button(container, 'SAVE').click());
    assert.equal(writes.filter((w) => w.url === '/api/llamacpp/catalog').length, 0);
    assert.match(container.textContent!, /already exists/);
  });
});

test('B159: a catalog edit submits the revision that was reviewed', async () => {
  fixtureFetch('PUT');
  await mounted(React.createElement(LlamacppCatalogEditor), async (container) => {
    await act(async () => button(container, 'EDIT').click());
    await act(async () => button(container, 'SAVE').click());
    const saved = writes.find((w) => w.url === '/api/llamacpp/catalog');
    assert.ok(saved); assert.equal(saved.body.revision, 'review-fixture');
  });
});

test('B168: the plan-library editor waits for its submitted save', async () => {
  fixtureFetch('PATCH');
  await mounted(React.createElement(PlansLens, { focusTick: 0 }), async (container) => {
    const project = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Fixture project'))!;
    if (project.getAttribute('aria-expanded') !== 'true') await act(async () => project.click());
    const row = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Fixture') && !b.textContent?.includes('Fixture project'))!;
    await act(async () => row.click());
    await act(async () => button(container, 'EDIT').click());
    await act(async () => button(container, 'SAVE').click());
    assert.ok(finish);
    assert.ok(container.querySelector('textarea')!.matches(':disabled'));
    assert.ok(button(container, 'CANCEL').matches(':disabled'));
  });
});
