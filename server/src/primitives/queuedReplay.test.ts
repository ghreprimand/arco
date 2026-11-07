import assert from 'node:assert/strict';
import { after,test } from 'node:test';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const root=mkdtempSync(join(tmpdir(),'arco-queued-replay-'));installIsolatedTestHome(root);
const {buildMessagesFromReplayEvents,replayMessagesWithResumePolicy}=await import('../providers/claude-native/resumeSummary.js');
const {buildReviewContent}=await import('./reviewContent.js');const {renderTranscript}=await import('./exportContext.js');const {parseRenderedTranscript}=await import('../providers/ollama.js');
after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
const echo=(content:string,id:string,extra:object={})=>({type:'user_message_echo',content,clientMessageId:id,...extra});
const text=(value:string)=>({type:'primary_text',phase:'passthrough',text:value});
const complete={type:'primary_complete'};
const start=(ids?:string[])=>({type:'primary_turn_started',...(ids?{inputClientMessageIds:ids}:{})});
const seq=(events:object[])=>events.map((event,index)=>({...event,seq:index+1,workflowId:'fixture'}));
const pairs=(events:any[])=>buildMessagesFromReplayEvents(events).map(m=>({role:m.role,content:typeof m.content==='string'?m.content:m.content.map(b=>b.text).join('')}));
for(const identified of [false,true])test(`queued follow-ups reconstruct their actual replies (${identified?'identified':'legacy'})`,async()=>{
 const events=seq([echo('FIRST_TASK','first',identified?{deliveryTracked:true}:{}),start(identified?['first']:undefined),text('FIRST_PART_A'),echo('FOLLOW_ONE','q1',{kind:'follow-up',...(identified?{deliveryTracked:true}:{})}),echo('FOLLOW_TWO','q2',{kind:'follow-up',...(identified?{deliveryTracked:true}:{})}),text('FIRST_PART_B'),complete,start(identified?['q1','q2']:undefined),text('ACTUAL_QUEUED_ANSWER'),complete]);
 assert.deepEqual(pairs(events),[{role:'user',content:'FIRST_TASK'},{role:'assistant',content:'FIRST_PART_AFIRST_PART_B'},{role:'user',content:'FOLLOW_ONE\n\nFOLLOW_TWO'},{role:'assistant',content:'ACTUAL_QUEUED_ANSWER'}]);
 const review=await buildReviewContent(events as any,root,{kind:'last-n',n:2},false);assert.equal(review.turnCount,2);for(const marker of ['FIRST_TASK','FIRST_PART_A','FIRST_PART_B','FOLLOW_ONE','FOLLOW_TWO','ACTUAL_QUEUED_ANSWER'])assert.ok(review.content.includes(marker),marker);
 const local=parseRenderedTranscript(renderTranscript(events as any));assert.equal(local.length,4);assert.equal(local[1].content,'FIRST_PART_AFIRST_PART_B');assert.equal(local[2].content,'FOLLOW_ONE\n\nFOLLOW_TWO');
});
test('legacy completed queued sequences without start markers still retain the original and actual queued answer',()=>{
 const events=seq([echo('first','a'),text('part A'),echo('queued','q',{kind:'follow-up'}),text('part B'),complete,text('queued answer'),complete]);
 assert.deepEqual(pairs(events),[{role:'user',content:'first'},{role:'assistant',content:'part Apart B'},{role:'user',content:'queued'},{role:'assistant',content:'queued answer'}]);
});
test('a steer moves at its delivery boundary, while review keeps the entire completed turn',async()=>{
 const events=seq([echo('FIRST_TASK','first',{deliveryTracked:true}),start(['first']),echo('STEER_TASK','s',{kind:'steer',deliveryTracked:true}),text('BEFORE_STEER'),{type:'turn_messages_delivered',clientMessageIds:['s']},text('AFTER_STEER'),complete]);
 assert.deepEqual(pairs(events),[{role:'user',content:'FIRST_TASK'},{role:'assistant',content:'BEFORE_STEER'},{role:'user',content:'STEER_TASK'},{role:'assistant',content:'AFTER_STEER'}]);
 const review=await buildReviewContent(events as any,root,{kind:'last-turn'},false);assert.equal(review.turnCount,1);for(const marker of ['FIRST_TASK','STEER_TASK','BEFORE_STEER','AFTER_STEER'])assert.ok(review.content.includes(marker),marker);
});
test('cancelled queued input never replaces the prompt of the turn still finishing',()=>{
 const events=seq([echo('FIRST_TASK','first',{deliveryTracked:true}),start(['first']),text('part A'),echo('CANCELLED_TASK','q',{kind:'follow-up',deliveryTracked:true}),{type:'queued_message_cancelled',clientMessageId:'q'},text('part B'),complete]);
 assert.deepEqual(pairs(events),[{role:'user',content:'FIRST_TASK'},{role:'assistant',content:'part Apart B'}]);
});
test('exact-tail replay resolves a combined delivery whose queued echoes are in the summarized prefix',async()=>{
 const cwd=join(root,'tail'),dir=join(cwd,'.arco','workflows','fixture');mkdirSync(dir,{recursive:true});
 const events=seq([echo('FIRST_TASK','first',{deliveryTracked:true}),start(['first']),text('FIRST_PART_A'),echo('FOLLOW_ONE','q1',{kind:'follow-up',deliveryTracked:true}),echo('FOLLOW_TWO','q2',{kind:'follow-up',deliveryTracked:true}),text('FIRST_PART_B'),complete,start(['q1','q2']),text('ACTUAL_QUEUED_ANSWER'),complete]);
 writeFileSync(join(dir,'events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
 const replay=await replayMessagesWithResumePolicy(cwd,'fixture',undefined,{exactReplayBytes:100,recentTailBytes:100});
 assert.equal(replay.messages.at(-2)?.content,'FOLLOW_ONE\n\nFOLLOW_TWO');assert.match(JSON.stringify(replay.messages.at(-1)),/ACTUAL_QUEUED_ANSWER/);
 const cacheFile=join(dir,'resume-summary.json'),cache=JSON.parse(readFileSync(cacheFile,'utf8'));cache.version=2;cache.summary='STALE_QUEUED_CACHE';writeFileSync(cacheFile,JSON.stringify(cache));
 const again=await replayMessagesWithResumePolicy(cwd,'fixture',undefined,{exactReplayBytes:100,recentTailBytes:100});assert.doesNotMatch(JSON.stringify(again.messages),/STALE_QUEUED_CACHE/);
});

test('a delayed steer acknowledgement remains anchored to its original execution',()=>{
 const events=seq([echo('FIRST_TASK','first',{deliveryTracked:true}),start(['first']),echo('STEER_TASK','s',{kind:'steer',deliveryTracked:true}),text('BEFORE_STEER'),{type:'queued_messages_drained',clientMessageIds:['s'],deliveryId:'attempt'},text('AFTER_STEER'),complete,echo('NEW_TASK','new',{deliveryTracked:true}),start(['new']),text('NEW_ANSWER'),{type:'turn_messages_delivered',clientMessageIds:['s'],deliveryId:'attempt'},complete]);
 assert.deepEqual(pairs(events),[{role:'user',content:'FIRST_TASK'},{role:'assistant',content:'BEFORE_STEER'},{role:'user',content:'STEER_TASK'},{role:'assistant',content:'AFTER_STEER'},{role:'user',content:'NEW_TASK'},{role:'assistant',content:'NEW_ANSWER'}]);
});

test('malformed optional delivery metadata does not block later valid turns',()=>{
 const events=seq([echo('legacy first','first'),{type:'primary_turn_started',inputClientMessageIds:'invalid'},text('first answer'),complete,{type:'turn_messages_delivered',clientMessageIds:'invalid'},echo('valid next','next',{deliveryTracked:true}),start(['next']),text('next answer'),complete]);
 assert.doesNotThrow(()=>pairs(events));assert.deepEqual(pairs(events),[{role:'user',content:'legacy first'},{role:'assistant',content:'first answer'},{role:'user',content:'valid next'},{role:'assistant',content:'next answer'}]);
});

test('a late acknowledgement in the tail does not inject an earlier steer into the new summarized execution',async()=>{
 const cwd=join(root,'late-tail'),dir=join(cwd,'.arco','workflows','fixture');mkdirSync(dir,{recursive:true});
 const events=seq([echo('FIRST_TASK','first',{deliveryTracked:true}),start(['first']),echo('STEER_TASK','s',{kind:'steer',deliveryTracked:true}),text('BEFORE_STEER'),{type:'queued_messages_drained',clientMessageIds:['s'],deliveryId:'attempt'},text('AFTER_STEER'),complete,echo('NEW_TASK','new',{deliveryTracked:true}),start(['new']),text('NEW_ANSWER'),{type:'turn_messages_delivered',clientMessageIds:['s'],deliveryId:'attempt'},complete]);
 writeFileSync(join(dir,'events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
 const replay=await replayMessagesWithResumePolicy(cwd,'fixture',undefined,{exactReplayBytes:100,recentTailBytes:100});assert.equal(replay.messages.at(-2)?.content,'NEW_TASK');assert.match(JSON.stringify(replay.messages.at(-1)),/NEW_ANSWER/);assert.ok(JSON.stringify(replay.messages[0]).includes('STEER_TASK'));
});

test('steering before the first visible reply preserves both instructions',async()=>{
 const events=seq([echo('FIRST_TASK','first',{deliveryTracked:true}),start(['first']),echo('STEER_TASK','s',{kind:'steer',deliveryTracked:true}),{type:'primary_thinking',text:'fixture thinking'},{type:'turn_messages_delivered',clientMessageIds:['s']},text('DONE'),complete]);
 assert.deepEqual(pairs(events),[{role:'user',content:'FIRST_TASK\n\nSTEER_TASK'},{role:'assistant',content:'DONE'}]);const review=await buildReviewContent(events as any,root,{kind:'last-turn'},false);assert.ok(review.content.includes('FIRST_TASK')&&review.content.includes('STEER_TASK'));
});
test('an unanswered cancelled dispatch does not merge into a later ordinary prompt',()=>{
 const events=seq([echo('CANCELLED_TASK','old',{deliveryTracked:true}),start(['old']),{type:'turn_cancelled'},{type:'primary_turn_ended'},echo('NEW_TASK','new',{deliveryTracked:true}),start(['new']),text('NEW_ANSWER'),complete]);assert.deepEqual(pairs(events),[{role:'user',content:'NEW_TASK'},{role:'assistant',content:'NEW_ANSWER'}]);
});
