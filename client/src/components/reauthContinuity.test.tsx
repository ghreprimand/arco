import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { ArcoSettings, AuthStatusByProvider, ClaudeCredentialBinding, ClaudeNativeAuthFlow } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useDraftStore } from '../stores/draftStore';
import { AuthReloginNotice } from './AuthReloginNotice';
import { useNativeLoginStore } from '../hooks/useClaudeNativeLogin';
import { ClaudeNativeAuthRow } from './ClaudeNativeAuthRow';

async function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const descriptors = Object.getOwnPropertyDescriptors(globalThis), before = useAppStore.getState();
  const drafts = useDraftStore.getState(), storage = useAppStore.persist.getOptions().storage;
  const calls: string[] = [], bodies: unknown[] = [], intervals = new Map<number, () => void>();
  let nextInterval = 0, flowCounter = 0;
  const control: { flow?: ClaudeNativeAuthFlow; onFlow?: () => Promise<Response>; onAuth?: () => Promise<Response> } = {};
  useNativeLoginStore.setState({ sessions: {} });
  const binding: ClaudeCredentialBinding = { source: 'claude-native', storeId: 'claude.native', revision: 'rejected-fixture' };
  const native = { state: 'needs-attention', credentialsPresent: true, loggedIn: true, execution: 'unverified', binding, checkedAt: Date.now() };
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window }, document: { configurable: true, value: dom.window.document },
    localStorage: { configurable: true, value: dom.window.localStorage }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    setInterval: { configurable: true, value: (fn: () => void) => { const id = ++nextInterval; intervals.set(id, fn); return id; } },
    clearInterval: { configurable: true, value: (id: number) => { intervals.delete(id); } },
    fetch: { configurable: true, value: async (url: string, init?: RequestInit) => {
      calls.push(url);
      const reply = (data: unknown) => new Response(JSON.stringify(data));
      if (url.endsWith('/login')) {
        const body = JSON.parse(String(init?.body)); bodies.push(body);
        control.flow = { id: `fixture-flow-${++flowCounter}`, status: 'pending', workflowId: body.workflowId,
          bindingBefore: binding, startedAt: Date.now(), expiresAt: Date.now() + 600_000 };
        return reply({ authorizationUrl: 'https://example.com/authorize', flow: control.flow });
      }
      if (url.includes('/flow?')) {
        if (init?.method === 'DELETE') control.flow = { ...control.flow!, status: 'cancelled' };
        if (control.onFlow) return control.onFlow();
        return reply({ flow: control.flow });
      }
      if (url === '/api/auth/claude-native') return reply(native);
      if (url === '/api/auth-status') return control.onAuth ? control.onAuth() : reply(auth());
      if (url.startsWith('/api/usage')) return reply({ session: null, weekly: null, fetchedAt: Date.now(), source: 'claude-native', binding: native.binding, credentialContext: { native: native.binding, cli: { source: 'claude-cli', storeId: 'claude-cli-default' } }, available: false });
      return reply({ started: false, command: 'fixture login' });
    } },
  });
  const auth = () => ({ claude: { loggedIn: true, native, cli: { loggedIn: false, binding: { source: 'claude-cli', storeId: 'claude-cli-default' }, bindingCheckedAt: Date.now() } } }) as unknown as AuthStatusByProvider;
  dom.window.open = () => null;
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  useAppStore.setState({ jobs: {}, activeJobId: null, settings: { claude: { transport: 'native' } } as ArcoSettings, authStatus: auth() });
  for (const [id, transport] of [['origin', 'native'], ['other', 'cli']] as const) useAppStore.getState().createJob(id, {
    name: id, workingDirectory: '/projects/fixture', primaryProvider: 'claude', primaryModel: 'fixture', primaryEffort: 'low', skipPermissions: false, claudeTransport: transport,
  });
  useDraftStore.getState().setDraft('origin', 'Review the partially completed operation before sending again.');
  useAppStore.setState({ attachments: { origin: [{ isImage: false, filename: 'fixture.txt', path: '/projects/fixture/fixture.txt' }] } });
  const savedAttachments = JSON.stringify(useAppStore.getState().attachments);
  const savedDrafts = JSON.stringify(useDraftStore.getState().drafts);
  const root = createRoot(dom.window.document.getElementById('root')!);
  return { dom, calls, bodies, intervals, root, control, native, auth, binding,
    tick: async () => { await act(async () => { for (const fn of [...intervals.values()]) fn(); await new Promise(resolve => setImmediate(resolve)); }); },
    complete: () => { native.binding = { ...binding, revision: 'replacement-fixture' }; native.state = 'present'; native.checkedAt = Date.now(); control.flow = { ...control.flow!, status: 'complete', binding: native.binding }; },
    text: () => dom.window.document.body.textContent!,
    click: async (text: string) => {
    const button = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent?.includes(text)); assert.ok(button, text);
    await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  }, close: async () => {
    assert.equal(JSON.stringify(useDraftStore.getState().drafts), savedDrafts);
    assert.equal(JSON.stringify(useAppStore.getState().attachments), savedAttachments);
    await act(async () => root.unmount()); useAppStore.setState(before, true); useDraftStore.setState(drafts, true); useNativeLoginStore.setState({ sessions: {} }); useAppStore.persist.setOptions({ storage });
    for (const key of ['window', 'document', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'setInterval', 'clearInterval']) {
      if (descriptors[key]) Object.defineProperty(globalThis, key, descriptors[key]); else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  } };
}

test('an old Native notice recovers its originating workflow while a CLI tab is active', async () => {
  const f = await fixture();
  try {
    await act(async () => f.root.render(createElement(AuthReloginNotice, { provider: 'claude', body: 'Fixture rejected grant', workflowId: 'origin', messageId: 'notice-origin' })));
    await f.click('RE-LOGIN');
    assert.ok(f.calls.includes('/api/auth/claude-native/login'), 'Origin Native recovery must not use the active CLI tab');
    assert.ok(!f.calls.some(url => url.startsWith('/api/auth-login')));
    assert.equal(useAppStore.getState().activeJobId, 'other');
  } finally { await f.close(); }
});

test('Settings keeps tracking callback completion when a rejected grant remains present', async () => {
  const f = await fixture();
  try {
    await act(async () => f.root.render(createElement(ClaudeNativeAuthRow)));
    await f.click('LOGIN');
    assert.ok(f.intervals.size > 0, 'Credential presence must not disable recovery completion polling');
  } finally { await f.close(); }
});


test('Settings detects local callback completion, clears paste controls and refreshes the binding', async () => {
  const f = await fixture();
  try {
    await act(async () => f.root.render(createElement(ClaudeNativeAuthRow)));
    await f.click('LOGIN'); await f.tick();
    assert.ok(f.dom.window.document.querySelector('input'));
    f.complete(); await f.tick();
    assert.match(f.text(), /Sign-in flow: complete/); assert.equal(f.dom.window.document.querySelector('input'), null);
    assert.equal(useAppStore.getState().authStatus?.claude.native?.binding.revision, 'replacement-fixture');
    assert.ok(f.calls.includes('/api/usage?force=1'));
  } finally { await f.close(); }
});

test('only the matching notice completes and explicit continuation returns to the origin without sending', async () => {
  const f = await fixture();
  const notice = (id: string, body: string) => createElement(AuthReloginNotice, { provider: 'claude', body, workflowId: 'origin', messageId: id, key: id } as const);
  try {
    await act(async () => f.root.render(createElement(Fragment, null, notice('one', 'First rejected grant'), notice('two', 'Second recovery remains separate'))));
    await f.click('RE-LOGIN'); f.complete(); await f.tick();
    assert.match(f.text(), /Second recovery remains separate/);
    assert.equal(useAppStore.getState().activeJobId, 'other');
    assert.equal(f.dom.window.document.querySelectorAll('button').length, 2);
    await f.click('REVIEW ORIGINAL WORKFLOW');
    assert.equal(useAppStore.getState().activeJobId, 'origin');
    assert.ok(f.calls.every(url => url.startsWith('/api/auth') || url.startsWith('/api/usage')));
    assert.match(f.text(), /Execution: idle/); assert.match(f.text(), /nothing was replayed/);
    assert.deepEqual(f.bodies, [{ binding: f.binding, workflowId: 'origin' }]);
  } finally { await f.close(); }
});

for (const status of ['cancelled', 'expired', 'superseded', 'failed'] as const) test(`${status} flow cannot clear the recovery notice`, async () => {
  const f = await fixture();
  try {
    await act(async () => f.root.render(createElement(AuthReloginNotice, { provider: 'claude', body: 'Original rejection', workflowId: 'origin', messageId: status })));
    await f.click('RE-LOGIN'); f.control.flow = { ...f.control.flow!, status }; await f.tick();
    assert.match(f.text(), /Original rejection/); assert.doesNotMatch(f.text(), /REVIEW ORIGINAL WORKFLOW/);
    assert.match(f.text(), new RegExp(`Sign-in flow: ${status}`));
  } finally { await f.close(); }
});

test('late old flow result is ignored after a newer sign-in starts', async () => {
  const f = await fixture(); let release!: (value: Response) => void;
  try {
    await act(async () => f.root.render(createElement(AuthReloginNotice, { provider: 'claude', body: 'Origin', workflowId: 'origin', messageId: 'late' })));
    await f.click('RE-LOGIN'); const old = f.control.flow!;
    f.control.onFlow = () => new Promise(resolve => { release = resolve; }); await f.tick();
    await f.click('RE-LOGIN'); assert.notEqual(f.control.flow?.id, old.id);
    await act(async () => { release(new Response(JSON.stringify({ flow: { ...old, status: 'complete', binding: { ...f.binding, revision: 'obsolete' } } }))); });
    assert.doesNotMatch(f.text(), /REVIEW ORIGINAL WORKFLOW/);
    assert.ok(!f.calls.includes('/api/auth-status'));
  } finally { await f.close(); }
});

test('a late auth refresh from a superseded flow cannot replace current client status', async () => {
  const f = await fixture(); let release!: (value: Response) => void;
  try {
    await act(async () => f.root.render(createElement(AuthReloginNotice, { provider: 'claude', body: 'Origin', workflowId: 'origin', messageId: 'late-auth' })));
    await f.click('RE-LOGIN'); f.complete();
    f.control.onAuth = () => new Promise(resolve => { release = resolve; }); await f.tick();
    await f.click('RE-LOGIN');
    const before = useAppStore.getState().authStatus;
    await act(async () => { release(new Response(JSON.stringify(f.auth()))); });
    assert.equal(useAppStore.getState().authStatus, before); assert.doesNotMatch(f.text(), /REVIEW ORIGINAL WORKFLOW/);
  } finally { await f.close(); }
});

test('explicit CLI notice and a later workflow transport change retain the original recovery source', async () => {
  const f = await fixture();
  try {
    await act(async () => f.root.render(createElement(AuthReloginNotice, { provider: 'claude', body: 'CLI-specific notice', workflowId: 'origin', messageId: 'cli', authRecovery: { transport: 'cli' } })));
    await f.click('RE-LOGIN'); assert.ok(f.calls.includes('/api/auth-login?provider=claude'));
    assert.ok(!f.calls.includes('/api/auth/claude-native/login'));
  } finally { await f.close(); }
});


test('a Settings flow supersedes an inline completion refresh that is still in flight', async () => {
  const f = await fixture(); let release!: (value: Response) => void;
  const notice = createElement(AuthReloginNotice, { key: 'notice', provider: 'claude', body: 'Original rejection', workflowId: 'origin', messageId: 'cross-owner' });
  try {
    await act(async () => f.root.render(createElement(Fragment, null, notice)));
    await f.click('RE-LOGIN'); f.complete();
    const response = JSON.stringify(f.auth());
    f.control.onAuth = () => new Promise(resolve => { release = resolve; }); await f.tick();
    f.native.state = 'needs-attention';
    await act(async () => f.root.render(createElement(Fragment, null, notice, createElement(ClaudeNativeAuthRow, { key: 'settings' }))));
    const login = [...f.dom.window.document.querySelectorAll('button')].find(b => b.textContent === 'LOGIN')!; assert.ok(login);
    await act(async () => { login.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })); });
    const before = useAppStore.getState().authStatus;
    await act(async () => { release(new Response(response)); });
    assert.equal(useAppStore.getState().authStatus, before); assert.doesNotMatch(f.text(), /REVIEW ORIGINAL WORKFLOW/);
    assert.match(f.text(), /Sign-in flow: superseded/);
  } finally { await f.close(); }
});

test('newer observed credentials fence a delayed completion status from another binding', async () => {
  const f = await fixture(); let release!: (value: Response) => void;
  try {
    await act(async () => f.root.render(createElement(AuthReloginNotice, { provider: 'claude', body: 'Origin', workflowId: 'origin', messageId: 'newer-observation' })));
    await f.click('RE-LOGIN'); f.complete();
    const response = JSON.stringify(f.auth());
    f.control.onAuth = () => new Promise(resolve => { release = resolve; }); await f.tick();
    const newer = JSON.parse(response) as AuthStatusByProvider;
    newer.claude.native = { ...newer.claude.native!, binding: { ...f.binding, revision: 'newer-observation' }, checkedAt: Date.now() + 1000 };
    await act(async () => { useAppStore.getState().setAuthStatus(newer); release(new Response(response)); });
    assert.equal(useAppStore.getState().authStatus, newer); assert.doesNotMatch(f.text(), /REVIEW ORIGINAL WORKFLOW/);
  } finally { await f.close(); }
});


test('Codex recovery retains the originating account profile without changing its transport or sending work', async () => {
  const f = await fixture();
  try {
    const jobs = useAppStore.getState().jobs;
    useAppStore.setState({ jobs: { ...jobs, origin: { ...jobs.origin, config: { ...jobs.origin.config, providerAccountRef: 'origin-account' } } } });
    await act(async () => f.root.render(createElement(AuthReloginNotice, { provider: 'codex', body: 'Codex fixture notice', workflowId: 'origin', messageId: 'codex-origin' })));
    await f.click('RE-LOGIN');
    assert.ok(f.calls.includes('/api/auth-login?provider=codex&account=origin-account'));
    assert.match(f.text(), /Sign-in completion is not verified here/);
    await f.click('REVIEW ORIGINAL WORKFLOW'); assert.equal(useAppStore.getState().activeJobId, 'origin');
  } finally { await f.close(); }
});
