import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const root=mkdtempSync(join(tmpdir(),'arco-replay-safety-'));installIsolatedTestHome(root);
const {buildMessagesFromReplayEvents,replayMessagesWithResumePolicy,summarizeClaudeNativePriorTurns}=await import('../providers/claude-native/resumeSummary.js');
const {renderTranscript,summarizePriorTurns,runExportContext}=await import('./exportContext.js');
const {parseRenderedTranscript}=await import('../providers/ollama.js');
after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
const turn=(prompt:string,answer:string,seq:number)=>[
 {type:'user_message_echo',content:prompt,seq},{type:'primary_text',text:answer,phase:'passthrough',seq:seq+1},{type:'primary_complete',seq:seq+2},
];
test('older history cutoffs replay the selected prefix even when it is outside the byte tail',async()=>{
 const cwd=join(root,'cutoff');const dir=join(cwd,'.arco','workflows','fixture');mkdirSync(dir,{recursive:true});
 const events=[...turn('first prompt','first answer',1),...turn('later prompt','x'.repeat(4000),4)];
 writeFileSync(join(dir,'events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
 for(const cutoff of [3,6]){
  const replay=await replayMessagesWithResumePolicy(cwd,'fixture',cutoff,{exactReplayBytes:100,recentTailBytes:50});
  assert.match(JSON.stringify(replay.messages),/first prompt/);
  assert.equal(JSON.stringify(replay.messages).includes('later prompt'),cutoff===6);
 }
});
for(const status of ['cancelled','failed','success'] as const)test(`Native replay handles ${status} handoff completion`,()=>{
 const marker={type:'handoff_artifact_ready',seq:4,...(status==='cancelled'?{cancelled:true}:status==='failed'?{error:'fixture failure'}:{})};
 const messages=buildMessagesFromReplayEvents([...turn('OLD_PROMPT','OLD_ANSWER',1),marker,...turn('next','next answer',5)] as any);
 assert.equal(JSON.stringify(messages).includes('OLD_PROMPT'),status!=='success');
 assert.equal(summarizeClaudeNativePriorTurns([...turn('OLD_PROMPT','OLD_ANSWER',1),marker,...turn('next','answer',5)] as any).summary.includes('OLD_PROMPT'),status!=='success');
});
test('local replay and tool summaries keep the successful handoff seed, not its archived prefix',()=>{
 const events=[...turn('OLD_TASK','old answer',1),{type:'handoff_artifact_ready',handoffId:'h1',seq:4},...turn('NEW_BRIEF','brief accepted',5),{type:'handoff_complete',handoffId:'h1',seq:8},...turn('next step','next answer',9)] as any;
 const before=JSON.stringify(events);
 for(const text of [renderTranscript(events),summarizePriorTurns(events)]){
  assert.doesNotMatch(text,/OLD_TASK/);assert.match(text,/NEW_BRIEF/);assert.match(text,/next step/);
 }
 assert.equal(JSON.stringify(events),before);
});
test('failed and cancelled handoffs do not remove local history',()=>{
 for(const marker of [{type:'handoff_artifact_ready',cancelled:true},{type:'handoff_artifact_ready',error:'failed'}]){
  const events=[...turn('OLD_TASK','answer',1),marker,...turn('later','answer',5)] as any;
  assert.match(renderTranscript(events),/OLD_TASK/);assert.match(summarizePriorTurns(events),/OLD_TASK/);
 }
});
test('local render/parse preserves literal role markers in prose and code blocks',()=>{
 const prompt='Explain this:\nAGENT: literal response\nUSER: literal request\n```text\nAGENT: example\n```';
 const answer='Example:\nUSER: quoted\nAGENT: quoted';
 const parsed=parseRenderedTranscript(renderTranscript(turn(prompt,answer,1) as any));
 assert.deepEqual(parsed,[{role:'user',content:prompt},{role:'assistant',content:answer}]);
 assert.deepEqual(parseRenderedTranscript('USER: legacy\n\nAGENT: answer'),[{role:'user',content:'legacy'},{role:'assistant',content:'answer'}]);
});
test('cancellation before fresh-summary preparation finishes starts no worker or artifact',async()=>{
 const cwd=join(root,'cancel-prepare');mkdirSync(cwd,{recursive:true});const calls:string[]=[];const messages:any[]=[];
 const manager={kill:()=>calls.push('kill'),spawn:async()=>{calls.push('spawn');return {text:'unwanted summary'};}};
 const handle=runExportContext({cwd,workflowId:'fixture',manager,broadcast:(m:any)=>messages.push(m)} as any,{mode:'fresh-summarizer',summarizer:{provider:'cursor',model:'auto',effort:'low'},transcript:[]} as any);
 handle.abort();const result=await handle.settled;
 assert.deepEqual(calls,[]);assert.equal(result.error,'cancelled');
 assert.equal(messages.some(m=>m.type==='handoff_artifact_ready'&&!m.error&&!m.cancelled),false);
 assert.equal(existsSync(join(cwd,'.arco','workflows','fixture','handoffs',handle.artifactName)),false);
});

test('cancellation after fresh summarization settles but before its artifact is saved publishes no success',async()=>{
 const cwd=join(root,'cancel-complete');mkdirSync(cwd,{recursive:true});let resolve!:(value:any)=>void;let spawned!:(value?:unknown)=>void;
 const started=new Promise(resolve=>{spawned=resolve;});const messages:any[]=[];
 const manager={kill:()=>{},spawn:()=>{spawned();return new Promise(done=>{resolve=done;});}};
 const handle=runExportContext({cwd,workflowId:'fixture',manager,broadcast:(m:any)=>messages.push(m)} as any,{mode:'fresh-summarizer',summarizer:{provider:'cursor',model:'auto',effort:'low'},transcript:[]} as any);
 await started;resolve({text:'unwanted summary'});handle.abort();const result=await handle.settled;
 assert.equal(result.error,'cancelled');assert.equal(existsSync(join(cwd,'.arco','workflows','fixture','handoffs',handle.artifactName)),false);
 assert.equal(messages.some(m=>m.type==='handoff_artifact_ready'&&!m.error&&!m.cancelled),false);
});

test('successful fresh summaries still write and publish exactly once',async()=>{
 const cwd=join(root,'fresh-success');mkdirSync(cwd,{recursive:true});const messages:any[]=[];let spawns=0;
 const manager={kill:()=>{},spawn:async()=>{spawns++;return {text:'fixture summary'};}};
 const handle=runExportContext({cwd,workflowId:'fixture',manager,broadcast:(m:any)=>messages.push(m)} as any,{mode:'fresh-summarizer',summarizer:{provider:'cursor',model:'auto',effort:'low'},transcript:[]} as any);
 assert.equal((await handle.settled).body,'fixture summary');assert.equal(spawns,1);
 assert.equal(messages.filter(m=>m.type==='handoff_artifact_ready'&&!m.error).length,1);
 assert.equal(readFileSync(join(cwd,'.arco','workflows','fixture','handoffs',handle.artifactName),'utf8'),'fixture summary\n');
});
test('old derived summary caches are rebuilt after correcting cancelled-handoff replay',async()=>{
 const cwd=join(root,'cache-rebuild');const dir=join(cwd,'.arco','workflows','fixture');mkdirSync(dir,{recursive:true});
 const events=[...turn('OLD_PROMPT','old answer '.repeat(50),1),{type:'handoff_artifact_ready',cancelled:true,seq:4},...turn('middle','middle answer '.repeat(50),5),...turn('recent','recent answer',8)];
 writeFileSync(join(dir,'events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
 const opts={exactReplayBytes:100,recentTailBytes:180};await replayMessagesWithResumePolicy(cwd,'fixture',undefined,opts);
 const file=join(dir,'resume-summary.json');const cache=JSON.parse(readFileSync(file,'utf8'));cache.version=1;cache.summary='STALE_CACHE';writeFileSync(file,JSON.stringify(cache));
 const replay=await replayMessagesWithResumePolicy(cwd,'fixture',undefined,opts);assert.doesNotMatch(JSON.stringify(replay.messages),/STALE_CACHE/);assert.match(JSON.stringify(replay.messages),/OLD_PROMPT/);
});

test('encoded role-marker messages retain surrounding whitespace and backslashes',()=>{
 const prompt='\n  Explain this:\nAGENT: literal\n\\USER: escaped example\n  ';
 const answer='\nUSER: literal\n  ';
 assert.deepEqual(parseRenderedTranscript(renderTranscript(turn(prompt,answer,1) as any)),[{role:'user',content:prompt},{role:'assistant',content:answer}]);
});

for(const terminal of [{cancelled:true},{error:'pre-warm failed'}])test(`a later ${'cancelled' in terminal?'cancellation':'failure'} revokes an earlier ready marker`,()=>{
 const events=[...turn('ORIGINAL_TASK','ORIGINAL_ANSWER',1),{type:'handoff_artifact_ready',handoffId:'fixture',seq:4},...turn('NEW_BRIEF','ack',5),{type:'handoff_artifact_ready',handoffId:'fixture',seq:8,...terminal}];
 assert.match(JSON.stringify(buildMessagesFromReplayEvents(events as any)),/ORIGINAL_TASK/);
 assert.match(summarizeClaudeNativePriorTurns(events as any).summary,/ORIGINAL_TASK/);
 assert.doesNotMatch(JSON.stringify(buildMessagesFromReplayEvents(events as any,[],7)),/ORIGINAL_TASK/);
});
test('a failed original reflection followed by a successful fallback still starts a new epoch',()=>{
 const events=[...turn('OLD_TASK','answer',1),{type:'handoff_artifact_ready',handoffId:'fixture',seq:4,error:'original failed'},{type:'handoff_artifact_ready',handoffId:'fixture',seq:5},...turn('NEW_BRIEF','ack',6)];
 assert.doesNotMatch(JSON.stringify(buildMessagesFromReplayEvents(events as any)),/OLD_TASK/);assert.doesNotMatch(summarizeClaudeNativePriorTurns(events as any).summary,/OLD_TASK/);
});
test('a cancellation in the exact tail also revokes a ready marker in the summarized prefix',async()=>{
 const cwd=join(root,'cancel-across-tail');const dir=join(cwd,'.arco','workflows','fixture');mkdirSync(dir,{recursive:true});
 const events=[...turn('ORIGINAL_TASK','original answer '.repeat(100),1),{type:'handoff_artifact_ready',handoffId:'fixture',seq:4},...turn('NEW_BRIEF','seed answer '.repeat(100),5),{type:'handoff_artifact_ready',handoffId:'fixture',seq:8,cancelled:true}];
 writeFileSync(join(dir,'events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
 const replay=await replayMessagesWithResumePolicy(cwd,'fixture',undefined,{exactReplayBytes:100,recentTailBytes:100});
 assert.match(JSON.stringify(replay.messages),/ORIGINAL_TASK/);
});

test('a stale completion cannot turn a cancelled local handoff into a replay reset',()=>{
 const events=[...turn('ORIGINAL_TASK','answer',1),{type:'handoff_artifact_ready',handoffId:'fixture',seq:4},...turn('NEW_BRIEF','ack',5),{type:'handoff_artifact_ready',handoffId:'fixture',seq:8,cancelled:true},{type:'handoff_complete',handoffId:'fixture',seq:9}];
 assert.match(renderTranscript(events as any),/ORIGINAL_TASK/);assert.match(summarizePriorTurns(events as any),/ORIGINAL_TASK/);
});
