import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleUserMessage } from './turnEngine.js';
import { workflows } from '../server/state.js';
import type { WorkflowState } from '../workflows/types.js';
import type { Session } from '../workflows/types.js';
import type WebSocket from 'ws';

// Reaches the real post-preflight seam without ever invoking a provider.
// A rejected conditional send must not echo, claim busy or enter the queue.
test('conditional claim fences cancellation, removal and a concurrent operator turn', async () => {
  const id = 'conditional-claim-test';
  const session = { id:'test',workflowIds:new Set([id]),clusterIds:new Set(),clusterObserved:new Map() } as Session;
  const ws = { readyState:3,send:()=>assert.fail('unexpected send') } as unknown as WebSocket;
  const wf = { config:{kind:'chat',workingDirectory:'/tmp',chatWebAccess:false}, primary:{provider:'codex',model:'gpt-6-luna'},
    busy:false, queue:{steering:[],followUp:[]}, observers:new Set() } as unknown as WorkflowState;
  const run = (guard: (claim:()=>boolean)=>Promise<boolean>) => handleUserMessage(ws,session,id,'mail reminder',undefined,undefined,false,undefined,undefined,undefined,{claimGuard:guard});
  workflows.set(id,wf);
  try {
    let reached = false;
    await run(async () => { reached = true; return false; }); // cancelled rule declines claim
    assert(reached); assert.equal(wf.busy,false);
    await run(async (claim) => { wf.busy = true; assert.equal(claim(),false); return false; });
    assert.deepEqual(wf.queue,{steering:[],followUp:[]}); assert.equal(wf.busy,true);
    wf.busy = false;
    await run(async (claim) => { workflows.delete(id); assert.equal(claim(),false); return false; });
    assert.equal(wf.busy,false); assert.deepEqual(wf.queue,{steering:[],followUp:[]});
  } finally { workflows.delete(id); }
});

test('Antigravity refuses automatic, internal and scheduling turns before dispatch', async () => {
  const id = 'antigravity-guard-fixture';
  const session = { id:'test', workflowIds:new Set([id]), clusterIds:new Set(), clusterObserved:new Map() } as Session;
  const sent: Array<{type:string;message?:string}> = [];
  const ws = { readyState:1, send:(raw:string)=>sent.push(JSON.parse(raw)) } as unknown as WebSocket;
  const wf = { config:{kind:'workflow',workingDirectory:'/fixture'}, primary:{provider:'antigravity-cli',model:'gemini-fixture'}, busy:false, queue:{steering:[],followUp:[]}, observers:new Set() } as unknown as WorkflowState;
  workflows.set(id,wf);
  try {
    await handleUserMessage(ws,session,id,'automatic',undefined,undefined,false,undefined,undefined,undefined,{automaticKind:'nudge'});
    await handleUserMessage(ws,session,id,'internal',undefined,undefined,false,undefined,undefined);
    await handleUserMessage(ws,session,id,'/schedule later',undefined,undefined,false,undefined,undefined,undefined,{operatorInitiated:true});
    assert.equal(wf.busy,false); assert.equal(sent.length,3);
    assert.ok(sent.every(event=>event.type==='error'));
    assert.match(sent[2].message ?? '', /scheduling.*unavailable/i);
  } finally { workflows.delete(id); }
});
