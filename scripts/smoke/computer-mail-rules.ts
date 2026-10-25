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
  const dir = mkdtempSync(join(tmpdir(), 'archon-computer-mail-rules-'));
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
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ARCHON_PORT: String(port), ARCHON_WS_AUTH: 'off', ARCHON_SERVE_CLIENT: '0', ARCHON_COMPUTER_TEST_CODEX_HOME: codexHome }, stdio: ['ignore', log, log],
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
  const project = join(dir,'project'); mkdirSync(project);
  const config = { name: 'Computer', kind: 'chat', voiceOperator: true, primaryProvider: 'codex', primaryModel: 'gpt-6-luna', primaryEffort: 'low', codexTransport: 'appserver', workingDirectory: '', chatWebAccess: false, skipPermissions: false };
  let owner = '', b1 = '', b2 = '', director = '', cluster = '', ownerConfig: any;
  const post = async (path: string, body?: object) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, body ? { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) } : {});
    const result: any = await r.json(); if (!r.ok) throw Error(result.error ?? result.message); return result;
  };
  const api = (body?: object, id = owner) => post(`/api/voice/mail-rules?owner=${id}`, body);
  const arm = (id = owner) => api({action:'create',cluster_id:cluster,worker_ids:[b1],final_id:director},id);
  const mail = (to: string, content: string) => post(`/api/clusters/${cluster}/peer/send`,{from:to === director ? b1 : director,to,content});
  const read = (id: string) => post(`/api/clusters/${cluster}/peer/read`,{workflowId:id});
  const until = async (predicate: (state: any) => boolean, ownerId = owner) => {
    for (let i=0;i<160;i++) { const result = await api(undefined,ownerId); if (predicate(result)) return result; await new Promise((r)=>setTimeout(r,60)); }
    throw Error('Mailbox rule did not reach expected state');
  };
  const begin = async (id: string, content: string) => { c!.send({type:'user_message',workflowId:id,content}); await c!.waitFor((m)=>m.type==='primary_turn_started'&&m.workflowId===id,15000); };
  const ruleFile = join(home,'.archon','computer-mail-rules.json');
  try {
    await ready(); c = await connect(`ws://127.0.0.1:${port}/ws`);
    c.send({type:'create_workflow',config}); const created=await c.waitFor((m)=>m.type==='workflow_created',10000); owner=String(created.workflowId); ownerConfig=created.config;
    for (const name of ['Builder 1','Builder 2','Director']) {
      c.send({type:'create_workflow',config:{...config,kind:'workflow',voiceOperator:false,name,workingDirectory:project,skipPermissions:true}});
      const m=await c.waitFor((m)=>m.type==='workflow_created',10000); const id=String(m.workflowId);
      if(name==='Builder 1')b1=id; else if(name==='Builder 2')b2=id; else director=id;
    }
    c.send({type:'cluster_create',cwd:project,memberWorkflowIds:[b1,b2,director]}); const cl=await c.waitFor((m)=>m.type==='cluster_created',15000); cluster=String(cl.clusterId);
    await step('exact worker; unchanged mail never repeats; final waits for unselected members and their queues',async()=>{
      await mail(b1,'selected worker mail'); await mail(b2,'unselected worker mail'); await mail(director,'director report');
      const rule=(await arm()).rule;
      await until((s)=>s.rules.find((r:any)=>r.id===rule.id)?.workers[0].nudges===1);
      const started=await c!.waitFor((m)=>m.type==='primary_turn_started'&&m.workflowId===b1,15000); assert(started);
      await c!.waitFor((m)=>m.type==='primary_turn_ended'&&m.workflowId===b1,15000);
      // Fake providers don't call peer_read: unchanged unread mail must not loop.
      await new Promise((r)=>setTimeout(r,2300));
      assert.equal((await api()).rules.find((r:any)=>r.id===rule.id).workers[0].nudges,1);
      assert(!c!.peekMessages().some((m)=>m.type==='primary_turn_started'&&m.workflowId===b2));
      await read(b1); await mail(b1,'new mail after the first nudge');
      // Exercise the real 30-second cooldown; no shortened production guard.
      const afterFirst = (await api()).rules.find((r:any)=>r.id===rule.id);
      assert.equal(afterFirst.workers[0].nudges,1);
      for (let i=0;i<120;i++) {
        const current=(await api()).rules.find((r:any)=>r.id===rule.id);
        if(current.workers[0].nudges===2){
          assert(current.workers[0].lastNudgedAt-afterFirst.workers[0].lastNudgedAt>=30000); break;
        }
        if(i===119)assert.fail('New mail was not nudged after cooldown');
        await new Promise((r)=>setTimeout(r,300));
      }
      await c!.waitFor((m)=>m.type==='primary_turn_started'&&m.workflowId===b1,15000);
      await c!.waitFor((m)=>m.type==='primary_turn_ended'&&m.workflowId===b1,15000);
      await read(b1); await begin(b2,'slow unselected member');
      c!.send({type:'user_message',workflowId:b2,content:'slow queued member',kind:'follow-up',interjection:true});
      await read(b2);
      assert.equal((await api()).rules.find((r:any)=>r.id===rule.id).status,'watching');
      await until((s)=>s.rules.find((r:any)=>r.id===rule.id)?.status==='finished');
      await c!.waitFor((m)=>m.type==='primary_turn_started'&&m.workflowId===director,15000);
      const claims=await Promise.all([api({action:'claim-announcement',rule_id:rule.id}),api({action:'claim-announcement',rule_id:rule.id})]); assert.equal(claims.filter((s)=>s.announce).length,1);
      assert.match(readFileSync(ruleFile,'utf8'),/finished/);
      await read(director);
    });
    await step('cancellation and STOP prevent future automatic nudges',async()=>{
      let r=(await arm()).rule;
      assert.equal((await api({action:'cancel',rule_id:r.id})).rule.status,'cancelled');
      await begin(b1,'hang until stop'); r=(await arm()).rule;
      c!.send({type:'cancel',workflowId:b1}); await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.status==='interrupted');
      await mail(b1,'after cancellation'); await new Promise((r)=>setTimeout(r,2200));
      assert.equal((await api()).rules.find((x:any)=>x.id===r.id).workers[0].nudges,0); await read(b1);
    });
    await step('private rules never enter disk/notices and full clear discards them',async()=>{
      c!.send({type:'create_workflow',config:{...config,incognito:true}}); const m=await c!.waitFor((m)=>m.type==='workflow_created',10000); const priv=String(m.workflowId);
      const before=readFileSync(ruleFile,'utf8'), r=(await arm(priv)).rule;
      assert(r.private); assert(!(await api()).rules.some((x:any)=>x.id===r.id));
      await mail(b1,'private requested mailbox nudge'); await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.workers[0].nudges===1,priv);
      await read(b1); await mail(director,'private final report');
      await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.status==='finished',priv);
      assert.equal(readFileSync(ruleFile,'utf8'),before);
      assert(!c!.peekMessages().some((m)=>m.type==='workbench_notice'&&(m.notice as any)?.workflowId===priv));
      c!.send({type:'computer_context_control',workflowId:priv,action:'fresh'}); await c!.waitFor((m)=>m.type==='computer_context_updated'&&m.workflowId===priv&&m.fresh===true,15000);
      assert.equal((await api(undefined,priv)).rules.length,(await api()).rules.length); await read(director);
    });
    await step('disk failure refuses arming; corrupted mailbox fails closed',async()=>{
      renameSync(ruleFile,ruleFile+'.saved'); mkdirSync(ruleFile);
      try { await assert.rejects(arm(),/could not be saved/); assert(!(await api()).rules.some((r:any)=>r.status==='watching')); }
      finally { rmSync(ruleFile,{recursive:true}); renameSync(ruleFile+'.saved',ruleFile); }
      const rule=(await arm()).rule;
      const box=join(home,'.archon','clusters',cluster,'mailbox',b2); mkdirSync(box,{recursive:true}); writeFileSync(join(box,'corrupt.json'),'{bad'); await mail(director,'trigger authoritative mailbox change');
      await until((s)=>s.rules.find((r:any)=>r.id===rule.id)?.status==='failed'); rmSync(join(box,'corrupt.json')); await read(director);
    });
    await step('AUTO-PICKUP conflict refuses arming; enabling it stops an existing rule',async()=>{
      const r=(await arm()).rule; c!.send({type:'cluster_auto_turn_toggle',clusterId:cluster,enabled:true});
      await c!.waitFor((m)=>m.type==='cluster_state'&&m.clusterId===cluster&&(m.state as any).autoTurnOnMailboxEnabled===true,10000);
      await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.status==='interrupted'); await assert.rejects(arm(),/AUTO-PICKUP/);
      c!.send({type:'cluster_auto_turn_toggle',clusterId:cluster,enabled:false});
      // buildClusterStatePayload may finish an older async snapshot late.
      // Read the authoritative cache via HTTP instead of accepting stale WS OFF.
      for (let i=0;i<100;i++) {
        if (!(await post(`/api/clusters/${cluster}`)).autoTurnOnMailboxEnabled) break;
        await new Promise((r)=>setTimeout(r,30));
        if (i===99) assert.fail('AUTO-PICKUP did not turn off');
      }
    });
    await step('restart records interruption and never resumes saved automation',async()=>{
      const r=(await arm()).rule;
      await c!.close(); server.kill('SIGTERM'); await once(server,'exit'); server=start(); await ready(); c=await connect(`ws://127.0.0.1:${port}/ws`);
      c.send({type:'rehydrate_workflows',workflows:[{workflowId:owner,config:ownerConfig,currentSessionId:owner,lastSeq:0}]}); await c.waitFor((m)=>m.type==='computer_context_updated'&&m.workflowId===owner,15000);
      await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.status==='interrupted');
    });
  } finally { await c?.close(); if(server.exitCode===null){server.kill('SIGTERM');await once(server,'exit');} closeSync(log); }
  console.log('Artifacts:',dir);summary('computer-mail-rules');
}
main().catch((e)=>{console.error(e);process.exitCode=1;});
