import assert from 'node:assert/strict';
import { after,test } from 'node:test';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const root=mkdtempSync(join(tmpdir(),'arco-local-cluster-prompt-'));process.once('exit',()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));installIsolatedTestHome(root);process.env.PATH=root;
const {releaseClusterPlansWatcher}=await import('../server/broadcast.js');
const engine=await import('./turnEngine.js');const {workflows,workflowCwds,plansWatchers,clusterPlanWatcherCwds}=await import('../server/state.js');
const store=await import('../clusterStore.js');const {createPlan}=await import('../planStore.js');const {initWorkflowStore}=await import('../workflowStore.js');
const {settleProjectWrites}=await import('../testSupport/projectWrites.js');const {trackRecallFixture}=await import('../testSupport/recallFixture.test-support.js');const closeRecall=trackRecallFixture();
after(async()=>{
 await settleProjectWrites();await closeRecall();await settleProjectWrites();
 // Unawaited cluster-state broadcasts can acquire watchers after per-case cleanup.
 for(const [clusterId,cwd] of clusterPlanWatcherCwds){
  const watcher=plansWatchers.get(cwd)?.watcher;
  const closed=watcher?once(watcher,'close'):undefined;
  releaseClusterPlansWatcher(clusterId);
  await closed;
 }
 rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});
engine.initTurnEngine({previewAutoDetect:{noteAgentText(){},notePotentialDevServerStart(){}} as any,handleCreateWorkflow:async()=>{},handleHandoffRequest:async()=>{},captureCheckpoint:async()=>null});
for(const {provider,blind} of [...(['ollama','llamacpp','lmstudio','strata','deepseek'] as const).map(provider=>({provider,blind:false})),...(['lmstudio','strata','deepseek'] as const).map(provider=>({provider,blind:true}))])test(`${provider} ${blind?'keeps the shared plan hidden in blind mode':'receives cluster context exactly once'}`,async(t)=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({models:[{name:'fixture',model:'fixture'}],data:[{id:'fixture'}],status:'ok'}));
 const id=randomUUID(),peer=randomUUID(),cwd=join(root,id);mkdirSync(cwd,{recursive:true});const messages:any[]=[];let captured:any;
 const ws={readyState:1,bufferedAmount:0,send:(raw:string)=>messages.push(JSON.parse(raw))} as any;
 const session={id:'fixture',workflowIds:new Set([id]),clusterIds:new Set(),clusterObserved:new Map()} as any;
 const manager={spawn:async(spec:any,emit:any,options:any)=>{captured={...options,systemPrompt:spec.systemPrompt};emit({type:'worker_text',text:'fixture answer'});emit({type:'worker_complete',costUsd:0,durationMs:1});return {id:spec.id,text:'fixture answer',costUsd:0,durationMs:1};},getWorkerPid:()=>undefined};
 const wf={config:{name:'Fixture member',workingDirectory:cwd,primaryProvider:provider,primaryModel:'fixture',primaryEffort:'low',autoCompaction:{enabled:false},autoHandoff:{enabled:false,afterCompactions:5}},primary:{provider,model:'fixture',effort:'low',skipPermissions:false},manager,busy:false,observers:new Set([ws]),queue:{steering:[],followUp:[]},autoHandoff:{enabled:false,afterCompactions:5,compactions:0,fired:false},lastContextPercent:0} as any;
 workflows.set(id,wf);workflowCwds.set(id,cwd);await initWorkflowStore(cwd,id);
 const cluster=await store.createCluster({cwd,memberWorkflowIds:[id,peer],progressTracking:'both'});const plan=await createPlan(cwd,{title:'Fixture cluster plan',body:'- [ ] PLAN_MARKER'});await store.setPlanId(cluster.clusterId,plan.id);await store.setMemberRole(cluster.clusterId,id,'ROLE_MARKER');if(blind)await store.setMemberAccessMode(cluster.clusterId,id,'blind');
 try{await engine.handleUserMessage(ws,session,id,'fixture task','fixture-input',undefined,false,undefined,undefined);assert.ok(captured,JSON.stringify(messages));
 const prompt=captured.systemPrompt??'';if(blind){assert.doesNotMatch(prompt,/PLAN_MARKER/);return;}assert.equal((prompt.match(/PLAN_MARKER/g)??[]).length,1);assert.equal((prompt.match(/ROLE_MARKER/g)??[]).length,1);assert.equal((prompt.match(/--- Cluster progress tracking ---/g)??[]).length,1);
 }finally{releaseClusterPlansWatcher(cluster.clusterId);await store.deleteCluster(cluster.clusterId);workflows.delete(id);workflowCwds.delete(id);await settleProjectWrites();}
});
