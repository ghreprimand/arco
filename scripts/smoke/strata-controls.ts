// Self-contained source-server smoke: never uses the live Arco or Strata.
import { createServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { connect, type SmokeClient } from './lib.js';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'arco-strata-controls-'));
  const model = 'strata-controls-fixture';
  let pending: ServerResponse | undefined;
  let requestBody: any;
  let unloads = 0;
  const runtime = createServer(async (req, res) => {
    const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/v1/models') return json({ data: [{ id: model, meta: { n_ctx: 262144 }, architecture: { input_modalities: ['text', 'image'] } }] });
    if (req.url === '/v1/status') return json({ model, loaded: true, engine: '0.1.44.1', activity: { in_flight: pending ? 1 : 0 } });
    if (req.url === '/v1/unload') { unloads++; return json({ loaded: false, status: 'unloaded' }); }
    if (req.url === '/api/ps') return json({ models: [] });
    if (req.url === '/api/v1/models') return json({ models: [] });
    if (req.url === '/v1/chat/completions') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      requestBody = JSON.parse(raw); pending = res; return;
    }
    res.writeHead(404); res.end('{}');
  });
  runtime.listen(0, '127.0.0.1'); await once(runtime, 'listening');
  const runtimePort = (runtime.address() as { port: number }).port;
  const base = `http://127.0.0.1:${runtimePort}`;
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const home = join(dir, 'home'); mkdirSync(join(home, '.arco'), { recursive: true });
  writeFileSync(join(home, '.arco/settings.json'), JSON.stringify({
    enabledProviders: { strata: true, ollama: false, lmstudio: false, llamacpp: false },
    strata: { baseUrl: `${base}/v1` }, ollama: { baseUrl: base }, lmstudio: { baseUrl: `${base}/v1` },
  }));
  const preload = join(dir, 'isolate.mjs');
  writeFileSync(preload, `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module';
os.homedir = () => ${JSON.stringify(home)}; syncBuiltinESMExports();
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
 const u = new URL(String(url));
 if (u.hostname === 'api.github.com' && u.pathname.includes('Niko1221/Strata/releases/latest')) return Promise.resolve(Response.json({tag_name:'v0.2.0-beta',body:'Engine package version 0.1.45.3.'}));
 if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return Promise.resolve(new Response('{}', {status:503}));
 return originalFetch(url, init);
};\n`);
  const log = openSync(join(dir, 'server.log'), 'w');
  const child = spawn(process.execPath, ['--conditions', 'development', '--import', 'tsx', '--import', preload, 'server/src/index.ts'], {
    env: { ...process.env, ARCO_PORT: String(port), ARCO_UPDATE_CHECK: '0', ARCO_WS_AUTH: 'off', ARCO_SERVE_CLIENT: '0' }, stdio: ['ignore', log, log],
  });
  let c: SmokeClient | undefined;
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error(`Source server exited; see ${dir}/server.log`);
      try { ready = (await fetch(`http://127.0.0.1:${port}/api/capabilities`)).ok; } catch {}
      if (ready) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(ready, `Source server never became ready; see ${dir}/server.log`);
    const api = `http://127.0.0.1:${port}`;
    const caps = await (await fetch(`${api}/api/capabilities`)).json() as any;
    assert.equal(caps.strataVersion, '0.1.44.1');
    assert.equal(caps.latestVersions.strata, '0.1.45.3');
    c = await connect(`ws://127.0.0.1:${port}/ws`);
    c.send({ type: 'create_workflow', config: { kind: 'chat', name: 'Strata controls smoke', primaryProvider: 'strata', primaryModel: model, primaryEffort: 'none', workingDirectory: '', skipPermissions: false, chatWebAccess: true } });
    const created = await c.waitFor((m) => m.type === 'workflow_created', 10000);
    const workflowId = String(created.workflowId);
    c.send({ type: 'user_message', workflowId, content: 'Say fixture.' });
    for (let i = 0; i < 80 && !pending; i++) await new Promise((r) => setTimeout(r, 100));
    assert(pending, 'Completion reached fixture');
    assert.equal(requestBody.reasoning_effort, 'none');
    assert.deepEqual(requestBody.tools.map((t: any) => t.function.name), ['WebSearch', 'WebFetch']);
    const busy = await fetch(`${api}/api/local-models/unload`, { method: 'POST' });
    assert.equal(busy.status, 409); assert.equal(unloads, 0);
    const complete = c.waitFor((m) => m.type === 'primary_complete' && m.workflowId === workflowId, 10000);
    pending.writeHead(200, { 'Content-Type': 'text/event-stream' });
    pending.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 25 }, timings: { predicted_n: 25, predicted_ms: 500, prompt_n: 100, prompt_ms: 200 } })}\n\ndata: [DONE]\n\n`); pending = undefined;
    assert.deepEqual((await complete).genSpeed, { decodeTokens: 25, decodeMs: 500, prefillTokens: 100, prefillMs: 200 });
    await c.waitFor((m) => m.type === 'primary_turn_ended' && m.workflowId === workflowId, 10000);
    const idle = await fetch(`${api}/api/local-models/unload`, { method: 'POST' });
    const report = await idle.json() as any;
    assert.equal(idle.status, 200); assert.equal(unloads, 1);
    assert(report.results.some((r: any) => r.provider === 'strata' && r.state === 'unloaded'));
    c.send({ type: 'remove_workflow', workflowId });
    console.log('PASS: Strata versions, None effort, Chat web-only tools, generation speed WS event, busy refusal and idle unload HTTP route.');
  } finally {
    if (pending) pending.destroy();
    if (c) await c.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit'); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await stopped; clearTimeout(timer);
    }
    closeSync(log);
    runtime.closeAllConnections(); await new Promise<void>((resolve) => runtime.close(() => resolve()));
    console.log('Isolated smoke artifacts:', dir);
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
