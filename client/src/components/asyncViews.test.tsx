import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const g = globalThis as any;
async function component(relative: string, expose = '', extra: Record<string, string> = {}) {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  g.__markdownComponent = (await import('react-markdown')).default;
  g.__remark = (await import('remark-gfm')).default;
  g.__rehype = (await import('rehype-highlight')).default;
  const mocks = {
    'remark-gfm': 'module.exports=globalThis.__remark;',
    'rehype-highlight': 'module.exports=globalThis.__rehype;',
    'react-markdown': 'module.exports=globalThis.__markdownComponent;',
    appStore: 'exports.useAppStore = selector => selector(globalThis.__asyncState);',
    ...extra,
  };
  const result = await build({ stdin: { contents: await readFile(path, 'utf8') + (expose ? `\nexport { ${expose} };` : ''), resolveDir: dirname(path), sourcefile: path, loader: 'tsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    plugins: [{ name: 'synthetic-ui', setup(b) {
      b.onResolve({ filter: /.*/ }, a => {
        if (a.path.endsWith('.css')) return { path: 'empty', namespace: 'fixture' };
        const key = Object.keys(mocks).find(k => a.path === k || a.path.endsWith('/' + k));
        return key ? { path: key, namespace: 'fixture' } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: a.path === 'empty' ? '' : mocks[a.path as keyof typeof mocks] }));
    } }],
  });
  const module = { exports: {} as Record<string, React.ComponentType<any>> };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}
async function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const before = Object.getOwnPropertyDescriptors(globalThis), clock = Date.now;
  const state: any = { settings: {}, jobs: {}, connectionState: 'online', clearRecovered() {}, pushNotification() {} };
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true, __asyncState: state };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(g, key, { configurable: true, writable: true, value });
  let id = 0; const timers = new Map<number, () => void>();
  dom.window.setInterval = dom.window.setTimeout = ((fn: () => void) => { timers.set(++id, fn); return id; }) as any;
  dom.window.clearInterval = dom.window.clearTimeout = (n: number) => { timers.delete(n); };
  const scrolled: string[] = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.id); };
  const root = createRoot(document.getElementById('root')!);
  let mounted = true;
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false; } };
  return { dom, state, timers, root, unmount, scrolled,
    render: async (C: React.ComponentType<any>, props: any = {}) => { await act(async () => root.render(React.createElement(C, props))); },
    click: async (text: string) => { const b = [...document.querySelectorAll('button')].find(b => b.textContent === text); assert.ok(b, text); await act(async () => b.click()); },
    close: async () => { await unmount(); Date.now = clock; dom.window.close(); for (const key of [...Object.keys(globals), 'fetch', '__capture', '__comparison']) { if (before[key]) Object.defineProperty(g, key, before[key]); else delete g[key]; } },
  };
}
const repo = { name: 'fixture', description: '', default_branch: 'main', owner: { login: 'fixture' } };
const base = { owner: 'fixture', name: 'fixture', repo, ref: 'main', onRefChange() {} };
const b64 = (value: string) => Buffer.from(value).toString('base64');
const file = (name: string) => ({ name, content: b64(name), encoding: 'base64', size: name.length, html_url: 'https://example.com/file' });

test('B152: repository README is decoded as UTF-8', async () => {
  const f = await fixture(); const text = 'Caf\u00e9 \u65e5\u672c\u8a9e';
  g.fetch = async (url: string) => Response.json(url.includes('/readme?') ? { content: b64(text) } : url.includes('/languages') ? {} : []);
  try { const { CodeView } = await component('./GitHubPanel/CodeView.tsx'); await f.render(CodeView, base); assert.ok(document.body.textContent?.includes(text)); }
  finally { await f.close(); }
});

test('B153: late trees and README cannot overwrite the current ref', async () => {
  const f = await fixture(); const pending = new Map<string, (r: Response) => void>();
  g.fetch = (url: string) => url.includes('/tree?') || url.includes('/readme?') ? new Promise(r => pending.set(url, r)) : Promise.resolve(Response.json(url.includes('/languages') ? {} : []));
  try {
    const { CodeView } = await component('./GitHubPanel/CodeView.tsx'); await f.render(CodeView, base); await f.render(CodeView, { ...base, ref: 'next' });
    for (const ref of ['next', 'main']) await act(async () => {
      for (const [url, done] of pending) if (url.endsWith('ref=' + ref)) done(Response.json(url.includes('/tree?') ? [{ name: ref + '.txt', path: ref + '.txt', type: 'file' }] : { content: b64(ref + ' README') }));
    });
    assert.ok(document.body.textContent?.includes('next.txt')); assert.ok(document.body.textContent?.includes('next README'));
    assert.ok(!document.body.textContent?.includes('main.txt')); assert.ok(!document.body.textContent?.includes('main README'));
  } finally { await f.close(); }
});

test('B153: late file contents cannot overwrite another file', async () => {
  const f = await fixture(); const pending: Array<(r: Response) => void> = [];
  g.fetch = () => new Promise(r => pending.push(r));
  try {
    const { FileContents } = await component('./GitHubPanel/CodeView.tsx', 'FileContents');
    const props = { owner: 'fixture', name: 'fixture', refName: 'main', onBack() {}, onOpenFile() {} };
    await f.render(FileContents, { ...props, path: 'first.txt' }); await f.render(FileContents, { ...props, path: 'next.txt' });
    await act(async () => pending[1](Response.json(file('next.txt')))); await act(async () => pending[0](Response.json(file('first.txt'))));
    assert.ok(document.body.textContent?.includes('next.txt')); assert.ok(!document.body.textContent?.includes('first.txt'));
  } finally { await f.close(); }
});

test('B155: relative links separate decoded file paths from document fragments', async () => {
  const f = await fixture(); const opened: unknown[][] = [];
  try {
    const { Markdown } = await component('./GitHubPanel/shared.tsx');
    await f.render(Markdown, { value: '[Guide](../docs/a%20guide.md#install)', basePath: 'src', ghBlobBase: 'https://example.com/blob/main', onOpenRelative: (...args: unknown[]) => opened.push(args) });
    await act(async () => document.querySelector('a')!.click());
    assert.deepEqual(opened, [['docs/a guide.md', 'install']]);
  } finally { await f.close(); }
});

test('B165: memory drafts follow the selected member', async () => {
  const f = await fixture(); const sent: unknown[][] = [];
  try {
    const { CodebaseMemorySection } = await component('./RightPanel/CodebaseMemorySection.tsx');
    const props = (id: string) => ({ job: { id, config: { workingDirectory: '/projects/' + id, codebaseMemory: { attached: false, indexPath: '/indexes/' + id } } }, onAttach: (...args: unknown[]) => sent.push(args), onDetach() {} });
    await f.render(CodebaseMemorySection, props('one')); await f.render(CodebaseMemorySection, props('two'));
    assert.equal(document.querySelector<HTMLInputElement>('input[type=text]')?.value, '/indexes/two');
    await act(async () => document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
    assert.deepEqual(sent, [['two', '/indexes/two']]);
  } finally { await f.close(); }
});

test('B169: an expanded running review loads its report on completion and clears the old error', async () => {
  const f = await fixture(); let ready = false;
  g.fetch = async () => ready ? Response.json({ contents: 'Completed report' }) : new Response('', { status: 404, statusText: 'Not Found' });
  try {
    const { ReviewRow } = await component('./RightPanel/ReviewTab.tsx', 'ReviewRow', { SpawnDialog: 'exports.SpawnDialog=()=>null;', FileViewerModal: 'exports.FileViewerModal=()=>null;', FilesTab: 'exports.EmptyState=()=>null;' });
    const props = { cwd: '/projects/fixture', workflowId: 'fixture', open: true, onToggle() {}, onOpenFinding() {}, review: { reviewId: 'one', artifactName: 'report.md', startedAt: 1, reviewer: { provider: 'claude', model: 'fixture', effort: 'low' } } };
    await f.render(ReviewRow, props); ready = true;
    await f.render(ReviewRow, { ...props, review: { ...props.review, completedAt: 2 } });
    assert.ok(document.body.textContent?.includes('Completed report')); assert.ok(!document.body.textContent?.includes('Not Found'));
  } finally { await f.close(); }
});

test('B171: a silent busy worker reaches the stuck deadline without store updates', async () => {
  const f = await fixture(); let now = 1000; Date.now = () => now;
  try {
    const { RuntimeStateBanner } = await component('./RuntimeStateBanner.tsx');
    await f.render(RuntimeStateBanner, { job: { id: 'fixture', busy: true, lastPrimaryEventAt: 1000 }, onCancel() {} });
    now = 32000; await act(async () => { for (const tick of [...f.timers.values()]) tick(); });
    assert.ok(document.body.textContent?.includes('CANCEL TURN'));
  } finally { await f.close(); }
});

test('B172: services polling accepts a slow first scan and keeps one request in flight', async () => {
  const f = await fixture(); const pending: Array<(r: Response) => void> = [];
  g.fetch = () => new Promise(r => pending.push(r));
  try {
    const { ServicesTab } = await component('./ServicesTab.tsx', '', { FilesTab: 'exports.EmptyState=({text})=>text;' });
    await f.render(ServicesTab);
    await act(async () => { for (const tick of [...f.timers.values()]) tick(); });
    assert.equal(pending.length, 1);
    await act(async () => pending[0](Response.json({ services: [{ port: 5173, pid: 1, host: 'localhost', likelyWeb: true, command: 'fixture', cwd: '/projects/fixture' }], warnings: [] })));
    assert.ok(document.body.textContent?.includes('5173'));
  } finally { await f.close(); }
});

for (const label of ['TEST MICROPHONE', 'SAY A PHRASE']) for (const rapid of [false, true]) test(`B178: ${label} acquisition is owned through ${rapid ? 'rapid starts' : 'unmount'}`, async () => {
  const f = await fixture(); const pending: Array<(cap: { rate: number; stop(): void }) => void> = []; let stops = 0;
  g.__capture = () => new Promise(r => pending.push(r));
  g.fetch = async () => Response.json({ deployment: 'host', voiceHome: 'fixture', uv: { found: true }, python: { found: true }, packages: [], models: [], ready: true, install: { running: false } });
  try {
    const { VoiceSetupSettings } = await component('./VoiceSetupSettings.tsx', '', { setupAudio: 'exports.openSetupMic=(...a)=>globalThis.__capture(...a);exports.peakLevel=()=>0;exports.meterPercent=()=>0;exports.SETUP_PHRASE_SECONDS=5;' });
    await f.render(VoiceSetupSettings);
    const button = [...document.querySelectorAll('button')].find(b => b.textContent === label)!;
    await act(async () => { button.click(); if (rapid) button.click(); });
    if (rapid) assert.equal(pending.length, 1);
    await f.unmount();
    await act(async () => { for (const done of pending) done({ rate: 16000, stop: () => stops++ }); });
    assert.equal(stops, pending.length);
  } finally { await f.close(); }
});

test('B182: closing active synthesis cancels before dismissing', async () => {
  const f = await fixture(); const calls: string[] = [];
  g.__comparison = { active: { workflowId: 'fixture', compareId: 'compare', prompt: 'Fixture', raceDone: true, synthesizing: true, winnerLegIndex: 0, legs: [], panes: [] }, dismiss: () => calls.push('dismiss'), cancel: () => calls.push('cancel') };
  try {
    const { CompareOverlay } = await component('./compare/CompareOverlay.tsx', '', { compareStore: 'exports.useCompareStore=s=>s(globalThis.__comparison);exports.sendCompareCancel=()=>globalThis.__comparison.cancel();', CompareGrid: 'exports.CompareGrid=()=>null;', CompareVote: 'exports.CompareVote=()=>null;', WorkSurfaceControls: 'exports.WorkSurfaceControls=()=>null;exports.contentSurfaceSize={};' });
    await f.render(CompareOverlay);
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === 'CLOSE' || b.textContent === 'CANCEL')!.click());
    assert.deepEqual(calls, ['cancel', 'dismiss']);
  } finally { await f.close(); }
});


test('B155: a repository link fetches its decoded pathname and scrolls to its section', async () => {
  const f = await fixture(); const paths: string[] = [];
  g.fetch = async (url: string) => {
    if (url.includes('/readme?')) return Response.json({ content: b64('[Guide](docs/a%20guide.md#install)') });
    if (url.includes('/contents?')) {
      paths.push(new URL(url, 'http://localhost').searchParams.get('path')!);
      return Response.json({ ...file('a guide.md'), content: b64('# Install\n\nSteps') });
    }
    return Response.json(url.includes('/languages') ? {} : []);
  };
  try {
    const { CodeView } = await component('./GitHubPanel/CodeView.tsx'); await f.render(CodeView, base);
    await act(async () => [...document.querySelectorAll('a')].find(a => a.textContent === 'Guide')!.click());
    assert.deepEqual(paths, ['docs/a guide.md']); assert.ok(f.scrolled.includes('install'));
  } finally { await f.close(); }
});

 test('B164: Activity normalizes cached Codex input before session and row totals', async () => {
  const f = await fixture();
  try {
    const { TokenUsageSection } = await component('./RightPanel/ActivityTab.tsx', 'TokenUsageSection');
    localStorage.setItem('arco.activity.tokenUsageRowsExpanded', '1');
    const usage = [{ provider: 'codex', input: 100, output: 10, cacheRead: 80, cacheCreate: 0, turnStartedAt: 1, thinkingBytes: 0, toolResultBytes: -1 }];
    await f.render(TokenUsageSection, { usage });
    const text = document.body.textContent ?? '';
    assert.match(text, /Session · 100 prompt \(80% cached\)/);
    assert.match(text, /20 fresh · 80 cache-read/);
    assert.doesNotMatch(text, /180 prompt/);
  } finally { await f.close(); }
});

 test('B176: reconnect replaces the terminal replay instead of duplicating it', async () => {
  const f = await fixture();
  const names = ['WebSocket', 'ResizeObserver', 'requestAnimationFrame', 'getComputedStyle', '__term', '__sockets', 'setTimeout', 'clearTimeout'];
  const before = new Map(names.map(n => [n, Object.getOwnPropertyDescriptor(g, n)]));
  const timers: (() => void)[] = [];
  try {
    Object.defineProperty(f.dom.window.HTMLElement.prototype, 'clientWidth', { get: () => 800 });
    Object.defineProperty(f.dom.window.HTMLElement.prototype, 'clientHeight', { get: () => 400 });
    g.getComputedStyle = f.dom.window.getComputedStyle.bind(f.dom.window);
    g.ResizeObserver = class { observe() {} disconnect() {} };
    g.requestAnimationFrame = (fn: () => void) => fn();
    g.setTimeout = (fn: () => void) => { timers.push(fn); return timers.length; }; g.clearTimeout = () => {};
    g.__sockets = [];
    g.WebSocket = class { static OPEN = 1; readyState = 1; constructor() { g.__sockets.push(this); } send() {} close() {} };
    const { XtermView } = await component('./Terminal/XtermView.tsx', '', {
      '@xterm/xterm': `exports.Terminal = class {
        constructor() { globalThis.__term=this; this.text=''; this.options={}; this.cols=80; this.rows=24; }
        loadAddon() {} open() {} focus() {} refresh() {} dispose() {}
        onData() { return { dispose() {} }; } onSelectionChange() { return { dispose() {} }; }
        reset() { this.text=''; } write(bytes) { this.text+=bytes; }
      };`,
      '@xterm/addon-fit': 'exports.FitAddon=class {fit(){}};',
      wsSession: 'exports.ensureWsSession=async()=>{};',
      'themes/registry': 'exports.THEME_REGISTRY={};',
    });
    await f.render(XtermView, { sessionId: 'fixture-terminal' });
    const message = (socket: any) => socket.onmessage({ data: JSON.stringify({ type: 'data', bytes: 'one\r\ntwo\r\n' }) });
    const first = g.__sockets[0]; assert.ok(first);
    await act(async () => { first.onopen(); message(first); first.onclose(); });
    await act(async () => { for (const fn of timers.splice(0)) fn(); });
    const second = g.__sockets[1]; assert.ok(second);
    await act(async () => { second.onopen(); message(second); });
    assert.equal(g.__term.text, 'one\r\ntwo\r\n');
  } finally {
    await f.close();
    for (const [n, desc] of before) { if (desc) Object.defineProperty(g, n, desc); else delete g[n]; }
  }
});


test('single-tab activity rows use the cluster local clock format', async () => {
  const f = await fixture();
  try {
    const { ActivityTab } = await component('./RightPanel/ActivityTab.tsx');
    const at = 1730000000000;
    const job = { id: 'fixture', busy: true, config: { workingDirectory: '/fixture' }, activity: [
      { id: 'one', kind: 'tool_use', tool: 'Read', input: '{}', at },
      { id: 'two', kind: 'thinking', text: 'Thinking', at: at + 1000 },
      { id: 'three', kind: 'native_event', text: 'Notice', at: at + 2000 },
    ] };
    await f.render(ActivityTab, { job });
    assert.deepEqual([...document.querySelectorAll('[data-testid="activity-time"]')].map(e => e.textContent),
      [at, at + 1000, at + 2000].map(ts => new Date(ts).toLocaleTimeString()));
  } finally { await f.close(); }
});

test('context displays distinguish measured prompt from accumulated Claude usage', async () => {
  const f = await fixture();
  try {
    const { ActivityTab } = await component('./RightPanel/ActivityTab.tsx');
    const usage = [1, 2].map((turnStartedAt) => ({ provider: 'claude', input: 500_000, output: 100, cacheRead: 100_000, cacheCreate: 0, lastPromptTokens: 165_000, turnStartedAt, thinkingBytes: 0, toolResultBytes: -1 }));
    const job = { id: 'fixture', config: { primaryProvider: 'claude', workingDirectory: '/fixture' }, activity: [], turnTokenUsage: usage, contextUsage: { estimatedTokens: 165_000, windowSize: 1_000_000, percentOfWindow: 17 } };
    await f.render(ActivityTab, { job });
    assert.match(document.body.textContent ?? '', /165k ctx.*17%/i);
    assert.doesNotMatch(document.body.textContent ?? '', /330k ctx/i);
    await f.render(ActivityTab, { job: { ...job, contextUsage: undefined } });
    assert.match(document.body.textContent ?? '', /- ctx/i);
  } finally { await f.close(); }
});

test('worker badge does not call a Claude usage sum context', async () => {
  const f = await fixture();
  try {
    const { TokenBadge } = await component('./TokenBadge.tsx');
    const turnTokens = { input: 900_000, output: 100, cacheRead: 100_000, cacheCreate: 200_000 };
    await f.render(TokenBadge, { turnTokens, provider: 'claude' });
    assert.match(document.body.textContent ?? '', /-\s*ctx/i);
    assert.doesNotMatch(document.body.innerHTML, /1\.1M ctx/i);
    await f.render(TokenBadge, { turnTokens });
    assert.match(document.body.textContent ?? '', /-\s*ctx/i);
  } finally { await f.close(); }
});

test('Claude spawned-worker card and detail show unknown context without a measurement', async () => {
  const f = await fixture();
  try {
    const worker = { id: 'fixture', model: 'fable', effort: 'high', provider: 'claude', status: 'completed', task: 'Review', output: '', thinking: '', toolCalls: [], spawnedAt: 1, lastActivityAt: 1, tokens: { input: 900_000, output: 100, cacheRead: 100_000, cacheCreate: 200_000 } };
    f.state.setDetailWorker = () => {};
    f.state.detailWorker = { jobId: 'job', workerId: 'fixture' };
    f.state.jobs = { job: { workers: { fixture: worker } } };
    const { WorkerCard } = await component('./WorkerCard.tsx');
    await f.render(WorkerCard, { jobId: 'job', worker });
    assert.match(document.body.textContent ?? '', /-\s*ctx/i);
    const { WorkerDetailModal } = await component('./WorkerDetailModal.tsx');
    await f.render(WorkerDetailModal);
    assert.match(document.body.textContent ?? '', /-\s*ctx/i);
    assert.doesNotMatch(document.body.innerHTML, /1\.1M ctx/i);
  } finally { await f.close(); }
});

test('Claude spawned-worker card and detail show the helper\'s own measured context', async () => {
  const f = await fixture();
  try {
    const tokens = { input: 900_000, output: 100, cacheRead: 100_000, cacheCreate: 200_000 };
    const worker = { id: 'fixture', model: 'fable', effort: 'high', provider: 'claude', status: 'completed', task: 'Review', output: '', thinking: '', toolCalls: [], spawnedAt: 1, lastActivityAt: 1, tokens, lastPromptTokens: 120_000 };
    f.state.setDetailWorker = () => {};
    f.state.detailWorker = { jobId: 'job', workerId: 'fixture' };
    f.state.jobs = { job: { workers: { fixture: worker } } };
    const { WorkerCard } = await component('./WorkerCard.tsx');
    await f.render(WorkerCard, { jobId: 'job', worker });
    assert.match(document.body.textContent ?? '', /120k\s*ctx/i);
    assert.doesNotMatch(document.body.innerHTML, /1\.1M ctx/i);
    await f.render(WorkerCard, { jobId: 'job', worker: { ...worker, lastPromptTokens: 140_000 } });
    assert.match(document.body.textContent ?? '', /140k\s*ctx/i);
    await f.render(WorkerCard, { jobId: 'job', worker: { ...worker, lastPromptTokens: undefined } });
    assert.match(document.body.textContent ?? '', /-\s*ctx/i);
    const { WorkerDetailModal } = await component('./WorkerDetailModal.tsx');
    await f.render(WorkerDetailModal);
    assert.match(document.body.textContent ?? '', /120k\s*ctx/i);
    f.state.jobs = { job: { workers: { fixture: { ...worker, lastPromptTokens: 140_000 } } } };
    await f.render(WorkerDetailModal, { key: 'second' });
    assert.match(document.body.textContent ?? '', /140k\s*ctx/i);
    assert.doesNotMatch(document.body.innerHTML, /1\.1M ctx/i);
  } finally { await f.close(); }
});
