import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(),'arco-usage-completeness-'));
const oldAuth = process.env.ARCO_CURSOR_AUTH;
process.env.ARCO_CURSOR_AUTH=join(root,'fixture-auth.json');
const payload=Buffer.from(JSON.stringify({sub:'fixture-usage'})).toString('base64url');
writeFileSync(process.env.ARCO_CURSOR_AUTH,JSON.stringify({accessToken:['fixture',payload,'fixture'].join('.')}));
const {getCursorUsage}=await import('./cursorUsage.js');

test('usage never presents capped or prematurely ended pages as a complete month',async(t)=>{
  const original=globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;if(oldAuth===undefined)delete process.env.ARCO_CURSOR_AUTH;else process.env.ARCO_CURSOR_AUTH=oldAuth;rmSync(root,{recursive:true,force:true});});
  for(const scenario of ['capped','early','complete','unreported'] as const){
    let pages=0;
    globalThis.fetch=async(input,init)=>{
      assert.ok(String(input).startsWith('https://cursor.com/'));
      if(!String(input).endsWith('get-filtered-usage-events'))return Response.json({});
      pages++;
      const page=JSON.parse(String(init?.body)).page;
      const count=scenario==='capped'?100:scenario==='early'?(page===1?100:0):scenario==='complete'?2:2;
      return Response.json({...(scenario!=='unreported'?{totalUsageEventsCount:scenario==='capped'?5001:scenario==='early'?300:2}:{}),usageEventsDisplay:Array.from({length:count},()=>({chargedCents:1,tokenUsage:{inputTokens:2}}))});
    };
    const usage=await getCursorUsage(true);
    if(scenario==='capped'||scenario==='early'){
      assert.equal(usage.available,false,scenario);
      assert.match(usage.error??'',/incomplete/i);
      assert.equal(usage.chargedCents,undefined);
      assert.equal(usage.totalTokens,undefined);
      assert.equal(pages,scenario==='capped'?50:2);
    }else{
      assert.equal(usage.available,true,scenario);
      assert.equal(usage.chargedCents,2);
      assert.equal(usage.eventCount,2);
      assert.equal(pages,1);
    }
  }
});
