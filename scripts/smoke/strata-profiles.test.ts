import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StrataProfileManager, readStrataProfiles, type StrataProfileRegistry, type StrataSwitchDependencies } from '../../server/src/providers/strataProfiles.js';
import { probeStrata } from '../../server/src/providers/strata.js';
import { beginLocalModelUnload, localModelsUnloading } from '../../server/src/providers/localModelControl.js';

const base = 'http://127.0.0.1:8081/v1';
const profiles = ['original', 'abliterated'].map((id) => ({ id, model: `qwen-${id}`, label: id, config: `/config/${id}`, unit: `strata-fixture@${id}.service`, capabilities: { tools: true, thinking: true, vision: true, numCtx: 262144 } }));
const registry: StrataProfileRegistry = { baseUrl: base, launcher: { python: '/python', script: '/launcher' }, profiles };
function fixture() {
  const calls: string[] = [], notices: string[] = [];
  let current: string | undefined = profiles[0].model;
  let loaded = true;
  const deps: StrataSwitchDependencies = {
    registry: async () => registry,
    status: async () => current ? { model: current, loaded, activity: { in_flight: 0 } } : null,
    unitState: async (unit) => ({ loaded: true, active: profiles.find((p) => p.unit === unit)?.model === current ? 'active' : 'inactive' }),
    control: async (action, unit) => { calls.push(`${action} ${unit}`); current = action === 'start' ? profiles.find((p) => p.unit === unit)?.model : undefined; loaded = true; },
    preflight: async () => { calls.push('preflight'); },
    otherLocalWork: () => false,
    unload: async () => { calls.push('unload'); loaded = false; },
    pause: async () => {}, readyTimeoutMs: 30,
  };
  const manager = new StrataProfileManager(deps);
  return { calls, notices, deps, manager, setLoaded: (v: boolean) => { loaded = v; },
    run: (model = profiles[1].model, signal = new AbortController().signal) => manager.ensure(base, model, signal, (n) => notices.push(n)) };
}

test('switch stops only registered old unit, then starts and verifies selected weights', async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.calls, ['preflight', `stop ${profiles[0].unit}`, `start ${profiles[1].unit}`]);
  assert.match(f.notices.at(-1)!, /ready: abliterated/);
  await f.run(profiles[0].model);
  assert.deepEqual(f.calls.slice(3), ['preflight', `stop ${profiles[1].unit}`, `start ${profiles[0].unit}`]);
  assert(!localModelsUnloading());
});
test('same unloaded profile stays unloaded until its completion; unmanaged endpoints stay HTTP-only', async () => {
  const f = fixture(); f.setLoaded(false); await f.run(profiles[0].model); assert.deepEqual(f.calls, []);
  f.deps.registry = async () => null; await f.run('remote-model'); assert.deepEqual(f.calls, []);
});
test('unknown model, active local work, external request, unmanaged listener and preflight refusal stop nothing', async () => {
  const cases = [
    (f: ReturnType<typeof fixture>) => { f.deps.otherLocalWork = () => true; },
    (f: ReturnType<typeof fixture>) => { f.deps.status = async () => ({ model: profiles[0].model, loaded: true, activity: { in_flight: 1 } }); },
    (f: ReturnType<typeof fixture>) => { f.deps.status = async () => ({ model: 'unmanaged' }); },
    (f: ReturnType<typeof fixture>) => { f.deps.unitState = async () => ({ active: 'activating', loaded: true }); },
    (f: ReturnType<typeof fixture>) => { f.deps.preflight = async () => { throw new Error('miner active'); }; },
  ];
  for (const mutate of cases) { const f = fixture(); mutate(f); await assert.rejects(f.run()); assert.deepEqual(f.calls, []); }
  const f = fixture(); await assert.rejects(f.run('typo'), /not a registered/); assert.deepEqual(f.calls, []);
  assert(!localModelsUnloading());
});
test('FREE VRAM and switches exclude each other, including while start awaits readiness', async () => {
  const f = fixture();
  const release = beginLocalModelUnload()!;
  await assert.rejects(f.run(), /being unloaded/); release();
  const control = f.deps.control;
  f.deps.control = async (action, unit) => { assert.equal(beginLocalModelUnload(), null); await control(action, unit); };
  await f.run(); assert(!localModelsUnloading());
});
test('failed target start restores the previous profile and its unloaded state', async () => {
  const f = fixture(); f.setLoaded(false);
  const control = f.deps.control;
  f.deps.control = async (action, unit) => { if (action === 'start' && unit === profiles[1].unit) { f.calls.push('failed start'); throw new Error('insufficient VRAM'); } await control(action, unit); };
  await assert.rejects(f.run(), /insufficient VRAM/);
  assert.deepEqual(f.calls, ['preflight', `stop ${profiles[0].unit}`, 'failed start', `stop ${profiles[1].unit}`, `start ${profiles[0].unit}`, 'unload']);
  assert.match(f.notices.at(-1)!, /restored: original/); assert(!localModelsUnloading());
});
test('cancel after old service stopped rolls back before releasing the local-model gate', async () => {
  const f = fixture(), abort = new AbortController();
  const control = f.deps.control;
  f.deps.control = async (action, unit) => { await control(action, unit); if (action === 'stop') abort.abort(); };
  await assert.rejects(f.run(profiles[1].model, abort.signal), /abort/i);
  assert.deepEqual(f.calls, ['preflight', `stop ${profiles[0].unit}`, `start ${profiles[0].unit}`]);
  assert(!localModelsUnloading());
});
test('ready response must match the selected model; mismatch rolls back', async () => {
  const f = fixture(); const control = f.deps.control;
  f.deps.control = async (action, unit) => { if (action === 'start' && unit === profiles[1].unit) { f.calls.push('wrong model'); return; } await control(action, unit); };
  await assert.rejects(f.run(), /load timeout|service stopped/); assert.match(f.notices.at(-1)!, /restored: original/);
});
test('registry discovers prepared context/vision while offline and rejects mismatched model IDs', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'arco-profile-registry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prior = process.env.ARCO_STRATA_PROFILES;
  t.after(() => { if (prior === undefined) delete process.env.ARCO_STRATA_PROFILES; else process.env.ARCO_STRATA_PROFILES = prior; });
  process.env.ARCO_STRATA_PROFILES = join(dir, 'registry.json');
  const file = join(dir, 'prepared'); await writeFile(file, 'fixture');
  const config = join(dir, 'config.json');
  const cfg = { exe: file, tokenizer: file, model_name: profiles[0].model, args: ['--max-context', '262144', '--pack', file, '--native', file, '--ple-gguf', file, '--vision'], vision: { exe: file, model: file, mmproj: file } };
  await writeFile(config, JSON.stringify(cfg));
  await writeFile(join(dir, 'registry.json'), JSON.stringify({ ...registry, launcher: { python: file, script: file }, profiles: [{ ...profiles[0], config }] }));
  assert.deepEqual((await readStrataProfiles(base))?.profiles[0].capabilities, profiles[0].capabilities);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const offline = await probeStrata();
  assert(offline.up); assert.deepEqual(offline.models, [profiles[0].model]);
  assert.equal(offline.labels?.[profiles[0].model], 'original');
  assert.deepEqual(offline.capabilities?.[profiles[0].model], profiles[0].capabilities);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: profiles[0].model, meta: { n_ctx: 131072 }, architecture: { input_modalities: ['text'] } }] }));
  const live = await probeStrata();
  assert.equal(live.capabilities?.[profiles[0].model].vision, false);
  assert.equal(live.capabilities?.[profiles[0].model].numCtx, 131072);
  assert.equal(await readStrataProfiles('http://remote:8081/v1'), null);
  assert.equal(await readStrataProfiles('http://127.0.0.1:1234/v1'), null);
  await writeFile(config, JSON.stringify({ ...cfg, model_name: 'wrong' }));
  await assert.rejects(readStrataProfiles(base), /does not match/);
});
