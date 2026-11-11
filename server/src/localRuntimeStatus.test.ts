import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { aggregateLocalRuntimeState, type ArcoSettings, type LocalRuntimeStatus, type LlamacppLiveStatus, type LocalStatusProvider } from '@arco/shared';
const home = realpathSync(mkdtempSync(join(tmpdir(), 'arco-local-status-')));
process.env.ARCO_HOME = join(home, 'state'); process.env.HOME = home; process.env.USERPROFILE = home;
after(() => rmSync(home, { recursive: true, force: true }));
const { LocalRuntimeStatusService, probeEngineStatus } = await import('./localRuntimeStatus.js');
const flags = (enabled: string[]): ArcoSettings => ({ enabledProviders: { claude: false, codex: false, cursor: false, ollama: enabled.includes('ollama'), llamacpp: enabled.includes('llamacpp'), lmstudio: enabled.includes('lmstudio'), strata: enabled.includes('strata'), deepseek: enabled.includes('deepseek') } });
const installed = { strataVersion: '1.0.0', xolotlRevision: 'fixture' };
const row = (provider: LocalStatusProvider, state: LocalRuntimeStatus['state']): LocalRuntimeStatus => ({ provider, state, models: [] });

test('local snapshot probes enabled programs only, excludes LM Studio, caches and deduplicates', async () => {
  let settings = flags(['ollama']); let now = 100;
  const calls: string[] = [];
  const service = new LocalRuntimeStatusService({ settings: async () => settings, now: () => now, timeoutMs: 100,
    ollama: async () => { calls.push('ollama'); return { up: true, version: 'fixture', loadedModels: [] }; },
    llamacpp: async () => { calls.push('llamacpp'); return { up: true, state: 'idle', version: '12110', loadedModel: null }; },
    engine: async provider => { calls.push(provider); return row(provider, 'stopped'); } });
  const [first, concurrent] = await Promise.all([service.snapshot(installed), service.snapshot(installed)]);
  assert.deepEqual(calls, ['ollama']); assert.equal(first, concurrent);
  assert.deepEqual(first.rows, [row('ollama', 'idle')]);
  await service.snapshot(installed); assert.deepEqual(calls, ['ollama']);
  settings = flags(['llamacpp', 'strata', 'deepseek']);
  const next = await service.snapshot(installed);
  assert.deepEqual(calls, ['ollama', 'llamacpp', 'strata', 'deepseek']);
  assert.equal(next.rows.every(r => r.state === 'stopped'), true);
  assert.equal(next.ollama, undefined, 'disabled snapshots do not carry an old live value');
  settings = flags(['lmstudio']); assert.deepEqual((await service.snapshot(installed)).rows, []);
  assert.equal(calls.length, 4, 'LM Studio does not cause any probe');
  settings = flags(['ollama']); now += 6000; await service.snapshot(installed); assert.equal(calls.length, 5);
});

test('absent unconfigured engines never receive status probes', async () => {
  const settings = flags(['ollama']);
  for (const provider of ['strata', 'deepseek', 'llamacpp']) Reflect.deleteProperty(settings.enabledProviders, provider);
  const calls: string[] = [];
  const service = new LocalRuntimeStatusService({ settings: async () => settings, llamaInstalled: () => false, now: Date.now, timeoutMs: 100,
    ollama: async () => ({ up: true, loadedModels: [] }),
    llamacpp: async () => { throw new Error('disabled'); },
    engine: async provider => { calls.push(provider); return row(provider, 'down'); } });
  const snapshot = await service.snapshot();
  assert.deepEqual(snapshot.rows.map(r => r.provider), ['ollama']);
  assert.equal(aggregateLocalRuntimeState(snapshot.rows), 'idle');
  assert.deepEqual(calls, [], 'no HTTP or managed-unit status path for absent engines');
});

test('llama.cpp distinguishes loaded, loading, failed, absent and stopped-on-demand', async () => {
  let live: Omit<LlamacppLiveStatus, 'fetchedAt'> = { up: true, state: 'idle', version: '12110', loadedModel: null };
  let now = 100;
  const service = new LocalRuntimeStatusService({ settings: async () => flags(['llamacpp']), now: () => now, timeoutMs: 100,
    ollama: async () => { throw new Error('disabled'); }, engine: async () => { throw new Error('disabled'); }, llamacpp: async () => live });
  for (const [state, up, model, expected] of [
    ['idle', true, null, 'stopped'], ['ready', true, 'fixture', 'loaded'], ['loading', true, 'fixture', 'unknown'], ['failed', true, null, 'down'], ['idle', false, null, 'down'],
  ] as const) {
    live = { ...live, state, up, loadedModel: model }; now += 6000;
    const result = (await service.snapshot(installed)).rows[0]; assert.equal(result.state, expected);
    assert.deepEqual(result.models, expected === 'loaded' ? ['fixture'] : []);
  }
});

test('engine status counts actual loaded flags, never registered model names', async () => {
  let live: { loaded?: boolean; model?: string } | null = { loaded: false, model: 'registered-only' };
  let states = [{ active: 'inactive', installed: true }]; let unitReads = 0;
  const deps = { base: async () => 'fixture', status: async () => live, units: async () => ['registered.service'], unitStates: async () => { unitReads++; return states; } };
  assert.equal((await probeEngineStatus('strata', deps)).state, 'idle'); assert.equal(unitReads, 0);
  live = { loaded: true, model: 'actual-model' };
  assert.deepEqual((await probeEngineStatus('deepseek', deps)).models, ['actual-model']);
  live = {}; assert.equal((await probeEngineStatus('strata', deps)).state, 'unknown');
  live = null;
  assert.equal((await probeEngineStatus('strata', deps)).state, 'stopped');
  for (const active of ['active', 'failed']) { states = [{ active, installed: true }]; assert.equal((await probeEngineStatus('deepseek', deps)).state, 'down'); }
  states = [{ active: 'inactive', installed: false }]; assert.equal((await probeEngineStatus('strata', deps)).state, 'down');
  states = [{ active: 'activating', installed: true }]; assert.equal((await probeEngineStatus('strata', deps)).state, 'unknown');
  assert.equal((await probeEngineStatus('strata', { ...deps, units: async () => null })).state, 'down');
});

test('a hung status read is bounded and remains unknown', async () => {
  const service = new LocalRuntimeStatusService({ settings: async () => flags(['strata']), now: Date.now, timeoutMs: 5,
    ollama: async () => { throw new Error('disabled'); }, llamacpp: async () => { throw new Error('disabled'); }, engine: () => new Promise(() => {}) });
  assert.equal((await service.snapshot(installed)).rows[0].state, 'unknown');
});

test('aggregate prioritizes confirmed faults, then loaded models, then unknown and idle', () => {
  assert.equal(aggregateLocalRuntimeState([row('strata', 'down'), row('ollama', 'loaded')]), 'down');
  assert.equal(aggregateLocalRuntimeState([row('strata', 'unknown'), row('ollama', 'loaded')]), 'loaded');
  assert.equal(aggregateLocalRuntimeState([row('strata', 'unknown'), row('llamacpp', 'stopped')]), 'unknown');
  assert.equal(aggregateLocalRuntimeState([row('strata', 'idle'), row('llamacpp', 'stopped')]), 'idle');
});


test('Ollama retains unload timestamps and daemon-down guidance', async () => {
  let up = true; let now = 100;
  const expiresAt = '2030-01-01T00:00:00.000Z';
  const service = new LocalRuntimeStatusService({ settings: async () => flags(['ollama']), now: () => now, timeoutMs: 100,
    ollama: async () => ({ up, loadedModels: [{ name: 'fixture', sizeVram: 1, expiresAt }] }),
    llamacpp: async () => { throw new Error('disabled'); }, engine: async () => { throw new Error('disabled'); } });
  assert.deepEqual((await service.snapshot()).rows[0].modelExpiries, { fixture: expiresAt });
  up = false; now += 6000;
  const down = (await service.snapshot()).rows[0];
  assert.equal(down.state, 'down'); assert.deepEqual(down.models, []);
  assert.match(down.detail!, /ollama serve.*OLLAMA_URL_BASE/);
});
