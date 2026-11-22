import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { registerHooks } from 'node:module';
const styles = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: 'export default {};', shortCircuit: true } : next(url, context); } });
const { ProvidersPopover } = await import('./ProvidersPopover');
styles.deregister();
const ClosedPanel = () => <ProvidersPopover open={false} />;
import { HeaderDropdown } from './HeaderDropdown';
import { useProviderHover } from './providerPanelState';
import { useAppStore } from '../stores/appStore';

function HoverProbe() {
  const [open, setOpen] = useProviderHover();
  return createElement('button', { id: 'hover', onMouseOver: () => setOpen(true) }, open ? 'hover shown' : 'hover hidden');
}

test('versions targets header menus, preserves drafts, and suppresses hovers across instances', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  const names = ['window', 'document', 'Element', 'Node', 'KeyboardEvent', 'getComputedStyle', 'ResizeObserver', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'];
  const before = useAppStore.getState();
  const storage = useAppStore.persist.getOptions().storage;
  const values = { window: dom.window, document: dom.window.document, Element: dom.window.Element, Node: dom.window.Node,
    KeyboardEvent: dom.window.KeyboardEvent, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ResizeObserver: class { observe() {} disconnect() {} }, fetch: async () => new Response('{}', { status: 503 }), IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  useAppStore.setState({ settings: null, authStatus: null, capabilities: null,
    llamacppLive: { fetchedAt: 0, up: true, version: '0.9.0-dev (build 12110, commit cd959bae9)', loadedModel: null, port: undefined, pid: undefined } });
  const root = createRoot(document.getElementById('root')!);
  let keys = 0;
  document.addEventListener('keydown', () => { keys++; });
  const render = async (second: boolean) => act(async () => root.render(createElement(Fragment, null,
    createElement(HeaderDropdown, { label: 'TOOLS', icon: '+', items: [{ key: 'item', label: 'fixture action', icon: '+', onClick() {} }] }),
    createElement('section', { role: 'dialog', 'aria-label': 'Settings' }, createElement('input', { defaultValue: 'half-typed draft' }), createElement(ProvidersPopover, { key: 'main' })),
    createElement(HoverProbe), second ? createElement(ClosedPanel, { key: 'other' }) : null)));
  const hover = async () => act(async () => document.getElementById('hover')!.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })));
  try {
    await render(false);
    const menu = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('TOOLS'))!;
    await act(async () => menu.click());
    assert.ok(document.body.textContent?.includes('fixture action'));
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Provider versions"]')!;
    await act(async () => trigger.click());
    assert.equal(document.body.textContent?.includes('fixture action'), false, 'opening versions closes the header dropdown');
    assert.equal(keys, 0, 'opening versions never dispatches a keyboard event');
    assert.equal(document.querySelector('input')?.value, 'half-typed draft');
    assert.ok(document.querySelector('[aria-label="Settings"]'));
    const chip = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent?.includes('LLAMA'))!;
    assert.ok(chip.textContent?.includes('0.9.0-dev (build 12110, commit cd959bae9)'));
    assert.ok(chip.title.includes('0.9.0-dev (build 12110, commit cd959bae9)'));
    assert.doesNotMatch(chip.title + chip.textContent + chip.getAttribute('aria-label'), /build b|b0\.9\.0/);
    await render(true);
    await hover();
    assert.equal(document.getElementById('hover')?.textContent, 'hover hidden', 'mounting a closed second panel keeps suppression');
    await render(false);
    await hover();
    assert.equal(document.getElementById('hover')?.textContent, 'hover hidden', 'unmounting a closed second panel keeps suppression');
    await act(async () => trigger.click());
    await hover();
    assert.equal(document.getElementById('hover')?.textContent, 'hover shown', 'last open panel releases suppression');
  } finally {
    await act(async () => root.unmount());
    useAppStore.setState(before, true);
    useAppStore.persist.setOptions({ storage });
    for (const key of names) { if (saved[key]) Object.defineProperty(globalThis, key, saved[key]); else Reflect.deleteProperty(globalThis, key); }
    dom.window.close();
  }
});

test('update chips clear after six seconds while honest notices and failures stay pinned', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  const before = useAppStore.getState();
  const storage = useAppStore.persist.getOptions().storage;
  let reply: Record<string, unknown> = {};
  const values = { window: dom.window, document: dom.window.document, Element: dom.window.Element, Node: dom.window.Node,
    KeyboardEvent: dom.window.KeyboardEvent, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async (url: string) => url.includes('check-updates') ? Response.json(reply) : new Response('{}', { status: 503 }),
    IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  useAppStore.setState({ settings: null, authStatus: null, capabilities: { codexVersion: '0.169.0' } as never,
    ollamaLive: null, llamacppLive: null });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<ProvidersPopover open />));
    const chip = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent?.includes('CODEX'))!;
    const result = () => chip.lastElementChild?.textContent;
    for (const [outcome, expected] of [['updated', '→ v0.169.0'], ['current', 'v0.169.0 (latest)']] as const) {
      reply = { outcome, currentVersion: '0.169.0', message: 'Full successful result.' };
      await act(async () => chip.click());
      assert.equal(result(), expected);
      await act(async () => t.mock.timers.tick(5999));
      assert.equal(result(), expected);
      await act(async () => t.mock.timers.tick(1));
      assert.equal(result(), 'v0.169.0');
    }
    for (const outcome of ['unchanged', 'deferred', 'manual']) {
      const message = outcome === 'manual' ? 'Run codex update in a terminal.' : 'A newer version is still available.';
      reply = { outcome, currentVersion: '0.169.0', message };
      await act(async () => chip.click());
      assert.equal(result(), 'v0.169.0 (!)');
      assert.equal(chip.title, message);
      assert.match(chip.lastElementChild?.getAttribute('style') ?? '', /var\(--color-warning\)/);
      await act(async () => t.mock.timers.tick(6000));
      assert.equal(result(), 'v0.169.0 (!)');
    }
    reply = { outcome: 'failed', currentVersion: '0.169.0', error: 'Updater exited with an error.' };
    await act(async () => chip.click());
    assert.equal(result(), 'FAILED');
    assert.equal(chip.title, reply.error);
    assert.match(chip.lastElementChild?.getAttribute('style') ?? '', /var\(--color-danger\)/);
    await act(async () => t.mock.timers.tick(6000));
    assert.equal(result(), 'FAILED');
    reply = { currentVersion: '0.169.0' };
    await act(async () => chip.click());
    assert.equal(result(), 'v0.169.0 (!)', 'an absent server outcome never confirms latest');
  } finally {
    await act(async () => root.unmount());
    t.mock.timers.reset();
    useAppStore.setState(before, true);
    useAppStore.persist.setOptions({ storage });
    for (const key of Object.keys(values)) { if (saved[key]) Object.defineProperty(globalThis, key, saved[key]); else Reflect.deleteProperty(globalThis, key); }
    dom.window.close();
  }
});


test('Cursor row updates through its own route, keeps a separate changelog and remains usable without latest metadata', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = Object.getOwnPropertyDescriptors(globalThis), before = useAppStore.getState();
  const storage = useAppStore.persist.getOptions().storage;
  const old = '2026.07.09-abcdef0', latest = '2026.11.13-eacade1';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests: string[] = [];
  let reply: Record<string, unknown> = { outcome: 'updated', currentVersion: latest, capabilities: { cursorVersion: latest, latestVersions: { cursor: latest } } };
  const values = { window: dom.window, document: dom.window.document, Element: dom.window.Element, Node: dom.window.Node,
    KeyboardEvent: dom.window.KeyboardEvent, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string) => { if (!url.includes('check-updates')) return new Response('{}', { status: 503 }); requests.push(url); return Response.json(reply); } };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  useAppStore.setState({ settings: null, authStatus: null, ollamaLive: null, llamacppLive: null, localRuntimeStatus: null,
    capabilities: { cursorVersion: old, latestVersions: { cursor: latest } } as never });
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<ProvidersPopover open />));
    const chip = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent?.includes('CURSOR'))!;
    assert.match(chip.title, /available.*cursor-agent update/);
    const changelog = document.querySelector<HTMLAnchorElement>('[aria-label="Cursor CLI changelog"]')!;
    assert.equal(changelog.href, 'https://cursor.com/docs/cli/changelog');
    assert.equal(changelog.closest('button'), null);
    await act(async () => chip.click());
    assert.deepEqual(requests, ['/api/check-updates?provider=cursor']);
    assert.match(chip.textContent ?? '', new RegExp(`→ v${latest.replaceAll('.', '\\.')}`));
    assert.doesNotMatch(chip.title, /available/);
    await act(async () => useAppStore.getState().setCapabilities({ cursorVersion: latest } as never));
    reply = { outcome: 'unchanged', currentVersion: latest, message: 'Cursor did not change; the latest version is unknown.' };
    await act(async () => chip.click());
    assert.equal(requests.length, 2, 'metadata failure must not disable updating');
    assert.match(chip.title, /latest version is unknown/);
    assert.doesNotMatch(chip.textContent ?? '', /\(latest\)/);
    reply = { outcome: 'failed', error: 'Cursor update failed: fixture permission denied' };
    await act(async () => chip.click());
    assert.match(chip.textContent ?? '', /FAILED/);
    assert.equal(chip.getAttribute('aria-label'), reply.error);
    assert.ok(document.querySelector('[aria-label="Cursor CLI changelog"]'));
  } finally {
    await act(async () => root.unmount());
    t.mock.timers.reset();
    useAppStore.setState(before, true); useAppStore.persist.setOptions({ storage });
    for (const key of Object.keys(values)) { if (saved[key]) Object.defineProperty(globalThis, key, saved[key]); else Reflect.deleteProperty(globalThis, key); }
    dom.window.close();
  }
});

test('Antigravity version row requests its updater and shows the latest version', async t => {
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true});const saved=Object.getOwnPropertyDescriptors(globalThis);const before=useAppStore.getState();const storage=useAppStore.persist.getOptions().storage;const calls:string[]=[];
 const values={window:dom.window,document:dom.window.document,Element:dom.window.Element,Node:dom.window.Node,KeyboardEvent:dom.window.KeyboardEvent,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),ResizeObserver:class{observe(){} disconnect(){}},fetch:async(url:string)=>{calls.push(url);return url.includes('check-updates')?Response.json({outcome:'current',currentVersion:'1.5.14'}):new Response('{}',{status:503});},IS_REACT_ACT_ENVIRONMENT:true};
 for(const [key,value] of Object.entries(values))Object.defineProperty(globalThis,key,{configurable:true,value});useAppStore.persist.setOptions({storage:{getItem:()=>null,setItem(){},removeItem(){}}});useAppStore.setState({settings:null,authStatus:null,capabilities:{antigravityVersion:'1.5.13',latestVersions:{'antigravity-cli':'1.5.14'}} as never,ollamaLive:null,llamacppLive:null});
 t.mock.timers.enable({apis:['setTimeout']});const root=createRoot(document.getElementById('root')!);try{await act(async()=>root.render(<ProvidersPopover open/>));const chip=[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b=>b.textContent?.includes('ANTIGRAVITY'));assert.ok(chip);assert.match(chip.title,/1\.5\.14 available/);await act(async()=>chip.click());assert.ok(calls.includes('/api/check-updates?provider=antigravity-cli'));await act(async()=>t.mock.timers.tick(6001));}finally{await act(async()=>root.unmount());useAppStore.setState(before,true);useAppStore.persist.setOptions({storage});for(const key of Object.keys(values)){if(saved[key])Object.defineProperty(globalThis,key,saved[key]);else Reflect.deleteProperty(globalThis,key);}dom.window.close();}
});
