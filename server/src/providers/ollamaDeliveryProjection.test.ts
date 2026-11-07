import assert from 'node:assert/strict';
import { after,test } from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const root=mkdtempSync(join(tmpdir(),'arco-ollama-delivery-'));installIsolatedTestHome(root);
const {projectOllamaHistory}=await import('./ollamaExecutionHistory.js');const {renderTranscript}=await import('../primitives/exportContext.js');const {parseRenderedTranscript}=await import('./ollama.js');
after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
const echo=(content:string,id:string,extra:object={})=>({type:'user_message_echo',content,clientMessageId:id,ollamaReplayInput:true,deliveryTracked:true,...extra});
const start={type:'primary_turn_started',ollamaExecutionId:'turn',ollamaInputSeqs:[1],inputClientMessageIds:['first']};
const text=(value:string)=>({type:'primary_text',text:value,phase:'passthrough',ollamaExecutionId:'turn'});
const complete={type:'primary_complete',ollamaExecutionId:'turn'};const end={type:'primary_turn_ended',ollamaExecutionId:'turn'};
const rows=(events:object[])=>events.map((e,i)=>({...e,workflowId:'fixture',seq:i+1})) as any[];
test('materialized Ollama executions remain readable through the common transcript renderer',()=>{
 const events=rows([echo('FIRST_TASK','first'),start,text('answer'),complete,end,echo('NEXT_TASK','next')]);const projected=projectOllamaHistory(events,'fixture',[6]);
 assert.equal(projected.valid,true);assert.deepEqual(parseRenderedTranscript(renderTranscript(projected.events)),[{role:'user',content:'FIRST_TASK'},{role:'assistant',content:'answer'}]);
});
test('accepted Ollama steering remains inside its completed execution and its compaction cut',()=>{
 const events=rows([echo('FIRST_TASK','first'),start,echo('STEER_TASK','steer',{kind:'steer'}),text('BEFORE_STEER'),{type:'turn_messages_delivered',deliveryId:'attempt',clientMessageIds:['steer']},{type:'queued_messages_drained',deliveryId:'attempt',clientMessageIds:['steer']},text('AFTER_STEER'),complete,end,echo('NEXT_TASK','next')]);const raw=JSON.stringify(events);
 const projected=projectOllamaHistory(events,'fixture',[10]);assert.equal(projected.valid,true);assert.equal(projected.cuts.length,1);
 const expected=[{role:'user',content:'FIRST_TASK'},{role:'assistant',content:'BEFORE_STEER'},{role:'user',content:'STEER_TASK'},{role:'assistant',content:'AFTER_STEER'}];
 assert.deepEqual(parseRenderedTranscript(renderTranscript(projected.events)),expected);assert.deepEqual(parseRenderedTranscript(renderTranscript(projected.cuts[0].events)),expected);assert.equal(JSON.stringify(events),raw);
});
