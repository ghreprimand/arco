import assert from 'node:assert/strict';
import { after,test } from 'node:test';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const root=mkdtempSync(join(tmpdir(),'arco-handoff-ownership-'));installIsolatedTestHome(root);process.env.PATH=root;
const {handleHandoffRequest,handleSpawnFromHere,initHandoffHandlers}=await import('./handoffHandlers.js');
const {handleCreateWorkflow,handleCancel}=await import('./workflowHandlers.js');
const {workflows,workflowCwds,sessions}=await import('../server/state.js');
const {initWorkflowStore,flushAll,persistAndStampSeq}=await import('../workflowStore.js');
const {claimBusy,ownsBusy,releaseBusy,persistInitialMeta,derivePrimaryConfig}=await import('./turnEngine.js');
const {settleProjectWrites}=await import('../testSupport/projectWrites.js');
const {trackRecallFixture}=await import('../testSupport/recallFixture.test-support.js');const closeRecall=trackRecallFixture();
const {CursorProvider,disposeCursorWorker}=await import('../providers/cursor/index.js');
const {runExportContext}=await import('../primitives/exportContext.js');
const {WorkerManager}=await import('../workers/WorkerManager.js');
initHandoffHandlers({previewAutoDetect:new Proxy({},{get:()=>()=>{}}),handleCreateWorkflow,handlePlanAttach:async()=>{},assertAllMembersClaudeOrCodex:async()=>null} as any);
after(async()=>{await settleProjectWrites();await closeRecall();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
const result=(id:string,text:string)=>({id,text,costUsd:0,durationMs:1});
async function fixture(){
 const id=randomUUID(),cwd=join(root,id);mkdirSync(cwd,{recursive:true});const messages:any[]=[];
 const ws={readyState:1,bufferedAmount:0,send:(raw:string)=>messages.push(JSON.parse(raw))} as any;
 const config={name:'Fixture conversation',workingDirectory:cwd,primaryProvider:'cursor',primaryModel:'auto',primaryEffort:'low',claudeTransport:'native'} as any;
 const manager={spawn:async(spec:any)=>result(spec.id,'fixture brief'),kill:()=>{},killAll:()=>{},getWorkerPid:()=>undefined} as any;
 const wf={config,primary:derivePrimaryConfig(config),manager,busy:false,observers:new Set([ws]),queue:{steering:[],followUp:[]},lastContextPercent:0,previewHistory:[]} as any;
 const session={id:'fixture',workflowIds:new Set([id]),clusterIds:new Set(),clusterObserved:new Map()} as any;
 workflows.set(id,wf);workflowCwds.set(id,cwd);sessions.set(ws,session);await initWorkflowStore(cwd,id);await persistInitialMeta(cwd,id,config,wf.primary);
 for(const event of [{type:'user_message_echo',content:'fixture task'},{type:'primary_text',phase:'passthrough',text:'fixture answer'},{type:'primary_complete'}])persistAndStampSeq(cwd,id,{...event,workflowId:id} as any);await flushAll();
 return {id,cwd,ws,wf,session,messages,close:async()=>{for(const wid of session.workflowIds){const item=workflows.get(wid);item?.manager.killAll();if(item?.busy)releaseBusy(item,(item as any).fixtureToken);disposeCursorWorker(wid);workflows.delete(wid);workflowCwds.delete(wid);}sessions.delete(ws);await settleProjectWrites();}};
}
test('STOP during handoff preparation prevents later seed work on a newer turn',async()=>{
 const f=await fixture();let spawns=0;f.wf.manager.spawn=async(spec:any)=>{spawns++;return result(spec.id,'fixture brief');};let running:Promise<any>|undefined;
 try{running=handleHandoffRequest(f.ws,f.session,{type:'handoff_request',workflowId:f.id,mode:'fresh-summarizer',summarizer:{provider:'cursor',model:'auto',effort:'low'}} as any);
 handleCancel(f.ws,f.id);f.wf.fixtureToken=claimBusy(f.wf);f.messages.length=0;await running;
 assert.equal(spawns,0);assert.equal(f.messages.some(m=>m.type==='handoff_complete'),false);assert.equal(ownsBusy(f.wf,f.wf.fixtureToken),true);
 }finally{await running;releaseBusy(f.wf,f.wf.fixtureToken);await f.close();}
});
test('a revoked pre-warm cannot complete or dispose the newer provider worker',async()=>{
 const f=await fixture();let spawns=0,release!:(value:any)=>void,started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
 f.wf.manager.spawn=(spec:any)=>++spawns===1?Promise.resolve(result(spec.id,'fixture brief')):new Promise(resolve=>{release=resolve;started();});
 const running=handleHandoffRequest(f.ws,f.session,{type:'handoff_request',workflowId:f.id,mode:'fresh-summarizer',summarizer:{provider:'cursor',model:'auto',effort:'low'}} as any);
 try{await Promise.race([ready,running.then(()=>{throw new Error('pre-warm was not reached: '+JSON.stringify(f.messages));})]);
 handleCancel(f.ws,f.id);f.wf.fixtureToken=claimBusy(f.wf);
 const config={provider:'cursor',model:'auto',effort:'low',workflowId:f.id,cwd:f.cwd} as any;
 const newer=CursorProvider.create('newer',config) as any;f.messages.length=0;release(result('prewarm','ack'));await running;
 assert.equal(f.messages.some(m=>m.type==='handoff_complete'||m.type==='primary_complete'),false);
 assert.equal((CursorProvider.create('later',config) as any).worker,newer.worker);assert.equal(ownsBusy(f.wf,f.wf.fixtureToken),true);
 }finally{release?.(result('prewarm','ack'));await running;releaseBusy(f.wf,f.wf.fixtureToken);await f.close();}
});
for(const pauseAt of [1,2])test(`revoked spawn at phase ${pauseAt} cannot seed or complete into a newer child turn`,async(t)=>{
 const f=await fixture();let spawns=0,release!:(value:any)=>void,started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
 t.mock.method(WorkerManager.prototype,'spawn',(spec:any)=>{if(++spawns===pauseAt)return new Promise(resolve=>{release=resolve;started();});return Promise.resolve(result(spec.id,'fixture brief'));});
 const running=handleSpawnFromHere(f.ws,f.session,{type:'spawn_from_here',parentWorkflowId:f.id,newConfig:{...f.wf.config,name:'Fixture child'},mode:'fresh-summarizer',summarizer:{provider:'cursor',model:'auto',effort:'low'}} as any);
 let child:any;
 try{await Promise.race([ready,running.then(()=>{throw new Error('spawn pause was not reached: '+JSON.stringify(f.messages));})]);
 const created=f.messages.find(m=>m.type==='workflow_created');assert.ok(created);child=workflows.get(created.workflowId)!;
 handleCancel(f.ws,created.workflowId);child.fixtureToken=claimBusy(child);f.messages.length=0;release(result('phase','fixture result'));await running;
 assert.equal(spawns,pauseAt);assert.equal(f.messages.some(m=>m.type==='spawn_from_here_complete'||m.type==='primary_complete'),false);assert.equal(ownsBusy(child,child.fixtureToken),true);
 }finally{release?.(result('phase','fixture result'));await running;if(child)releaseBusy(child,child.fixtureToken);t.mock.restoreAll();await f.close();}
});

test('normal handoff still completes once and releases its claim',async()=>{
 const f=await fixture();
 try{await handleHandoffRequest(f.ws,f.session,{type:'handoff_request',workflowId:f.id,mode:'fresh-summarizer',summarizer:{provider:'cursor',model:'auto',effort:'low'}} as any);
 assert.equal(f.messages.filter(m=>m.type==='handoff_complete').length,1);assert.equal(f.wf.busy,false);assert.equal(f.wf.activeHandoff,undefined);
 }finally{await f.close();}
});
test('normal fresh spawn still completes once and releases child admission',async(t)=>{
 const f=await fixture();t.mock.method(WorkerManager.prototype,'spawn',async(spec:any)=>result(spec.id,'fixture brief'));
 try{await handleSpawnFromHere(f.ws,f.session,{type:'spawn_from_here',parentWorkflowId:f.id,newConfig:{...f.wf.config,name:'Fixture child'},mode:'fresh-summarizer',summarizer:{provider:'cursor',model:'auto',effort:'low'}} as any);
 const complete=f.messages.filter(m=>m.type==='spawn_from_here_complete');assert.equal(complete.length,1);assert.equal(workflows.get(complete[0].newWorkflowId)?.busy,false);assert.equal(f.wf.busy,false);
 }finally{t.mock.restoreAll();await f.close();}
});
test('original-worker reflection abort targets its spawning manager',async()=>{
 const cwd=join(root,'original-abort');mkdirSync(cwd,{recursive:true});let release!:(value:any)=>void,started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
 const kills:string[]=[];const manager={spawn:()=>new Promise(resolve=>{release=resolve;started();}),kill:(id:string)=>kills.push(id),getWorkerPid:()=>undefined};
 const handle=runExportContext({workflowId:randomUUID(),cwd,manager,broadcast:()=>{}} as any,{mode:'original-worker',transcript:[],summarizer:{provider:'cursor',model:'auto',effort:'low'},original:{primary:{provider:'codex',model:'gpt-6-luna',effort:'low'},sessionId:'fixture-session',cwd,transport:'exec'}} as any);
 try{await Promise.race([ready,handle.settled.then(()=>{throw new Error('reflection did not start');})]);handle.abort();assert.equal(kills.length,1);}
 finally{release?.({...result('reflection',''),error:'cancelled'});await handle.settled;}
});
