import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { JobState } from '../stores/appStore';
import { QueuedMessagesIndicator } from './QueuedMessagesIndicator';
import { NorthStarBar } from './NorthStarBar';
import { ContextMeter } from './ContextMeter';

function job(extra: Partial<JobState> = {}): JobState {
  return {
    config: { primaryProvider: 'claude', claudeTransport: 'cli' },
    queue: { steering: [{ content: 'Review this synthetic change', clientMessageId: 'fixture' }], followUp: [] },
    turnMessages: {},
    totalTokens: { output: 0 },
    ...extra,
  } as JobState;
}

test('pending messages still open a preview where a queued item can be cancelled', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const previous = new Map(['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'navigator', 'getComputedStyle'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    localStorage: { configurable: true, value: dom.window.localStorage },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    Node: { configurable: true, value: dom.window.Node },
    navigator: { configurable: true, value: dom.window.navigator },
    getComputedStyle: { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  const cancelled: string[] = [];
  const render = (value: JobState) => act(async () => { root.render(createElement(QueuedMessagesIndicator, { job: value, onCancel: (id) => cancelled.push(id) })); });
  try {
    await render(job());
    const pending = [...host.querySelectorAll('button')].find((button) => button.textContent === 'PENDING · 1');
    assert.ok(pending);
    assert.equal(dom.window.document.body.textContent?.includes('CANCEL'), false, 'cancel stays in the preview');
    await act(async () => { pending!.click(); });
    assert.match(dom.window.document.body.textContent ?? '', /Review this synthetic change/);
    const cancel = [...dom.window.document.body.querySelectorAll('button')].find((button) => button.textContent === 'CANCEL');
    assert.ok(cancel);
    await act(async () => { cancel!.click(); });
    assert.deepEqual(cancelled, ['fixture']);

    await render(job({
      queue: { steering: [], followUp: [{ content: 'no id yet' }] },
      turnMessages: { delivered: { kind: 'follow-up', content: 'already sent', state: 'delivered', index: 0 } },
    } as Partial<JobState>));
    const again = [...host.querySelectorAll('button')].find((button) => button.textContent?.startsWith('PENDING'));
    await act(async () => { again!.click(); });
    assert.match(dom.window.document.body.textContent ?? '', /already sent/);
    assert.match(dom.window.document.body.textContent ?? '', /no id yet/);
    assert.equal([...dom.window.document.body.querySelectorAll('button')].some((button) => button.textContent === 'CANCEL'), false, 'a delivered row and a row without an id cannot be cancelled');
    await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })); });
    assert.equal(dom.window.document.body.textContent?.includes('QUEUED MESSAGES'), false);
    assert.deepEqual(cancelled, ['fixture']);
  } finally {
    await act(async () => { root.unmount(); });
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

test('the north star and a running goal stay actionable, and the context gauge names handoff', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    localStorage: { configurable: true, value: dom.window.localStorage },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    Node: { configurable: true, value: dom.window.Node },
    navigator: { configurable: true, value: dom.window.navigator },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  const updates: unknown[] = [];
  try {
    await act(async () => {
      root.render(createElement(NorthStarBar, {
        job: { config: { goal: 'Finish the synthetic project', goalRun: { enabled: true, total: 4, remaining: 3, tokensUsed: 20 } } } as JobState,
        onUpdatePrimary: (update) => updates.push(update),
      }));
    });
    assert.match(host.textContent ?? '', /Finish the synthetic project/);
    const stop = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('RUN'));
    assert.ok(stop, 'an armed goal run still has its stop control');
    await act(async () => { stop!.click(); });
    assert.deepEqual(updates, [{ goalRun: { enabled: false } }]);

    await act(async () => {
      root.render(createElement(ContextMeter, { job: { config: { primaryProvider: 'cursor' }, totalTokens: { output: 0 } } as JobState }));
    });
    const title = host.querySelector('[title]')?.getAttribute('title') ?? '';
    assert.match(title, /FRESH SUMMARIZER/);
    assert.match(title, /ORIGINAL WORKER/);
    assert.equal(host.textContent?.includes('TOOL CALLS SINCE HANDOFF'), false);

    // A Claude tab without a server context reading shows none: the turn's
    // usage sums every request and pass, so it is not a context size.
    await act(async () => {
      root.render(createElement(ContextMeter, { job: { config: { primaryProvider: 'claude', claudeTransport: 'native' }, totalTokens: { output: 500 }, lastTurnTokens: { input: 900_000, output: 500, cacheRead: 0, cacheCreate: 50_000 } } as JobState }));
    });
    assert.match(host.textContent ?? '', /- CTX/);
    assert.equal(host.textContent?.includes('950K'), false, 'the summed turn usage is not shown as context');
    assert.match(host.querySelector('[title]')?.getAttribute('title') ?? '', /No context reading yet/);
    // Other providers keep their last-turn figure.
    await act(async () => {
      root.render(createElement(ContextMeter, { job: { config: { primaryProvider: 'ollama' }, totalTokens: { output: 0 }, lastTurnTokens: { input: 12_000, output: 10, cacheRead: 0, cacheCreate: 0 } } as JobState }));
    });
    assert.match(host.textContent ?? '', /12k CTX/);
    await act(async () => {
      root.render(createElement(ContextMeter, { job: { config: { primaryProvider: 'codex' }, providerConversation: 'unavailable', totalTokens: { output: 500 }, lastTurnTokens: { input: 60000, output: 10, cacheRead: 0, cacheCreate: 0 }, contextUsage: { estimatedTokens: 60000, windowSize: 100000, percentOfWindow: 60 } } as JobState }));
    });
    assert.equal(host.textContent, 'CTX: -');
    assert.match(host.querySelector('[title]')?.getAttribute('title') ?? '', /previous provider conversation cannot be resumed/);
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test('a phone upload route is unverified until a file arrives through it, in the chooser and beside the code', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const names = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'navigator', 'getComputedStyle', 'fetch', 'CustomEvent'];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const requests: string[] = [];
  const lastWorked = Date.UTC(2026, 10, 18, 9, 30);
  let uploaded = false;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    localStorage: { configurable: true, value: dom.window.localStorage },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    Node: { configurable: true, value: dom.window.Node },
    navigator: { configurable: true, value: dom.window.navigator },
    getComputedStyle: { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) },
    CustomEvent: { configurable: true, value: dom.window.CustomEvent },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    fetch: { configurable: true, value: async (url: string, init: RequestInit = {}) => {
      requests.push(`${init.method ?? 'GET'} ${url}`);
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { origin?: string };
        return body.origin
          ? reply({ id: 'fixture-link', url: `${body.origin}/phone-upload#fixture`, expiresAt: Date.now() + 300_000 }, 201)
          : reply({ origins: ['http://192.0.2.10:3019', 'http://100.64.0.10:3019'], verified: { 'http://100.64.0.10:3019': lastWorked } });
      }
      return reply({ files: [], closed: false, ...(uploaded ? { verifiedAt: lastWorked + 60_000 } : {}) });
    } },
  });
  const { useAppStore } = await import('../stores/appStore');
  const { PhoneUploadWindow } = await import('./PhoneUpload');
  useAppStore.setState({ jobs: { 'phone-fixture': job({ messages: [], reviews: [], handoffs: [] } as Partial<JobState>) } });
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(PhoneUploadWindow)); });
    const trigger = dom.window.document.createElement('button');
    dom.window.document.body.append(trigger);
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.CustomEvent('arco:open-phone-upload', { detail: { workflowId: 'phone-fixture', trigger } }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const panel = dom.window.document.querySelector('[data-testid="phone-upload-window"]')!;
    const routes = [...panel.querySelectorAll('button')].filter((button) => button.textContent?.startsWith('http://'));
    assert.deepEqual(routes.map((button) => button.textContent), [
      'http://192.0.2.10:3019 UNVERIFIED',
      `http://100.64.0.10:3019 VERIFIED BY UPLOAD Last worked ${new Date(lastWorked).toLocaleString()}`,
    ]);
    // Address, mark and time each take their own line.
    assert.deepEqual([...routes[1].querySelector('.phone-upload-route-label')!.children].map((line) => line.className),
      ['phone-upload-address', 'phone-upload-verified', 'phone-upload-last-worked']);
    const info = panel.querySelector('details.phone-upload-info');
    assert.equal(info?.querySelector('summary')?.textContent, 'More info');
    assert.match(info?.textContent ?? '', /settings can change/);
    assert.match(info?.textContent ?? '', /firewall allows incoming connections/);

    await act(async () => { routes[0].click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.ok(panel.querySelector('img'), 'the chosen route still produces a code');
    assert.equal(panel.querySelector('.phone-upload-route')?.textContent, 'http://192.0.2.10:3019 UNVERIFIED');
    // Troubleshooting appears once, in More info, with no route-specific footer.
    assert.equal(panel.querySelectorAll('details.phone-upload-info').length, 1);
    assert.doesNotMatch(panel.textContent ?? '', /tailnet|Node\.js/);
    // The open code's own polling shows the route verified once a file arrives.
    uploaded = true;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });
    assert.equal(panel.querySelector('.phone-upload-route')?.textContent,
      `http://192.0.2.10:3019 VERIFIED BY UPLOAD Last worked ${new Date(lastWorked + 60_000).toLocaleString()}`);
    assert.equal(requests.filter((request) => request.startsWith('POST')).length, 2);
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
