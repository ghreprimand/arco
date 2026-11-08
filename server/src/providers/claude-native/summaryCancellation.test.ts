import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installIsolatedTestHome} from '../../testSupport/isolatedHome.js';
const home=mkdtempSync(join(tmpdir(),'arco-summary-cancel-'));installIsolatedTestHome(home);
const {ClaudeNativeWorker}=await import('./worker.js');
after(()=>rmSync(home,{recursive:true,force:true}));
function setup(){
  const worker:any=new ClaudeNativeWorker({workflowId:'cancel-summary',config:{cwd:home,model:'claude-haiku-4-5',effort:'low',claudeNativeInTurnCompactPercent:70}});
  worker.ensureStarted=async()=>{};worker.client={messages:{}};worker.countCurrentContextTokens=async()=>100;
  worker.preCompactBlock=async()=>null;
  const events:any[]=[];worker.workflowEventBroadcast=(event:any)=>events.push(event);
  worker.messages=Array.from({length:6},(_,index)=>index%2?{role:'assistant',content:[{type:'text',text:'a'.repeat(300000)}]}:{role:'user',content:'u'.repeat(300000)});
  return {worker,events};
}
for(const mode of ['manual','in-turn'] as const)test(`${mode} compaction cancelled after one successful part starts no later part`,async()=>{
  const {worker,events}=setup();
  if(mode==='in-turn')worker.messages.push({role:'assistant',content:[{type:'text',text:'Latest round'},{type:'tool_use',id:'fixture',name:'Read',input:{file_path:'fixture'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'fixture',content:'Synthetic result'}]});
  const original=worker.messages,snapshot=JSON.stringify(original);
  let calls=0;worker.generateCompactSummary=async()=>{calls++;if(calls===1){if(mode==='manual')worker.cancelCompaction();else worker.cancel();}return 'Synthetic summary';};
  const result=mode==='manual'?await worker.compactInPlace():await worker.maybeCompactInTurn({input_tokens:150000});
  assert.equal(calls,1,'no later summarizer call after STOP');
  if(mode==='manual'){assert.equal(result.ok,false);assert.match(result.error,/cancel/i);}else assert.equal(result,'cancelled');
  assert.equal(worker.messages,original);assert.equal(JSON.stringify(worker.messages),snapshot);
  assert.ok(!events.some(event=>event.type==='native_compacted'));
  if(mode==='manual') {
    worker.generateCompactSummary=async()=> 'Fresh summary';
    assert.equal((await worker.compactInPlace()).ok,true,'a new explicit compaction is not permanently cancelled');
  }
});
test('cancellation during manual preparation prevents the first SDK request',async()=>{
  const {worker,events}=setup();
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
  worker.ensureStarted=async()=>{entered();await held;};
  let requests=0;worker.client={messages:{create:async()=>{requests++;return(async function*(){yield{type:'content_block_delta',delta:{type:'text_delta',text:'Synthetic summary'}};})();}}};
  const original=worker.messages;
  const pending=worker.compactInPlace();await started;worker.cancelCompaction();release();
  const result=await pending;
  assert.equal(requests,0);assert.equal(result.ok,false);assert.equal(worker.messages,original);
  assert.ok(!events.some(event=>event.type==='native_compacted'));
});
test('a stopped summary generation refuses a new SDK request at entry',async()=>{
  const {worker}=setup();
  worker.compactOperationEpoch=0;worker.cancelCompaction();
  let requests=0;worker.client={messages:{create:async()=>{requests++;throw Error('should not run');}}};
  await assert.rejects(worker.generateCompactSummary([{role:'user',content:'Synthetic prompt'}]),/cancel|abort/i);
  assert.equal(requests,0);
});
