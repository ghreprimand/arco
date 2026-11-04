import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../../testSupport/isolatedHome.js';
import { strict as assert } from 'node:assert';
const temp = mkdtempSync(join(tmpdir(), 'arco-native-ownership-'));
installIsolatedTestHome(temp);
const { ClaudeNativeWorker } = await import('./worker.js');
after(() => rmSync(temp, { recursive:true, force:true }));

test('cancelled compaction cannot replace messages from a newer turn', async () => {
  const worker = new ClaudeNativeWorker({workflowId:'fixture',config:{model:'claude-opus-4-8',effort:'high'}} as never);
  const internals = worker as unknown as { ensureStarted:()=>Promise<void>; client:object; messages:Array<{role:string;content:string}>; generateCompactSummary:()=>Promise<string>; compactInPlace:(valid:()=>boolean)=>Promise<{ok:boolean}> };
  internals.ensureStarted=async()=>{};
  internals.client={};
  internals.messages=[{role:'user',content:'original input'},{role:'assistant',content:'original response'}];
  let finish!: (value:string)=>void;
  internals.generateCompactSummary=()=>new Promise(resolve=>{finish=resolve;});
  let owns = true; const events: string[]=[];
  worker.setWorkflowEventBroadcast(event=>events.push(event.type));
  const compact=internals.compactInPlace(()=>owns);
  await Promise.resolve();
  owns=false;
  internals.messages.push({role:'user',content:'newer input'});
  finish('obsolete summary');
  assert.equal((await compact).ok,false);
  assert.ok(internals.messages.some(m=>m.content==='newer input'));
  assert.equal(events.includes('native_compacted'),false);
});

test('cancelCompaction aborts the summarization request and keeps history', async () => {
  const worker = new ClaudeNativeWorker({workflowId:'fixture',config:{model:'claude-opus-4-8',effort:'high'}} as never);
  const internals = worker as unknown as { ensureStarted:()=>Promise<void>; client:object; messages:Array<{role:string;content:string}> };
  internals.ensureStarted=async()=>{};
  let signal: AbortSignal | undefined;
  internals.client={messages:{create:(_params:unknown, options:{signal:AbortSignal})=>new Promise((_resolve,reject)=>{signal=options.signal; signal.addEventListener('abort',()=>reject(new Error('aborted')));})}};
  internals.messages=[{role:'user',content:'original input'},{role:'assistant',content:'original response'}];
  const pending=worker.compactInPlace(()=>true);
  await Promise.resolve();
  assert.ok(signal);
  worker.cancelCompaction();
  assert.equal(signal.aborted,true);
  assert.equal((await pending).ok,false);
  assert.ok(internals.messages.some(m=>m.content==='original input'));
});

test('failed compact does not reshape retained history', async () => {
  const worker = new ClaudeNativeWorker({workflowId:'fixture',config:{model:'claude-opus-4-8',effort:'high'}} as never);
  const internals = worker as unknown as { ensureStarted:()=>Promise<void>; client:object; messages:unknown[]; generateCompactSummary:()=>Promise<string> };
  internals.ensureStarted=async()=>{}; internals.client={};
  internals.messages=[{role:'user',content:'original'},{role:'assistant',content:[{type:'tool_use',id:'fixture-tool',name:'Read',input:{}}]}];
  const before=structuredClone(internals.messages);
  internals.generateCompactSummary=async()=>{throw new Error('fixture failure');};
  assert.equal((await worker.compactInPlace(()=>true)).ok,false);
  assert.deepEqual(internals.messages,before);
});

test('a second compact cannot run while the first summary is pending', async () => {
  const worker = new ClaudeNativeWorker({workflowId:'fixture',config:{model:'claude-opus-4-8',effort:'high'}} as never);
  const internals = worker as unknown as {ensureStarted:()=>Promise<void>;client:object;messages:unknown[];generateCompactSummary:()=>Promise<string>};
  internals.ensureStarted=async()=>{}; internals.client={}; internals.messages=[{role:'user',content:'first'},{role:'assistant',content:'reply'}];
  let finish!: (value:string)=>void;
  internals.generateCompactSummary=()=>new Promise(resolve=>{finish=resolve;});
  const first=worker.compactInPlace(()=>true); await Promise.resolve();
  const second=worker.compactInPlace(()=>true);
  const outcome=await Promise.race([second,new Promise<'pending'>(resolve=>setTimeout(()=>resolve('pending'),20))]);
  finish('summary');
  assert.notEqual(outcome,'pending');
  if (outcome !== 'pending') assert.equal(outcome.ok,false);
  await first;
});

test('Fold cannot reshape history while compaction is in flight', async () => {
  const worker = new ClaudeNativeWorker({workflowId:'fixture',config:{model:'claude-opus-4-8',effort:'high'}} as never);
  const internals = worker as unknown as {ensureStarted:()=>Promise<void>;client:object;messages:unknown[];generateCompactSummary:()=>Promise<string>};
  internals.ensureStarted=async()=>{}; internals.client={}; internals.messages=[{role:'user',content:'first'},{role:'assistant',content:'reply'}];
  let finish!: (value:string)=>void;
  internals.generateCompactSummary=()=>new Promise(resolve=>{finish=resolve;});
  const compact=worker.compactInPlace(()=>true); await Promise.resolve();
  const result=await worker.foldInPlace();
  finish('summary'); await compact;
  assert.equal(result.ok,false);
});
