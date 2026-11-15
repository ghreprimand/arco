import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installIsolatedTestHome} from '../testSupport/isolatedHome.js';
const root=mkdtempSync(join(tmpdir(),'arco-remote-compact-'));installIsolatedTestHome(root);
const {snapshotWorkflows,applyAction}=await import('./initHubLink.js');
const {workflows}=await import('../server/state.js');
after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
test('every advertised Cursor compact action reaches the ordinary handler',async()=>{
 const id='fixture-remote-cursor',events:any[]=[];
 let finish!:()=>void;const settled=new Promise<void>(resolve=>{finish=resolve;});
 const wf={config:{name:'Fixture Cursor',workingDirectory:root,remoteEnabled:true,incognito:true},primary:{provider:'cursor',model:'fixture'},busy:false,queue:{steering:[],followUp:[]},observers:new Set([{readyState:1,bufferedAmount:0,send:(raw:string)=>{const event=JSON.parse(raw);events.push(event);if(event.type==='primary_turn_ended')finish();}}])} as any;
 workflows.set(id,wf);
 try{
  assert.equal(snapshotWorkflows().find(w=>w.workflowId===id)?.canCompact,true);
  const result=await applyAction({type:'compact',workflowId:id},'fixture-action');
  assert.equal(result.ok,true,JSON.stringify(result));
  // The remote action acknowledges dispatch; the handler can still be reading history.
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([settled,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Cursor compact did not settle: '+JSON.stringify(events))),5000);})]);}
  finally{if(timer)clearTimeout(timer);}
  assert.ok(events.some(e=>e.type==='ctx_action'&&e.action==='compact'),JSON.stringify(events));
  assert.ok(events.some(e=>e.type==='system_notice'&&/no saved Cursor session/.test(e.content)),JSON.stringify(events));
  wf.busy=true;assert.equal((await applyAction({type:'compact',workflowId:id},'busy')).error,'busy');
 }finally{workflows.delete(id);}
});
