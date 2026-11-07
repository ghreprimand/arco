import assert from 'node:assert/strict';
import { after,test } from 'node:test';
import { mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const root=mkdtempSync(join(tmpdir(),'arco-remote-cursor-'));installIsolatedTestHome(root);
const {getTranscript}=await import('./initHubLink.js');const {workflowCwds}=await import('../server/state.js');
after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
let serial=0;
function fixture(events:any[]){const id=`fixture-${++serial}`,cwd=join(root,id),dir=join(cwd,'.arco','workflows',id);mkdirSync(dir,{recursive:true});const path=join(dir,'events.jsonl');writeFileSync(path,events.map(e=>JSON.stringify(e)).join('\n')+'\n');workflowCwds.set(id,cwd);return{id,path};}
const read=(id:string,sinceTurn?:number,sinceSeq?:number)=>(getTranscript as any)(id,sinceTurn,sinceSeq);
test('incremental polling continues when the retained transcript reaches its 800-row cap',()=>{
 const events:any[]=[];for(let i=0;i<405;i++){events.push({type:'user_message_echo',seq:events.length+1,content:`prompt ${i}`},{type:'primary_text',seq:events.length+2,text:`answer ${i}`},{type:'primary_turn_ended',seq:events.length+3});}
 const f=fixture(events);const before=read(f.id);assert.equal(before.turns.length,800);
 const seq=events.length;appendFileSync(f.path,[{type:'user_message_echo',seq:seq+1,content:'latest prompt'},{type:'primary_text',seq:seq+2,text:'latest answer'},{type:'primary_turn_ended',seq:seq+3}].map(e=>JSON.stringify(e)).join('\n')+'\n');
 const next=read(f.id,before.totalTurns,before.cursor);assert.equal(next.turns.some((t:any)=>t.text==='latest prompt'),true);assert.equal(next.turns.some((t:any)=>t.text==='latest answer'),true);
 assert.ok(next.cursor>before.cursor);assert.ok(next.startCursor>before.startCursor);
});
test('a growing assistant row keeps its identity and is returned again with its complete current text',()=>{
 const f=fixture([{type:'user_message_echo',seq:1,content:'prompt'},{type:'primary_text',seq:2,text:'first'}]);const before=read(f.id);
 appendFileSync(f.path,JSON.stringify({type:'primary_text',seq:3,text:' second'})+'\n');const next=read(f.id,before.totalTurns,before.cursor);
 assert.equal(next.turns.length,1);assert.equal(next.turns[0].text,'first second');assert.equal(next.turns[0].seq,before.turns[1].seq);
});

test('event cursors continue after the byte-limited tail drops earlier rows',()=>{
 const events:any[]=[];for(let i=0;i<400;i++){events.push({type:'user_message_echo',seq:events.length+1,content:`prompt ${i} `+'u'.repeat(12000)},{type:'primary_text',seq:events.length+2,text:`answer ${i} `+'a'.repeat(12000)},{type:'primary_turn_ended',seq:events.length+3});}
 const f=fixture(events),before=read(f.id);assert.ok(before.turns.length<800);const at=events.length;
 appendFileSync(f.path,[{type:'system_notice',seq:at+1,content:'metadata '.repeat(20000)},{type:'user_message_echo',seq:at+2,content:'newest prompt'},{type:'primary_text',seq:at+3,text:'newest answer'},{type:'primary_turn_ended',seq:at+4}].map(e=>JSON.stringify(e)).join('\n')+'\n');
 const next=read(f.id,before.totalTurns,before.cursor);assert.ok(next.startCursor>before.startCursor);assert.equal(next.turns.some((t:any)=>t.text==='newest prompt'),true);assert.equal(next.turns.some((t:any)=>t.text==='newest answer'),true);
});
