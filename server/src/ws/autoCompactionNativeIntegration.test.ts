import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkflowState, Session } from '../workflows/types.js';
import type { WebSocket } from 'ws';
const temp=mkdtempSync(join(tmpdir(),'arco-native-policy-'));
installIsolatedTestHome(temp); process.env.ARCO_TEST='1';
const native=await import('../providers/claude-native/index.js');
const engine=await import('./turnEngine.js');
const compact=await import('./compactHandlers.js');
const { workflows, workflowCwds }=await import('../server/state.js');
const { broadcastWorkflow }=await import('../server/broadcast.js');
const { initWorkflowStore,replayEvents }=await import('../workflowStore.js');

test('fresh threshold runs one guarded Native compact and preserves prior events', async () => {
  const cwd=join(temp,'project'), id=randomUUID(); const sent: Array<Record<string,unknown>>=[];
  const ws={readyState:1,send:(payload:string)=>sent.push(JSON.parse(payload))} as unknown as WebSocket;
  const config={name:'fixture',workingDirectory:cwd,primaryProvider:'claude' as const,primaryModel:'claude-opus-4-8',primaryEffort:'low' as const,claudeTransport:'native' as const,autoCompaction:{enabled:true,thresholdPercent:80}};
  const wf={busy:false,config,primary:{provider:'claude',model:'claude-opus-4-8',effort:'low',skipPermissions:false},observers:new Set([ws]),queue:{steering:[],followUp:[]},autoHandoff:{enabled:false,warnAt:75,autoAt:90,warnFired:false,autoFired:false},lastContextPercent:85} as unknown as WorkflowState;
  workflows.set(id,wf); workflowCwds.set(id,cwd); await initWorkflowStore(cwd,id);
  native.setClaudeNativeWorkflowEventBroadcast((workflowId,event)=>broadcastWorkflow(workflowId,event));
  engine.initTurnEngine({previewAutoDetect:{} as never,handleCreateWorkflow:async()=>{},handleHandoffRequest:async()=>{},handleCompactWorkflow:compact.handleCompactWorkflow});
  try {
    assert.equal(native.debugSeedNativeCompactProbe(id,{provider:'claude',model:'claude-opus-4-8',effort:'low',cwd,workflowId:id},[{role:'user',content:'original input'},{role:'assistant',content:'original reply'}]),true);
    broadcastWorkflow(id,{type:'system_notice',workflowId:id,content:'original fixture event'});
    const token=engine.claimBusy(wf); engine.releaseBusy(wf,token);
    assert.equal(await engine.maybeAutoCompactPolicy(id,wf,cwd,config.autoCompaction,{percent:85,provider:'claude',sessionId:undefined},token,ws,{} as Session),true);
    const events=await replayEvents(cwd,id,0);
    assert.ok(events.some(e=>e.type==='native_compacted'));
    assert.ok(events.some(e=>e.type==='system_notice' && e.content==='original fixture event'));
    assert.ok(events.some(e=>e.type==='ctx_action' && e.trigger==='auto-threshold'));
    assert.equal(wf.lastContextPercent,0);
    assert.equal(await engine.maybeAutoCompactPolicy(id,wf,cwd,config.autoCompaction,{percent:85,provider:'claude',sessionId:undefined},token,ws,{} as Session),true); // stale claim cannot retry
    assert.equal((await replayEvents(cwd,id,0)).filter(e=>e.type==='native_compacted').length,1);
    // A real deterministic Fold consumes the boundary before compaction or handoff.
    wf.config.autoFold={enabled:true,foldAt:60,tailBudget:1};
    wf.autoFold=engine.deriveAutoFold(wf.config);
    wf.lastContextBudgetPct=90; wf.lastContextPercent=90;
    const foldToken=engine.claimBusy(wf); engine.releaseBusy(wf,foldToken);
    let handoffs=0,compacts=0;
    engine.initTurnEngine({previewAutoDetect:{} as never,handleCreateWorkflow:async()=>{},handleHandoffRequest:async()=>{handoffs++;},handleCompactWorkflow:async()=>{compacts++;}});
    assert.equal(await engine.runExplicitContextActions(id,wf,cwd,config.autoCompaction,{percent:90,provider:'claude',sessionId:undefined},foldToken,ws,{} as Session),'done');
    assert.equal(handoffs,0); assert.equal(compacts,0);
    assert.equal(wf.lastContextPercent,0);
    assert.ok((await replayEvents(cwd,id,0)).some(e=>e.type==='context_folded'));
    // A failed Fold is also an attempt and cannot fall through to another mutation.
    native.disposeClaudeNativeWorker(id);
    wf.autoFold=engine.deriveAutoFold(wf.config); wf.lastContextBudgetPct=90;
    const failToken=engine.claimBusy(wf); engine.releaseBusy(wf,failToken);
    assert.equal(await engine.runExplicitContextActions(id,wf,cwd,config.autoCompaction,{percent:90,provider:'claude',sessionId:undefined},failToken,ws,{} as Session),'done');
    assert.equal(handoffs,0); assert.equal(compacts,0);
    // A failed compact cannot fall through into handoff on the same reading.
    wf.config.autoFold={enabled:false,foldAt:60}; wf.autoFold=engine.deriveAutoFold(wf.config);
    engine.resetAutoCompactionCycle(wf);
    const compactToken=engine.claimBusy(wf); engine.releaseBusy(wf,compactToken);
    assert.equal(await engine.runExplicitContextActions(id,wf,cwd,config.autoCompaction,{percent:90,provider:'claude',sessionId:undefined},compactToken,ws,{} as Session),'compact-attempted');
    assert.equal(compacts,1); assert.equal(handoffs,0);

  } finally {native.disposeClaudeNativeWorker(id); workflows.delete(id); workflowCwds.delete(id); rmSync(temp,{recursive:true,force:true});}
});
