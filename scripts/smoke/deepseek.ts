// Isolated HTTP/WS acceptance: fake Xolotl and launcher, no real GPU/services.
import { createServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { connect, type SmokeClient } from './lib.js';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'arco-deepseek-smoke-'));
  const models = ['exact', 'light'].map((id) => `deepseek-v4.1-flash-1017-${id}`);
  const stateFile = join(dir, 'runtime.json');
  writeFileSync(stateFile, JSON.stringify({ index: -1, calls: [], mining: false }));
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  let pending: ServerResponse | undefined;
  const requests: any[] = [];
  const runtime = createServer(async (req, res) => {
    const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    const index = state().index;
    if (index === -1) { res.writeHead(503); res.end('{}'); return; }
    if (req.url === '/v1/status') return json({ model: models[index], loaded: true, context: { max_positions: 262144 }, vision: { enabled: true }, activity: { in_flight: pending ? 1 : 0 } });
    if (req.url === '/v1/chat/completions') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body); assert.equal(body.model, models[index]);
      if (String(body.messages.at(-1).content).includes('Hold')) {
        pending = res; res.on('close', () => { if (pending === res) pending = undefined; }); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Fixture reasoning.' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: models[index] }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 }, timings: { predicted_n: 10, predicted_ms: 500 } })}\n\ndata: [DONE]\n\n`);
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
  writeFileSync(join(home, '.arco/settings.json'), JSON.stringify({ enabledProviders: { deepseek: true }, deepseek: { baseUrl: base } }));
  const asset = join(dir, 'asset'); writeFileSync(asset, 'fixture');
  writeFileSync(join(dir, 'vision.py'), 'fixture'); writeFileSync(join(dir, 'image_processor.py'), 'fixture');
  const launcher = join(dir, 'guarded.py');
  writeFileSync(launcher, `import json,sys\np=${JSON.stringify(stateFile)}\ns=json.load(open(p))\na=sys.argv[1]\nif a=='status': print(json.dumps({'miners':[{'name':'fixture-miner'}] if s['mining'] else [],'preparation':{'phase':'ready'}}))\nelif a in ('start','stop'):\n if a=='start' and s['mining']: sys.exit('Mining is running')\n s['calls'].append(a+' '+sys.argv[2]);s['index']=['exact','light'].index(sys.argv[2]) if a=='start' else -1\n json.dump(s,open(p,'w'))\nelse: sys.exit('unsupported fixture action')\n`);
  const profiles = models.map((model, i) => {
    const id = i ? 'light' : 'exact', config = join(dir, `${id}.json`);
    writeFileSync(config, JSON.stringify({ model_name: model, cwd: dir, exe: asset, tokenizer: asset,
      vision: { exe: asset, python: '/usr/bin/python3', mmproj: asset, model: asset, reference_dir: dir, gpu: false, lazy: true, max_tokens: 1024 },
      args: ['--ctx', '262144', '-m', asset, '--engram', dir, '--rank', asset, '--route-bias', i ? '0.25' : '0', '--route-bias-file', i ? '0.15' : '0'] }));
    return { id, model, label: `${id} · Xolotl`, config };
  });
  const registry = join(home, '.arco/deepseek-profiles.json');
  writeFileSync(registry, JSON.stringify({ baseUrl: base, runtime: dir, launcher: { python: '/usr/bin/python3', script: launcher }, profiles }));
  const preload = join(dir, 'isolate.mjs');
  writeFileSync(preload, `import os from 'node:os'; import cp from 'node:child_process'; import fs from 'node:fs'; import {promisify} from 'node:util'; import {syncBuiltinESMExports} from 'node:module';
os.homedir = () => ${JSON.stringify(home)};
const original = cp.execFile, real = promisify(original);
cp.execFile = (...args) => original(...args);
cp.execFile[promisify.custom] = async (cmd,args,options) => {
 if (cmd === 'git' && args[1] === ${JSON.stringify(dir)}) return {stdout:'1111111111111111111111111111111111111111',stderr:''};
 if (cmd !== 'systemctl' || !args.some(a => /^deepseek-flash@(exact|light)\\.service$/.test(a))) return real(cmd,args,options);
 const s=JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)},'utf8')); const unit=args.find(a=>a.startsWith('deepseek-flash@')); const i=unit.includes('@exact')?0:1;
 return {stdout:s.index===i?'active\\n':'inactive\\n',stderr:''};
}; syncBuiltinESMExports();
const realFetch=globalThis.fetch;
globalThis.fetch=(url,init)=>{const u=new URL(String(url));
 if(u.hostname==='api.github.com' && u.pathname.includes('Xolotl/commits/HEAD'))return Promise.resolve(Response.json({sha:'2222222222222222222222222222222222222222'}));
 if(u.hostname!=='127.0.0.1'&&u.hostname!=='localhost')return Promise.resolve(new Response('{}',{status:503}));
 return realFetch(url,init);};\n`);
  const log = openSync(join(dir, 'server.log'), 'w');
  const child = spawn(process.execPath, ['--conditions', 'development', '--import', 'tsx', '--import', preload, 'server/src/index.ts'], {
    env: { ...process.env, ARCO_PORT: String(port), ARCO_WS_AUTH: 'off', ARCO_SERVE_CLIENT: '0', ARCO_DEEPSEEK_PROFILES: registry }, stdio: ['ignore', log, log],
  });
  let c: SmokeClient | undefined;
  try {
    const api = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 160; i++) {
      if (child.exitCode !== null) throw Error(`Server exited: ${dir}/server.log`);
      try { if ((await fetch(`${api}/api/capabilities`)).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    const auth = await (await fetch(`${api}/api/auth-status`)).json() as any;
    assert.deepEqual(auth.deepseek.installedModels, models);
    assert.deepEqual(auth.deepseek.installedModelCapabilities[models[0]], { tools: true, thinking: true, vision: true, numCtx: 262144 });
    const caps = await (await fetch(`${api}/api/capabilities`)).json() as any;
    assert.equal(caps.xolotlRevision, '1111111111111111111111111111111111111111');
    assert.equal(caps.latestVersions.xolotl, '2222222222222222222222222222222222222222');
    const control = (body: unknown) => fetch(`${api}/api/deepseek`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const stopped = await (await fetch(`${api}/api/deepseek`)).json() as any;
    assert.equal(stopped.profiles.length, 2); assert(stopped.profiles.every((p: any) => !p.loaded));
    assert.equal((await control({ action: 'load', profile: 'exact' })).status, 200);
    c = await connect(`ws://127.0.0.1:${port}/ws`);
    c.send({ type: 'create_workflow', config: { kind: 'chat', name: 'DeepSeek smoke', primaryProvider: 'deepseek', primaryModel: models[0], primaryEffort: 'medium', workingDirectory: '', chatWebAccess: false } });
    const workflowId = String((await c.waitFor((m) => m.type === 'workflow_created', 10000)).workflowId);
    c.send({ type: 'user_message', workflowId, content: 'Fixture answer.' });
    const complete = await c.waitFor((m) => m.type === 'primary_complete' && m.workflowId === workflowId, 10000);
    assert.equal(complete.modelContextWindow, 262144); assert.equal(complete.genSpeed?.decodeTokens, 10);
    await c.waitFor((m) => m.type === 'primary_turn_ended' && m.workflowId === workflowId, 10000);
    assert.equal(requests[0].reasoning_effort, 'medium'); assert.equal(requests[0].max_tokens, 16384); assert.equal(requests[0].tools, undefined);
    const image = join(dir, 'image.png');
    writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTH8AAAAASUVORK5CYII=', 'base64'));
    c.send({ type: 'user_message', workflowId, content: 'Look at this image.', attachments: [image] });
    await c.waitFor((m) => m.type === 'primary_turn_ended' && m.workflowId === workflowId, 10000);
    assert(requests.at(-1).messages.at(-1).content.some((p: any) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')), 'image bytes reached runtime');
    assert.equal((await control({ action: 'load', profile: 'light' })).status, 200);
    c.send({ type: 'update_primary_config', workflowId, model: models[1] });
    c.send({ type: 'user_message', workflowId, content: 'Hold this response.' });
    for (let i = 0; i < 100 && !pending; i++) await new Promise((r) => setTimeout(r, 100));
    assert(pending); assert.equal((await control({ action: 'unload' })).status, 409);
    assert.equal((await fetch(`${api}/api/local-models/unload`, { method: 'POST' })).status, 409);
    c.send({ type: 'cancel', workflowId });
    await c.waitFor((m) => m.type === 'primary_turn_ended' && m.workflowId === workflowId, 10000);
    for (let i = 0; i < 50 && pending; i++) await new Promise((r) => setTimeout(r, 100));
    assert(!pending, 'cancel disconnected the runtime request');
    const unloaded = await control({ action: 'unload' }); assert.equal(unloaded.status, 200);
    assert.equal(state().index, -1);
    assert.deepEqual(state().calls, ['start exact', 'stop exact', 'start light', 'stop light']);
    const mining = state(); mining.mining = true; writeFileSync(stateFile, JSON.stringify(mining));
    const refused = await control({ action: 'load', profile: 'exact' }); assert.equal(refused.status, 409);
    assert.match(JSON.stringify(await refused.json()), /Mining/); assert.equal(state().index, -1);
    c.send({ type: 'remove_workflow', workflowId });
    console.log('PASS: offline profiles/revision tracking, guarded load/switch, WS images/context/reasoning/streaming, busy unload refusal, cancellation, service release and mining refusal.');
  } finally {
    pending?.destroy(); if (c) await c.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await stopped; clearTimeout(timer);
    }
    closeSync(log); runtime.closeAllConnections(); await new Promise<void>((resolve) => runtime.close(() => resolve()));
    console.log('Isolated artifacts:', dir);
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
