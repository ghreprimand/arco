import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ArcoSettings, AuthStatus, AuthStatusByProvider, ClaudeNativeAuthStatus } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useStartupStore } from '../stores/startupStore';
import { UsageBar } from './UsageBar';
import { claudeAuthPresentation, selectedClaudeTransport } from '../utils/claudeAuth';

function status(native: ClaudeNativeAuthStatus['state'], cli: boolean): AuthStatus {
  const credentialsPresent = native !== 'missing' && native !== 'unknown';
  return {
    loggedIn: cli || credentialsPresent,
    native: { state: native, credentialsPresent, execution: 'unverified', checkedAt: Date.now(), binding: { source: 'claude-native', storeId: 'claude.native' } },
    cli: { loggedIn: cli, checkedAt: Date.now(), binding: { source: 'claude-cli', storeId: 'claude-cli-default' } },
  };
}

async function fixture(auth: AuthStatus, transport: 'native' | 'cli' = 'native', enabled = true, others: Partial<AuthStatusByProvider> = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  const requests: string[] = [];
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window }, document: { configurable: true, value: dom.window.document },
    localStorage: { configurable: true, value: dom.window.localStorage }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    fetch: { configurable: true, value: async (url: string) => {
      requests.push(url);
      throw new Error(`no request expected: ${url}`);
    } },
  });
  const before = useAppStore.getState(), startup = useStartupStore.getState();
  const storage = useAppStore.persist.getOptions().storage;
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const providers = Object.fromEntries(['claude', 'codex', 'cursor', 'ollama', 'github', 'llamacpp', 'lmstudio', 'strata', 'deepseek'].map(id => [id, id === 'claude' ? auth : { loggedIn: false }])) as unknown as AuthStatusByProvider;
  Object.assign(providers, others);
  useAppStore.setState({ authStatus: providers, jobs: {}, activeJobId: null, showSettings: false, settings: { claude: { transport }, enabledProviders: { claude: enabled, codex: 'codex' in others, cursor: 'cursor' in others, ollama: false } } as ArcoSettings });
  useAppStore.getState().createJob('fixture', { name: 'Saved fixture', workingDirectory: '/projects/fixture', primaryProvider: 'claude', primaryModel: 'fixture', primaryEffort: 'low', skipPermissions: false, claudeTransport: transport });
  const saved = JSON.stringify(useAppStore.getState().jobs.fixture.config);
  const root = createRoot(dom.window.document.getElementById('root')!);
  await act(async () => root.render(createElement(UsageBar, { usage: { session: null, weekly: null, fetchedAt: Date.now(), subscriptionType: null, error: 'fixture meter unavailable' } })));
  return {
    dom, requests,
    text: () => dom.window.document.body.textContent!,
    click: async (button: Element) => { await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))); },
    close: async () => {
      assert.equal(JSON.stringify(useAppStore.getState().jobs.fixture.config), saved);
      await act(async () => root.unmount());
      useAppStore.setState(before, true); useStartupStore.setState(startup, true); useAppStore.persist.setOptions({ storage });
      for (const name of ['window', 'document', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT', 'fetch']) {
        if (globals[name]) Object.defineProperty(globalThis, name, globals[name]); else Reflect.deleteProperty(globalThis, name);
      }
      dom.window.close();
    },
  };
}

test('Native credentials with CLI signed out keep the dot and avoid a false Native logout warning', async () => {
  const f = await fixture(status('present', false));
  try {
    assert.doesNotMatch(f.text(), /AUTH:/);
    const dot = f.dom.window.document.querySelector<HTMLAnchorElement>('a[aria-label="Claude usage page"]')!; assert.ok(dot);
    await act(async () => dot.focus());
    assert.match(f.text(), /Claude/);
    assert.doesNotMatch(f.text(), /Native: Credentials present|CLI: Signed out|Allowance/);
    assert.match(dot.getAttribute('title') ?? dot.querySelector('span')?.getAttribute('title') ?? f.text(), /Native|Claude/);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

// Opens Connections at the provider; the indicator is the only recovery
// control, with no second warning chip and no login request of its own.
async function opensConnections(f: Awaited<ReturnType<typeof fixture>>, provider: string, label: RegExp) {
  const dot = f.dom.window.document.querySelector<HTMLButtonElement>(`button[data-testid="provider-dot"][data-provider="${provider}"]`)!;
  assert.ok(dot, `${provider} indicator`);
  assert.match(dot.getAttribute('aria-label') ?? '', label);
  assert.equal(dot.getAttribute('title'), dot.getAttribute('aria-label'));
  await f.click(dot);
  assert.equal(useStartupStore.getState().setupOpen, true);
  assert.equal(useStartupStore.getState().setupProvider, provider);
  assert.doesNotMatch(f.text(), /AUTH:/);
  assert.equal(f.requests.length, 0);
}

for (const native of ['missing', 'needs-attention'] as const) {
  test(`CLI sign-in with Native ${native}: the Claude indicator opens Connections`, async () => {
    const f = await fixture(status(native, true));
    try { await opensConnections(f, 'claude', /^Claude: Native sign-in (needed|needs attention)\. Open Connections/); }
    finally { await f.close(); }
  });
}

test('a saved CLI transport that is signed out: the Claude indicator says so and opens Connections', async () => {
  const f = await fixture(status('present', false), 'cli');
  try { await opensConnections(f, 'claude', /^Claude: CLI signed out/); }
  finally { await f.close(); }
});

test('disabled Claude has no indicator at all', async () => {
  const f = await fixture(status('needs-attention', true), 'native', false);
  try { assert.doesNotMatch(f.text(), /AUTH:/); assert.equal(f.dom.window.document.querySelector('[data-provider="claude"], a'), null); }
  finally { await f.close(); }
});

test('enabled Codex and Cursor stay in the top bar signed out; a failed probe is not a sign-out', async () => {
  const f = await fixture(status('present', false), 'native', true, {
    codex: { loggedIn: false },
    cursor: { loggedIn: false, probeFailed: true, error: 'Cursor keeps its sign-in in the system keyring, which is locked.' },
  });
  try {
    await opensConnections(f, 'codex', /^Codex: sign-in needed\. Open Connections/);
    // A finished check that could not read the keyring is unknown, not signed
    // out, and still leads to its recovery step.
    await opensConnections(f, 'cursor', /^Cursor: status unknown: .*locked\..*Open Connections/);
    assert.equal(f.dom.window.document.querySelector('[data-provider="cursor"]')!.getAttribute('data-state'), 'unknown');
  } finally { await f.close(); }
});

test('both, neither, failed probes and stale state retain transport-specific meaning', () => {
  assert.equal(selectedClaudeTransport('native', 'native', true), 'cli');
  assert.equal(selectedClaudeTransport('native', 'cli'), 'native');
  assert.equal(selectedClaudeTransport(undefined, 'cli'), 'cli');
  assert.equal(claudeAuthPresentation(status('present', true), 'native').attention, undefined);
  assert.equal(claudeAuthPresentation(status('missing', false), 'native').attention, 'native');
  assert.equal(claudeAuthPresentation(status('missing', false), 'cli').attention, 'cli');
  const unknown = status('present', false); unknown.cli!.probeFailed = true; unknown.native!.probeFailed = true; unknown.native!.stale = true;
  assert.equal(claudeAuthPresentation(unknown, 'native').attention, undefined);
  assert.equal(claudeAuthPresentation(unknown, 'cli').attention, undefined);
  assert.match(claudeAuthPresentation(unknown, 'native').nativeText, /unknown.*stale/);
  const stale = status('needs-attention', false); stale.native!.checkedAt = 1; stale.cli!.checkedAt = 1;
  assert.equal(claudeAuthPresentation(stale, 'native').attention, undefined);
  assert.equal(claudeAuthPresentation(stale, 'cli').attention, undefined);
  assert.equal(claudeAuthPresentation({ loggedIn: false, probeFailed: true }, 'cli').attention, undefined);
  assert.equal(claudeAuthPresentation({ loggedIn: true }, 'cli').attention, undefined);
});
