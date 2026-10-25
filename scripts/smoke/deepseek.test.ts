import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeepSeekProfileManager, readDeepSeekProfiles, type DeepSeekDependencies, type DeepSeekRegistry } from '../../server/src/providers/deepseekProfiles.js';
import { OpenAIHttpWorkerProcess } from '../../server/src/providers/lmstudio.js';
import { beginLocalModelUnload, localModelsUnloading } from '../../server/src/providers/localModelControl.js';
import { CHAT_PROVIDERS, INCOGNITO_CHAT_PROVIDERS, chatWebArmed } from '../../server/src/chatMode.js';
import { installedStrataVersion, probeStrataVersion, strataEngineReleaseVersion } from '../../server/src/providers/runtimeVersions.js';
import type { WorkerConfig } from '@archon/shared';

const base = 'http://127.0.0.1:8150/v1';
const profiles: DeepSeekRegistry['profiles'] = (['exact', 'light'] as const).map((id) => ({
  id, model: `deepseek-v4.1-flash-1017-${id}`, label: `DeepSeek ${id} · Xolotl`, config: `/config/${id}`,
  capabilities: { tools: true, thinking: true, vision: false, numCtx: 262144 },
}));
const registry: DeepSeekRegistry = { baseUrl: base, runtime: '/runtime', launcher: { python: '/python', script: '/guarded.py' }, profiles };
test('Strata engine updates use component versions rather than the 0.2 app tag', () => {
  const release = { tag_name: 'v0.2.0-beta', body: 'Engine package version 0.1.45.3.' };
  assert.equal(strataEngineReleaseVersion({ schema_version: 1, feed: 'strata-updates', engine: { packages: [{ version: '0.1.45.3' }, { version: '0.1.46.1' }] } }, release), '0.1.46.1');
  assert.equal(strataEngineReleaseVersion(null, release), '0.1.45.3');
  assert.equal(strataEngineReleaseVersion(null, { tag_name: 'v0.2.0-beta' }), undefined);
  assert.equal(strataEngineReleaseVersion(null, { tag_name: 'v0.1.44.1' }), '0.1.44.1');
  assert.equal(strataEngineReleaseVersion({ schema_version: 1, feed: 'strata-updates', engine: { packages: [{ version: 'junk' }, null] } }, { tag_name: 'v0.2.0' }), undefined);
});
function fixture() {
  const calls: string[] = [], notices: string[] = [];
  let current: string | undefined = 'exact', loaded = true;
  const deps: DeepSeekDependencies = {
    registry: async () => registry,
    status: async () => current ? { model: profiles.find((p) => p.id === current)!.model, loaded, context: { max_positions: 262144 }, activity: { in_flight: 0 } } : null,
    state: async (id) => id === current ? 'active' : 'inactive',
    launcher: async (_r, action, id) => { calls.push(`${action} ${id}`); current = action === 'start' ? id : undefined; loaded = true; },
    checkSwitch: async () => { calls.push('guard'); }, otherLocalWork: () => false,
    pause: async () => {}, timeoutMs: 25,
  };
  const manager = new DeepSeekProfileManager(deps);
  return { manager, deps, calls, notices, setLoaded: (v: boolean) => { loaded = v; },
    stop: () => { current = undefined; },
    run: (signal = new AbortController().signal, manual = false) => manager.ensure(base, profiles[1].model, signal, (s) => notices.push(s), manual) };
}
test('DeepSeek switches only through guarded launcher, confirms identity and releases exclusion', async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.calls, ['guard', 'stop exact', 'start light']);
  const s = await f.manager.snapshot(base);
  assert(s.profiles[1].loaded); assert(!s.profiles[0].loaded); assert(!localModelsUnloading());
});
test('prepared profiles remain listed while stopped; first turn starts selected profile', async () => {
  const f = fixture(); f.stop();
  assert.equal((await f.manager.snapshot(base)).profiles.length, 2);
  await f.run(); assert.deepEqual(f.calls, ['guard', 'start light']);
});
test('mining refusal does not stop an existing profile', async () => {
  const f = fixture(); f.deps.checkSwitch = async () => { throw Error('Mining is running'); };
  await assert.rejects(f.run(), /Mining/); assert.deepEqual(f.calls, []); assert(!localModelsUnloading());
});
test('external requests, other active work and concurrent unload refuse before service changes', async () => {
  const f = fixture(); f.deps.status = async () => ({ model: profiles[0].model, loaded: true, activity: { in_flight: 1 } });
  await assert.rejects(f.run(), /external request/); await assert.rejects(f.manager.unload(base), /external request/);
  f.deps.otherLocalWork = () => true; await assert.rejects(f.run(), /other local/); assert.deepEqual(f.calls, []);
  const release = beginLocalModelUnload()!;
  try { await assert.rejects(f.run(), /being unloaded/); } finally { release(); }
});
test('manual loads include active DeepSeek work in the activity guard', async () => {
  const f = fixture(); f.deps.otherLocalWork = (includeSelf) => !!includeSelf;
  await assert.rejects(f.run(undefined, true), /other local/); assert.deepEqual(f.calls, []);
});
test('failed load restores previous loaded profile through the same guard', async () => {
  const f = fixture(), launcher = f.deps.launcher;
  f.deps.launcher = async (r, a, id) => { if (a === 'start' && id === 'light') throw Error('VRAM guard refused'); await launcher(r, a, id); };
  await assert.rejects(f.run(), /VRAM guard/);
  assert.deepEqual(f.calls, ['guard', 'stop exact', 'stop light', 'start exact']); assert(!localModelsUnloading());
});
test('cancel after stop restores previous profile before releasing the operation guard', async () => {
  const f = fixture(), abort = new AbortController(), launcher = f.deps.launcher;
  f.deps.launcher = async (r, a, id) => { assert(localModelsUnloading()); await launcher(r, a, id); if (a === 'stop') abort.abort(); };
  await assert.rejects(f.run(abort.signal), /abort/i);
  assert.deepEqual(f.calls, ['guard', 'stop exact', 'start exact']); assert(!localModelsUnloading());
});
test('idle-unloaded service restarts through guard; failure preserves unloaded state', async () => {
  const f = fixture(); f.setLoaded(false);
  await f.manager.ensure(base, profiles[0].model, new AbortController().signal, () => {});
  assert.deepEqual(f.calls, ['guard', 'stop exact', 'start exact']);
  f.setLoaded(false); const launcher = f.deps.launcher;
  f.deps.launcher = async (r, a, id) => { if (a === 'start') throw Error('RAM guard'); await launcher(r, a, id); };
  await assert.rejects(f.run(), /RAM guard/); assert.equal((await f.manager.snapshot(base)).live, null);
});
test('wrong served identity never reaches inference, and a failed recovery is visible', async () => {
  const f = fixture(); f.deps.status = async () => ({ model: 'unmanaged', loaded: true });
  await assert.rejects(f.run(), /identity/); assert.deepEqual(f.calls, []);
  const g = fixture(); g.deps.launcher = async () => { throw Error('service failed'); };
  await assert.rejects(g.run(), /recovery also failed/); assert(!localModelsUnloading());
});
test('a matching model ID with the wrong live context is refused', async () => {
  const f = fixture();
  f.deps.status = async () => ({ model: profiles[0].model, loaded: true, context: { max_positions: 32768 } });
  await assert.rejects(f.manager.ensure(base, profiles[0].model, new AbortController().signal, () => {}), /live context/);
  assert.deepEqual(f.calls, []); assert(!localModelsUnloading());
});
test('unload stops the service and confirms inactive plus endpoint disappearance', async () => {
  const f = fixture(); assert.equal(await f.manager.unload(base), 'unloaded');
  assert.deepEqual(f.calls, ['stop exact']); assert.equal(await f.manager.unload(base), 'idle');
  const g = fixture(); g.deps.launcher = async () => {};
  await assert.rejects(g.manager.unload(base), /not confirmed/);
});
test('registry validates Xolotl ctx/assets/routing and refuses the Qwen schema or a remote endpoint', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'archon-deepseek-registry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const asset = join(dir, 'asset'); await writeFile(asset, 'fixture');
  const file = join(dir, 'registry.json'); const previousRegistry = process.env.ARCHON_DEEPSEEK_PROFILES; process.env.ARCHON_DEEPSEEK_PROFILES = file;
  t.after(() => { if (previousRegistry === undefined) delete process.env.ARCHON_DEEPSEEK_PROFILES; else process.env.ARCHON_DEEPSEEK_PROFILES = previousRegistry; });
  const configs = profiles.map((p) => ({ ...p, config: join(dir, `${p.id}.json`) }));
  for (const p of configs) await writeFile(p.config, JSON.stringify({ model_name: p.model, cwd: dir, exe: asset, tokenizer: asset,
    args: ['--ctx', '262144', '-m', asset, '--rank', asset, '--engram', dir, '--route-bias', p.id === 'exact' ? '0' : '0.25', '--route-bias-file', p.id === 'exact' ? '0' : '0.15'] }));
  await writeFile(file, JSON.stringify({ baseUrl: base, runtime: dir, launcher: { python: '/usr/bin/python3', script: asset }, profiles: configs }));
  const prepared = await readDeepSeekProfiles(base); assert.equal(prepared?.profiles.length, 2);
  assert.deepEqual(prepared?.profiles[0].capabilities, { tools: true, thinking: true, vision: false, numCtx: 262144 });
  assert.equal(await readDeepSeekProfiles('http://remote:8150/v1'), null);
  const cfg = JSON.parse(await (await import('node:fs/promises')).readFile(configs[0].config, 'utf8'));
  await writeFile(join(dir, 'vision.py'), 'fixture'); await writeFile(join(dir, 'image_processor.py'), 'fixture');
  cfg.vision = { exe: asset, python: '/usr/bin/python3', mmproj: asset, model: asset,
    reference_dir: dir, gpu: false, lazy: true, max_tokens: 1024 };
  await writeFile(configs[0].config, JSON.stringify(cfg));
  assert.equal((await readDeepSeekProfiles(base))?.profiles[0].capabilities.vision, true);
  cfg.args.push('--vision'); await writeFile(configs[0].config, JSON.stringify(cfg));
  assert.equal((await readDeepSeekProfiles(base))?.profiles[0].capabilities.vision, true);
  cfg.vision.mmproj = join(dir, 'missing.gguf'); await writeFile(configs[0].config, JSON.stringify(cfg));
  await assert.rejects(readDeepSeekProfiles(base), /ENOENT/);
  delete cfg.vision;
  cfg.args[0] = '--max-context'; await writeFile(configs[0].config, JSON.stringify(cfg));
  await assert.rejects(readDeepSeekProfiles(base), /prepared 262144/);
});
test('Strata version metadata remains discoverable offline without running an engine', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'archon-offline-version-'));
  const asset = join(dir, 'engine'), cfg = join(dir, 'profile.json'), path = join(dir, 'registry.json');
  const previous = process.env.ARCHON_STRATA_PROFILES;
  process.env.ARCHON_STRATA_PROFILES = path;
  t.after(async () => { if (previous === undefined) delete process.env.ARCHON_STRATA_PROFILES; else process.env.ARCHON_STRATA_PROFILES = previous; await rm(dir, { recursive: true, force: true }); });
  await writeFile(asset, 'not executable'); await writeFile(join(dir, 'BUILD.json'), JSON.stringify({ version: '0.1.44.1' }));
  await writeFile(cfg, JSON.stringify({ model_name: 'qwen-fixture', exe: asset, tokenizer: asset,
    args: ['--max-context', '262144', '--pack', asset, '--native', asset, '--ple-gguf', asset] }));
  await writeFile(path, JSON.stringify({ baseUrl: base, launcher: { python: '/usr/bin/python3', script: asset },
    profiles: [{ id: 'fixture', model: 'qwen-fixture', label: 'Qwen', unit: 'strata-fixture@fixture.service', config: cfg }] }));
  t.mock.method(globalThis, 'fetch', async () => { throw Error('No server/network in offline discovery'); });
  assert.equal(await installedStrataVersion(base), '0.1.44.1');
  assert.equal(await probeStrataVersion(base), '0.1.44.1');
  await writeFile(join(dir, 'BUILD.json'), JSON.stringify({ version: '0.1.45.3' }));
  // An external replacement must surface without a restart, even if a live
  // server still reports its shorter build version.
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ engine: '0.1.45' })));
  assert.equal(await probeStrataVersion(base), '0.1.45.3');
  assert.equal(await probeStrataVersion('http://remote.example/v1'), '0.1.45');
});

const sse = (events: unknown[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
function worker(config: Partial<WorkerConfig> = {}, vision = false) {
  return new OpenAIHttpWorkerProcess('deepseek-fixture', { provider: 'deepseek', model: profiles[0].model, effort: 'medium', cwd: '/tmp', ...config }, {
    name: 'deepseek', label: 'DeepSeek (Xolotl)', base: async () => base, chatWeb: true, toolResultPolicy: 'runtime',
    probe: async () => ({ up: true, models: profiles.map((p) => p.model), capabilities: Object.fromEntries(profiles.map((p) => [p.model, { ...p.capabilities, vision }])) }),
  });
}
function run(w: OpenAIHttpWorkerProcess) {
  return new Promise<any>((resolve, reject) => {
    let text = '', thinking = '';
    w.on('text', (s) => { text += s; }); w.on('thinking', (s) => { thinking += s; });
    w.once('error', reject); w.once('result', (result) => resolve({ text, thinking, result })); w.spawn('Use available tools then answer.');
  });
}
test('DeepSeek streams reasoning and tool round trips with exact budgets/context and retained reasoning', async (t) => {
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/search?')) return Response.json({ results: [{ title: 'Evidence', url: 'https://example.com', content: 'Tool evidence' }] });
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1 ? sse([
      { choices: [{ delta: { reasoning_content: 'Check the evidence.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'ds-tool', function: { name: 'WebSearch', arguments: '{"query":"evidence"}' } }] }, finish_reason: 'tool_calls' }] },
    ]) : sse([{ choices: [{ delta: { content: 'Confirmed.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 20 }, timings: { predicted_n: 20, predicted_ms: 1000 } }]);
  });
  const out = await run(worker({ interactionMode: 'chat', chatWebAccess: true }));
  assert.equal(out.text, 'Confirmed.'); assert.equal(out.thinking, 'Check the evidence.');
  assert.equal(bodies[0].reasoning_effort, 'medium'); assert.equal(bodies[0].max_tokens, 16384); assert.equal(bodies[0].reasoning_budget_tokens, 8192);
  assert.deepEqual(bodies[0].tools.map((t: any) => t.function.name), ['WebSearch', 'WebFetch']);
  assert.equal(bodies[1].messages.find((m: any) => m.tool_calls)?.reasoning_content, 'Check the evidence.');
  assert.equal(bodies[1].messages.at(-1).tool_call_id, 'ds-tool');
  assert.equal(out.result.modelContextWindow, 262144); assert.equal(out.result.lastPromptTokens, 1200);
  assert.equal(out.result.genSpeed.decodeTokens, 20);
});
test('DeepSeek saved Chat is web-only, offline omits tools, and strict Incognito stays rejected', async (t) => {
  assert(CHAT_PROVIDERS.has('deepseek')); assert(!INCOGNITO_CHAT_PROVIDERS.has('deepseek')); assert(chatWebArmed({ kind: 'chat' }, 'deepseek'));
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_u, init) => { bodies.push(JSON.parse(String(init?.body))); return sse([{ choices: [{ delta: { content: 'Offline.' }, finish_reason: 'stop' }] }]); });
  await run(worker({ interactionMode: 'chat', chatWebAccess: false, effort: 'none' }));
  assert.equal(bodies[0].tools, undefined); assert.equal(bodies[0].reasoning_effort, 'none');
});
test('images fail before model preparation or completion; primitive Read allowlist is retained', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_u, init) => {
    calls++; assert.deepEqual(JSON.parse(String(init?.body)).tools.map((t: any) => t.function.name), ['Read']);
    return sse([{ choices: [{ delta: { content: 'Read only.' }, finish_reason: 'stop' }] }]);
  });
  await assert.rejects(run(worker({ attachments: ['/tmp/unreadable.png'] })), /text-only/); assert.equal(calls, 0);
  await run(worker({ tools: ['Read'], skipPermissions: true })); assert.equal(calls, 1);
});
test('prepared vision forwards image bytes with native context and streaming', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'archon-deepseek-image-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'screenshot.png');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTH8AAAAASUVORK5CYII=';
  await writeFile(path, Buffer.from(png, 'base64'));
  t.mock.method(globalThis, 'fetch', async (_u, init) => {
    const content = JSON.parse(String(init?.body)).messages.at(-1).content;
    assert(content.some((p: any) => p.type === 'image_url' && p.image_url.url === `data:image/png;base64,${png}`));
    return sse([{ choices: [{ delta: { content: 'A screenshot.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1024, completion_tokens: 4 } }]);
  });
  assert.equal((await run(worker({ attachments: [path], tools: [] }, true))).text, 'A screenshot.');
});
test('live vision capability must match the selected prepared profile', async () => {
  const f = fixture();
  f.deps.registry = async () => ({ ...registry, profiles: profiles.map((p) => ({ ...p, capabilities: { ...p.capabilities, vision: true } })) });
  await assert.rejects(f.manager.ensure(base, profiles[0].model, new AbortController().signal, () => {}), /modalities/);
  f.deps.status = async () => ({ model: profiles[0].model, loaded: true, context: { max_positions: 262144 }, vision: { enabled: true } });
  await f.manager.ensure(base, profiles[0].model, new AbortController().signal, () => {});
  assert.deepEqual(f.calls, []);
});
test('cancel closes the streaming request and emits one terminal error', async (t) => {
  let w: OpenAIHttpWorkerProcess; let signal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_u, init) => {
    signal = init?.signal as AbortSignal;
    queueMicrotask(() => w.kill());
    return new Response(new ReadableStream({ start(c) { signal!.addEventListener('abort', () => c.close()); } }));
  });
  w = worker({ interactionMode: 'chat', chatWebAccess: false });
  await assert.rejects(run(w), /Worker killed/); assert(signal?.aborted); assert.equal(w.status, 'failed');
});
