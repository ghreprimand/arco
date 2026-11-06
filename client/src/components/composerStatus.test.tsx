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
  } finally {
    await act(async () => { root.unmount(); });
  }
});
