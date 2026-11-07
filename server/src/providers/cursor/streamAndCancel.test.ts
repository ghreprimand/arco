import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import type { WorkerConfig } from '@arco/shared';
import { AcpJsonRpcClient } from './acpJsonRpc.js';
import { CursorPrintProvider } from './print.js';
import { CursorAcpWorker } from './worker.js';
const config={provider:'cursor',model:'auto',effort:'low'} as WorkerConfig;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('ACP preserves UTF-8 at every byte split in text and filenames',()=>{
 const frame=Buffer.from(JSON.stringify({jsonrpc:'2.0',method:'fixture',params:{text:'café 日本語',file:'résumé.ts'}})+'\n');
 for(let split=1;split<frame.length;split++){
  const stdin=new PassThrough(),stdout=new PassThrough();const rpc=new AcpJsonRpcClient(stdin,stdout);let result:any;
  rpc.on('notification',n=>{result=n.params;});stdout.write(frame.subarray(0,split));stdout.write(frame.subarray(split));
  assert.deepEqual(result,{text:'café 日本語',file:'résumé.ts'});rpc.close();
 }
});
test('print mode decodes streamed multibyte text without changing result or deltas',t=>{
 const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
 t.mock.method(childProcess,'spawn',()=>child);syncBuiltinESMExports();
 try{const proc=CursorPrintProvider.create('fixture',config);const chunks:string[]=[];let result:any;proc.on('text',t=>chunks.push(t));proc.on('result',r=>{result=r;});proc.spawn('fixture');
 const text='café 日本語';const buf=Buffer.from(text);for(const byte of buf)child.stdout.write(Buffer.from([byte]));child.emit('exit',0,null);child.emit('close',0,null);
 assert.equal(chunks.join(''),text);assert.equal(result.text,text);
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
test('cancelled Cursor compression settles its cancellation timer before a later turn',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});const worker=new CursorAcpWorker('fixture',config,undefined);const w=worker as any;let release!:(value:any)=>void;let kills=0;
 Object.assign(w,{bootstrapped:true,sessionId:'session',rpc:{request:()=>new Promise(resolve=>{release=resolve;}),notify:()=>{}},applyModelIfChanged:async()=>{},hardKill:()=>{kills++;}});
 const compact=worker.compressConversation();await tick();let cancelled=false;const cancel=worker.cancelCurrentTurn().then(()=>{cancelled=true;});
 release({stopReason:'cancelled'});await compact;await tick();assert.equal(cancelled,true);
 w.turnActive=true;t.mock.timers.tick(5001);await cancel;assert.equal(kills,0);assert.equal(w.turnActive,true);
});
