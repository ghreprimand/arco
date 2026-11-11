import assert from 'node:assert/strict';
import { after,test } from 'node:test';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync,realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const root=mkdtempSync(join(tmpdir(),'arco-input-delivery-'));installIsolatedTestHome(root);process.env.PATH=root;
const engine=await import('./turnEngine.js');const {workflows,workflowCwds}=await import('../server/state.js');
const {initWorkflowStore,replayEvents,flushAll}=await import('../workflowStore.js');const {settleProjectWrites}=await import('../testSupport/projectWrites.js');
const {trackRecallFixture}=await import('../testSupport/recallFixture.test-support.js');const closeRecall=trackRecallFixture();
const {renderTranscript}=await import('../primitives/exportContext.js');const {parseRenderedTranscript}=await import('../providers/ollama.js');
const {buildMessagesFromReplayEvents}=await import('../providers/claude-native/resumeSummary.js');const {buildReviewContent}=await import('../primitives/reviewContent.js');
after(async()=>{await settleProjectWrites();await closeRecall();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
engine.initTurnEngine({previewAutoDetect:{noteAgentText(){},notePotentialDevServerStart(){}} as any,handleCreateWorkflow:async()=>{},handleHandoffRequest:async()=>{},captureCheckpoint:async()=>null});
async function fixture(provider:'claude'|'codex'|'ollama'|'llamacpp'|'lmstudio'|'strata'|'deepseek'){
 const id=randomUUID(),cwd=join(root,id);mkdirSync(cwd,{recursive:true});const messages:any[]=[],pending:any[]=[];
 const ws={readyState:1,bufferedAmount:0,send:(raw:string)=>messages.push(JSON.parse(raw))} as any;const session={id:'fixture',workflowIds:new Set([id]),clusterIds:new Set(),clusterObserved:new Map()} as any;
 const manager={spawn:(spec:any,emit:any,options:any)=>new Promise(resolve=>{let finished=false;pending.push({spec,emit,options,finish:(text:string)=>{if(finished)return;finished=true;emit({type:'worker_complete',costUsd:0,durationMs:1});resolve({id:spec.id,text,costUsd:0,durationMs:1});}});}),getWorkerPid:()=>undefined};
 const wf={config:{name:'Fixture',workingDirectory:cwd,primaryProvider:provider,primaryModel:provider==='claude'?'haiku':'gpt-6-luna',primaryEffort:'low',claudeTransport:'native',codexTransport:'appserver',autoCompaction:{enabled:false},autoHandoff:{enabled:false,afterCompactions:5}},primary:{provider,model:provider==='claude'?'haiku':'gpt-6-luna',effort:'low',skipPermissions:false},manager,busy:false,observers:new Set([ws]),queue:{steering:[],followUp:[]},autoHandoff:{enabled:false,afterCompactions:5,compactions:0,fired:false},lastContextPercent:0} as any;
 workflows.set(id,wf);workflowCwds.set(id,cwd);await initWorkflowStore(cwd,id);
 const wait=async(n:number)=>{for(let i=0;i<600&&pending.length<n;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(pending.length,n,JSON.stringify(messages).slice(-4000));};
 return{id,cwd,ws,session,wf,pending,wait,close:async()=>{workflows.delete(id);workflowCwds.delete(id);await settleProjectWrites();}};
}
for(const provider of ['claude','codex'] as const)test(`${provider} records a combined queued dispatch without corrupting completed replay`,async()=>{
 const f=await fixture(provider);let run:Promise<void>|undefined;
 try{run=engine.handleUserMessage(f.ws,f.session,f.id,'FIRST_TASK','first',undefined,false,undefined,undefined);await f.wait(1);f.pending[0].emit({type:'worker_text',text:'FIRST_PART_A'});
 await engine.handleUserMessage(f.ws,f.session,f.id,'FOLLOW_ONE','q1',undefined,true,'follow-up',undefined);await engine.handleUserMessage(f.ws,f.session,f.id,'FOLLOW_TWO','q2',undefined,true,'follow-up',undefined);
 f.pending[0].emit({type:'worker_text',text:'FIRST_PART_B'});f.pending[0].finish('FIRST_PART_AFIRST_PART_B');await f.wait(2);
 f.pending[1].emit({type:'worker_text',text:'ACTUAL_QUEUED_ANSWER'});f.pending[1].finish('ACTUAL_QUEUED_ANSWER');await run;await flushAll();
 const events=await replayEvents(f.cwd,f.id,0);const starts=events.filter(e=>e.type==='primary_turn_started') as any[];assert.deepEqual(starts.map(e=>e.inputClientMessageIds),[['first'],['q1','q2']]);
 const messages=buildMessagesFromReplayEvents(events as any);assert.equal(messages[0].content,'FIRST_TASK');assert.match(JSON.stringify(messages[1]),/FIRST_PART_AFIRST_PART_B/);assert.equal(messages[2].content,'FOLLOW_ONE\n\nFOLLOW_TWO');assert.match(JSON.stringify(messages[3]),/ACTUAL_QUEUED_ANSWER/);
 const review=await buildReviewContent(events,f.cwd,{kind:'last-n',n:2},false);assert.equal(review.turnCount,2);
 }finally{if(f.wf.busy)engine.revokeBusy(f.wf);f.wf.queue.steering.length=0;f.wf.queue.followUp.length=0;for(const pending of f.pending)pending.finish('fixture cleanup');await run;await f.close();}
});
for(const provider of ['claude','codex'] as const)test(`${provider} records steering at its accepted delivery boundary`,async()=>{
 const f=await fixture(provider);let run:Promise<void>|undefined;
 try{run=engine.handleUserMessage(f.ws,f.session,f.id,'FIRST_TASK','first',undefined,false,undefined,undefined);await f.wait(1);
 await engine.handleUserMessage(f.ws,f.session,f.id,'STEER_TASK','steer',undefined,true,'steer',undefined);f.pending[0].emit({type:'worker_text',text:'BEFORE_STEER'});
 const items=f.pending[0].options.drainSteer();assert.equal(items.length,1);if(provider==='codex')f.pending[0].options.onSteerDelivered(items);
 f.pending[0].emit({type:'worker_text',text:'AFTER_STEER'});f.pending[0].finish('BEFORE_STEERAFTER_STEER');await run;await flushAll();
 const events=await replayEvents(f.cwd,f.id,0);assert.equal(events.filter(e=>e.type==='turn_messages_delivered').length,1);
 const messages=buildMessagesFromReplayEvents(events as any);assert.equal(messages[0].content,'FIRST_TASK');assert.match(JSON.stringify(messages[1]),/BEFORE_STEER/);assert.equal(messages[2].content,'STEER_TASK');assert.match(JSON.stringify(messages[3]),/AFTER_STEER/);
 const review=await buildReviewContent(events,f.cwd,{kind:'last-turn'},false);assert.equal(review.turnCount,1);assert.ok(review.content.includes('FIRST_TASK')&&review.content.includes('STEER_TASK'));
 }finally{if(f.wf.busy)engine.revokeBusy(f.wf);f.wf.queue.steering.length=0;f.wf.queue.followUp.length=0;for(const pending of f.pending)pending.finish('fixture cleanup');await run;await f.close();}
});

for(const stopped of [false,true])test(`a late failed steer ${stopped?'stays cancelled after STOP':'remains queued after normal completion'}`,async()=>{
 const f=await fixture('codex');let run:Promise<void>|undefined,newToken:number|undefined;
 try{run=engine.handleUserMessage(f.ws,f.session,f.id,'FIRST_TASK','first',undefined,false,undefined,undefined);await f.wait(1);await engine.handleUserMessage(f.ws,f.session,f.id,'STEER_TASK','s',undefined,true,'steer',undefined);
 const options=f.pending[0].options,items=options.drainSteer();f.pending[0].emit({type:'worker_text',text:'answer'});f.pending[0].finish('answer');await run;
 if(stopped){engine.revokeBusy(f.wf);newToken=engine.claimBusy(f.wf);}
 options.requeueSteer(items,'follow-up');assert.equal(f.wf.queue.followUp.length,stopped?0:1);
 }finally{f.wf.queue.steering.length=0;f.wf.queue.followUp.length=0;for(const pending of f.pending)pending.finish('cleanup');await run;if(newToken!==undefined)engine.releaseBusy(f.wf,newToken);await f.close();}
});

test('revoked primary callbacks cannot append outcomes into a newer turn',async()=>{
 let previewNotes=0;engine.initTurnEngine({previewAutoDetect:{noteAgentText(){previewNotes++;},notePotentialDevServerStart(){}} as any,handleCreateWorkflow:async()=>{},handleHandoffRequest:async()=>{},captureCheckpoint:async()=>null});
 const f=await fixture('claude');let run:Promise<void>|undefined,newToken:number|undefined;
 try{run=engine.handleUserMessage(f.ws,f.session,f.id,'OLD_TASK','old',undefined,false,undefined,undefined);await f.wait(1);engine.revokeBusy(f.wf);newToken=engine.claimBusy(f.wf);const seen:any[]=[];const send=f.ws.send;f.ws.send=(raw:string)=>{seen.push(JSON.parse(raw));send(raw);};
 f.pending[0].emit({type:'worker_text',text:'late old output'});f.pending[0].finish('late old output');await run;assert.equal(seen.some(m=>m.type==='primary_text'||m.type==='primary_complete'||m.type==='primary_turn_ended'),false);assert.equal(engine.ownsBusy(f.wf,newToken),true);assert.equal(previewNotes,0);
 }finally{for(const pending of f.pending)pending.finish('cleanup');await run;if(newToken!==undefined)engine.releaseBusy(f.wf,newToken);await f.close();}
});
test('a finished execution cannot drain steering intended for the next queued execution',async()=>{
 const f=await fixture('claude');let run:Promise<void>|undefined;
 try{run=engine.handleUserMessage(f.ws,f.session,f.id,'FIRST_TASK','first',undefined,false,undefined,undefined);await f.wait(1);const first=f.pending[0].options;
 await engine.handleUserMessage(f.ws,f.session,f.id,'NEXT_TASK','next',undefined,true,'follow-up',undefined);f.pending[0].emit({type:'worker_text',text:'first answer'});f.pending[0].finish('first answer');await f.wait(2);
 await engine.handleUserMessage(f.ws,f.session,f.id,'NEW_STEER','steer',undefined,true,'steer',undefined);assert.deepEqual(first.drainSteer(),[]);assert.equal(f.wf.queue.steering.length,1);
 const current=f.pending[1].options.drainSteer();assert.equal(current.length,1);f.pending[1].emit({type:'worker_text',text:'next answer'});f.pending[1].finish('next answer');await run;
 }finally{if(f.wf.busy)engine.revokeBusy(f.wf);f.wf.queue.steering.length=0;f.wf.queue.followUp.length=0;for(const pending of f.pending)pending.finish('cleanup');await run;await f.close();}
});

test('the current provider may drain steering synchronously during startup',async()=>{
 const f=await fixture('claude');let drained=0,spawns=0;
 f.wf.manager.spawn=async(spec:any,emit:any,options:any)=>{if(++spawns===1)f.wf.queue.steering.push({content:'startup steer',clientMessageId:'startup'});drained=options.drainSteer().length;emit({type:'worker_text',text:'answer'});emit({type:'worker_complete',costUsd:0,durationMs:1});return {id:spec.id,text:'answer',costUsd:0,durationMs:1};};
 try{await engine.handleUserMessage(f.ws,f.session,f.id,'FIRST_TASK','first',undefined,false,undefined,undefined);assert.equal(drained,1);}
 finally{f.wf.queue.steering.length=0;f.wf.queue.followUp.length=0;await f.close();}
});

test('a revoked initialization cannot pin its session onto a newer provider',async()=>{
 const f=await fixture('claude');let run:Promise<void>|undefined,newToken:number|undefined;
 try{run=engine.handleUserMessage(f.ws,f.session,f.id,'OLD_TASK','old',undefined,false,undefined,undefined);await f.wait(1);engine.revokeBusy(f.wf);newToken=engine.claimBusy(f.wf);f.wf.primary.provider='codex';f.wf.primary.model='gpt-6-luna';f.wf.primarySessionId=undefined;
 f.pending[0].options.onInit({sessionId:'OLD_SESSION',model:'haiku'});assert.equal(f.wf.primarySessionId,undefined);f.pending[0].finish('cleanup');await run;
 }finally{for(const pending of f.pending)pending.finish('cleanup');await run;if(newToken!==undefined)engine.releaseBusy(f.wf,newToken);await f.close();}
});

test('anonymous incognito queued input keeps delivery identity entirely in memory',async()=>{
 const f=await fixture('claude');f.wf.config.kind='chat';f.wf.config.incognito=true;f.wf.incognitoEvents=[];workflowCwds.delete(f.id);let run:Promise<void>|undefined;
 try{run=engine.handleUserMessage(f.ws,f.session,f.id,'PRIVATE_FIRST',undefined,undefined,false,undefined,undefined);await f.wait(1);f.pending[0].emit({type:'worker_text',text:'first answer'});
 await engine.handleUserMessage(f.ws,f.session,f.id,'PRIVATE_FOLLOW',undefined,undefined,true,'follow-up',undefined);f.pending[0].finish('first answer');await f.wait(2);f.pending[1].emit({type:'worker_text',text:'follow answer'});f.pending[1].finish('follow answer');await run;
 const transcript=parseRenderedTranscript(renderTranscript(f.wf.incognitoEvents));assert.deepEqual(transcript.map(m=>m.content),['PRIVATE_FIRST','first answer','PRIVATE_FOLLOW','follow answer']);
 assert.equal(f.wf.incognitoEvents.filter((e:any)=>e.type==='primary_turn_started'&&e.inputClientMessageIds?.length===1).length,2);await flushAll();assert.equal((await replayEvents(f.cwd,f.id,0)).length,0);
 }finally{if(f.wf.busy)engine.revokeBusy(f.wf);f.wf.queue.steering.length=0;f.wf.queue.followUp.length=0;for(const pending of f.pending)pending.finish('cleanup');await run;await f.close();}
});

test('an accepted late steer retains its original provider delivery policy after a provider change',async()=>{
 const f=await fixture('codex');let run:Promise<void>|undefined;
 try{run=engine.handleUserMessage(f.ws,f.session,f.id,'FIRST_TASK','first',undefined,false,undefined,undefined);await f.wait(1);await engine.handleUserMessage(f.ws,f.session,f.id,'STEER_TASK','s',undefined,true,'steer',undefined);
 const options=f.pending[0].options;f.pending[0].emit({type:'worker_text',text:'BEFORE_STEER'});const items=options.drainSteer();f.pending[0].emit({type:'worker_text',text:'AFTER_STEER'});f.pending[0].finish('BEFORE_STEERAFTER_STEER');await run;
 f.wf.primary.provider='claude';options.onSteerDelivered(items);await flushAll();const events=await replayEvents(f.cwd,f.id,0);assert.equal(events.filter(e=>e.type==='turn_messages_delivered').length,1);const replay=buildMessagesFromReplayEvents(events as any);assert.equal(replay[2].content,'STEER_TASK');
 }finally{f.wf.queue.steering.length=0;f.wf.queue.followUp.length=0;for(const pending of f.pending)pending.finish('cleanup');await run;await f.close();}
});

test('a busy reminder enters steering and never starts a turn when the member is idle',async()=>{
 const f=await fixture('claude');let run:Promise<void>|undefined;
 try{
  assert.equal(await engine.enqueueBusyReminder(f.id,'REMINDER'),false);assert.equal(f.pending.length,0);
  run=engine.handleUserMessage(f.ws,f.session,f.id,'FIRST_TASK','first',undefined,false,undefined,undefined);await f.wait(1);
  assert.equal(await engine.enqueueBusyReminder(f.id,'REMINDER'),true);assert.equal(f.wf.queue.steering[0].content,'REMINDER');
  f.pending[0].options.drainSteer();f.pending[0].finish('fixture answer');await run;
 }finally{f.wf.queue.steering.length=0;f.wf.queue.followUp.length=0;for(const p of f.pending)p.finish('cleanup');await run;await f.close();}
});
test('a busy reminder abandoned during preparation cannot steer a replacement turn',async()=>{
 const f=await fixture('claude');let run:Promise<void>|undefined,token:number|undefined;
 try{
  run=engine.handleUserMessage(f.ws,f.session,f.id,'FIRST_TASK','first',undefined,false,undefined,undefined);await f.wait(1);
  const reminder=engine.enqueueBusyReminder(f.id,'STALE_REMINDER');engine.revokeBusy(f.wf);token=engine.claimBusy(f.wf);
  assert.equal(await reminder,false);assert.equal(f.wf.queue.steering.length,0);
  f.pending[0].finish('fixture answer');await run;
 }finally{f.wf.queue.steering.length=0;f.wf.queue.followUp.length=0;for(const p of f.pending)p.finish('cleanup');await run;if(token!==undefined)engine.releaseBusy(f.wf,token);await f.close();}
});

test('automatic markers persist with full idle and queued prompts while typed lookalikes stay ordinary', async () => {
 const f=await fixture('claude'); let run:Promise<void>|undefined;
 try {
  const first='(nudge) full synthetic wake';
  run=engine.handleUserMessage(f.ws,f.session,f.id,first,'auto-first',undefined,false,undefined,undefined,undefined,{automaticKind:'nudge'});
  await f.wait(1);
  assert.ok(f.pending[0].spec.task.includes(first));
  const busy='(auto-pickup) full synthetic reminder';
  assert.equal(await engine.enqueueBusyReminder(f.id,busy),true);
  await engine.handleUserMessage(f.ws,f.session,f.id,'(nudge) typed manually','typed',undefined,true,'steer',undefined);
  const queue=engine.projectQueue(f.wf.queue.steering);
  assert.equal(queue[0].automaticKind,'auto-pickup');
  assert.equal(queue[0].content,busy);
  assert.equal(queue[1].automaticKind,undefined);
  f.wf.queue.steering.length=0;
  f.pending[0].finish('answer'); await run; await flushAll();
  const echoes=(await replayEvents(f.cwd,f.id,0)).filter(e=>e.type==='user_message_echo');
  assert.deepEqual(echoes.map(e=>[e.content,e.automaticKind]),[[first,'nudge'],[busy,'auto-pickup'],['(nudge) typed manually',undefined]]);
 } finally {
  f.wf.queue.steering.length=0;f.wf.queue.followUp.length=0;
  for(const pending of f.pending) pending.finish('cleanup');
  await run; await f.close();
 }
});

test('a native turn beginning with a tool publishes working before output',async()=>{
 const f=await fixture('claude');const clusters=await import('../clusterStore.js');const {sessions}=await import('../server/state.js');const cluster=await clusters.createCluster({cwd:f.cwd,memberWorkflowIds:[f.id,randomUUID()]});
 const updates:any[]=[];const observer={readyState:1,send:(raw:string)=>updates.push(JSON.parse(raw))} as any;sessions.set(observer,{id:'cluster-fixture',workflowIds:new Set(),clusterIds:new Set([cluster.clusterId]),clusterObserved:new Map()} as any);let run:Promise<void>|undefined;
 try{
  run=engine.handleUserMessage(f.ws,f.session,f.id,'FIRST_TOOL','tool-start',undefined,false,undefined,undefined);await f.wait(1);
  f.pending[0].emit({type:'worker_tool_use',workerId:f.id,tool:'Read',input:JSON.stringify({file_path:'fixture.txt'}),status:'started'});
  for(let i=0;i<100&&!updates.some(u=>u.type==='cluster_state'&&u.state.members.find((m:any)=>m.workflowId===f.id)?.status==='busy');i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(updates.some(u=>u.type==='cluster_state'&&u.state.members.find((m:any)=>m.workflowId===f.id)?.status==='busy'),'cluster must see the accepted turn before any text or thinking');
 }finally{for(const pending of f.pending)pending.finish('cleanup');await run;sessions.delete(observer);await clusters.deleteCluster(cluster.clusterId);await f.close();}
});

test('image context references reach immediate and queued provider turns',async()=>{
 const f=await fixture('claude');let run:Promise<void>|undefined;
 try{
  const image=join(f.cwd,'fixture.png');
  writeFileSync(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64'));
  run=engine.handleUserMessage(f.ws,f.session,f.id,'Inspect @file:fixture.png','first',undefined,false,undefined,undefined);
  await f.wait(1);assert.deepEqual(f.pending[0].options.attachments,[realpathSync(image)]);
  await engine.handleUserMessage(f.ws,f.session,f.id,'Inspect again @file:fixture.png','next',undefined,true,'follow-up',undefined);
  f.pending[0].finish('first answer');await f.wait(2);assert.deepEqual(f.pending[1].options.attachments,[realpathSync(image)]);
  f.pending[1].finish('second answer');await run;
 }finally{if(f.wf.busy)engine.revokeBusy(f.wf);f.wf.queue.steering.length=0;f.wf.queue.followUp.length=0;for(const pending of f.pending)pending.finish('fixture cleanup');await run;await f.close();}
});

test('an image context reference remains attached to a steered message',async()=>{
 const f=await fixture('claude');let run:Promise<void>|undefined;
 try{
  const image=join(f.cwd,'fixture.png');
  writeFileSync(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64'));
  run=engine.handleUserMessage(f.ws,f.session,f.id,'FIRST','first',undefined,false,undefined,undefined);await f.wait(1);
  await engine.handleUserMessage(f.ws,f.session,f.id,'Inspect @file:fixture.png','steer',undefined,true,'steer',undefined);
  const items=f.pending[0].options.drainSteer();assert.equal(items.length,1);assert.deepEqual(items[0].attachments,[realpathSync(image)]);
  f.pending[0].finish('answer');await run;
 }finally{if(f.wf.busy)engine.revokeBusy(f.wf);f.wf.queue.steering.length=0;f.wf.queue.followUp.length=0;for(const pending of f.pending)pending.finish('fixture cleanup');await run;await f.close();}
});

for (const provider of ['ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek'] as const) test(`${provider} primary dispatch restores named file references through seedWorker`, async () => {
 const f = await fixture(provider); let run: Promise<void> | undefined;
 try {
  const { persistAndStampSeq } = await import('../workflowStore.js');
  persistAndStampSeq(f.cwd, f.id, { type: 'user_message_echo', workflowId: f.id, content: 'Earlier input', attachments: [join(f.cwd, 'earlier.rtf')] } as any);
  persistAndStampSeq(f.cwd, f.id, { type: 'primary_complete', workflowId: f.id } as any);
  run = engine.handleUserMessage(f.ws, f.session, f.id, 'Continue', 'current', undefined, false, undefined, undefined);
  await f.wait(1);
  const options = f.pending[0].options;
  assert.equal(options.fileContextCwd, f.cwd);
  assert.deepEqual(options.fileContextInputIds, ['current']);
  assert.ok(options.priorFiles.some((ref: any) => ref.kind === 'source' && ref.path === join(f.cwd, 'earlier.rtf')));
  f.pending[0].emit({ type: 'worker_file_context', workerId: f.pending[0].spec.id, workflowId: f.id, origin: 'tool', receipt: 'Restorable named file', files: [] });
  f.pending[0].finish('Done'); await run; await flushAll();
  assert.ok((await replayEvents(f.cwd, f.id, 0)).some(event => event.type === 'file_context' && event.receipt === 'Restorable named file'));
 } finally { for (const pending of f.pending) pending.finish('cleanup'); await run; await f.close(); }
});

const pendingNotice = 'This tab is working. It gets its cluster tools when the current turn ends.';
for (const provider of ['claude','codex','ollama','llamacpp','lmstudio'] as const) test(`${provider} joining a dispatched turn warns both browsers and decorates only old-turn steering`, async()=>{
 const f=await fixture(provider);let run:Promise<void>|undefined;
 const store=await import('../clusterStore.js');const second:any[]=[];f.wf.observers.add({readyState:1,send:(raw:string)=>second.push(JSON.parse(raw))});
 try {
  run=engine.handleUserMessage(f.ws,f.session,f.id,'FIRST_TASK','first',undefined,false,undefined,undefined);await f.wait(1);
  await engine.handleUserMessage(f.ws,f.session,f.id,'UNCHANGED_BYTES\nwith punctuation: []','before',undefined,true,'steer',undefined);
  assert.equal(f.pending[0].options.drainSteer()[0].content,'UNCHANGED_BYTES\nwith punctuation: []');
  const cluster=await store.createCluster({cwd:f.cwd,memberWorkflowIds:[f.id,randomUUID()]});
  await store.setMemberRole(cluster.clusterId,f.id,'Director role. Delegate using peer_send.');
  assert.equal(second.filter(m=>m.type==='system_notice'&&m.content===pendingNotice).length,1);
  assert.equal(await engine.enqueueBusyReminder(f.id,'Read peer mail and delegate'),false,'pending turn refuses automatic reminder without another notice');
  await engine.handleUserMessage(f.ws,f.session,f.id,'AUTOMATIC_PICKUP','automatic',undefined,true,'follow-up',undefined,undefined,{automaticKind:'auto-pickup'});
  assert.equal(second.filter(m=>m.type==='system_notice'&&m.content===pendingNotice).length,1,'automatic pickup adds no operator notice');
  await engine.handleUserMessage(f.ws,f.session,f.id,'BACKGROUND_EVENT','background',undefined,true,'follow-up',undefined,undefined,{backgroundEvent:true});
  assert.equal(second.filter(m=>m.type==='system_notice'&&m.content===pendingNotice).length,1,'background event adds no operator notice');
  await engine.handleUserMessage(f.ws,f.session,f.id,'OPERATOR_STEER','steer',undefined,true,'steer',undefined);
  const items=f.pending[0].options.drainSteer();assert.match(items[0].content,/Arco cluster tools pending/);assert.match(items[0].content,/Do not work around/);assert.ok(items[0].content.endsWith('OPERATOR_STEER'));assert.ok(!items[0].content.includes('Delegate using'));
  // A failed steer requeues the original input, never its transient warning.
  f.pending[0].options.requeueSteer(items,'follow-up');
  assert.equal(f.wf.queue.followUp.find((item:any)=>item.clientMessageId==='steer')?.content,'OPERATOR_STEER');
  await engine.handleUserMessage(f.ws,f.session,f.id,'FOLLOW_UP','follow',undefined,true,'follow-up',undefined);
  assert.equal(second.filter(m=>m.type==='system_notice'&&m.content===pendingNotice).length,3,'join plus two operator inputs, no drain/reminder spam');
  f.pending[0].finish('first');await f.wait(2);
  assert.equal(f.pending[1].options.clusterId,cluster.clusterId);assert.ok(!f.pending[1].spec.task.includes('Arco cluster tools pending'));assert.ok(f.pending[1].spec.task.includes('OPERATOR_STEER'));assert.ok(f.pending[1].spec.task.includes('FOLLOW_UP'));
  await engine.handleUserMessage(f.ws,f.session,f.id,'READY_STEER\n[]','ready',undefined,true,'steer',undefined);
  assert.equal(f.pending[1].options.drainSteer()[0].content,'READY_STEER\n[]');
  f.pending[1].finish('second');await run;await flushAll();
  const notices=(await replayEvents(f.cwd,f.id,0)).filter((e:any)=>e.type==='system_notice'&&e.content===pendingNotice);assert.equal(notices.length,3,'notices survive reconnect replay');
 } finally {f.wf.queue.steering.length=0;f.wf.queue.followUp.length=0;for(const item of f.pending)item.finish('cleanup');await run;await f.close();}
});
