import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthStatusByProvider } from '@arco/shared';
import { defaultComputerSelection } from './computerAvailability';
import type { ModelCatalogs } from './modelCatalog';

const catalogs: ModelCatalogs = { claude: null, codex: null, cursor: null, ollamaModels: ['fixture-local'], strataModels: ['fixture-strata'], llamacppModels: [], lmstudioModels: [], zaiModels: [] };
const auth = Object.fromEntries(['codex', 'claude', 'ollama', 'strata'].map(provider => [provider, { loggedIn: true }])) as Partial<AuthStatusByProvider>;
test('Computer defaults follow connected enabled providers in subscription then local order', () => {
  assert.equal(defaultComputerSelection(auth, {}, catalogs)?.provider, 'codex');
  assert.equal(defaultComputerSelection(auth, { codex: false }, catalogs)?.provider, 'claude');
  assert.equal(defaultComputerSelection({ ...auth, codex: { loggedIn: false } as AuthStatusByProvider['codex'] }, { claude: false }, catalogs)?.provider, 'ollama');
  assert.equal(defaultComputerSelection(auth, { codex: false, claude: false, ollama: false }, catalogs)?.provider, 'strata');
  assert.equal(defaultComputerSelection(auth, { codex: false, claude: false, ollama: false, strata: false }, catalogs), null);
  assert.equal(defaultComputerSelection(null, {}, catalogs), null);
});
test('local Computer defaults require an installed model and use its exact catalog id', () => {
  const selection = defaultComputerSelection(auth, { codex: false, claude: false }, catalogs);
  assert.equal(selection?.model, 'fixture-local');
  assert.equal(selection?.history, 'saved');
  assert.equal(defaultComputerSelection(auth, { codex: false, claude: false }, { ...catalogs, ollamaModels: [] })?.model, 'fixture-strata');
});

test('automatic Computer selection does not overwrite an explicit saved choice', async () => {
  const { useAppStore } = await import('../stores/appStore');
  const { useComputerStore } = await import('../stores/computerStore');
  const { syncComputerDefault } = await import('../voice/computerControl');
  useAppStore.setState({ authStatus: { claude: { loggedIn: true } } as AuthStatusByProvider });
  const selection = { provider: 'codex' as const, model: 'gpt-6-luna', effort: 'low' as const, history: 'saved' as const };
  useComputerStore.setState({ selection, activeId: null, pending: null, automatic: true });
  syncComputerDefault();
  assert.equal(useComputerStore.getState().selection.provider, 'claude');
  useComputerStore.setState({ selection, automatic: false });
  syncComputerDefault();
  assert.deepEqual(useComputerStore.getState().selection, selection);
});

test('Computer without a connected agent creates no conversation or turn', async () => {
  const { useAppStore } = await import('../stores/appStore');
  const { ComputerConversation } = await import('../voice/conversation');
  const { NO_COMPUTER_AGENT } = await import('./computerAvailability');
  useAppStore.setState({ connected: true, authStatus: {} as AuthStatusByProvider });
  let created = 0, sent = 0;
  const computer = new ComputerConversation({ createWorkflow: () => { created++; }, sendMessage: () => { sent++; return true; } }, () => {});
  assert.equal(await computer.talk('Open settings', new AbortController().signal), NO_COMPUTER_AGENT);
  assert.equal(created, 0);
  assert.equal(sent, 0);
});
