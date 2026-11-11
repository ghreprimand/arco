import assert from 'node:assert/strict';
import test from 'node:test';
import {Readable} from 'node:stream';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {markThrottled,markAvailable,getState,isAvailable,setChangeListener,announcesRecovery} from '../quota.js';
import {tryHandleProviderThrottleRoutes} from './providerThrottleRoutes.js';
const read = {codex:async()=>({available:true,source:'appserver',fetchedAt:Date.now(),rows:[{label:'5h',value:'30% used'}]}),claude:async()=>({available:true,source:'claude-cli',freshness:'fresh',fetchedAt:Date.now(),session:{utilization:15},weekly:{utilization:25}})};
async function request(body:unknown,method='POST',url='/api/provider-throttle',meters:any=read){
 const req=Object.assign(Readable.from([Buffer.from(typeof body==='string'?body:JSON.stringify(body))]),{method,url}) as IncomingMessage;
 let code=0,text='';const res={writeHead(s:number){code=s;},end(s:string){text=s;}} as unknown as ServerResponse;
 const handled=await tryHandleProviderThrottleRoutes(req,res,meters);return {handled,code,body:text?JSON.parse(text):undefined};
}
test('clear removes remembered reset/error, changes availability and broadcasts once',async()=>{
 markThrottled('codex','fixture',Date.now()+60_000);const events:boolean[]=[];setChangeListener((p,s)=>{if(p==='codex')events.push(s.throttled);});
 try{const r=await request({provider:'codex',action:'clear'});assert.equal(r.code,200);assert.equal(r.body.providers.codex.throttled,false);assert.equal(getState('codex').resetsAt,undefined);assert.equal(getState('codex').lastError,undefined);assert.equal(getState('codex').sourceOfTruth,'manual-clear');assert.equal(isAvailable('codex'),true);assert.deepEqual(events,[false]);}finally{setChangeListener(null);markAvailable('codex');}
});
test('exact route validates provider, action, body, method and request size',async()=>{
 assert.equal((await request({},'GET')).code,405);assert.equal((await request({provider:'bogus',action:'clear'})).code,400);
 assert.equal((await request({provider:'codex',action:'probe'})).code,400);assert.equal((await request(null)).code,400);
 assert.equal((await request('{')).code,400);assert.equal((await request('x'.repeat(5_000))).code,413);
 assert.equal((await request({},'POST','/api/provider-throttle-extra')).handled,false);
 assert.equal((await request({provider:'ollama',action:'recheck'})).code,400);
});
test('headroom clears through markAvailable with one broadcast and no recovered notice',async()=>{
 markThrottled('codex','fixture',Date.now()+60_000);markThrottled('claude','fixture',Date.now()+60_000);
 const events:Array<[string,boolean,string]>=[];setChangeListener((p,s)=>{events.push([p,s.throttled,s.sourceOfTruth]);});
 try{
  const r=await request({provider:'codex',action:'recheck'});
  assert.equal(r.body.usage.status,'headroom');assert.equal(r.body.usage.cleared,true);
  assert.equal(r.body.usage.message,'Usage shows headroom. Notice cleared. If the provider is still limiting requests, the next turn will show it again.');
  assert.equal(r.body.providers.codex.throttled,false);assert.equal(r.body.providers.claude.throttled,true);
  assert.equal(isAvailable('codex'),true);assert.equal(getState('codex').sourceOfTruth,'manual-probe');assert.equal(getState('codex').resetsAt,undefined);
  assert.deepEqual(events,[['codex',false,'manual-probe']]);assert.equal(announcesRecovery(getState('codex')),false);
  assert.equal((await request({provider:'claude',action:'recheck'})).body.usage.cleared,true);assert.equal(isAvailable('claude'),true);
 }finally{setChangeListener(null);markAvailable('codex');markAvailable('claude');}
});
test('recovery notice is announced for real recovery only, never for manual clear or recheck',()=>{
 assert.equal(announcesRecovery({throttled:false,sourceOfTruth:'observed-error'}),true);
 assert.equal(announcesRecovery({throttled:false,sourceOfTruth:'parsed-header'}),true);
 assert.equal(announcesRecovery({throttled:false,sourceOfTruth:'manual-clear'}),false);
 assert.equal(announcesRecovery({throttled:false,sourceOfTruth:'manual-probe'}),false);
 assert.equal(announcesRecovery({throttled:true,sourceOfTruth:'observed-error'}),false);
});
test('exhausted usage reports but does not clear',async()=>{
 markThrottled('codex','fixture',Date.now()+60_000);const events:boolean[]=[];setChangeListener(()=>events.push(true));
 try{
  const r=await request({provider:'codex',action:'recheck'},'POST','/api/provider-throttle',{...read,codex:async()=>({...await read.codex(),rows:[{label:'5h',value:'100% used'}]})});
  assert.equal(r.body.usage.status,'exhausted');assert.equal(r.body.usage.cleared,false);assert.equal(r.body.providers.codex.throttled,true);assert.equal(isAvailable('codex'),false);assert.deepEqual(events,[]);
 }finally{setChangeListener(null);markAvailable('codex');}
});
test('a newer limit that arrives during a headroom recheck is not cleared',async()=>{
 markThrottled('codex','before',Date.now()+60_000);
 try{
  const r=await request({provider:'codex',action:'recheck'},'POST','/api/provider-throttle',{...read,codex:async()=>{markThrottled('codex','new limit',Date.now()+90_000);return read.codex();}});
  assert.equal(r.body.usage.status,'headroom');assert.equal(r.body.usage.cleared,false);assert.match(r.body.usage.message,/newer limit/);
  assert.equal(isAvailable('codex'),false);assert.equal(getState('codex').lastError,'new limit');assert.equal(r.body.providers.codex.throttled,true);
 }finally{markAvailable('codex');}
});
test('stale, malformed, unavailable and failed meters remain unavailable, do not clear and preserve new errors',async()=>{
 markThrottled('codex','held',Date.now()+60_000);
 for(const sample of [{available:false},{...await read.codex(),stale:true},{...await read.codex(),rows:[{label:'5h',value:'unknown'}]}]){
  const r=await request({provider:'codex',action:'recheck'},'POST','/api/provider-throttle',{...read,codex:async()=>sample});assert.equal(r.body.usage.status,'unavailable');assert.equal(r.body.usage.cleared,false);assert.equal(isAvailable('codex'),false);assert.equal(getState('codex').lastError,'held');
 }
 markThrottled('codex','before',Date.now()+60_000);
 try{const r=await request({provider:'codex',action:'recheck'},'POST','/api/provider-throttle',{...read,codex:async()=>{markThrottled('codex','new limit',Date.now()+90_000);throw Error('fixture failure');}});assert.equal(r.body.usage.status,'unavailable');assert.equal(getState('codex').lastError,'new limit');}finally{markAvailable('codex');}
});
