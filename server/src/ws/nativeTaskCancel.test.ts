import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,mkdirSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the callback registered by the real server entry point, with only
// fixture workers and an ephemeral loopback listener in the child process.
test('a Task child stopped by its own CANCEL settles its parent card as cancelled, not as an error',()=>{
 const root=mkdtempSync(join(tmpdir(),'arco-task-cancel-'));const home=join(root,'home'),cwd=join(root,'project'),report=join(root,'report.json');mkdirSync(home);mkdirSync(cwd);
 const url=(relative:string)=>new URL(relative,import.meta.url).href;
 const code=`
 const fs=await import('node:fs');const path=await import('node:path');
 const {randomUUID}=await import('node:crypto');
 process.chdir(process.env.ARCO_TASK_FIXTURE_CWD);
 globalThis.fetch=async()=>{throw Error('fixture network disabled');};
 const {WorkerManager}=await import(${JSON.stringify(url('../workers/WorkerManager.ts'))});
 WorkerManager.prototype.spawn=async function(spec,emit){emit({type:'worker_error',error:'Worker killed'});return {id:spec.id,text:'',costUsd:0,durationMs:1,error:'Worker killed'};};
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
  const handle=await turn.worker.taskHandler({parentWorkflowId:id,description:'Fixture Task',prompt:'Fixture work',subagentType:'fixture',model:'haiku'});
  let rejection='';try{await handle.finalText;}catch(error){rejection=String(error?.message??error);}await settleProjectWrites();
  fs.writeFileSync(process.env.ARCO_TASK_FIXTURE_REPORT,JSON.stringify({abort:/AbortError/.test(rejection),rejection}));process.exit(0);
 }catch(error){fs.writeFileSync(process.env.ARCO_TASK_FIXTURE_REPORT,JSON.stringify({error:String(error),stack:error?.stack}));process.exit(2);}
 `;
 const env:NodeJS.ProcessEnv={HOME:home,USERPROFILE:home,ARCO_HOME:join(home,'.arco'),CODEX_HOME:join(home,'.codex'),CLAUDE_CONFIG_DIR:join(home,'.claude'),XDG_CONFIG_HOME:join(home,'.config'),XDG_DATA_HOME:join(home,'.local','share'),XDG_CACHE_HOME:join(home,'.cache'),PATH:root,ARCO_PORT:'0',ARCO_HOST:'localhost',ARCO_UPDATE_CHECK:'0',ARCO_TEST:'1',ARCO_TEST_NO_AUTO_TURN_DISPATCH:'1',ARCO_TASK_FIXTURE_CWD:cwd,ARCO_TASK_FIXTURE_REPORT:report};
 for(const key of ['SystemRoot','SYSTEMROOT','windir','WINDIR','ComSpec','COMSPEC','PATHEXT'])if(process.env[key]!==undefined)env[key]=process.env[key];
 try{const result=spawnSync(process.execPath,['--conditions','development','--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),env,encoding:'utf8',timeout:30000,maxBuffer:128*1024});
 const value=JSON.parse(readFileSync(report,'utf8'));assert.equal(result.status,0,JSON.stringify(value));assert.equal(value.abort,true,JSON.stringify(value));
 }finally{rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
