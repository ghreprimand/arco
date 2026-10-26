import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ArcoSettings, AuthStatusByProvider } from '@arco/shared';
import { LoginCommand } from '../../client/src/components/LoginCommand';
import { AuthOverlay } from '../../client/src/components/AuthOverlay';
import { useAppStore } from '../../client/src/stores/appStore';
import { startupGate, anyPrimaryProviderConnected, disconnectedProviderLines, DOCKER_ENDPOINT_HELP, fetchInstallationHistory, parseInstallationHistory, INSTALLATION_HISTORY_URL } from '../../client/src/utils/startupGate';
import { ProviderOutageBanner } from '../../client/src/components/ProviderOutageBanner';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
(globalThis as any).React = React;
(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

test('fresh Docker setup shows a host command before a workflow terminal exists', () => {
  const html = renderToStaticMarkup(<LoginCommand command="codex login --device-auth" hostCommand="docker compose exec arco codex login --device-auth" />);
  assert.match(html, /docker compose exec arco codex login --device-auth/);
  assert.match(html, /Windows Terminal, PowerShell/);
  assert.doesNotMatch(html, /RUN IN TERMINAL/);
});
test('existing workflows retain the Docker fallback as well as their terminal shortcut', () => {
  const before = useAppStore.getState();
  const initial = useAppStore.getInitialState();
  const initialJobs = initial.jobs, initialJob = initial.activeJobId;
  useAppStore.getState().createJob('onboarding', { name: 'Onboarding fixture', workingDirectory: '/projects', primaryProvider: 'codex', primaryModel: 'gpt-5.5', primaryEffort: 'low' });
  useAppStore.getState().setActiveJob('onboarding');
  // Server rendering uses Zustand's initial snapshot; supply the same fixture.
  initial.jobs = useAppStore.getState().jobs; initial.activeJobId = 'onboarding';
  try {
    const html = renderToStaticMarkup(<LoginCommand command="codex login --device-auth" hostCommand="docker compose exec arco codex login --device-auth" />);
    assert.match(html, /RUN IN TERMINAL/);
    assert.match(html, /docker compose exec arco codex login --device-auth/);
  } finally {
    initial.jobs = initialJobs; initial.activeJobId = initialJob;
    useAppStore.setState({ jobs: before.jobs, activeJobId: before.activeJobId, activeClusterId: before.activeClusterId });
  }
});
test('first-run settings remain reachable while server-owned connection details are loading', () => {
  const settings = useAppStore.getState().settings;
  useAppStore.setState({ settings: { enabledProviders: { gemini: false, cursor: false, antigravity: false, llamacpp: false } } as ArcoSettings });
  try {
    const html = renderToStaticMarkup(<AuthOverlay />);
    assert.match(html, /PROVIDER SETTINGS/);
    assert.match(html, /All provider controls/);
    assert.match(html, /Loading connection setup/);
  } finally { useAppStore.setState({ settings }); }
});

// Startup gate: provider outages never replace an established workspace.

const base = { authKnown: true, providerConnected: false, setupDeferred: false, hasOpenWork: false, hasHistory: false as boolean | null, workspaceSynced: true };

test('first run on an unused installation shows provider setup', () => {
  assert.equal(startupGate(base), 'setup');
});
test('a returning operator keeps the workspace when every provider drops', () => {
  assert.equal(startupGate({ ...base, setupCompleted: true }), 'workspace');
  assert.equal(startupGate({ ...base, hasOpenWork: true }), 'workspace');
  assert.equal(startupGate({ ...base, hasHistory: true }), 'workspace');
  // A new browser: no local tabs yet, but the server remembers earlier workflows.
  assert.equal(startupGate({ ...base, workspaceSynced: false, hasHistory: true }), 'workspace');
});
test('setup can be deferred without pretending a provider is connected', () => {
  assert.equal(startupGate({ ...base, setupDeferred: true }), 'workspace');
});
test('the gate waits for workspace and history signals instead of flashing setup', () => {
  assert.equal(startupGate({ ...base, workspaceSynced: false }), 'pending');
  assert.equal(startupGate({ ...base, hasHistory: null }), 'pending');
  assert.equal(startupGate({ ...base, authKnown: false }), 'workspace');
  assert.equal(startupGate({ ...base, providerConnected: true }), 'workspace');
});
test('installation history decides only from a well-formed 2xx answer', () => {
  assert.equal(parseInstallationHistory(true, { used: true }), true);
  assert.equal(parseInstallationHistory(true, { used: false }), false);
  assert.equal(parseInstallationHistory(false, { used: false }), null);
  for (const body of [null, undefined, 'false', [], {}, { used: 'false' }, { used: 0 }, { projects: [] }]) {
    assert.equal(parseInstallationHistory(true, body), null);
  }
});
test('failed, non-2xx and malformed history requests never read as first run', async () => {
  const respond = (status: number, body: string): typeof fetch => async () => new Response(body, { status });
  assert.equal(await fetchInstallationHistory(async () => { throw new TypeError('network down'); }), null);
  assert.equal(await fetchInstallationHistory(respond(503, '{"error":"unavailable"}')), null);
  assert.equal(await fetchInstallationHistory(respond(500, '{"used":false}')), null);
  assert.equal(await fetchInstallationHistory(respond(200, 'not json')), null);
  assert.equal(await fetchInstallationHistory(respond(200, '{"projects":[]}')), null);
  assert.equal(await fetchInstallationHistory(respond(200, '{"used":true}')), true);
  assert.equal(await fetchInstallationHistory(respond(200, '{"used":false}')), false);
  // Unknown history never yields the full-screen setup.
  assert.equal(startupGate({ ...base, hasHistory: await fetchInstallationHistory(respond(502, '')) }), 'pending');
});
test('the gate asks the dedicated history endpoint, not project classification', async () => {
  let asked = '';
  await fetchInstallationHistory(async (input) => { asked = String(input); return new Response('{"used":true}'); });
  assert.equal(asked, INSTALLATION_HISTORY_URL);
  assert.equal(INSTALLATION_HISTORY_URL, '/api/installation-history');
  const app = readFileSync(resolve(process.cwd(), 'client/src/App.tsx'), 'utf8');
  assert.doesNotMatch(app, /source === 'recent'/);
  assert.match(app, /fetchInstallationHistory\(\)/);
});
test('only enabled primary providers count as connected; local runtimes do', () => {
  const status = { claude: { loggedIn: true }, ollama: { loggedIn: false } } as unknown as AuthStatusByProvider;
  assert.equal(anyPrimaryProviderConnected(status, (p) => p !== 'claude'), false);
  assert.equal(anyPrimaryProviderConnected(status, () => true), true);
  const local = { ollama: { loggedIn: true, apiProvider: 'ollama:http://host.docker.internal:11434' } } as unknown as AuthStatusByProvider;
  assert.equal(anyPrimaryProviderConnected(local, () => true), true);
  assert.equal(anyPrimaryProviderConnected(null, () => true), false);
});
test('disconnected status names the endpoint a local runtime tried', () => {
  const status = {
    ollama: { loggedIn: false, apiProvider: 'ollama:http://localhost:11434', error: 'connect ECONNREFUSED' },
    zai: { loggedIn: false, error: 'Z.ai API key is not configured' },
    codex: { loggedIn: false, error: 'Not logged in' },
  } as unknown as AuthStatusByProvider;
  const lines = disconnectedProviderLines(status, (p) => p === 'ollama' || p === 'zai' || p === 'codex');
  assert.deepEqual(lines.map((l) => l.provider).sort(), ['codex', 'ollama', 'zai']);
  assert.match(lines.find((l) => l.provider === 'ollama')!.detail, /not reachable at http:\/\/localhost:11434 \(connect ECONNREFUSED\)/);
  assert.equal(lines.find((l) => l.provider === 'zai')!.detail, 'no API key configured');
  assert.equal(lines.find((l) => l.provider === 'codex')!.detail, 'not signed in');
});
test('first-run setup is a labelled dialog that can be deferred and explains Docker endpoints', () => {
  const html = renderToStaticMarkup(<AuthOverlay />);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-labelledby="provider-setup-title"/);
  assert.match(html, /SKIP FOR NOW/);
  assert.match(html, /Local models/);
  assert.match(html, /Provider sign-in/);
  assert.match(html, /Loading connection setup/);
  assert.doesNotMatch(html, /NO AUTHENTICATED PROVIDER/);
});
test('the reopened setup dialog closes instead of deferring', () => {
  const html = renderToStaticMarkup(<AuthOverlay mode="dialog" />);
  assert.match(html, />CLOSE</);
  assert.doesNotMatch(html, /SKIP FOR NOW/);
  assert.doesNotMatch(html, /Setup steps/);
});
test('the outage banner keeps retry, setup and settings one click away', () => {
  const html = renderToStaticMarkup(<ProviderOutageBanner />);
  assert.match(html, /No AI provider is connected\./);
  assert.match(html, /Your projects and saved work are still here/);
  assert.match(html, />RETRY</);
  assert.match(html, />CONNECT A PROVIDER</);
  assert.match(html, />PROVIDER SETTINGS</);
  assert.match(html, /aria-label="Provider connection status"/);
});
test('settings retain both transport options and expose endpoint guidance', () => {
  const src = readFileSync(resolve(process.cwd(), 'client/src/components/SettingsPanel.tsx'), 'utf8');
  assert.match(src, /options: \['cli', 'native'\] as const/);
  for (const key of ['ollama', 'lmstudio', 'strata']) {
    assert.match(src, new RegExp(`<EndpointHelp id="${key}-endpoint-help" />`));
    assert.match(src, new RegExp(`htmlFor="${key}-endpoint"`));
  }
  assert.match(DOCKER_ENDPOINT_HELP, /host\.docker\.internal/);
});
