import { registerHooks } from 'node:module';
const styles = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: 'export default {};', shortCircuit: true } : next(url, context); } });
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

test('HANDOFFS shows the saved source after tail-only hydration with no seed loaded', async () => {
 const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
 const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage, React, IS_REACT_ACT_ENVIRONMENT: true };
 const previous = new Map([...Object.keys(globals), 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
 for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
 globalThis.fetch = async () => Response.json({ currentSourceKey: 'saved', sources: [{ key: 'saved', name: 'Earlier tab', available: true, throughSeq: 50 }], nextOffset: null });
 const { createRoot } = await import('react-dom/client');
 const { useAppStore } = await import('../../stores/appStore');
 const { HandoffsTab } = await import('./HandoffsTab');
 const old = useAppStore.getState();
 useAppStore.setState({ jobs: {}, clusters: {}, handoffLocksByCwd: {} });
 useAppStore.getState().createJob('reloaded', { workingDirectory: '/fixture', name: 'Reloaded', primaryModel: 'opus', primaryEffort: 'low' } as never);
 const job = { ...useAppStore.getState().jobs.reloaded, messages: [] };
 useAppStore.setState({ jobs: { reloaded: job } });
 const root = createRoot(document.getElementById('root')!);
 try {
  await act(async () => root.render(<HandoffsTab job={job} />));
  assert.match(document.body.textContent!, /From Earlier tab/);
  assert.equal(document.querySelector('button')?.getAttribute('title'), 'Open the earlier conversation');
  const { ChatMessage } = await import('../ChatMessage');
  const older = { id: 'older', role: 'user', content: '[HANDOFF: new session initialized for this tab.]', handoffSourceKey: 'old' } as any;
  const latest = { id: 'latest', role: 'user', content: 'Brief\n\n---\n\nNew direction: Continue', handoffSourceKey: 'saved' } as any;
  useAppStore.setState({ jobs: { reloaded: { ...job, messages: [older, latest] } } });
  await act(async () => root.render(<><section id="older"><ChatMessage message={older} jobId="reloaded" /></section><section id="latest"><ChatMessage message={latest} jobId="reloaded" /></section></>));
  assert.doesNotMatch(document.getElementById('older')!.textContent!, /From Earlier tab/);
  assert.match(document.getElementById('latest')!.textContent!, /From Earlier tab/);
  const failed = { ...latest, id: 'failed', handoffSourceKey: undefined };
  await act(async () => {
   useAppStore.setState({ jobs: { reloaded: { ...job, messages: [older, failed] } } });
   root.render(<><ChatMessage message={older} jobId="reloaded" /><ChatMessage message={failed} jobId="reloaded" /></>);
  });
  assert.doesNotMatch(document.body.textContent!, /From Earlier tab/);
  const { HandoffSource } = await import('../HandoffSource');
  const { useVoicePanelOpener, useVoicePanelRequest } = await import('../../voice/panels');
  useVoicePanelRequest.setState({ request: null });
  globalThis.fetch = async input => Response.json(String(input).includes('&source=')
   ? { workflowId: 'reloaded', config: job.config }
   : { currentSourceKey: 'saved', sources: [{ key: 'saved', name: 'Earlier tab', available: true, throughSeq: 50 }] });
  function NarrowContainer() {
   const [open, setOpen] = React.useState(false);
   useVoicePanelOpener('reloaded', true, () => setOpen(true));
   return <><HandoffSource workflowId="reloaded" />{open && <div data-testid="history-drawer"><button onClick={() => setOpen(false)}>Close drawer</button>History boundary</div>}</>;
  }
  await act(async () => root.render(<NarrowContainer />));
  for (let attempt = 0; attempt < 2; attempt++) {
   const from = [...document.querySelectorAll('button')].find(button => button.textContent === 'From Earlier tab')!;
   await act(async () => from.click());
   assert.ok(document.querySelector('[data-testid="history-drawer"]'));
   assert.equal(useVoicePanelRequest.getState().request?.throughSeq, 50);
   await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Close drawer')!.click());
   assert.equal(document.querySelector('[data-testid="history-drawer"]'), null);
  }


 } finally {
  styles.deregister(); await act(async () => root.unmount()); useAppStore.setState(old); dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
 }
});
