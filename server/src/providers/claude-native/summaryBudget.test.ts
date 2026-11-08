import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installIsolatedTestHome} from '../../testSupport/isolatedHome.js';
const home=mkdtempSync(join(tmpdir(),'arco-summary-budget-'));installIsolatedTestHome(home);
const {splitSummaryParts,estimateSummaryTokens}=await import('./workerHelpers.js');
const {ClaudeNativeWorker}=await import('./worker.js');
after(()=>rmSync(home,{recursive:true,force:true}));
const text=(message:any):string=>typeof message.content==='string'?message.content:message.content.map((block:any)=>block.text).join('');
const cost=(messages:any[])=>messages.reduce((sum,m)=>sum+estimateSummaryTokens(text(m)),0);
for(const budget of [7,1000,175808])test(`every split part fits ${budget} tokens without losing text`,()=>{
  for(const messages of [
    [{role:'user',content:'u'.repeat(budget*2)},{role:'assistant',content:[{type:'text',text:'a'.repeat(budget*2)}]}],
    [{role:'assistant',content:[{type:'text',text:'long'.repeat(budget*4)}]}],
  ]) {
    const parts=splitSummaryParts(messages as any,budget);
    for(const part of parts)assert.ok(cost(part)<=budget,`part cost ${cost(part)} exceeds ${budget}`);
    assert.equal(parts.flat().map(text).join(''),messages.map(text).join(''));
  }
});
test('boundary-crossing pair never falls back to the unsplit prefix',async()=>{
  const worker:any=new ClaudeNativeWorker({workflowId:'budget',config:{cwd:home,model:'claude-haiku-4-5',effort:'low'}});
  const calls:any[][]=[];worker.generateCompactSummary=async(messages:any[])=>{calls.push(structuredClone(messages));return 'Synthetic summary';};
  const prefix=[{role:'user',content:'u'.repeat(300000)},{role:'assistant',content:[{type:'text',text:'a'.repeat(300000)}]}];
  assert.equal(await worker.summarizeInParts(prefix),'Synthetic summary');
  assert.ok(calls.length>=2);
  for(const call of calls){assert.equal(call[0].role,'user');assert.ok(cost(call)<=175808);}
});
test('every actual request reserves its carried summary and assistant-leading context',async()=>{
  const worker:any=new ClaudeNativeWorker({workflowId:'carry-budget',config:{cwd:home,model:'claude-haiku-4-5',effort:'low'}});
  const calls:any[][]=[];worker.generateCompactSummary=async(messages:any[])=>{calls.push(structuredClone(messages));return 's'.repeat(30000);};
  await worker.summarizeInParts([{role:'assistant',content:[{type:'text',text:'a'.repeat(175808*9)}]}]);
  assert.ok(calls.length>=3);
  for(const call of calls){assert.equal(call[0].role,'user');assert.ok(cost(call)<=175808,`request costs ${cost(call)}`);}
});
test('a carried summary too large for another request fails without sending that request',async()=>{
  const worker:any=new ClaudeNativeWorker({workflowId:'carry-overflow',config:{cwd:home,model:'claude-haiku-4-5',effort:'low'}});
  let calls=0;worker.generateCompactSummary=async()=>{calls++;return 's'.repeat(175808*3+1);};
  await assert.rejects(worker.summarizeInParts([{role:'user',content:'u'.repeat(175808*6)}]),/summary.*budget/i);
  assert.equal(calls,1);
});
