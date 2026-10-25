import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import test from 'node:test';
import { isLoopbackModelEndpoint, unloadLocalModels } from '../../server/src/localModels.js';
import { workflows } from '../../server/src/server/state.js';
import { beginLocalModelUnload, localModelsUnloading } from '../../server/src/providers/localModelControl.js';
import { createProviderProcess } from '../../server/src/providers/index.js';

process.env.ARCHON_DEEPSEEK_PROFILES = join(tmpdir(), `archon-no-deepseek-${process.pid}.json`);

test('FREE VRAM only targets loopback endpoints', () => {
  for (const url of ['http://localhost:8081/v1', 'http://127.0.0.1:11434', 'http://[::1]:1234/v1']) assert(isLoopbackModelEndpoint(url));
  for (const url of ['http://gpu.tailnet:11434', 'http://192.168.1.4:8081', 'http://localhost.attacker.test', 'http://127.attacker.test', 'http://127.0.0.1.attacker.test', 'file://localhost/model', 'invalid']) assert(!isLoopbackModelEndpoint(url));
});

test('FREE VRAM refuses busy local workflows before any runtime requests', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('must not call'); });
  workflows.set('unload-test-busy', { busy: true, primary: { provider: 'strata' }, manager: { snapshotWorkers: () => ({}) } } as any);
  t.after(() => workflows.delete('unload-test-busy'));
  const report = await unloadLocalModels();
  assert(report.blocked);
  assert.match(report.error!, /Finish or cancel/);
  assert.equal(requests, 0);
  assert(!localModelsUnloading());
});

test('FREE VRAM protects local reviewer workers even when the primary is remote', async (t) => {
  workflows.set('unload-test-reviewer', { busy: true, primary: { provider: 'claude' }, manager: { snapshotWorkers: () => ({ reviewer: { provider: 'ollama', status: 'running' } }) } } as any);
  t.after(() => workflows.delete('unload-test-reviewer'));
  assert((await unloadLocalModels()).blocked);
});

test('new local turns are refused while unload owns the slot', async () => {
  const release = beginLocalModelUnload(); assert(release);
  try {
    const worker = createProviderProcess('unload-test-new-turn', { provider: 'strata', model: 'test', effort: 'high' });
    const error = new Promise<string>((resolve) => worker.once('error', resolve));
    worker.spawn('do not dispatch');
    assert.match(await error, /FREE VRAM/);
    assert.equal(worker.status, 'failed');
  } finally { release(); }
  assert(!localModelsUnloading());
});

test('concurrent unload is refused without releasing the existing owner', async () => {
  const release = beginLocalModelUnload(); assert(release);
  try {
    assert((await unloadLocalModels()).blocked);
    assert(localModelsUnloading());
  } finally { release(); }
});

test('an external Strata request prevents its unload while other runtimes are inspected', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    assert.notEqual(init?.method, 'POST', 'busy Strata must not receive unload');
    if (String(url).endsWith('/status')) return Response.json({ loaded: true, activity: { in_flight: 1 } });
    return Response.json({ models: [] });
  });
  const report = await unloadLocalModels();
  assert(report.results.some((r) => r.provider === 'strata' && r.state === 'failed' && /busy/.test(r.detail ?? '')));
  assert(report.results.some((r) => r.provider === 'ollama' && r.state === 'idle'));
  assert(!localModelsUnloading());
});

test('idle unload uses each runtime protocol and reports per-model outcomes', async (t) => {
  const calls: Array<{ url: string; body?: any }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });
    const json = (value: any) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    if (String(url).endsWith('/api/ps')) return json({ models: [{ name: 'ollama-test', size_vram: 1024 }] });
    if (String(url).endsWith('/api/chat')) return json({ done: true });
    if (String(url).endsWith('/status')) return json({ model: 'strata-test', loaded: true, activity: { in_flight: 0 } });
    if (String(url).endsWith('/v1/unload')) return json({ status: 'unloaded', loaded: false });
    if (String(url).endsWith('/api/v1/models')) return json({ models: [{ type: 'llm', loaded_instances: [{ id: 'lm-test' }] }, { type: 'embedding', loaded_instances: [{ id: 'leave-embedding' }] }] });
    if (String(url).endsWith('/api/v1/models/unload')) return json({ instance_id: body.instance_id });
    throw new Error(`Unexpected runtime request ${url}`);
  });
  const report = await unloadLocalModels();
  assert(!report.blocked);
  for (const provider of ['strata', 'ollama', 'lmstudio']) assert(report.results.some((r) => r.provider === provider && r.state === 'unloaded'), provider);
  assert(calls.some((c) => c.body?.keep_alive === 0));
  assert(calls.some((c) => c.body?.instance_id === 'lm-test'));
  assert(!calls.some((c) => c.body?.instance_id === 'leave-embedding'));
  assert(!localModelsUnloading());
});
