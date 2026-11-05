import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session,WorkflowState } from '../workflows/types.js';
import type { ServerMessage,WorkerConfig } from '@arco/shared';
import type WebSocket from 'ws';
const temp=mkdtempSync(join(tmpdir(),'arco-ollama-execution-'));installIsolatedTestHome(temp);
const engine=await import('./turnEngine.js');
const { workflows,workflowCwds }=await import('../server/state.js');
const { initWorkflowStore,replayEvents,flushAll }=await import('../workflowStore.js');
const { settleProjectWrites } = await import('../testSupport/projectWrites.js');
const { projectOllamaHistory }=await import('../providers/ollamaExecutionHistory.js');
const { acquireCheckoutWriter }=await import('../checkoutOwnership.js');

test('real turn loop persists exact queued input identities and scopes each provider execution',async()=>{
 const cwd=join(temp,'project'),id='ollama-execution';mkdirSync(cwd,{recursive:true});
 const messages:ServerMessage[]=[];let checkpointsComplete!:()=>void;
 const checkpoints=new Promise<void>(resolve=>{checkpointsComplete=resolve;});
 const ws={readyState:1,send:(s:string)=>{messages.push(JSON.parse(s));if(messages.filter(e=>e.type==='checkpoint_created').length===2)checkpointsComplete();}} as unknown as WebSocket;
 const session={id:'fixture',workflowIds:new Set([id]),clusterIds:new Set(),clusterObserved:new Map()} as Session;
 const pending:Array<{options:WorkerConfig;reply:()=>void;task:string}>=[];
 const manager={
  spawn:(spec:{task:string},emit:(event:unknown)=>void,options:WorkerConfig)=>new Promise(resolve=>{
   pending.push({options,task:spec.task,reply:()=>{emit({type:'worker_text',text:'answer '+spec.task});emit({type:'worker_complete',costUsd:0,durationMs:1});resolve({text:'answer',costUsd:0,durationMs:1});}});
  }),getWorkerPid:()=>undefined,
 };
 const wf={config:{name:'fixture',workingDirectory:cwd,primaryProvider:'ollama',primaryModel:'fixture',primaryEffort:'medium',skipPermissions:false,autoCompaction:{enabled:true,thresholdPercent:80},autoHandoff:{enabled:false,afterCompactions:5}},primary:{provider:'ollama',model:'fixture',effort:'medium',skipPermissions:false},manager,busy:false,observers:new Set([ws]),queue:{steering:[],followUp:[]},autoHandoff:{enabled:false,afterCompactions:5,compactions:0,fired:false},bgTracker:{noteBgHint:()=>{},attachParent:()=>{},detachParent:()=>{}}} as unknown as WorkflowState;
 workflows.set(id,wf);workflowCwds.set(id,cwd);await initWorkflowStore(cwd,id);
 engine.initTurnEngine({previewAutoDetect:{noteAgentText:()=>{},notePotentialDevServerStart:()=>{}} as never,handleCreateWorkflow:async()=>{},handleHandoffRequest:async()=>{throw Error('handoff must wait for enabled Ollama policy');}});
 const waitFor=async(n:number)=>{for(let i=0;i<200&&pending.length<n;i++)await new Promise(r=>setTimeout(r,5));assert.equal(pending.length,n);};
 try {
  const run=engine.handleUserMessage(ws,session,id,'first','a',undefined,false,undefined,undefined);await waitFor(1);
  await engine.handleUserMessage(ws,session,id,'follow','f',undefined,true,'follow-up',undefined);
  await engine.handleUserMessage(ws,session,id,'steer','s',undefined,true,'steer',undefined);
  writeFileSync(join(cwd,'first.txt'),'first\n');
  pending[0].reply();await waitFor(2);
  assert.ok(pending[1].task.endsWith('steer\n\nfollow'));
  assert.equal((pending[1].task.match(/steer/g) ?? []).length, 1);
  assert.ok(pending[1].options.ollamaReplay);assert.equal(pending[1].options.ollamaReplay?.activeInputSeqs.length,2);
  const peer = acquireCheckoutWriter([cwd], undefined, {});
  writeFileSync(join(cwd,'second.txt'),'second\n'); peer();
  pending[1].reply();await run;
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try { await Promise.race([checkpoints,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('Two checkpoint events did not arrive')),15000);})]); }
  finally {if(timeout)clearTimeout(timeout);}
  assert.equal(messages.filter(e=>e.type==='checkpoint_created').length,2);
  const events=await replayEvents(cwd,id,0);const starts=events.filter(e=>e.type==='primary_turn_started');
  const changes=events.filter(e=>e.type==='turn_changes');
  assert.equal(changes.length,2);
  assert.deepEqual(changes.map(e=>e.otherWriters),[false,true]);
  assert.deepEqual(changes.map(e=>e.paths),[['first.txt'],['second.txt']]);
  assert.equal(starts.length,2);assert.ok(starts[0].ollamaExecutionId);assert.notEqual(starts[0].ollamaExecutionId,starts[1].ollamaExecutionId);
  const echoSeq=(content:string)=>(events.find(e=>e.type==='user_message_echo'&&e.content===content) as ServerMessage & {seq:number}).seq;
  assert.deepEqual(starts[1].ollamaInputSeqs,[echoSeq('steer'),echoSeq('follow')]);
  const next={type:'user_message_echo',workflowId:id,seq:Math.max(...events.map(e=>(e as ServerMessage&{seq:number}).seq))+1,content:'next',ollamaReplayInput:true} as unknown as ServerMessage;
  const p=projectOllamaHistory([...events,next],id,[(next as ServerMessage&{seq:number}).seq]);
  assert.equal(p.valid,true,p.reason);assert.deepEqual(p.events.flatMap(e=>e.type==='user_message_echo'?[e.content]:[]),['first','steer\n\nfollow']);
  for(const start of starts)assert.equal(events.filter(e=>e.type==='primary_complete'&&e.ollamaExecutionId===start.ollamaExecutionId).length,1);
  process.env.ARCO_CHECKPOINT_TOTAL_CAP_BYTES='1';
  const noCapture=engine.handleUserMessage(ws,session,id,'no capture','n',undefined,false,undefined,undefined);
  await waitFor(3); pending[2].reply(); await noCapture;
  assert.equal((await replayEvents(cwd,id,0)).filter(e=>e.type==='turn_changes').length,2);
  delete process.env.ARCO_CHECKPOINT_TOTAL_CAP_BYTES;
  const noEdit=engine.handleUserMessage(ws,session,id,'no edits','z',undefined,false,undefined,undefined);
  await waitFor(4); pending[3].reply(); await noEdit;
  assert.equal((await replayEvents(cwd,id,0)).filter(e=>e.type==='turn_changes').length,2);
 } finally {delete process.env.ARCO_CHECKPOINT_TOTAL_CAP_BYTES;workflows.delete(id);workflowCwds.delete(id);await settleProjectWrites();rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
