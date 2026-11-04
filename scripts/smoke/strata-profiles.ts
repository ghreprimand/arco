// Full protocol smoke with fake Strata and intercepted registered user units.
// No real model, systemd service or operator workspace is touched.
import { createServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { connect, type SmokeClient } from './lib.js';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'arco-strata-profiles-'));
  const models = ['qwen-original-fixture', 'qwen-abliterated-fixture'];
  const units = ['strata-fixture@original.service', 'strata-fixture@abliterated.service'];
  const stateFile = join(dir, 'runtime.json');
  writeFileSync(stateFile, JSON.stringify({ index: 0, calls: [] }));
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  let pending: ServerResponse | undefined;
  const requests: any[] = [];
  function complete(res: ServerResponse, model: string) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: model }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
  }
  const runtime = createServer(async (req, res) => {
    const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    const index = state().index;
    if (index === -1) { res.writeHead(503); res.end('{}'); return; }
    if (req.url === '/v1/models') return json({ data: [{ id: models[index], meta: { n_ctx: 262144 }, architecture: { input_modalities: ['text', 'image'] } }] });
    if (req.url === '/v1/status') return json({ model: models[index], loaded: true, engine: '0.1.44.1', activity: { in_flight: pending ? 1 : 0 } });
    if (req.url === '/v1/chat/completions') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      assert.equal(body.model, models[index], 'never serve a model ID with the wrong weights');
      if (requests.length === 1) pending = res;
      else complete(res, models[index]);
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  runtime.listen(0, '127.0.0.1'); await once(runtime, 'listening');
  const base = `http://127.0.0.1:${(runtime.address() as { port: number }).port}/v1`;
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const home = join(dir, 'home'); mkdirSync(join(home, '.arco'), { recursive: true });
  writeFileSync(join(home, '.arco/settings.json'), JSON.stringify({ enabledProviders: { strata: true, ollama: false, lmstudio: false, llamacpp: false }, strata: { baseUrl: base } }));
  const prepared = join(dir, 'prepared'); writeFileSync(prepared, 'fixture');
  const preflight = join(dir, 'preflight.py'); writeFileSync(preflight, 'import sys\nassert sys.argv[1] == "check-switch"\n');
  const profiles = models.map((model, i) => {
    const config = join(dir, `config-${i}.json`);
    writeFileSync(config, JSON.stringify({ model_name: model, exe: prepared, tokenizer: prepared, args: ['--max-context', '262144', '--pack', prepared, '--native', prepared, '--ple-gguf', prepared, '--vision'], vision: { exe: prepared, model: prepared, mmproj: prepared } }));
    return { id: i ? 'abliterated' : 'original', model, label: i ? 'SC117 Abliterated' : 'Original', unit: units[i], config };
  });
  const registryFile = join(home, '.arco/strata-profiles.json');
  writeFileSync(registryFile, JSON.stringify({ baseUrl: base, launcher: { python: '/usr/bin/python3', script: preflight }, profiles }));
  const preload = join(dir, 'isolate.mjs');
  writeFileSync(preload, `import os from 'node:os'; import cp from 'node:child_process'; import fs from 'node:fs'; import {promisify} from 'node:util'; import {syncBuiltinESMExports} from 'node:module';
os.homedir = () => ${JSON.stringify(home)};
const originalExec = cp.execFile, realExec = promisify(originalExec), units = ${JSON.stringify(units)}, file = ${JSON.stringify(stateFile)};
const intercepted = async (command, args, options) => {
 if (command !== 'systemctl' || !args.some(a => units.includes(a))) return realExec(command, args, options);
 const unit = args.find(a => units.includes(a)), index = units.indexOf(unit), s = JSON.parse(fs.readFileSync(file, 'utf8'));
 if (args.includes('show')) return {stdout: 'LoadState=loaded\\nActiveState=' + (s.index === index ? 'active' : 'inactive') + '\\n', stderr: ''};
 const action = args.includes('start') ? 'start' : 'stop'; s.calls.push(action + ' ' + index); s.index = action === 'start' ? index : -1; fs.writeFileSync(file, JSON.stringify(s)); return {stdout: '', stderr: ''};
};
cp.execFile = (...args) => originalExec(...args); cp.execFile[promisify.custom] = intercepted; syncBuiltinESMExports();
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
 const u = new URL(String(url));
 if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return Promise.resolve(new Response('{}', {status:503}));
 return originalFetch(url, init);
};\n`);
  const log = openSync(join(dir, 'server.log'), 'w');
  const child = spawn(process.execPath, ['--conditions', 'development', '--import', 'tsx', '--import', preload, 'server/src/index.ts'], {
    env: { ...process.env, ARCO_PORT: String(port), ARCO_UPDATE_CHECK: '0', ARCO_WS_AUTH: 'off', ARCO_SERVE_CLIENT: '0', ARCO_STRATA_PROFILES: registryFile, ARCO_LOCAL_PROVIDER_SERIAL_QUEUE: '0' }, stdio: ['ignore', log, log],
  });
  let c: SmokeClient | undefined;
  try {
    const api = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error(`Source server exited; see ${dir}/server.log`);
      try { ready = (await fetch(`${api}/api/capabilities`)).ok; } catch {}
      if (ready) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(ready, `Server never became ready: ${dir}`);
    const auth = await (await fetch(`${api}/api/auth-status`)).json() as any;
    assert.deepEqual(auth.strata.installedModels, models);
    assert.equal(auth.strata.installedModelLabels[models[1]], 'SC117 Abliterated');
    for (const model of models) assert.deepEqual(auth.strata.installedModelCapabilities[model], { tools: true, thinking: true, vision: true, numCtx: 262144 });
    c = await connect(`ws://127.0.0.1:${port}/ws`);
    const ids: string[] = [];
    for (const model of models) {
      c.send({ type: 'create_workflow', config: { kind: 'chat', name: 'Strata profile smoke', primaryProvider: 'strata', primaryModel: model, primaryEffort: 'none', workingDirectory: '', chatWebAccess: false } });
      ids.push(String((await c.waitFor((m) => m.type === 'workflow_created', 10000)).workflowId));
    }
    c.send({ type: 'user_message', workflowId: ids[0], content: 'Hold original turn.' });
    for (let i = 0; i < 80 && !pending; i++) await new Promise((r) => setTimeout(r, 100));
    assert(pending);
    c.send({ type: 'user_message', workflowId: ids[1], content: 'Use abliterated.' });
    await c.waitFor((m) => m.type === 'system_notice' && m.workflowId === ids[1] && String(m.content).includes('queued'), 10000);
    assert.equal(requests.length, 1); assert.deepEqual(state().calls, []);
    complete(pending, models[0]); pending = undefined;
    const second = await c.waitFor((m) => m.type === 'primary_complete' && m.workflowId === ids[1], 15000);
    assert.equal(second.modelContextWindow, 262144);
    await c.waitFor((m) => m.type === 'primary_turn_ended' && m.workflowId === ids[1], 10000);
    assert.deepEqual(state().calls, ['stop 0', 'start 1']);
    c.send({ type: 'update_primary_config', workflowId: ids[1], model: models[0] });
    await c.waitFor((m) => m.type === 'workflow_config_synced' && m.workflowId === ids[1], 10000);
    assert.equal(state().index, 1, 'selection alone does not load weights');
    c.send({ type: 'user_message', workflowId: ids[1], content: 'Now use original in the same conversation.' });
    await c.waitFor((m) => m.type === 'primary_complete' && m.workflowId === ids[1], 15000);
    assert.deepEqual(state().calls, ['stop 0', 'start 1', 'stop 1', 'start 0']);
    assert.equal(requests[2].model, models[0]);
    assert(requests[2].messages.some((m: any) => m.role === 'assistant' && m.content === models[1]), 'conversation carries over');
    assert(requests.every((body) => body.tools === undefined), 'Chat project tools stay absent');
    for (const workflowId of ids) c.send({ type: 'remove_workflow', workflowId });
    console.log('PASS: prepared profile discovery/labels/context/vision, serial turns despite queue override, exact weights, same-tab switch, retained conversation and Chat boundary.');
  } finally {
    pending?.destroy(); if (c) await c.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit'); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await stopped; clearTimeout(timer);
    }
    closeSync(log); runtime.closeAllConnections(); await new Promise<void>((resolve) => runtime.close(() => resolve()));
    console.log(`Artifacts: ${dir}`);
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
