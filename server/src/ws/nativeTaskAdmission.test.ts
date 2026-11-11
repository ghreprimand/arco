import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,mkdirSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the callback registered by the real server entry point, with only
// fixture workers and an ephemeral loopback listener in the child process.
test('registered Native Task callback enforces queue, turn budget, fixed model and context guards',()=>{
 const root=mkdtempSync(join(tmpdir(),'arco-task-model-'));const home=join(root,'home'),cwd=join(root,'project'),report=join(root,'report.json');mkdirSync(home);mkdirSync(cwd);
 const url=(relative:string)=>new URL(relative,import.meta.url).href;
 const code=`
 const fs=await import('node:fs');const path=await import('node:path');
 const {randomUUID}=await import('node:crypto');const assert=(await import('node:assert/strict')).default;const children=[];
 process.chdir(process.env.ARCO_TASK_FIXTURE_CWD);
 globalThis.fetch=async()=>{throw Error('fixture network disabled');};
 const {WorkerManager}=await import(${JSON.stringify(url('../workers/WorkerManager.ts'))});
 WorkerManager.prototype.spawn=async function(spec,emit){return await new Promise(resolve=>children.push({spec,emit,resolve}));};
 try{
  await import(${JSON.stringify(url('../index.ts'))});
  const {workflows,workflowCwds,sessions}=await import(${JSON.stringify(url('../server/state.ts'))});
  const {ClaudeNativeProvider}=await import(${JSON.stringify(url('../providers/claude-native/index.ts'))});
  const {initWorkflowStore}=await import(${JSON.stringify(url('../workflowStore.ts'))});
  const {persistInitialMeta,derivePrimaryConfig}=await import(${JSON.stringify(url('./turnEngine.ts'))});
  const {readMeta}=await import(${JSON.stringify(url('../workflowMeta.ts'))});
  const {settleProjectWrites}=await import(${JSON.stringify(url('../testSupport/projectWrites.ts'))});
  const id=randomUUID(),cwd=process.cwd(),messages=[];
  const ws={readyState:1,bufferedAmount:0,send:raw=>messages.push(JSON.parse(raw))};
  const config={name:'Fixture parent',workingDirectory:cwd,primaryProvider:'claude',primaryModel:'haiku',primaryEffort:'low',claudeTransport:'native'};
  const parent={config,primary:derivePrimaryConfig(config),manager:new WorkerManager(),busy:false,observers:new Set([ws]),queue:{steering:[],followUp:[]},previewHistory:[],lastContextPercent:0};
  workflows.set(id,parent);workflowCwds.set(id,cwd);sessions.set(ws,{id:'fixture',workflowIds:new Set([id]),clusterIds:new Set(),clusterObserved:new Map()});
  await initWorkflowStore(cwd,id);await persistInitialMeta(cwd,id,config,parent.primary);
  const turn=ClaudeNativeProvider.create('fixture-parent',{provider:'claude',model:'haiku',effort:'low',workflowId:id,cwd,tools:[]});
  const handler=turn.worker.taskHandler;
  const turnSignal=new AbortController().signal;
  const policy={maxRunning:1,maxStarts:2,model:'haiku'};
  const args={parentWorkflowId:id,description:'Fixture Task',prompt:'Fixture work',model:'sonnet',turnSignal,policy};
  const first=await handler(args);
  const until=async check=>{for(let n=0;n<200&&!check();n++)await new Promise(r=>setTimeout(r,5));assert.ok(check());};
  await until(()=>children.length===1);
  let secondReady=false;
  const pending=handler(args).then(h=>{secondReady=true;return h;});
  await assert.rejects(handler(args),/limit of 2/);
  await new Promise(r=>setTimeout(r,10));assert.equal(secondReady,false);assert.equal(children.length,1);
  const finish=n=>{children[n].emit({type:'worker_text',text:'fixture answer'});children[n].emit({type:'worker_complete',costUsd:0,durationMs:1});children[n].resolve({id:children[n].spec.id,text:'fixture answer',costUsd:0,durationMs:1});};
  first.cancel();await assert.rejects(first.finalText,/AbortError/);
  await new Promise(r=>setTimeout(r,10));assert.equal(secondReady,false);assert.equal(children.length,1);
  finish(0);
  const second=await pending;await until(()=>children.length===2);finish(1);await second.finalText;
  assert.equal(workflows.get(first.childWorkflowId).primary.model,'haiku');
  assert.equal(workflows.get(second.childWorkflowId).config.primaryModel,'haiku');
  await assert.rejects(handler(args),/limit of 2/);
  await assert.rejects(handler({...args,turnSignal:new AbortController().signal,policy:{...policy,model:'fixture-model-unavailable'}}),/unavailable/);
  assert.equal(children.length,2);
  parent.config.kind='chat';await assert.rejects(handler(args),/Task not available/);delete parent.config.kind;
  parent.config.claudeNativeTaskDisabled=true;await assert.rejects(handler(args),/Task not available/);delete parent.config.claudeNativeTaskDisabled;
  const clusters=await import(${JSON.stringify(url('../clusterStore.ts'))});
  const cluster=await clusters.createCluster({cwd,memberWorkflowIds:[id,randomUUID()]});
  await assert.rejects(handler(args),/Task not available/);
  await settleProjectWrites();
  fs.writeFileSync(process.env.ARCO_TASK_FIXTURE_REPORT,JSON.stringify({started:children.length,model:'haiku',queue:true,budget:true,guards:true}));process.exit(0);
 }catch(error){fs.writeFileSync(process.env.ARCO_TASK_FIXTURE_REPORT,JSON.stringify({error:String(error),stack:error?.stack}));process.exit(2);}
 `;
 const env:NodeJS.ProcessEnv={HOME:home,USERPROFILE:home,ARCO_HOME:join(home,'.arco'),CODEX_HOME:join(home,'.codex'),CLAUDE_CONFIG_DIR:join(home,'.claude'),XDG_CONFIG_HOME:join(home,'.config'),XDG_DATA_HOME:join(home,'.local','share'),XDG_CACHE_HOME:join(home,'.cache'),PATH:root,ARCO_PORT:'0',ARCO_HOST:'localhost',ARCO_UPDATE_CHECK:'0',ARCO_TEST:'1',ARCO_TEST_NO_AUTO_TURN_DISPATCH:'1',ARCO_TASK_FIXTURE_CWD:cwd,ARCO_TASK_FIXTURE_REPORT:report};
 for(const key of ['SystemRoot','SYSTEMROOT','windir','WINDIR','ComSpec','COMSPEC','PATHEXT'])if(process.env[key]!==undefined)env[key]=process.env[key];
 try{const result=spawnSync(process.execPath,['--conditions','development','--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),env,encoding:'utf8',timeout:30000,maxBuffer:128*1024});
 const value=JSON.parse(readFileSync(report,'utf8'));assert.equal(result.status,0,JSON.stringify(value));assert.deepEqual(value,{started:2,model:'haiku',queue:true,budget:true,guards:true});
 }finally{rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
