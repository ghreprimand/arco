// Self-contained source-server smoke with a fake Codex executable. No live workers.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect, type SmokeClient } from './lib.js';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'arco-question-smoke-'));
  const bin = join(dir, 'bin'), home = join(dir, 'home'); mkdirSync(bin); mkdirSync(join(home, '.arco'), { recursive: true });
  const executable = join(bin, 'codex'); copyFileSync('scripts/smoke/fixtures/question-codex.mjs', executable);
  writeFileSync(executable, '#!/usr/bin/env node\n' + readFileSync(executable, 'utf8')); chmodSync(executable, 0o755);
  const preload = join(dir, 'isolate.mjs');
  writeFileSync(preload, `import os from 'node:os';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';os.homedir=()=>${JSON.stringify(home)};const originalSpawn=cp.spawn;cp.spawn=(command,args,options)=>originalSpawn(command==='codex'?${JSON.stringify(executable)}:command,args,options);syncBuiltinESMExports();globalThis.fetch=async()=>new Response('{}',{status:503});\n`);
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = (reserve.address() as { port: number }).port; await new Promise<void>((r) => reserve.close(() => r()));
  const log = openSync(join(dir, 'server.log'), 'w');
  const child = spawn(process.execPath, ['--conditions', 'development', '--import', 'tsx', '--import', preload, 'server/src/index.ts'], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ARCO_PORT: String(port), ARCO_UPDATE_CHECK: '0', ARCO_WS_AUTH: 'off', ARCO_SERVE_CLIENT: '0' }, stdio: ['ignore', log, log],
  });
  let c: SmokeClient | undefined;
  try {
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error(`Server exited; see ${dir}/server.log`);
      try { if ((await fetch(`http://127.0.0.1:${port}/api/capabilities`)).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    const url = `ws://127.0.0.1:${port}/ws`;
    c = await connect(url);
    c.send({ type: 'create_workflow', config: { kind: 'chat', name: 'Operator questions smoke', primaryProvider: 'codex', primaryModel: 'gpt-5.5', primaryEffort: 'high', codexTransport: 'appserver', workingDirectory: '', skipPermissions: false, chatWebAccess: false } });
    const created = await c.waitFor((m) => m.type === 'workflow_created', 10000);
    const workflowId = String(created.workflowId);
    c.send({ type: 'user_message', workflowId, content: 'question-demo' });
    const ask = await c.waitFor((m) => m.type === 'operator_question' && (m.question as any)?.status === 'pending', 15000, 'blocking question');
    const question = ask.question as any;
    assert.equal(question.mode, 'blocking'); assert.equal(question.questions[0].options[0].description, 'Use this location.');
    // Browser disconnect must leave the real pending handle alive.
    await c.close(); c = await connect(url);
    c.send({ type: 'rehydrate_workflows', workflows: [{ workflowId, config: created.config, currentSessionId: question.threadId, lastSeq: ask.seq }] });
    const snapshot = await c.waitFor((m) => m.type === 'workflow_state_snapshot', 15000, 'reconnect snapshot');
    assert.equal((snapshot.operatorQuestions as any[])[0].requestId, question.requestId);
    c.send({ type: 'operator_question_reply', workflowId, requestId: question.requestId, answers: { destination: ['Stay'] } });
    const invalid = await c.waitFor((m) => m.type === 'operator_question_reply_result', 5000);
    assert.equal(invalid.ok, false);
    c.send({ type: 'operator_question_reply', workflowId, requestId: question.requestId, answers: { destination: ['Stay'], note: ['Custom note'] } });
    await c.waitFor((m) => m.type === 'operator_question' && (m.question as any)?.status === 'answered', 5000);
    const asyncAsk = await c.waitFor((m) => m.type === 'operator_question' && (m.question as any)?.mode === 'async', 10000, 'async question');
    await c.waitFor((m) => m.type === 'primary_turn_ended', 10000);
    c.send({ type: 'operator_question_reply', workflowId, requestId: (asyncAsk.question as any).requestId, answers: { 'question-1': ['Blue'] } });
    await c.waitFor((m) => m.type === 'operator_question' && (m.question as any)?.status === 'answered', 5000);
    const answer = await c.waitFor((m) => m.type === 'primary_text' && String(m.text).includes('Async answer received'), 10000, 'async answer dispatch');
    assert.match(String(answer.text), /Blue/);
    await c.waitFor((m) => m.type === 'primary_turn_ended', 10000);
    c.send({ type: 'user_message', workflowId, content: 'cancel-question' });
    const cancelAsk = await c.waitFor((m) => m.type === 'operator_question' && (m.question as any)?.status === 'pending', 10000);
    c.send({ type: 'cancel', workflowId });
    await c.waitFor((m) => m.type === 'operator_question' && (m.question as any)?.status === 'cancelled', 5000);
    c.send({ type: 'operator_question_reply', workflowId, requestId: (cancelAsk.question as any).requestId, answers: { destination: ['Stay'], note: ['Custom note'] } });
    const stale = await c.waitFor((m) => m.type === 'operator_question_reply_result' && m.requestId === (cancelAsk.question as any).requestId, 5000);
    assert.equal(stale.ok, false);
    c.send({ type: 'remove_workflow', workflowId });
    console.log('PASS: blocking questions, option descriptions, reconnect snapshot, validation, per-ID replies, async question after turn completion, normal answer turn, cancel and stale reply.');
  } finally {
    if (c) await c.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await stopped; clearTimeout(timer);
    }
    closeSync(log); console.log('Isolated artifacts:', dir);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
