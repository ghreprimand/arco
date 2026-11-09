import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { applyTheme } from '../themes/apply';
import { getTheme } from '../themes/registry';
import { RecentsLens } from '../explorer/RecentsLens';
import { ArtifactsLens } from '../explorer/ArtifactsLens';
import { parseAskNotice } from './AskUserQuestionNotice';
import { CatchMeUp } from './CatchMeUp';
import { openSetupMic } from '../voice/setupAudio';
import { useAppStore } from '../stores/appStore';
import { VoiceExecutor } from '../voice/executor';
import { useVoiceStore } from '../voice/store';
import { useVoicePanelRequest } from '../voice/panels';

async function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const before = Object.getOwnPropertyDescriptors(globalThis), state = useAppStore.getState();
  const storage = useAppStore.persist.getOptions().storage;
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(document.getElementById('root')!);
  return { dom, root, render: async (node: React.ReactNode) => { await act(async () => root.render(node)); },
    click: async (name: string) => { const button = [...document.querySelectorAll('button')].find(b => b.textContent === name); assert.ok(button, name); await act(async () => button.click()); },
    close: async () => { await act(async () => root.unmount()); useAppStore.setState(state, true); useAppStore.persist.setOptions({ storage }); dom.window.close(); for (const key of [...Object.keys(globals), 'fetch', 'AudioContext']) { if (before[key]) Object.defineProperty(globalThis, key, before[key]); else Reflect.deleteProperty(globalThis, key); } },
  };
}

test('B70: switching classic themes removes optional colors from the previous theme', async () => {
  const f = await fixture();
  try {
    applyTheme(getTheme('lavender'));
    assert.ok(document.documentElement.style.getPropertyValue('--color-link'));
    document.documentElement.style.setProperty('--independent-preference', 'kept');
    applyTheme(getTheme('matrix'));
    assert.equal(document.documentElement.style.getPropertyValue('--color-link'), '');
    assert.equal(document.documentElement.style.getPropertyValue('--independent-preference'), 'kept');
  } finally { await f.close(); }
});

for (const lens of ['recents', 'artifacts']) test(`B72: ${lens} hides tree reveal for native Windows state paths`, async () => {
  const f = await fixture();
  const path = String.raw`C:\projects\fixture\.arco\workflows\run\artifacts\notes.md`;
  globalThis.fetch = async (input) => Response.json(lens === 'recents' ? (String(input).includes('/changed?') ? { entries: [{ path, name: 'notes.md', project: 'Fixture', mtime: 1, size: 20 }] } : { records: [] }) : { entries: [{ path, name: 'notes.md', cwd: String.raw`C:\projects\fixture`, project: 'Fixture', mtime: 1, size: 20, workflowId: 'run' }] });
  try {
    await f.render(createElement(lens === 'recents' ? RecentsLens : ArtifactsLens, { focusTick: 1, onOpen() {}, onRevealInTree() {} }));
    if (lens === 'recents') assert.ok([...document.querySelectorAll('span, div')].some(e => e.textContent === 'notes.md'), document.body.textContent!);
    assert.equal([...document.querySelectorAll('button')].filter(b => b.title?.includes('tree') || b.textContent?.includes('OPEN IN TREE')).length, 0);
  } finally { await f.close(); }
});

test('B74: Computer opens cluster usage', async () => {
  const f = await fixture();
  try {
    useAppStore.setState({ activeClusterId: 'fixture', clusters: { fixture: { clusterId: 'fixture', cwd: '/projects/fixture', createdAt: '', members: [], mailboxDepth: {}, taskBoardMode: 'none', taskBoardAttached: false } } });
    useVoiceStore.setState({ enabled: true });
    const executor = new VoiceExecutor({ sendMessage: () => true, cancel() {} });
    assert.equal(await executor.execute({ action: 'panel', target: '', value: 'usage' }), 'usage panel opened.');
    assert.equal(useVoicePanelRequest.getState().request?.panel, 'usage');
  } finally { useVoiceStore.setState({ enabled: false }); useVoicePanelRequest.setState({ request: null }); await f.close(); }
});

test('B76: AudioContext construction failure releases every microphone track', async () => {
  const f = await fixture(); let stopped = 0;
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }, { stop: () => stopped++ }] }) } });
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class { constructor() { throw new Error('fixture unavailable'); } } });
  try { await assert.rejects(openSetupMic(() => {}), /fixture unavailable/); assert.equal(stopped, 2); }
  finally { await f.close(); }
});

test('B139: question options preserve escaped pipes and original backslashes', () => {
  const options = ['Use A | B', String.raw`Keep C:\tools`, String.raw`Keep \| literal`, 'Trailing \\'];
  const encoded = options.map(o => o.replace(/\|/g, '\\|')).join(' | ');
  assert.deepEqual(parseAskNotice(`[ASK:claude-native:fixture] Pick one\n[ASK_OPTIONS:${encoded}]`)?.options, options);
});

test('B140: switching scope while catch-up is pending leaves the new scope ready', async () => {
  const f = await fixture(); let settle!: (value: Response) => void;
  globalThis.fetch = (url) => String(url).includes('/cancel') ? Promise.resolve(Response.json({})) : new Promise(resolve => { settle = resolve; });
  try {
    useAppStore.setState({ settings: { utilityAgent: { provider: 'ollama', model: 'fixture' } } as any });
    await f.render(createElement(CatchMeUp, { scope: { kind: 'workflow', id: 'first' } }));
    await f.click('CATCH ME UP'); await f.click('SUMMARIZE');
    await f.render(createElement(CatchMeUp, { scope: { kind: 'workflow', id: 'second' } }));
    await act(async () => settle(Response.json({ empty: true, facts: [] })));
    await f.click('CATCH ME UP');
    assert.ok([...document.querySelectorAll('button')].some(b => b.textContent === 'SUMMARIZE'));
    assert.ok(!document.body.textContent?.includes('Collecting and summarizing'));
  } finally { await f.close(); }
});
