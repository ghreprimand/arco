// Isolated HTTP + real turn-loop acceptance. Canned Codex, no paid calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, openSync, closeSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect, step, summary, type SmokeClient } from './lib.js';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'arco-computer-tools-'));
  const home = join(dir, 'home'), bin = join(dir, 'bin'), codexHome = join(home, '.codex');
  mkdirSync(bin); mkdirSync(codexHome, { recursive: true });
  const executable = join(bin, 'codex');
  writeFileSync(executable, '#!/usr/bin/env node\n' + readFileSync('scripts/smoke/fixtures/computer-context-codex.mjs', 'utf8')); chmodSync(executable, 0o755);
  const preload = join(dir, 'isolate.mjs');
  writeFileSync(preload, `import os from 'node:os';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';os.homedir=()=>${JSON.stringify(home)};const original=cp.spawn;cp.spawn=(command,args,options)=>original(command==='codex'?${JSON.stringify(executable)}:command,args,options);syncBuiltinESMExports();globalThis.fetch=async()=>new Response('{}',{status:503});\n`);
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = (reserve.address() as { port: number }).port; await new Promise<void>((r) => reserve.close(() => r()));
  const log = openSync(join(dir, 'server.log'), 'w');
  const start = () => spawn(process.execPath, ['--conditions', 'development', '--import', 'tsx', '--import', preload, 'server/src/index.ts'], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ARCO_PORT: String(port), ARCO_WS_AUTH: 'off', ARCO_SERVE_CLIENT: '0', ARCO_COMPUTER_TEST_CODEX_HOME: codexHome }, stdio: ['ignore', log, log],
  });
  let server = start(), c: SmokeClient | undefined;
  const ready = async () => {
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw Error(`Server exited; see ${dir}/server.log`);
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    throw Error('Server not ready');
  };
  const config = { kind: 'chat', name: 'Computer', voiceOperator: true, primaryProvider: 'codex', primaryModel: 'gpt-6-luna', primaryEffort: 'low', codexTransport: 'appserver', workingDirectory: '', chatWebAccess: false, skipPermissions: false };
  let owner = '', b1 = '', b2 = '', ownerConfig: any;
  const api = async (body?: object, id = owner) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/voice/watches?owner=${id}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const result: any = await response.json(); if (!response.ok) throw Error(result.error); return result;
  };
  const until = async (id: string, status: string, watchOwner = owner) => {
    for (let i = 0; i < 100; i++) { const w = (await api(undefined, watchOwner)).watches.find((w: any) => w.id === id); if (w?.status === status) return w; await new Promise((r) => setTimeout(r, 60)); }
    throw Error('Watch did not become ' + status);
  };
  const begin = async (id: string, content: string) => {
    c!.send({ type: 'user_message', workflowId: id, content });
    await c!.waitFor((m) => m.type === 'primary_turn_started' && m.workflowId === id, 15000);
  };
  try {
    await ready(); c = await connect(`ws://127.0.0.1:${port}/ws`);
    for (const name of ['Computer', 'Builder 1', 'Builder 2']) {
      c.send({ type: 'create_workflow', config: { ...config, name, voiceOperator: name === 'Computer' } });
      const m = await c.waitFor((m) => m.type === 'workflow_created', 10000);
      if (name === 'Computer') { owner = String(m.workflowId); ownerConfig = m.config; }
      else if (name === 'Builder 1') b1 = String(m.workflowId); else b2 = String(m.workflowId);
    }
    await step('Builder 2 finishing does not trigger Builder 1, and queued work keeps the watch armed', async () => {
      await begin(b1, 'slow first work');
      const armed = await api({ action: 'create', target: b1 });
      assert.deepEqual(armed.watch.targets.map((t: any) => t.id), [b1]);
      c!.send({ type: 'user_message', workflowId: b1, content: 'slow queued work', kind: 'follow-up', interjection: true });
      await begin(b2, 'other builder finishes');
      await c!.waitFor((m) => m.type === 'primary_turn_ended' && m.workflowId === b2, 15000);
      assert.equal((await api()).watches[0].status, 'watching');
      await c!.waitFor((m) => m.type === 'primary_text' && m.workflowId === b1 && String(m.text).includes('first work'), 15000);
      assert.equal((await api()).watches[0].status, 'watching');
      await until(armed.watch.id, 'finished');
      const notice = await c!.waitFor((m) => m.type === 'workbench_notice' && (m.notice as any)?.category === 'computer-watch', 5000);
      assert.equal((notice.notice as any).severity, 'success');
      const claims = await Promise.all([api({ action: 'claim-announcement', watch_id: armed.watch.id }), api({ action: 'claim-announcement', watch_id: armed.watch.id })]);
      assert.equal(claims.filter((r) => r.announce).length, 1, 'only one browser gets speech delivery');
    });
    await step('cancel reports interruption, never successful completion', async () => {
      await begin(b1, 'hang until stopped'); const w = (await api({ action: 'create', target: b1 })).watch;
      c!.send({ type: 'cancel', workflowId: b1 }); await until(w.id, 'interrupted');
    });
    await step('unknown/idle targets do not silently arm future work', async () => {
      await assert.rejects(api({ action: 'create', target: 'does-not-exist' }), /unavailable/);
      await assert.rejects(api({ action: 'create', target: '../escape' }), /exact id/);
      await assert.rejects(api({ action: 'create', target: b2 }), /already idle/);
      await begin(b2, 'hang until watch cancellation');
      const w = (await api({ action: 'create', target: b2 })).watch;
      assert.equal((await api({ action: 'cancel', watch_id: w.id })).watch.status, 'cancelled');
      c!.send({ type: 'cancel', workflowId: b2 });
      await until(w.id, 'cancelled');
    });
    await step('private watches never enter the saved watch file and a full clear discards them', async () => {
      c!.send({ type: 'create_workflow', config: { ...config, incognito: true } });
      const p = await c!.waitFor((m) => m.type === 'workflow_created', 10000), privateId = String(p.workflowId);
      await begin(b2, 'slow private watch finish');
      const file = join(home, '.arco', 'computer-watches.json'); const before = readFileSync(file, 'utf8');
      const w = (await api({ action: 'create', target: b2 }, privateId)).watch;
      assert(w.private); assert.equal(readFileSync(file, 'utf8'), before);
      assert(!(await api()).watches.some((x: any) => x.id === w.id));
      await until(w.id, 'finished', privateId);
      assert.equal(readFileSync(file, 'utf8'), before);
      assert(!c!.peekMessages().some((m) => m.type === 'workbench_notice' && (m.notice as any)?.workflowId === privateId));
      await begin(b2, 'hang for private clear');
      const pending = (await api({ action: 'create', target: b2 }, privateId)).watch;
      c!.send({ type: 'computer_context_control', workflowId: privateId, action: 'fresh' });
      await c!.waitFor((m) => m.type === 'computer_context_updated' && m.workflowId === privateId && m.fresh === true, 15000);
      assert(!(await api(undefined, privateId)).watches.some((x: any) => [w.id,pending.id].includes(x.id)));
      c!.send({ type: 'cancel', workflowId: b2 });
    });
    await step('a persistence failure refuses arming and leaves no hidden active watch', async () => {
      await begin(b2, 'hang while testing disk failure');
      const file = join(home, '.arco', 'computer-watches.json');
      renameSync(file, file + '.saved'); mkdirSync(file);
      try {
        await assert.rejects(api({ action: 'create', target: b2 }), /could not be saved/);
        assert(!(await api()).watches.some((w: any) => w.status === 'watching' && w.targets.some((t: any) => t.id === b2)));
      } finally { rmSync(file, { recursive: true }); renameSync(file + '.saved', file); c!.send({ type: 'cancel', workflowId: b2 }); }
    });
    await step('server restart preserves watches as interrupted, never fabricates success', async () => {
      await begin(b1, 'hang across server restart'); const w = (await api({ action: 'create', target: b1 })).watch;
      await c!.close(); server.kill('SIGTERM'); await once(server, 'exit'); server = start(); await ready();
      c = await connect(`ws://127.0.0.1:${port}/ws`); c.send({ type: 'rehydrate_workflows', workflows: [{ workflowId: owner, config: ownerConfig, currentSessionId: owner, lastSeq: 0 }] });
      await c.waitFor((m) => m.type === 'computer_context_updated' && m.workflowId === owner, 15000);
      await until(w.id, 'interrupted');
    });
  } finally { await c?.close(); if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); } closeSync(log); }
  console.log('Artifacts:', dir); summary('computer-tools');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
