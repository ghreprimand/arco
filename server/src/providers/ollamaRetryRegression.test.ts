import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const home = mkdtempSync(join(tmpdir(), 'arco-retry-'));
installIsolatedTestHome(home);
after(() => rmSync(home, {recursive:true,force:true}));
const { OllamaWorkerProcess } = await import('./ollama.js');
import { classifyOllamaError } from './ollamaResilience.js';
import { subsetOllamaTools } from './ollamaToolSubset.js';
import { getOllamaToolDefinitions, executeOllamaTool } from './ollamaTools.js';
import type { WorkerConfig } from '@arco/shared';

function fixture(windows = [8192]) {
  const backends = windows.map((_, i) => ({ baseUrl: `http://fixture-${i}.invalid`, label: `fixture-${i}`, weight: 1 }));
  const ctx = { modelCache: new Map(backends.map(b => [b.baseUrl, ['fixture']])), showCache: new Map(backends.map((b,i) => [b.baseUrl, {numCtx:windows[i], capabilities:[]} ])), resolvedModelByBase: new Map(backends.map(b => [b.baseUrl,'fixture'])), lastChosen:null };
  // Exercise the real retry path with a synthetic transport, without network I/O.
  const worker = new OllamaWorkerProcess('fixture', { provider:'ollama', model:'fixture', effort:'medium', ollamaParams:{num_ctx:2048} } as WorkerConfig) as any;
  worker.rng=()=>0;
  worker.on('error',()=>{});
  return {worker,ctx,backends, run:()=>worker.streamWithFailover(backends,{},[{role:'user',content:'fixture'}],undefined,ctx,false)};
}
const success = () => ({ok:true,assistantMessage:{role:'assistant',content:'answer',tool_calls:[{function:{name:'Read',arguments:{file_path:'fixture'}}}]},usage:{inputTokens:1,outputTokens:1,durationMs:1,genSpeed:null},sawDone:true});
const overflow = () => ({ok:false,error:new Error('input length exceeds context window'),httpStatus:400});

test('B103 successful larger context survives the next tool round',async()=>{
  const f=fixture();const windows:unknown[]=[];
  f.worker.streamOneTurn=async(...args:unknown[])=>{windows.push(args[7]);return windows.length===1?overflow():success();};
  await f.run();await f.run();assert.deepEqual(windows,[undefined,8192,8192]);
});
test('B103 peer escalation sends its larger window despite a small preset',async()=>{
  const f=fixture([2048,16384]);const calls:Array<{base:string;window:unknown}>=[];
  f.worker.streamOneTurn=async(...args:any[])=>{calls.push({base:args[0],window:args[7]});return calls.length===1?overflow():success();};
  await f.run();assert.equal(calls[1].window,16384);
});
test('B105 a sole backend is retried after a transient failure',async()=>{
  const f=fixture();let calls=0;
  f.worker.streamOneTurn=async()=>++calls===1?{ok:false,error:new Error('temporary'),httpStatus:503}:success();
  assert.equal((await f.run())?.ok,true);assert.equal(calls,2);
});
test('B106 nested fetch DNS errors retain the resolver discriminator',()=>{
  for(const code of ['ENOTFOUND','EAI_AGAIN'])assert.equal(classifyOllamaError(new TypeError('fetch failed',{cause:{code}})).reason,'DNS resolution failed');
  assert.match(classifyOllamaError(new TypeError('fetch failed',{cause:{code:'ECONNRESET'}})).reason,/connection/);
});
test('B107 only explicit context errors widen the window',()=>{
  for(const message of ['model does not support tools','invalid parameter num_predict','invalid request shape'])assert.equal(classifyOllamaError(new Error(message),400).contextOverflow,undefined);
  assert.equal(classifyOllamaError(new Error('input length exceeds context window'),400).contextOverflow,true);
});
test('B108 default cluster subset retains action and research tools',()=>{
  const result=subsetOllamaTools({tools:getOllamaToolDefinitions({clusterEnabled:true}),clusterMember:true,taskContext:'Write files and research the web with WebSearch and WebFetch'});
  for(const name of ['Write','WebSearch','WebFetch','peer_read','peer_send'])assert.ok(result.kept.includes(name),name);
});
test('B109 confirmed peer send preserves the guard handshake',async(t)=>{
  const bodies:any[]=[];
  t.mock.method(globalThis,'fetch',async(_url:unknown,opts:any)=>{const body=JSON.parse(opts.body);bodies.push(body);return new Response(JSON.stringify(body.confirm?{ok:true}:{status:'status_confirmation'}));});
  const ctx={cwd:'.',workflowId:'fixture',clusterId:'cluster'} as any;
  await executeOllamaTool('peer_send',{to:'reviewer',content:'DONE'},ctx);
  await executeOllamaTool('peer_send',{to:'reviewer',content:'DONE',confirm:true},ctx);
  assert.equal(bodies.length,2);assert.equal(bodies[0].confirm,undefined);assert.equal(bodies[1].confirm,true);
  const def=getOllamaToolDefinitions({clusterEnabled:true}).find(t=>t.function.name==='peer_send')!;
  assert.ok(def.function.parameters.properties.confirm);
});

test('B104 rejected structured synthesis returns the completed free-text review',async()=>{
  const f=fixture();f.worker.config.ollamaFormat={type:'object'};
  f.worker.maybeCompact=async()=>{};
  const real=f.worker.streamWithFailover.bind(f.worker);
  f.worker.streamWithFailover=(_b:unknown,_m:unknown,messages:unknown,tools:unknown,_ctx:unknown,first:unknown,format:unknown,terminal:unknown)=>real(f.backends,{},messages,tools,f.ctx,first,format,terminal);
  let calls=0;const results:any[]=[];const errors:string[]=[];const notices:string[]=[];
  f.worker.on('result',(r:any)=>results.push(r));f.worker.on('error',(e:string)=>errors.push(e));f.worker.on('system_notice',(n:string)=>notices.push(n));
  f.worker.streamOneTurn=async()=>{
    if(++calls===1){f.worker._output='VERDICT: PASS\nThe reviewed change is sound.';return {...success(),assistantMessage:{role:'assistant',content:f.worker._output}};}
    return {ok:false,error:new Error('format is unsupported'),httpStatus:422};
  };
  await f.worker.run('Review the change');
  assert.equal(results.length,1);assert.match(results[0].text,/VERDICT: PASS/);assert.deepEqual(errors,[]);assert.ok(notices.some(n=>/fallback/i.test(n)));
});

test('B105 repeated failures stop at the backend retry budget',async()=>{
  const f=fixture();let calls=0;f.worker.streamOneTurn=async()=>{calls++;return {ok:false,error:new Error('temporary'),httpStatus:503};};
  assert.equal(await f.run(),null);assert.equal(calls,3);
});
test('B107 unrelated validation failure is surfaced without an escalation request',async()=>{
  const f=fixture();let calls=0;const errors:string[]=[];f.worker.on('error',(error:string)=>errors.push(error));
  f.worker.streamOneTurn=async()=>{calls++;return {ok:false,error:new Error('model does not support tools'),httpStatus:400};};
  assert.equal(await f.run(),null);assert.equal(calls,1);assert.deepEqual(errors,['model does not support tools']);
});
