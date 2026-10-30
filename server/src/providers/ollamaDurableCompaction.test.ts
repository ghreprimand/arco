import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { WorkerConfig } from '@arco/shared';
import type { OllamaHistoryEvent } from './ollamaExecutionHistory.js';
const root=mkdtempSync(join(tmpdir(),'arco-ollama-durable-'));
installIsolatedTestHome(root);
const { compactDurableOllama }=await import('./ollamaDurableCompaction.js');
const { readOllamaBoundary,saveOllamaBoundary,ollamaProjectDigest }=await import('./ollamaBoundaryStore.js');
const { OllamaWorkerProcess,parseRenderedTranscript }=await import('./ollama.js');
const { projectOllamaHistory }=await import('./ollamaExecutionHistory.js');
const { renderTranscript }=await import('../primitives/exportContext.js');
const { defaultCompactionConfig }=await import('./ollamaRecovery.js');
after(()=>rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
let fixtureCount=0;
function fixture(turnCount=12) {
 const cwd=join(root,`project-${++fixtureCount}`),workflowId='fixture';mkdirSync(cwd,{recursive:true});
 const events:OllamaHistoryEvent[]=[];const add=(e:object)=>events.push({workflowId,seq:events.length+1,...e} as OllamaHistoryEvent);
 for(let i=0;i<turnCount;i++) {
  const input=events.length+1;
  add({type:'user_message_echo',content:`prompt ${i} `+'word '.repeat(150),ollamaReplayInput:true,clientMessageId:`i${i}`});
  add({type:'primary_turn_started',ollamaExecutionId:`t${i}`,ollamaInputSeqs:[input]});
  add({type:'primary_text',phase:'passthrough',text:`answer ${i} `+'text '.repeat(150),ollamaExecutionId:`t${i}`});
  add({type:'primary_complete',ollamaExecutionId:`t${i}`});
  add({type:'primary_turn_ended',ollamaExecutionId:`t${i}`});
 }
 const activeInputSeqs=[events.length+1];add({type:'user_message_echo',content:'current input',ollamaReplayInput:true,clientMessageId:'current'});
 let owner=true, summaries=0;const notices:string[]=[];
 const context={events,activeInputSeqs,policy:{enabled:true,thresholdPercent:50},stillOwner:()=>owner};
 const prepare=()=>[{role:'system' as const,content:'fixture system'},...parseRenderedTranscript(renderTranscript(projectOllamaHistory(events,workflowId,activeInputSeqs).events,{preserveThinking:true})),{role:'user' as const,content:'current input'}];
 const config={...defaultCompactionConfig(),keepLastMessages:2};
 const args={context,cwd,workflowId,config,window:4000,parse:parseRenderedTranscript,estimate:(messages: Array<{content?:string}>)=>messages.reduce((n,m)=>n+(m.content?.length??0)/4,0),summarize:async()=>{summaries++;return {text:'synthetic summary',source:'fixture'};},emit:(notice:string)=>notices.push(notice)};
 return {args,prepare,events,notices,revoke:()=>{owner=false;},summaries:()=>summaries};
}
test('summary survives a fresh process and raw events remain unchanged',async()=>{
 const f=fixture(),raw=JSON.stringify(f.events),messages=f.prepare();
 await compactDurableOllama({...f.args,messages});
 const saved=readOllamaBoundary(f.args.cwd,'fixture');assert.ok(saved);assert.equal(f.summaries(),1);
 assert.equal(messages.filter(m=>m.content.includes('synthetic summary')).length,1);assert.equal(messages.at(-1)?.content,'current input');assert.equal(JSON.stringify(f.events),raw);
 const restarted=f.prepare();await compactDurableOllama({...f.args,messages:restarted});assert.deepEqual(restarted,messages);assert.equal(f.summaries(),1);
 const code=`const input=JSON.parse(process.argv[1]);const {compactDurableOllama}=await import('./server/src/providers/ollamaDurableCompaction.ts');const {parseRenderedTranscript}=await import('./server/src/providers/ollama.ts');await compactDurableOllama({...input,parse:parseRenderedTranscript,estimate:messages=>messages.reduce((n,m)=>n+(m.content?.length??0)/4,0),summarize:()=>{throw Error('restart must reuse the saved summary');},emit:()=>{},context:{...input.context,stillOwner:()=>true}});process.stdout.write(JSON.stringify(input.messages));`;
 const input={cwd:f.args.cwd,workflowId:'fixture',context:f.args.context,messages:f.prepare(),config:f.args.config,window:4000};
 const child=spawnSync(process.execPath,['--conditions','development','--import','tsx','--input-type=module','-e',code,JSON.stringify(input)],{cwd:process.cwd(),env:process.env,encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),messages);
});
test('legacy identity, changed source and unknown context never publish guessed summaries',async()=>{
 for(const mode of ['legacy','unknown','changed']) {
  const f=fixture();if(mode==='changed')await compactDurableOllama({...f.args,messages:f.prepare()});
  const before=readOllamaBoundary(f.args.cwd,'fixture');
  if(mode==='legacy')delete f.events[0].ollamaReplayInput;
  if(mode==='changed')Object.assign(f.events[2],{text:'changed source'});
  const messages=f.prepare();await compactDurableOllama({...f.args,messages,window:mode==='unknown'?undefined:4000});
  assert.deepEqual(readOllamaBoundary(f.args.cwd,'fixture'),before);assert.equal(messages.some(m=>m.content.includes('synthetic summary')),false);
 }
});
test('STOP while summary is pending cannot publish or install a boundary',async()=>{
 const f=fixture(),messages=f.prepare(),raw=JSON.stringify(messages);let finish!:(x:{text:string;source:string})=>void;
 const waiting=new Promise<{text:string;source:string}>(resolve=>{finish=resolve;});
 const pending=compactDurableOllama({...f.args,messages,summarize:()=>waiting});f.revoke();finish({text:'cancelled',source:'fixture'});await pending;
 assert.equal(readOllamaBoundary(f.args.cwd,'fixture'),null);assert.equal(JSON.stringify(messages),raw);assert.equal(f.notices.some(n=>n.startsWith('ollama_compacted:')),false);
});
test('failed save and ineffective summary cannot create retry loops',async()=>{
 const f=fixture();let attempts=0;
 const summarize=async()=>{attempts++;return {text:'large '.repeat(10000),source:'fixture'};};
 await compactDurableOllama({...f.args,messages:f.prepare(),summarize});await compactDurableOllama({...f.args,messages:f.prepare(),summarize});assert.equal(attempts,1);
 const bad=fixture();const messages=bad.prepare(),raw=JSON.stringify(messages);
 // Invalid bounded summary is refused by the store, without altering messages.
 let failed=0;const fail=async()=>{failed++;return {text:'',source:'fixture'};};
 await compactDurableOllama({...bad.args,messages,summarize:fail});await compactDurableOllama({...bad.args,messages:bad.prepare(),summarize:fail});
 assert.equal(failed,1);assert.equal(JSON.stringify(messages),raw);assert.equal(readOllamaBoundary(bad.args.cwd,'fixture'),null);
});
test('newer boundary, project and workflow identities are enforced',async()=>{
 const f=fixture();await compactDurableOllama({...f.args,messages:f.prepare()});const saved=readOllamaBoundary(f.args.cwd,'fixture')!;
 assert.equal(await saveOllamaBoundary(f.args.cwd,{...saved,throughSeq:saved.throughSeq-1},()=>true),false);
 assert.equal(await saveOllamaBoundary(f.args.cwd,{...saved,throughSeq:saved.throughSeq+1},()=>false),false);
 const other=fixture();const file=join('.arco','workflows','fixture','ollama-compact-boundary.json');mkdirSync(join(other.args.cwd,'.arco','workflows','fixture'),{recursive:true});copyFileSync(join(f.args.cwd,file),join(other.args.cwd,file));
 assert.equal(readOllamaBoundary(other.args.cwd,'fixture'),null);assert.equal(readOllamaBoundary(f.args.cwd,'other'),null);
 assert.notEqual(ollamaProjectDigest(f.args.cwd),ollamaProjectDigest(other.args.cwd));
 const newer={...saved,throughSeq:saved.throughSeq+10};await Promise.all([saveOllamaBoundary(f.args.cwd,newer,()=>true),saveOllamaBoundary(f.args.cwd,{...saved,throughSeq:saved.throughSeq+2},()=>true)]);
 assert.equal(readOllamaBoundary(f.args.cwd,'fixture')?.throughSeq,newer.throughSeq);
 assert.ok(readFileSync(join(f.args.cwd,file),'utf8').includes('synthetic summary'));
});
test('real Ollama pre-dispatch path honors enabled and explicit off policies using cached metadata only',async()=>{
 const f=fixture();const config={provider:'ollama',model:'fixture',effort:'medium',cwd:f.args.cwd,workflowId:'fixture',ollamaReplay:f.args.context} as WorkerConfig;
 const worker=new OllamaWorkerProcess('fixture',config) as unknown as {maybeCompact:(...args:unknown[])=>Promise<void>;produceCompactionSummary:()=>Promise<{text:string;source:string}>};
 worker.produceCompactionSummary=async()=>({text:'adapter summary',source:'fixture'});
 const cache=()=>({modelCache:new Map(),showCache:new Map([['fixture',{numCtx:4000}]]),resolvedModelByBase:new Map([['fixture','fixture']]),lastChosen:null});
 const messages=f.prepare();await worker.maybeCompact(messages,undefined,[{baseUrl:'fixture'}],{},cache());assert.ok(readOllamaBoundary(f.args.cwd,'fixture'));
 const off=fixture();off.args.context.policy.enabled=false;const disabled=new OllamaWorkerProcess('off',{...config,cwd:off.args.cwd,ollamaReplay:off.args.context}) as unknown as typeof worker;
 disabled.produceCompactionSummary=async()=>{throw Error('explicit Off must never summarize');};await disabled.maybeCompact(off.prepare(),undefined,[{baseUrl:'fixture'}],{},cache());assert.equal(readOllamaBoundary(off.args.cwd,'fixture'),null);
});

test('filesystem save failure leaves request and raw history unchanged',async()=>{
 const f=fixture(),messages=f.prepare(),raw=JSON.stringify(messages),events=JSON.stringify(f.events);
 mkdirSync(join(f.args.cwd,'.arco','workflows','fixture','ollama-compact-boundary.json'),{recursive:true});
 await compactDurableOllama({...f.args,messages});
 assert.equal(JSON.stringify(messages),raw);assert.equal(JSON.stringify(f.events),events);
 assert.equal(readOllamaBoundary(f.args.cwd,'fixture'),null);assert.ok(f.notices.some(n=>n.includes('failed to save')));assert.equal(f.notices.some(n=>n.startsWith('ollama_compacted:')),false);
});

test('durable prefix replacement preserves retained native tool pairs and current input',async()=>{
 const f=fixture(),messages=f.prepare();
 const call={role:'assistant' as const,content:'',tool_calls:[{function:{name:'fixture',arguments:{value:'x'}}}]};
 const result={role:'tool' as const,content:'result'};messages.splice(-1,0,call,result);
 await compactDurableOllama({...f.args,messages});
 assert.ok(readOllamaBoundary(f.args.cwd,'fixture'));assert.deepEqual(messages.slice(-3),[call,result,{role:'user',content:'current input'}]);
});

test('long histories select a closed prefix without rebuilding every candidate transcript',async()=>{
 const f=fixture(512);let parses=0;
 await compactDurableOllama({...f.args,messages:f.prepare(),parse:(text)=>{parses++;return parseRenderedTranscript(text);}});
 assert.ok(readOllamaBoundary(f.args.cwd,'fixture'));assert.ok(parses<20,`prefix parsing must stay bounded; saw ${parses}`);
});
