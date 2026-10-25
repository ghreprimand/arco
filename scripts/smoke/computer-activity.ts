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
  const dir = mkdtempSync(join(tmpdir(), 'archon-computer-activity-'));
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
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ARCHON_PORT: String(port), ARCHON_WS_AUTH: 'off', ARCHON_SERVE_CLIENT: '0', ARCHON_COMPUTER_TEST_CODEX_HOME: codexHome, ARCHON_COMPUTER_FIXTURE_ACTIVITY_DELAY_MS:'800' }, stdio: ['ignore', log, log],
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
  const project=join(dir,'project');mkdirSync(project);
  const config={name:'Computer',kind:'chat',voiceOperator:true,primaryProvider:'codex',primaryModel:'gpt-6-luna',primaryEffort:'low',codexTransport:'appserver',workingDirectory:'',chatWebAccess:false,skipPermissions:false};
  let owner='',b1='',b2='',cluster='',ownerConfig:any;
  const post=async(path:string,body?:object)=>{
    const r=await fetch(`http://127.0.0.1:${port}${path}`,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
    const result:any=await r.json();if(!r.ok)throw Error(result.error??result.message);return result;
  };
  const api=(body?:object,id=owner)=>post(`/api/voice/activity?owner=${id}`,body);
  const rule=(body?:object)=>post(`/api/voice/mail-rules?owner=${owner}`,body);
  const mail=(to:string)=>post(`/api/clusters/${cluster}/peer/send`,{from:to===b1?b2:b1,to,content:'mailbox test'});
  const read=(id:string)=>post(`/api/clusters/${cluster}/peer/read`,{workflowId:id});
  const until=async(predicate:(s:any)=>boolean,id=owner)=>{
    for(let i=0;i<160;i++){const s=await api(undefined,id);if(predicate(s))return s;await new Promise((r)=>setTimeout(r,40));}throw Error('Activity state did not settle');
  };
  const begin=async(id:string,content:string)=>{c!.send({type:'user_message',workflowId:id,content});await c!.waitFor((m)=>m.type==='primary_turn_started'&&m.workflowId===id,15000);};
  const activityFile=join(home,'.archon','computer-activity.json');
  try{
    await ready();c=await connect(`ws://127.0.0.1:${port}/ws`);
    for(const name of ['Computer','Builder 1','Builder 2']){
      c.send({type:'create_workflow',config:name==='Computer'?config:{...config,kind:'workflow',voiceOperator:false,name,workingDirectory:project,skipPermissions:true}});
      const m=await c.waitFor((m)=>m.type==='workflow_created',10000);if(name==='Computer'){owner=String(m.workflowId);ownerConfig=m.config;}else if(name==='Builder 1')b1=String(m.workflowId);else b2=String(m.workflowId);
    }
    c.send({type:'cluster_create',cwd:project,memberWorkflowIds:[b1,b2]});const cl=await c.waitFor((m)=>m.type==='cluster_created',15000);cluster=String(cl.clusterId);
    await step('live worker events use the full queue boundary; default feed makes no model calls',async()=>{
      await begin(b1,'slow first directive');c!.send({type:'user_message',workflowId:b1,content:'slow queued directive',kind:'follow-up',interjection:true});
      await c!.waitFor((m)=>m.type==='primary_turn_ended'&&m.workflowId===b1,15000);
      assert(!(await api()).ledger.some((e:any)=>e.kind==='worker_finished'&&e.workflowId===b1));
      const state=await until((s)=>s.ledger.some((e:any)=>e.kind==='worker_finished'&&e.workflowId===b1));
      assert.equal(state.deliveries.length,0);assert.equal(state.policy.agentUpdates,'off');
      assert(c!.peekMessages().some((m)=>m.type==='computer_activity_changed'&&m.workflowId===owner));
      assert(!JSON.stringify(state.ledger).includes('slow queued directive'),'ledger contains facts, not transcript text');
    });
    await step('opt-in queues while Computer is busy; one batch delivers once and cannot invoke tools',async()=>{
      await api({action:'configure',agent_updates:'workers'});await begin(owner,'hang while taking a directive');
      await begin(b1,'first worker fact');await until((s)=>s.pending===1);
      await begin(b2,'second worker fact');let state=await until((s)=>s.pending===2);
      assert(state.deliveries.every((d:any)=>d.status==='queued'));
      c!.send({type:'cancel',workflowId:owner});
      state=await until((s)=>s.deliveries.some((d:any)=>d.status==='delivering'));
      const denied=await post('/api/voice/tool',{workflowId:owner,tool:'archon_nudge',args:{target:b1}});assert.equal(denied.ok,false);assert.match(denied.error,/Background activity/);
      state=await until((s)=>s.deliveries.filter((d:any)=>d.status==='delivered').length===2);
      assert.equal(state.pending,0);
      const turns=readFileSync(join(codexHome,'fixture-turns.jsonl'),'utf8').trim().split('\n').map((line)=>JSON.parse(line));
      assert.equal(turns.filter((t)=>t.text.startsWith('[Archon activity update')).length,1);
    });
    await step('master pause and per-condition pause/resume react immediately to events',async()=>{
      await api({action:'configure',agent_updates:'off',enabled:false});await mail(b1);
      const r=(await rule({action:'create',cluster_id:cluster,worker_ids:[b1],final_id:b2})).rule;
      await new Promise((r)=>setTimeout(r,150));assert.equal((await rule()).rules.find((x:any)=>x.id===r.id).workers[0].nudges,0);
      await rule({action:'pause',rule_id:r.id});await api({action:'configure',enabled:true});
      assert.equal((await rule()).rules.find((x:any)=>x.id===r.id).paused,true);
      const started=Date.now();await rule({action:'resume',rule_id:r.id});
      for(let i=0;i<40;i++){if((await rule()).rules.find((x:any)=>x.id===r.id).workers[0].nudges===1)break;await new Promise((r)=>setTimeout(r,20));if(i===39)assert.fail('Event dispatch took longer than 800ms');}
      assert(Date.now()-started<1500);await rule({action:'cancel',rule_id:r.id});await read(b1);
    });
    await step('matches feed ignores unrelated worker events, then receives the exact matched condition',async()=>{
      await api({action:'configure',agent_updates:'matches'});const before=(await api()).deliveries.length;
      await begin(b2,'slow watched worker');
      const w=await post(`/api/voice/watches?owner=${owner}`,{action:'create',target:b2});assert(w.watch);
      await until((s)=>s.deliveries.length===before+1&&s.deliveries.at(-1).status==='delivered');
      const last=(await api()).deliveries.at(-1);assert.equal(last.event.kind,'condition_matched');
    });
    await step('private event settings/inbox never persist, and a private full clear removes them',async()=>{
      c!.send({type:'create_workflow',config:{...config,incognito:true}});const m=await c!.waitFor((m)=>m.type==='workflow_created',10000);const priv=String(m.workflowId);
      await api({action:'configure',agent_updates:'workers'},priv);await begin(priv,'hang private while updates queue');
      await begin(b1,'worker event for private Computer');await until((s)=>s.pending===1,priv);
      assert(!readFileSync(activityFile,'utf8').includes(priv));
      c!.send({type:'computer_context_control',workflowId:priv,action:'fresh'});c!.send({type:'cancel',workflowId:priv});
      await c!.waitFor((m)=>m.type==='computer_context_updated'&&m.workflowId===priv&&m.fresh===true,15000);
      const state=await api(undefined,priv);assert.equal(state.policy.agentUpdates,'off');assert.equal(state.deliveries.length,0);
      assert(!readFileSync(activityFile,'utf8').includes(priv));
    });
    await step('persistence failure stops automatic dispatch and a restart never replays queued updates',async()=>{
      await begin(owner,'hang while collecting restart update');await api({action:'configure',agent_updates:'workers'});
      await begin(b1,'restart worker fact');await until((s)=>s.pending>0);
      renameSync(activityFile,activityFile+'.saved');mkdirSync(activityFile);
      try{await assert.rejects(api({action:'configure',agent_updates:'matches'}),/could not be saved/);}finally{rmSync(activityFile,{recursive:true});renameSync(activityFile+'.saved',activityFile);}
      await c!.close();server.kill('SIGTERM');await once(server,'exit');server=start();await ready();c=await connect(`ws://127.0.0.1:${port}/ws`);
      c.send({type:'rehydrate_workflows',workflows:[{workflowId:owner,config:ownerConfig,currentSessionId:owner,lastSeq:0}]});await c.waitFor((m)=>m.type==='computer_context_updated'&&m.workflowId===owner,15000);
      const state=await api();assert.equal(state.pending,0);assert(state.deliveries.some((d:any)=>d.status==='interrupted'));
    });
  }finally{await c?.close();if(server.exitCode===null){server.kill('SIGTERM');await once(server,'exit');}closeSync(log);}
  console.log('Artifacts:',dir);summary('computer-activity');
}
main().catch((e)=>{console.error(e);process.exitCode=1;});
