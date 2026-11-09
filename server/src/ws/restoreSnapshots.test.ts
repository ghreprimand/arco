import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const root=mkdtempSync(join(tmpdir(),'arco-restore-snapshots-'));installIsolatedTestHome(root);
const {rehydrateOneWorkflow}=await import('./handoffHandlers.js');
const {workflows,workflowCwds}=await import('../server/state.js');
const {initWorkflowStore,flushAll,persistAndStampSeq}=await import('../workflowStore.js');
const {handleCreateWorkflow,handleRevertToPointRequest}=await import('./workflowHandlers.js');
const {persistInitialMeta}=await import('./turnEngine.js');
const {replayMessagesWithResumePolicy}=await import('../providers/claude-native/resumeSummary.js');
const {createPlan}=await import('../planStore.js');
const {settleProjectWrites}=await import('../testSupport/projectWrites.js');
const {trackRecallFixture}=await import('../testSupport/recallFixture.test-support.js');const closeRecall=trackRecallFixture();
after(async()=>{await flushAll();await settleProjectWrites();await closeRecall();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
async function fixture(provider:'claude'|'cursor'){
 const id=randomUUID(),cwd=join(root,id);mkdirSync(cwd,{recursive:true});const messages:any[]=[];
 const ws={readyState:1,bufferedAmount:0,send:(raw:string)=>messages.push(JSON.parse(raw))} as any;
 const wf={config:{workingDirectory:cwd,primaryProvider:provider,primaryModel:'fixture',name:'Fixture conversation',claudeTransport:'native'},primary:{provider,model:'fixture'},primarySessionId:provider==='claude'?'fixture-session':undefined,busy:false,observers:new Set([ws]),manager:{},queue:{steering:[],followUp:[]},previewHistory:[],lastContextPercent:0} as any;
 workflows.set(id,wf);workflowCwds.set(id,cwd);await initWorkflowStore(cwd,id);
 return {id,cwd,ws,wf,messages,close:async()=>{await flushAll();wf.sessionWatcher?.();workflows.delete(id);workflowCwds.delete(id);}};
}
for(const provider of ['claude','cursor'] as const)test(`${provider} rehydrate echoes the active plan independently of context estimation`,async()=>{
 const f=await fixture(provider);
 try{const plan=await createPlan(f.cwd,{title:'Fixture plan',body:'- [ ] Fixture task'});f.wf.planId=plan.id;
 await rehydrateOneWorkflow(f.ws,f.id,f.wf,0,{tail:true});
 assert.equal(f.messages.some(m=>m.type==='plan_attached'&&m.planId===plan.id),true);
 }finally{await f.close();}
});
test('rehydrate sends the authoritative empty terminal list after a server restart',async()=>{
 const f=await fixture('cursor');
 try{await rehydrateOneWorkflow(f.ws,f.id,f.wf,0,{tail:true});const snapshot=f.messages.find(m=>m.type==='terminal_sessions');assert.ok(snapshot);assert.deepEqual(snapshot.sessions,[]);}
 finally{await f.close();}
});

test('explicit saved-conversation resume sends its retained history as one atomic batch',async(t)=>{
 const f=await fixture('claude');
 t.mock.method(globalThis,'fetch',async()=>Response.json({models:[],data:[]}));
 try{
  await persistInitialMeta(f.cwd,f.id,f.wf.config,{...f.wf.primary,effort:'low'});
  const events=Array.from({length:300},(_,i)=>({type:i%3===0?'user_message_echo':i%3===1?'primary_text':'primary_complete',workflowId:f.id,seq:i+1,timestamp:i+1,...(i%3===0?{content:`prompt ${i}`}:i%3===1?{phase:'passthrough',text:`answer ${i}`}:{})}));
  for(const event of events)persistAndStampSeq(f.cwd,f.id,event as any);await flushAll();
  workflows.delete(f.id);f.messages.length=0;
  const session={id:'fixture-session',workflowIds:new Set(),clusterIds:new Set(),clusterObserved:new Map()} as any;
  await handleCreateWorkflow(f.ws,session,{...f.wf.config,resumeWorkflowId:f.id});
  const batches=f.messages.filter(m=>m.type==='replay_batch');assert.equal(batches.length,1);
  assert.equal(batches[0].events.filter((e:any)=>e.type==='user_message_echo').length,100);
  assert.equal(f.messages.some(m=>m.type==='primary_text'),false);
 }finally{await f.close();}
});

test('rewind reserves primary admission before its asynchronous validation and releases on refusal',async()=>{
 const f=await fixture('claude');let pending:Promise<void>|undefined;
 try{pending=handleRevertToPointRequest(f.ws,{type:'revert_to_point_request',workflowId:f.id,targetSeq:1});assert.equal(f.wf.busy,true);await pending;assert.equal(f.wf.busy,false);}
 finally{await pending;await f.close();}
});

async function seedRewind(f:Awaited<ReturnType<typeof fixture>>){
 await persistInitialMeta(f.cwd,f.id,f.wf.config,{...f.wf.primary,effort:'low'});
 for(const event of [{type:'user_message_echo',content:'kept prompt'},{type:'primary_text',phase:'passthrough',text:'kept answer'},{type:'primary_complete'},{type:'user_message_echo',content:'abandoned prompt'},{type:'primary_text',phase:'passthrough',text:'abandoned answer'},{type:'primary_complete'}])persistAndStampSeq(f.cwd,f.id,{...event,workflowId:f.id} as any);
 await flushAll();
}
test('a valid rewind persists branch mode before publishing its head transition',async()=>{
 const f=await fixture('claude');
 try{await seedRewind(f);await handleRevertToPointRequest(f.ws,{type:'revert_to_point_request',workflowId:f.id,targetSeq:3});await flushAll();
 const move=f.messages.find(m=>m.type==='leaf_move');assert.ok(move);
 const replay=await replayMessagesWithResumePolicy(f.cwd,f.id,undefined,{leafSeq:move.seq});assert.match(JSON.stringify(replay.messages),/kept prompt/);assert.doesNotMatch(JSON.stringify(replay.messages),/abandoned prompt/);assert.equal(f.wf.busy,false);
 }finally{await f.close();}
});
test('a failed branch-mode write cannot publish a rewind head move',async(t)=>{
 const f=await fixture('claude');let blocked=false;
 try{await seedRewind(f);const rename=fsPromises.rename.bind(fsPromises);const target=join(f.cwd,'.arco','workflows',f.id,'meta.json');
 t.mock.method(fsPromises,'rename',async(from:any,to:any)=>{if(String(to)===target){blocked=true;throw Object.assign(new Error('fixture EIO'),{code:'EIO'});}return rename(from,to);});
 await handleRevertToPointRequest(f.ws,{type:'revert_to_point_request',workflowId:f.id,targetSeq:3});assert.equal(blocked,true);assert.equal(f.messages.some(m=>m.type==='leaf_move'),false);assert.equal(f.wf.busy,false);
 }finally{t.mock.restoreAll();await f.close();}
});

test('busy reconnect sends the current turn start even when the client has seen every event', async () => {
 const f=await fixture('cursor');
 const {send,broadcastTransient,broadcastWorkflow}=await import('../server/broadcast.js');
 const {getHeadSeq}=await import('../workflowStore.js');
 try {
  const startedAt=Date.now()-1620000; f.wf.busy=true;
  send(f.ws,{type:'primary_turn_started',workflowId:f.id,startedAt});
  send(f.ws,{type:'primary_text',workflowId:f.id,text:'Synthetic work',phase:'passthrough'});
  await flushAll();const head=await getHeadSeq(f.cwd,f.id);f.messages.length=0;
  await rehydrateOneWorkflow(f.ws,f.id,f.wf,head);
  assert.equal(f.messages.find(m=>m.type==='workflow_state_snapshot')?.turnStartedAt,startedAt);
  assert.equal(f.messages.some(m=>m.type==='primary_turn_started'||m.events?.some((e:any)=>e.type==='primary_turn_started')),false);
  const transientStart=startedAt+1000;
  broadcastTransient(f.id,{type:'primary_turn_started',workflowId:f.id,startedAt:transientStart});
  f.messages.length=0;await rehydrateOneWorkflow(f.ws,f.id,f.wf,head);
  assert.equal(f.messages.find(m=>m.type==='workflow_state_snapshot')?.turnStartedAt,transientStart);
  const broadcastStart=startedAt+2000;
  broadcastWorkflow(f.id,{type:'primary_turn_started',workflowId:f.id,startedAt:broadcastStart});
  f.messages.length=0;await rehydrateOneWorkflow(f.ws,f.id,f.wf,head);
  assert.equal(f.messages.find(m=>m.type==='workflow_state_snapshot')?.turnStartedAt,broadcastStart);
  f.wf.busy=false;f.messages.length=0;await rehydrateOneWorkflow(f.ws,f.id,f.wf,head);
  assert.equal(f.messages.find(m=>m.type==='workflow_state_snapshot')?.turnStartedAt,undefined);
 } finally {await f.close();}
});
