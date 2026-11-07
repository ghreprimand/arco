import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkerConfig } from '@arco/shared';
import { CodexAppServerWorker } from './worker.js';
for(const fails of [false,true])test(`a late steer ${fails?'failure':'acknowledgement'} keeps the dispatching callbacks`,async()=>{
 let oldDelivered=0,newDelivered=0,oldQueued=0,newQueued=0;
 const config={provider:'codex',model:'fixture',effort:'low',onSteerDelivered:()=>oldDelivered++,requeueSteer:()=>oldQueued++} as WorkerConfig;
 const worker=new CodexAppServerWorker('fixture',config,'thread'),w=worker as any;const notices:string[]=[];worker.on('system_notice',notice=>notices.push(notice));let resolve!:(value:any)=>void,reject!:(error:Error)=>void;
 w.threadId='thread';Object.assign(w.current,{turnId:'old',startedAt:Date.now()});const original=w.current;
 w.rpc={request:()=>new Promise((done,fail)=>{resolve=done;reject=fail;})};
 const pending=w.dispatchSteer([{content:'fixture input',clientMessageId:'input'}]);
 worker.updateConfig({...config,onSteerDelivered:()=>newDelivered++,requeueSteer:()=>newQueued++});w.current={...w.current,turnId:'new',steerCount:0};
 if(fails)reject(new Error('fixture failure'));else resolve({turnId:'old'});await pending;
 assert.equal(newDelivered,0);assert.equal(newQueued,0);assert.equal(fails?oldQueued:oldDelivered,1);assert.equal(w.current.steerCount,0);assert.equal(notices.length,0);if(!fails)assert.equal(original.steerCount,1);
});
