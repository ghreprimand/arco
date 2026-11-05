import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, WorkflowState } from '../workflows/types.js';
import type WebSocket from 'ws';

const home = mkdtempSync(join(tmpdir(), 'arco-turn-interrupt-')); installIsolatedTestHome(home);
const engine = await import('./turnEngine.js');
const { workflows, workflowCwds } = await import('../server/state.js');
const { initWorkflowStore, flushAll } = await import('../workflowStore.js');
const { settleProjectWrites } = await import('../testSupport/projectWrites.js');

test('an interrupt during pre-capture replaces the prompt before any worker starts', async () => {
  const cwd = join(home, 'project'), id = 'fixture-interrupt'; mkdirSync(cwd, {recursive:true});
  const ws = {readyState:1, send:()=>{}} as unknown as WebSocket;
  const session = {id:'fixture',workflowIds:new Set([id]),clusterIds:new Set(),clusterObserved:new Map()} as Session;
  const tasks: string[] = [];
  const manager = {spawn: async (spec:{task:string}, emit:(event:unknown)=>void) => {
    tasks.push(spec.task); emit({type:'worker_text',text:'answer'}); emit({type:'worker_complete',costUsd:0,durationMs:1});
    return {text:'answer',costUsd:0,durationMs:1};
  }, getWorkerPid:()=>undefined};
  const wf = {config:{name:'fixture',workingDirectory:cwd,primaryProvider:'codex',primaryModel:'fixture',primaryEffort:'low',skipPermissions:false},primary:{provider:'codex',model:'fixture',effort:'low',skipPermissions:false},manager,busy:false,observers:new Set([ws]),queue:{steering:[],followUp:[]},autoHandoff:{enabled:false,warnAt:75,autoAt:90,warnFired:false,autoFired:false},bgTracker:{noteBgHint:()=>{},attachParent:()=>{},detachParent:()=>{}}} as unknown as WorkflowState;
  workflows.set(id,wf); workflowCwds.set(id,cwd); await initWorkflowStore(cwd,id);
  let signal!:()=>void, finish!:(value:null)=>void, calls=0;
  const started = new Promise<void>(resolve=>{signal=resolve;});
  engine.initTurnEngine({previewAutoDetect:{noteAgentText:()=>{},notePotentialDevServerStart:()=>{}} as never,handleCreateWorkflow:async()=>{},handleHandoffRequest:async()=>{},captureCheckpoint:async()=>{if (++calls>1) return null; signal(); return await new Promise<null>(resolve=>{finish=resolve;});}});
  try {
    const run = engine.handleUserMessage(ws,session,id,'old instruction','old',undefined,false,undefined,undefined);
    await started;
    await engine.handleUserMessage(ws,session,id,'new instruction','new',undefined,true,'interrupt',undefined);
    finish(null); await run;
    assert.equal(tasks.length,1);
    assert.match(tasks[0],/new instruction/);
    assert.doesNotMatch(tasks[0],/old instruction/);
  } finally { workflows.delete(id); workflowCwds.delete(id); await settleProjectWrites(); rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
});
