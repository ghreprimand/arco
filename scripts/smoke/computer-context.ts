// Isolated source-server protocol/lifecycle acceptance. Fake Codex, no quota.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { connect, step, summary, type SmokeClient } from './lib.js';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'archon-computer-smoke-'));
  const home = join(dir, 'home'), bin = join(dir, 'bin'); mkdirSync(bin); mkdirSync(home);
  const codexHome = join(home, '.codex'); mkdirSync(codexHome);
  const executable = join(bin, 'codex');
  writeFileSync(executable, '#!/usr/bin/env node\n' + readFileSync('scripts/smoke/fixtures/computer-context-codex.mjs', 'utf8')); chmodSync(executable, 0o755);
  const preload = join(dir, 'isolate.mjs');
  const watchdogUrl=pathToFileURL(join(process.cwd(),'server/src/voice/turnWatchdog.ts')).href;
  writeFileSync(preload, `import os from 'node:os';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {COMPUTER_DEADLINES} from ${JSON.stringify(watchdogUrl)};Object.assign(COMPUTER_DEADLINES,{startup:3000,idle:700,total:6500});os.homedir=()=>${JSON.stringify(home)};const original=cp.spawn;cp.spawn=(command,args,options)=>original(command==='codex'?${JSON.stringify(executable)}:command,args,options);syncBuiltinESMExports();globalThis.fetch=async()=>new Response('{}',{status:503});\n`);
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = (reserve.address() as { port: number }).port; await new Promise<void>((r) => reserve.close(() => r()));
  const log = openSync(join(dir, 'server.log'), 'w');
  let durablePrivate = false;
  const start = () => spawn(process.execPath, ['--conditions', 'development', '--import', 'tsx', '--import', preload, 'server/src/index.ts'], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ARCHON_PORT: String(port), ARCHON_WS_AUTH: 'off', ARCHON_SERVE_CLIENT: '0', ARCHON_COMPUTER_TEST_CODEX_HOME: codexHome, ARCHON_COMPUTER_FIXTURE_DURABLE_PRIVATE: durablePrivate ? '1' : '0' }, stdio: ['ignore', log, log],
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
  let id = '', resolvedConfig: any, privateConfig: any;
  const state = (test: (state: any) => boolean) => c!.waitFor((m) => m.type === 'computer_context_updated' && m.workflowId === id && test(m.state), 15000, 'Computer context state');
  const fresh = (resets: number) => c!.waitFor((m) => m.type === 'computer_context_updated' && m.workflowId === id && m.fresh === true && (m.state as any)?.resets === resets, 15000, 'fresh thread boundary');
  try {
    await ready(); c = await connect(`ws://127.0.0.1:${port}/ws`);
    c.send({ type: 'create_workflow', config });
    const created = await c.waitFor((m) => m.type === 'workflow_created', 10000); id = String(created.workflowId); resolvedConfig = created.config;
    await step('fresh requested mid-turn waits through the entire queued follow-up', async () => {
      c!.send({ type: 'user_message', workflowId: id, content: 'large slow request' });
      await c!.waitFor((m) => m.type === 'primary_turn_started' && m.workflowId === id, 15000);
      c!.send({ type: 'computer_context_control', workflowId: id, action: 'fresh' });
      await state((s) => s.pendingFresh === true);
      assert(!c!.peekMessages().some((m) => m.type === 'computer_context_updated' && m.fresh === true));
      c!.send({ type: 'user_message', workflowId: id, content: 'queued follow-up', kind: 'follow-up', interjection: true });
      const boundary = await fresh(1); assert.equal((boundary.state as any).resets, 1);
      const turns = readFileSync(join(codexHome, 'fixture-turns.jsonl'), 'utf8').trim().split('\n').map((s) => JSON.parse(s));
      assert.equal(turns.length, 2); assert.equal(turns[0].threadId, turns[1].threadId);
      assert.equal(turns[1].text, 'queued follow-up');
    });
    await step('a new request really uses a different thread and receives no archived transcript', async () => {
      c!.send({ type: 'user_message', workflowId: id, content: 'new thought' });
      await c!.waitFor((m) => m.type === 'primary_text' && String(m.text).includes('Completed new thought'), 15000);
      const turns = readFileSync(join(codexHome, 'fixture-turns.jsonl'), 'utf8').trim().split('\n').map((s) => JSON.parse(s));
      assert.notEqual(turns[2].threadId, turns[1].threadId); assert.equal(turns[2].text, 'new thought');
      await c!.waitFor((m) => m.type === 'codex_token_snapshot' && (m.tokens as any)?.input === 1000, 15000);
    });
    await step('KEEP CONTEXT postpones a threshold reset until released', async () => {
      c!.send({ type: 'computer_context_control', workflowId: id, action: 'configure', keepContext: true });
      await state((s) => s.keepContext === true);
      c!.send({ type: 'user_message', workflowId: id, content: 'large held conversation' });
      await c!.waitFor((m) => m.type === 'codex_token_snapshot' && (m.tokens as any)?.input === 60000, 15000);
      c!.send({ type: 'computer_context_control', workflowId: id, action: 'configure', keepContext: false });
      const boundary = await fresh(2); assert.equal((boundary.state as any).lastResetReason, 'threshold');
      assert.equal((boundary.state as any).resets, 2);
    });
    await step('automatic 50% reset happens after a slow turn completes, without compaction', async () => {
      c!.send({ type: 'user_message', workflowId: id, content: 'large slow automatic' });
      await c!.waitFor((m) => m.type === 'primary_text' && String(m.text).includes('Completed large slow automatic'), 15000);
      const boundary = await fresh(3); assert.equal((boundary.state as any).resets, 3);
      assert.equal((boundary.state as any).lastResetReason, 'threshold');
      const meta = JSON.parse(readFileSync(join(resolvedConfig.workingDirectory, '.archon', 'workflows', id, 'meta.json'), 'utf8'));
      assert.equal(meta.cliSessions.length, 0); assert.equal(meta.history.length, 3);
    });
    await step('OFF preserves a large context, manual fresh still works, and invalid thresholds are rejected', async () => {
      c!.send({ type: 'computer_context_control', workflowId: id, action: 'configure', resetAtPercent: 95 });
      await c!.waitFor((m) => m.type === 'error' && m.workflowId === id && String(m.message).includes('10% and 75%'));
      c!.send({ type: 'computer_context_control', workflowId: id, action: 'configure', resetAtPercent: null });
      await state((s) => s.resetAtPercent === null);
      c!.send({ type: 'user_message', workflowId: id, content: 'large preserved context' });
      await c!.waitFor((m) => m.type === 'codex_token_snapshot' && (m.tokens as any)?.input === 60000, 15000);
      c!.send({ type: 'computer_context_control', workflowId: id, action: 'configure', keepContext: false });
      await state((s) => s.resetAtPercent === null && s.resets === 3);
      c!.send({ type: 'computer_context_control', workflowId: id, action: 'fresh' });
      await fresh(4);
    });
    await step('server restart after reset keeps the archive and cannot resurrect the old thread', async () => {
      await c!.close(); server.kill('SIGTERM'); await once(server, 'exit'); server = start(); await ready();
      c = await connect(`ws://127.0.0.1:${port}/ws`);
      c.send({ type: 'rehydrate_workflows', workflows: [{ workflowId: id, config: resolvedConfig, currentSessionId: id, lastSeq: 0 }] });
      await state((s) => s.resets === 4 && s.resetAtPercent === null);
      c.send({ type: 'user_message', workflowId: id, content: 'after restart' });
      await c.waitFor((m) => m.type === 'primary_text' && String(m.text).includes('Completed after restart'), 15000);
      const turns = readFileSync(join(codexHome, 'fixture-turns.jsonl'), 'utf8').trim().split('\n').map((s) => JSON.parse(s));
      assert.notEqual(turns.at(-1).threadId, turns.at(-2).threadId); assert.equal(turns.at(-1).text, 'after restart');
    });
    await step('a pending manual fresh request waits for STOP to settle, then clears', async () => {
      c!.send({ type: 'user_message', workflowId: id, content: 'slow stopped request' });
      await c!.waitFor((m) => m.type === 'primary_turn_started' && m.workflowId === id, 15000);
      c!.send({ type: 'computer_context_control', workflowId: id, action: 'fresh' });
      await state((s) => s.pendingFresh === true && s.resets === 4);
      c!.send({ type: 'cancel', workflowId: id });
      await fresh(5);
    });
    await step('Computer timeout ignores fake activity, cancels queued actions, and resumes history on a new process', async () => {
      c!.send({type:'create_workflow',config});
      id=String((await c!.waitFor((m)=>m.type==='workflow_created',10000)).workflowId);
      c!.send({type:'user_message',workflowId:id,content:'hang on a tool result'});
      await c!.waitFor((m)=>m.type==='primary_text' && m.workflowId===id,15000);
      c!.send({type:'user_message',workflowId:id,content:'QUEUED_ACTION_MUST_NOT_RUN',mode:'follow-up',clientMessageId:'cancel-on-timeout'});
      const error=await c!.waitFor((m)=>m.type==='error' && m.workflowId===id && String(m.message).startsWith('[COMPUTER TIMEOUT]'),15000);
      assert.match(String(error.message),/No action tools were dispatched/);
      await c!.waitFor((m)=>m.type==='queued_message_cancelled' && m.workflowId===id && m.clientMessageId==='cancel-on-timeout',15000);
      await c!.waitFor((m)=>m.type==='computer_context_updated' && m.workflowId===id && m.settled===true,15000);
      const before=readFileSync(join(codexHome,'fixture-turns.jsonl'),'utf8').trim().split('\n').map((s)=>JSON.parse(s));
      const previous=before.at(-1);
      assert(!before.some((row)=>row.text.includes('QUEUED_ACTION_MUST_NOT_RUN')));
      c!.send({type:'user_message',workflowId:id,content:'normal request after recovery'});
      await c!.waitFor((m)=>m.type==='computer_context_updated' && m.workflowId===id && m.settled===true,15000);
      const after=readFileSync(join(codexHome,'fixture-turns.jsonl'),'utf8').trim().split('\n').map((s)=>JSON.parse(s));
      assert.equal(after.at(-1).threadId,previous.threadId);
      assert.notEqual(after.at(-1).pid,previous.pid);
      assert.equal(after.filter((row)=>row.threadId===previous.threadId).length,2,'never replay the stalled request');
    });
    await step('ordinary Chat is not subject to the Computer watchdog', async()=>{
      c!.send({type:'create_workflow',config:{...config,voiceOperator:false,name:'Ordinary chat'}});
      const normalId=String((await c!.waitFor((m)=>m.type==='workflow_created',10000)).workflowId);
      c!.send({type:'user_message',workflowId:normalId,content:'hang in an ordinary chat'});
      await c!.waitFor((m)=>m.type==='primary_text' && m.workflowId===normalId,15000);
      await assert.rejects(c!.waitFor((m)=>m.type==='error' && m.workflowId===normalId,1100));
      c!.send({type:'cancel',workflowId:normalId});
      await c!.waitFor((m)=>m.type==='primary_turn_ended' && m.workflowId===normalId,15000);
    });
    await step('private Computer timeout discards the lost ephemeral context before a new request',async()=>{
      c!.send({type:'create_workflow',config:{...config,incognito:true}});
      id=String((await c!.waitFor((m)=>m.type==='workflow_created',10000)).workflowId);
      c!.send({type:'user_message',workflowId:id,content:'hang PRIVATE_RECOVERY_SENTINEL_9182'});
      await c!.waitFor((m)=>m.type==='error' && m.workflowId===id && String(m.message).startsWith('[COMPUTER TIMEOUT]'),15000);
      const reset=await fresh(1);assert.equal(reset.discardTranscript,true);
      assert.equal((reset.state as any).lastResetReason,'recovery');
      await c!.waitFor((m)=>m.type==='computer_context_updated' && m.workflowId===id && m.settled===true,15000);
      c!.send({type:'user_message',workflowId:id,content:'new private request'});
      await c!.waitFor((m)=>m.type==='computer_context_updated' && m.workflowId===id && m.settled===true,15000);
      const rows=readFileSync(join(codexHome,'fixture-turns.jsonl'),'utf8').trim().split('\n').map((s)=>JSON.parse(s));
      assert.notEqual(rows.at(-1).threadId,rows.at(-2).threadId);
      assert(!readFileSync(join(dir,'server.log'),'utf8').includes('PRIVATE_RECOVERY_SENTINEL_9182'));
    });
    await step('Incognito Codex uses an ephemeral app-server thread, clears at 50%, and creates no saved transcript', async () => {
      c!.send({ type: 'create_workflow', config: { ...config, incognito: true } });
      const made = await c!.waitFor((m) => m.type === 'workflow_created', 10000);
      id = String(made.workflowId); privateConfig = made.config;
      assert.equal((made.config as any).codexTransport, 'appserver');
      c!.send({ type: 'user_message', workflowId: id, content: 'large PRIVATE_CODEX_SENTINEL_8217' });
      const boundary = await fresh(1); assert.equal(boundary.discardTranscript, true);
      await c!.waitFor((m) => m.type === 'computer_context_updated' && m.workflowId === id && m.settled === true, 15000);
      c!.send({ type: 'user_message', workflowId: id, content: 'after private clear' });
      await c!.waitFor((m) => m.type === 'primary_text' && m.workflowId === id && String(m.text).includes('after private clear'), 15000);
      await c!.waitFor((m) => m.type === 'computer_context_updated' && m.workflowId === id && m.settled === true, 15000);
      const privateDir = join(String((made.config as any).workingDirectory), '.archon', 'workflows', id);
      const { existsSync } = await import('node:fs');
      assert.equal(existsSync(privateDir), false);
      assert(!readFileSync(join(dir, 'server.log'), 'utf8').includes('PRIVATE_CODEX_SENTINEL_8217'));
      const turns = readFileSync(join(codexHome, 'fixture-turns.jsonl'), 'utf8').trim().split('\n').map((s) => JSON.parse(s));
      assert.notEqual(turns.at(-1).threadId, turns.at(-2).threadId);
      assert.equal(turns.at(-1).text, 'after private clear');
    });
    await step('a private page reconnecting after server restart discards its obsolete browser transcript', async () => {
      await c!.close(); server.kill('SIGTERM'); await once(server, 'exit'); server = start(); await ready();
      c = await connect(`ws://127.0.0.1:${port}/ws`);
      c.send({type:'rehydrate_workflows',workflows:[{workflowId:id,config:privateConfig,currentSessionId:id,lastSeq:0}]});
      const cleared = await c.waitFor((m)=>m.type==='computer_context_updated' && m.workflowId===id && m.discardTranscript===true,15000);
      assert.equal(cleared.fresh,true); assert.equal((cleared.state as any).resets,0);
      c.send({type:'user_message',workflowId:id,content:'new private server epoch'});
      await c.waitFor((m)=>m.type==='primary_text' && m.workflowId===id && String(m.text).includes('new private server epoch'),15000);
      const turns=readFileSync(join(codexHome,'fixture-turns.jsonl'),'utf8').trim().split('\n').map((s)=>JSON.parse(s));
      assert.notEqual(turns.at(-1).threadId,turns.at(-2).threadId);
    });
    await step('a Codex server that returns a durable private thread is refused before sending any utterance', async () => {
      await c!.close(); server.kill('SIGTERM'); await once(server, 'exit'); durablePrivate = true; server = start(); await ready();
      c = await connect(`ws://127.0.0.1:${port}/ws`);
      c.send({type:'create_workflow',config:{...config,incognito:true}});
      const made = await c.waitFor((m)=>m.type==='workflow_created',10000); id=String(made.workflowId);
      c.send({type:'user_message',workflowId:id,content:'DO_NOT_SEND_PRIVATE_29817'});
      await c.waitFor((m)=>m.type==='error' && m.workflowId===id && JSON.stringify(m).includes('memory-only'),15000);
      assert(!readFileSync(join(codexHome,'fixture-turns.jsonl'),'utf8').includes('DO_NOT_SEND_PRIVATE_29817'));
    });
  } finally {
    await c?.close(); server.kill('SIGTERM'); await once(server, 'exit'); closeSync(log);
    console.log(`Isolated artifacts: ${dir}`);
  }
  summary('computer-context');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
