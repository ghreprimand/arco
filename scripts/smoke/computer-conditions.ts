// Isolated HTTP + real turn-loop acceptance. Canned Codex, no paid calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, openSync, closeSync, renameSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect, step, summary, type SmokeClient } from './lib.js';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'arco-computer-conditions-'));
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
  const project = join(dir,'project'); mkdirSync(project);
  const config = { name: 'Computer', kind: 'chat', voiceOperator: true, primaryProvider: 'codex', primaryModel: 'gpt-6-luna', primaryEffort: 'low', codexTransport: 'appserver', workingDirectory: '', chatWebAccess: false, skipPermissions: false };
  let owner = '', b1 = '', b2 = '', director = '', cluster = '', ownerConfig: any;
  const post = async (path: string, body?: object) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, body ? { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) } : {});
    const result: any = await r.json(); if (!r.ok) throw Error(result.error ?? result.message); return result;
  };
  const api = (body?: object, id = owner) => post(`/api/voice/conditions?owner=${id}`, body);
  const arm = (definition: object, id = owner) => api({action:'create',definition},id);
  const mail = (to: string, content: string, from=to===director?b1:director) => post(`/api/clusters/${cluster}/peer/send`,{from,to,content});
  const read = (id: string) => post(`/api/clusters/${cluster}/peer/read`,{workflowId:id});
  const until = async (predicate: (state: any) => boolean, ownerId = owner) => {
    for (let i=0;i<160;i++) { const result = await api(undefined,ownerId); if (predicate(result)) return result; await new Promise((r)=>setTimeout(r,60)); }
    throw Error('Mailbox rule did not reach expected state');
  };
  const begin = async (id: string, content: string) => {
    c!.send({type:'user_message',workflowId:id,content});
    // Scripted turns leave start/end events in the buffer. The exact operator
    // echo fences those stale events before waiting for this turn to start.
    await c!.waitFor((m)=>m.type==='user_message_echo'&&m.workflowId===id&&m.content===content,15000);
    await c!.waitFor((m)=>m.type==='primary_turn_started'&&m.workflowId===id,15000);
  };
  const ruleFile = join(home,'.arco','computer-conditions.json');
  try {
    await ready(); c = await connect(`ws://127.0.0.1:${port}/ws`);
    c.send({type:'create_workflow',config}); const created=await c.waitFor((m)=>m.type==='workflow_created',10000); owner=String(created.workflowId); ownerConfig=created.config;
    for (const name of ['Builder 1','Builder 2','Director']) {
      c.send({type:'create_workflow',config:{...config,kind:'workflow',voiceOperator:false,name,workingDirectory:project,skipPermissions:true}});
      const m=await c.waitFor((m)=>m.type==='workflow_created',10000); const id=String(m.workflowId);
      if(name==='Builder 1')b1=id; else if(name==='Builder 2')b2=id; else director=id;
    }
    c.send({type:'cluster_create',cwd:project,memberWorkflowIds:[b1,b2,director]}); const cl=await c.waitFor((m)=>m.type==='cluster_created',15000); cluster=String(cl.clusterId);
    const group=(field:string,value:unknown)=>({op:'group',worker_ids:[b1,b2],quantifier:'all',field,cmp:'eq',value});
    const def=(hold_on_input=false)=>({label:'Operator exact policy',cluster_ids:[cluster],hold_on_input,hold_worker_ids:[b1,b2],clauses:[
      {id:'mail',when:{op:'group',worker_ids:[b1,b2],quantifier:'any',field:'pending_mail',cmp:'gt',value:0},actions:[{kind:'nudge_mail',worker_ids:[b1,b2]}],repeat:'changes'},
      {id:'settled',when:{op:'all',conditions:[group('busy',false),group('queued',0),group('pending_mail',0)]},actions:[{kind:'notify',text:'Workers settled. Director left alone.'}],finish:true},
    ]});
    await step('composable exact worker policy, new-mail dedup and notify-only completion leave Director alone',async()=>{
      await mail(b1,'first worker mail');await mail(b2,'second worker mail');await mail(director,'report for Director');
      const r=(await arm(def())).rule;
      await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.workerTurns[b1]?.count===1&&s.rules.find((x:any)=>x.id===r.id)?.workerTurns[b2]?.count===1);
      await new Promise((r)=>setTimeout(r,300));
      let current=(await api()).rules.find((x:any)=>x.id===r.id);assert.equal(current.actions,2);assert(!current.workerTurns[director]);
      await read(b1);await read(b2);await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.status==='finished');
      current=(await api()).rules.find((x:any)=>x.id===r.id);assert.equal(current.announcements.length,1);assert(!current.workerTurns[director]);
      const claims=await Promise.all([api({action:'claim-announcement',rule_id:r.id,announcement_id:current.announcements[0].id}),api({action:'claim-announcement',rule_id:r.id,announcement_id:current.announcements[0].id})]);assert.equal(claims.filter((s)=>s.announce).length,1);await read(director);
    });
    await step('ordinary worker question holds all actions until an actual operator answer; observer never answers',async()=>{
      await begin(b1,'NEEDS_OPERATOR_INPUT');await c!.waitFor((m)=>m.type==='primary_turn_ended'&&m.workflowId===b1,10000);
      await mail(b1,'mail while question waits');const r=(await arm(def(true))).rule;
      await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.reason.includes('Holding'));
      assert.equal((await api()).rules.find((x:any)=>x.id===r.id).actions,0);
      const state=await api({action:'state',cluster_ids:[cluster]});assert.equal(state.workers.find((w:any)=>w.id===b1).needs_input,true);
      await begin(b1,'The human answered: use option B.');await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.workerTurns[b1]?.count===1);
      await read(b1);await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.status==='finished');
      assert((await api()).observationTurnsThisHour>=2);
    });
    await step('operator limits exceed the old ceilings and can be removed in place; more than eight nudges dispatch without replay',async()=>{
      const caps=await api({action:'capabilities'});assert.match(caps.limits,/No default time/);
      const definition={label:'No arbitrary nudge ceiling',cluster_ids:[cluster],hold_on_input:false,ttl_minutes:360,max_actions:500,max_worker_turns:100,cooldown_seconds:0,clauses:[
        {id:'mail',when:{op:'worker',worker_id:b1,field:'pending_mail',cmp:'gt',value:0},actions:[{kind:'nudge_mail',worker_ids:[b1]}],repeat:'changes'},
      ]};
      // This fixture sender stays below the separate per-provider-turn peer-send
      // budget; the assertion concerns script-dispatched turns, not peer tools.
      await mail(b1,'mail before removing limits',b2);const r=(await arm(definition)).rule;
      assert.equal(r.definition.max_worker_turns,100);assert.equal(r.definition.max_actions,500);assert.equal(r.definition.ttl_minutes,360);
      await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.actions===1);
      const {ttl_minutes,max_actions,max_worker_turns,cooldown_seconds,...withoutBudgets}=definition;
      const preserved=(await api({action:'update',rule_id:r.id,expected_revision:0,definition:{...withoutBudgets,label:'Same policy, renamed'}})).rule;
      assert.equal(preserved.definition.ttl_minutes,360);assert.equal(preserved.definition.max_actions,500);assert.equal(preserved.definition.max_worker_turns,100);assert.equal(preserved.definition.cooldown_seconds,0);assert.equal(preserved.expiresAt,r.expiresAt,'omitted budgets cannot broaden a saved script');
      const current=(await api({action:'list',rule_id:r.id})).rule;
      const updated=(await api({action:'update',rule_id:r.id,expected_revision:current.revision,definition:{...current.definition,ttl_minutes:null,max_actions:null,max_worker_turns:null}})).rule;
      assert.equal(updated.id,r.id);assert.equal(updated.actions,1);assert.equal(updated.expiresAt,null);
      for(let i=2;i<=10;i++){
        await read(b1);await mail(b1,`new mail ${i}`,b2);
        await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.workerTurns[b1]?.count===i);
      }
      await new Promise((resolve)=>setTimeout(resolve,1400));
      const live=(await api()).rules.find((x:any)=>x.id===r.id);assert.equal(live.actions,10);assert.equal(live.status,'watching');assert(!live.workerTurns[director]);
      assert.equal(JSON.parse(readFileSync(ruleFile,'utf8')).find((x:any)=>x.id===r.id).workerTurns[b1].count,10);
      await api({action:'cancel',rule_id:r.id});await read(b1);await mail(b1,'mail after cancellation',b2);await new Promise((resolve)=>setTimeout(resolve,200));
      assert.equal((await api()).rules.find((x:any)=>x.id===r.id).actions,10);await read(b1);
    });
    await step('unknown semantic observation holds without repeated classifier calls',async()=>{
      await begin(b1,'UNKNOWN_INPUT');await c!.waitFor((m)=>m.type==='primary_turn_ended'&&m.workflowId===b1,10000);
      await mail(b1,'held unread mail');const r=(await arm(def(true))).rule;
      await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.reason.includes('Holding'));
      const count=(await api()).observationTurnsThisHour;
      await mail(director,'unrelated event must not retry the same text');await new Promise((r)=>setTimeout(r,300));
      const current=await api();assert.equal(current.observationTurnsThisHour,count);assert.equal(current.rules.find((x:any)=>x.id===r.id).actions,0);
      await api({action:'cancel',rule_id:r.id});await read(b1);await read(director);
    });
    await step('context telemetry triggers native compaction and continuation waits for its actual completion',async()=>{
      await begin(b1,'large settled context');await c!.waitFor((m)=>m.type==='primary_turn_ended'&&m.workflowId===b1,10000);
      let filled=false;for(let i=0;i<100;i++){const state=await api({action:'state',cluster_ids:[cluster]});if(state.workers.find((w:any)=>w.id===b1).context_percent>=40){filled=true;break;}await new Promise((r)=>setTimeout(r,30));}assert(filled,'latest per-request context reaches 40 percent');
      const r=(await arm({label:'Compact then resume exactly',cluster_ids:[cluster],hold_on_input:false,clauses:[
        {id:'compact',when:{op:'all',conditions:[{op:'worker',worker_id:b1,field:'busy',cmp:'eq',value:false},{op:'worker',worker_id:b1,field:'context_percent',cmp:'gte',value:40}]},actions:[{kind:'tool',name:'arco_compact',args:{target:b1}}]},
        {id:'resume',after:['compact'],when:{op:'worker',worker_id:b1,field:'compacting',cmp:'eq',value:false},actions:[{kind:'send_message',worker_id:b1,text:'Resume the exact assigned task after compaction.'},{kind:'notify',text:'Compaction ended; requested continuation sent.'}],finish:true},
      ]})).rule;
      await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.status==='finished');
      const current=(await api()).rules.find((x:any)=>x.id===r.id);assert.equal(current.workerTurns[b1].count,2);assert.equal(current.actions,3);
      const activity=await post(`/api/voice/activity?owner=${owner}`);
      assert(activity.ledger.some((e:any)=>e.workflowId===b1&&e.kind==='worker_compaction_finished'));
      assert(!activity.ledger.some((e:any)=>e.workflowId===b1&&e.kind==='worker_interrupted'),'successful compaction must not fabricate a worker STOP');
      assert(readFileSync(join(codexHome,'fixture-turns.jsonl'),'utf8').includes('Resume the exact assigned task after compaction.'));
    });
    await step('pause/master switch and cancellation stop future actions; malformed declarations are refused',async()=>{
      await begin(b1,'slow start for pause');
      const r=(await arm({...def(),clauses:[def().clauses[0]]})).rule;
      await api({action:'pause',rule_id:r.id});await mail(b1,'new paused mail');
      await post(`/api/voice/activity?owner=${owner}`,{action:'configure',enabled:false});await api({action:'resume',rule_id:r.id});
      await new Promise((r)=>setTimeout(r,1400));assert.equal((await api()).rules.find((x:any)=>x.id===r.id).actions,0);
      await post(`/api/voice/activity?owner=${owner}`,{action:'configure',enabled:true});await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.actions===1);
      await api({action:'cancel',rule_id:r.id});await read(b1);
      await assert.rejects(arm({...def(),clauses:[{id:'bad',when:{op:'worker',worker_id:'outside-worker',field:'busy',cmp:'eq',value:false},actions:[{kind:'notify',text:'bad'}]}]}),/outside/);
      await assert.rejects(arm({...def(),clauses:[{id:'bad',when:group('busy',false),actions:[{kind:'tool',name:'arco_condition',args:{action:'list'}}]}]}),/cannot create/);
    });
    await step('STOP is a default terminal guard; explicitly requested interruption handling can notify instead',async()=>{
      await begin(b2,'hang for interruption policy');
      const state=await api({action:'state',cluster_ids:[cluster]}),baseline=state.workers.find((w:any)=>w.id===b2).turns_interrupted;
      const r=(await arm({label:'Notify on explicit stop',cluster_ids:[cluster],hold_on_input:false,stop_on_interrupt:false,clauses:[{id:'stopped',when:{op:'worker',worker_id:b2,field:'turns_interrupted',cmp:'gt',value:baseline},actions:[{kind:'notify',text:'Worker was stopped; no restart requested.'}],finish:true}]})).rule;
      c!.send({type:'cancel',workflowId:b2});await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.status==='finished');
      await begin(b2,'hang for default stop');const guarded=(await arm({...def(),clauses:[def().clauses[0]]})).rule;
      c!.send({type:'cancel',workflowId:b2});await until((s)=>s.rules.find((x:any)=>x.id===guarded.id)?.status==='interrupted');
    });
    await step('operator updates preserve identity, expiry, spent turns and previously handled mail',async()=>{
      await mail(b1,'mail before update');const r=(await arm({...def(),clauses:[def().clauses[0]]})).rule;
      await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.actions===1);
      const current=(await api({action:'list',rule_id:r.id})).rule;assert(current.definition);
      const revised={...current.definition,label:'Same policy plus an input hold',hold_on_input:true,hold_worker_ids:[b1,b2]};
      const updated=(await api({action:'update',rule_id:r.id,expected_revision:current.revision,definition:revised})).rule;
      assert.equal(updated.id,r.id);assert.equal(updated.revision,1);assert.equal(updated.actions,1);assert.equal(updated.expiresAt,current.expiresAt);
      await assert.rejects(api({action:'update',rule_id:r.id,expected_revision:0,definition:revised}),/current expected_revision/);
      await new Promise((r)=>setTimeout(r,200));assert.equal((await api()).rules.find((x:any)=>x.id===r.id).actions,1);
      await api({action:'cancel',rule_id:r.id});await read(b1);
    });
    await step('private declarations/notices never persist and late activity cannot resurrect a cleared private script',async()=>{
      c!.send({type:'create_workflow',config:{...config,incognito:true}});const m=await c!.waitFor((m)=>m.type==='workflow_created',10000),priv=String(m.workflowId);
      const r=(await arm({...def(),clauses:[def().clauses[0]]},priv)).rule;
      assert(r.private);assert(!readFileSync(ruleFile,'utf8').includes(priv));assert(!(await api()).rules.some((x:any)=>x.id===r.id));
      c!.send({type:'computer_context_control',workflowId:priv,action:'fresh'});await c!.waitFor((m)=>m.type==='computer_context_updated'&&m.workflowId===priv&&m.fresh===true,15000);
      await mail(b1,'after private clear');await new Promise((r)=>setTimeout(r,200));assert(!(await api(undefined,priv)).rules.some((x:any)=>x.id===r.id));assert(!readFileSync(ruleFile,'utf8').includes(priv));await read(b1);
    });
    await step('persistence failure refuses arming and restart interrupts rather than replaying scripts',async()=>{
      renameSync(ruleFile,ruleFile+'.saved');mkdirSync(ruleFile);
      try{await assert.rejects(arm(def()),/Could not save/);}finally{rmSync(ruleFile,{recursive:true});renameSync(ruleFile+'.saved',ruleFile);}
      const r=(await arm({...def(),clauses:[def().clauses[0]]})).rule;
      await c!.close();server.kill('SIGTERM');await once(server,'exit');
      const history=join(project,'.arco','workflows',director,'events.jsonl');
      let seq=JSON.parse(readFileSync(history,'utf8').trim().split('\n').at(-1)!).seq;
      const entries=[{type:'user_message_echo',content:'Report your status.',timestamp:Date.now()},
        {type:'primary_turn_started',startedAt:Date.now()},
        {type:'primary_text',phase:'passthrough',text:'NEEDS_OPERATOR_INPUT: Which option should I use?'},
        {type:'task_ledger_snapshot',padding:'metadata'.repeat(75000)}];
      appendFileSync(history,entries.map((e)=>JSON.stringify({workflowId:director,seq:++seq,ts:Date.now(),...e})).join('\n')+'\n');
      server=start();await ready();c=await connect(`ws://127.0.0.1:${port}/ws`);
      c.send({type:'rehydrate_workflows',workflows:[{workflowId:owner,config:ownerConfig,currentSessionId:owner,lastSeq:0}]});await c.waitFor((m)=>m.type==='computer_context_updated'&&m.workflowId===owner,15000);
      assert.equal((await api()).rules.find((x:any)=>x.id===r.id).status,'interrupted');
      const state=await api({action:'state',cluster_ids:[cluster]});
      const restored=state.workers.find((w:any)=>w.id===b1);
      assert(restored.context_tokens>0,'idle workers regain reported context after restart without another turn');
      assert.equal(restored.context_window,100000);
      const count=readFileSync(join(codexHome,'fixture-turns.jsonl'),'utf8').trim().split('\n').length;
      const watch=(await arm({label:'Restored context notification',cluster_ids:[cluster],hold_on_input:false,clauses:[{id:'restored',when:{op:'worker',worker_id:b1,field:'context_tokens',cmp:'gte',value:restored.context_tokens},actions:[{kind:'notify',text:'Restored context threshold reached.'}],finish:true}]})).rule;
      await until((s)=>s.rules.find((x:any)=>x.id===watch.id)?.status==='finished');
      assert.equal(readFileSync(join(codexHome,'fixture-turns.jsonl'),'utf8').trim().split('\n').length,count,'restoration and threshold evaluation must not prompt workers');
    });
    await step('a short restored Director question behind large metadata holds workers, then an actual answer releases them',async()=>{
      await mail(b1,'new work while Director needs input');
      const r=(await arm({...def(true),hold_worker_ids:[director,b1,b2]})).rule;
      for(let i=0;i<100;i++){const state=await api({action:'state',cluster_ids:[cluster]});if(state.workers.find((w:any)=>w.id===director).needs_input===true)break;await new Promise((r)=>setTimeout(r,30));}
      const state=await api({action:'state',cluster_ids:[cluster]});assert.equal(state.workers.find((w:any)=>w.id===director).needs_input,true,'read the full short reply instead of stranding an unknown on a truncated metadata tail');
      assert.equal((await api()).rules.find((x:any)=>x.id===r.id).actions,0);
      await begin(director,'The human answered: use option B.');
      await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.workerTurns[b1]?.count===1);
      assert(!(await api()).rules.find((x:any)=>x.id===r.id).workerTurns[director],'checking a Director question cannot nudge the Director');
      await read(b1);await until((s)=>s.rules.find((x:any)=>x.id===r.id)?.status==='finished');
    });
  }finally{await c?.close();if(server.exitCode===null){server.kill('SIGTERM');await once(server,'exit');}closeSync(log);}
  console.log('Artifacts:',dir);summary('computer-conditions');
}
main().catch((e)=>{console.error(e);process.exitCode=1;});
