import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {installIsolatedTestHome} from './testSupport/isolatedHome.js';
const root=mkdtempSync(join(tmpdir(),'arco-busy-reminder-'));installIsolatedTestHome(root);
const store=await import('./clusterStore.js'),mail=await import('./clusterMailbox.js'),auto=await import('./clusterAutoTurn.js'),smart=await import('./smartPickup.js');
after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
async function fixture(){const cwd=join(root,randomUUID());mkdirSync(cwd);const a=randomUUID(),b=randomUUID();const cluster=await store.createCluster({cwd,memberWorkflowIds:[a,b]});return{cluster,a,b};}
async function send(a:string,b:string,content='Implement the fixture task'){await mail.enqueue(b,{msgId:mail.mintMsgId(),fromWorkflowId:a,fromDisplayName:'Fixture sender',toWorkflowId:b,content,createdAt:new Date().toISOString(),delivered:false});}
const settle=()=>new Promise(resolve=>setTimeout(resolve,30));

test('busy-reminder choice is off by default and survives mode changes and state echoes',async()=>{
 const {cluster}=await fixture();
 assert.equal((await smart.autoPickupStateFor(cluster) as any).remindBusy,false);
 await smart.applyAutoPickup(cluster.clusterId,{mode:'rule',remindBusy:true} as any,()=>true);
 assert.equal((await store.readCluster(cluster.clusterId) as any).remindBusy,true);
 assert.equal((await smart.autoPickupStateFor((await store.readCluster(cluster.clusterId))!) as any).remindBusy,true);
 await smart.applyAutoPickup(cluster.clusterId,{mode:'off'},()=>true);
 assert.equal((await store.readCluster(cluster.clusterId) as any).remindBusy,true);
 await smart.applyAutoPickup(cluster.clusterId,{mode:'rule',remindBusy:false} as any,()=>true);
 assert.equal((await store.readCluster(cluster.clusterId) as any).remindBusy,false);
});

test('busy reminders send once per unread batch and respect the five-minute gap',async(t)=>{
 const {cluster,a,b}=await fixture();let now=1_900_000_000_000;const sent:string[]=[];let busy=true,idleWakes=0;
 t.mock.method(Date,'now',()=>now);
 auto.configure({broadcastWorkflow:()=>{},isBusy:()=>busy,dispatchAutoTurn:()=>{assert.equal(busy,false);idleWakes++;},dispatchBusyReminder:async(_id:string,content:string)=>{sent.push(content);return true;}} as any);
 await store.setAutoPickup(cluster.clusterId,{mode:'rule',remindBusy:true} as any);
 const trigger=()=>auto.onPeerMessageSent({clusterId:cluster.clusterId,senderWfid:a,recipientWfid:b,incomingChainDepth:0});
 await send(a,b);trigger();trigger();await settle();assert.equal(sent.length,1);assert.match(sent[0],/You are currently working/);
 now+=300000;trigger();await settle();assert.equal(sent.length,1,'same unread batch remains suppressed after the gap');
 await send(a,b,'Second task');now+=1;trigger();await settle();assert.equal(sent.length,2);
 await send(a,b,'Third task');now+=299999;trigger();await settle();assert.equal(sent.length,2);
 now+=1;trigger();await settle();assert.equal(sent.length,3);
 busy=false;trigger();await settle();assert.equal(idleWakes,1);
});

test('acknowledgement-only mail, Off, Observe-only and expired Smart sessions never remind',async(t)=>{
 const {cluster,a,b}=await fixture();const sent:string[]=[];
 auto.configure({broadcastWorkflow:()=>{},isBusy:()=>true,dispatchAutoTurn:()=>assert.fail('must not wake'),dispatchBusyReminder:async(_id:string,content:string)=>{sent.push(content);return true;}} as any);
 const trigger=()=>auto.onPeerMessageSent({clusterId:cluster.clusterId,senderWfid:a,recipientWfid:b,incomingChainDepth:0});
 await store.setAutoPickup(cluster.clusterId,{mode:'rule',remindBusy:true} as any);
 await send(a,b,'Acknowledged.');trigger();await settle();assert.equal(sent.length,0);
 await send(a,b);for(const mode of ['off','smart-observe','smart-auto'] as const){await store.setAutoPickup(cluster.clusterId,{mode,remindBusy:true,evaluator:{provider:'cursor',model:'fixture'},now:mode==='smart-auto'?0:Date.now()} as any);trigger();await settle();assert.equal(sent.length,0,mode);}
 await store.setAutoPickup(cluster.clusterId,{mode:'smart-auto',remindBusy:true,evaluator:{provider:'cursor',model:'fixture'}} as any);trigger();await settle();assert.equal(sent.length,1);
});

test('turning pickup off while a reminder prepares prevents its queue admission',async()=>{
 const {cluster,a,b}=await fixture();let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);let admitted=false;
 auto.configure({broadcastWorkflow:()=>{},isBusy:()=>true,dispatchAutoTurn:()=>assert.fail('must not wake'),dispatchBusyReminder:async(_id:string,_content:string,allow:()=>boolean)=>{entered();await hold;admitted=allow();return admitted;}} as any);
 await store.setAutoPickup(cluster.clusterId,{mode:'rule',remindBusy:true} as any);await send(a,b);
 auto.onPeerMessageSent({clusterId:cluster.clusterId,senderWfid:a,recipientWfid:b,incomingChainDepth:0});await ready;
 await store.setAutoPickup(cluster.clusterId,{mode:'off'});release();await settle();assert.equal(admitted,false);
});

test('the periodic sweep retries new mail held by the gap, without repeating the previous batch',async(t)=>{
 const {cluster,a,b}=await fixture();let now=1_950_000_000_000,sends=0;
 t.mock.method(Date,'now',()=>now);t.mock.timers.enable({apis:['setInterval']});
 auto.configure({broadcastWorkflow:()=>{},isBusy:()=>true,resolveMembers:()=>new Map([[cluster.clusterId,[{workflowId:b,busy:true}]]]),dispatchAutoTurn:()=>assert.fail('must not wake'),dispatchBusyReminder:async()=>{sends++;return true;}} as any);
 await store.setAutoPickup(cluster.clusterId,{mode:'rule',remindBusy:true} as any);await send(a,b);
 auto.onPeerMessageSent({clusterId:cluster.clusterId,senderWfid:a,recipientWfid:b,incomingChainDepth:0});await settle();assert.equal(sends,1);
 await send(a,b,'New task during cooldown');now+=1;auto.start();
 try{t.mock.timers.tick(5000);await settle();assert.equal(sends,1);now+=300000;t.mock.timers.tick(5000);await settle();assert.equal(sends,2);now+=300000;t.mock.timers.tick(5000);await settle();assert.equal(sends,2);}
 finally{auto.stop();}
});
