import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installIsolatedTestHome} from '../testSupport/isolatedHome.js';
const root=mkdtempSync(join(tmpdir(),'arco-llama-lifetime-'));installIsolatedTestHome(root);process.env.ARCO_LLAMACPP_KEEPALIVE_MS='0';
const {llamacppManager:manager}=await import('./llamacppManager.js');
after(async()=>{await manager.shutdown();const stream=manager._getLogStream();if(stream)await new Promise<void>(resolve=>stream.end(resolve));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
function fakeChild(pid:number){
 const child=Object.assign(new EventEmitter(),{pid,exitCode:null as number|null,signalCode:null as string|null,stdout:new PassThrough(),stderr:new PassThrough(),kill(){queueMicrotask(()=>{child.exitCode=0;child.emit('exit',0,null);});return true;}});
 return child;
}
function fixtures(t:any){
 const children:ReturnType<typeof fakeChild>[]=[],args:string[][]=[],ports:number[]=[],health:string[]=[];
 t.mock.method(childProcess,'spawn',(_file:string,argv:string[])=>{args.push(argv);const child=fakeChild(10000+children.length);children.push(child);return child;});
 t.mock.method(childProcess,'execFile',(_file:string,argv:string[],_opts:any,callback:any)=>{ports.push(Number(argv.at(-1)?.replace(':','')));queueMicrotask(()=>callback(null,'',''));});
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 t.mock.method(globalThis,'fetch',async(url:string)=>{health.push(String(url));return Response.json({status:'ok'});});
 return {children,args,ports,health};
}
function catalog(extraArgs:string[]=[]){mkdirSync(process.env.ARCO_HOME!,{recursive:true});writeFileSync(join(process.env.ARCO_HOME!,'llamacpp.json'),JSON.stringify({models:[{alias:'fixture',ggufPath:'fixture.gguf',extraArgs}]}));}

test('a ready child exit invalidates its state and the next turn loads a replacement',async(t)=>{
 const f=fixtures(t);catalog();
 try{
  const first=await manager.ensureLoaded('fixture');const old=f.children[0];old.exitCode=2;old.emit('exit',2,null);
  assert.notEqual(manager.getStatus().state,'ready');
  assert.match(manager.getStatus().error??'',/exit/i);
  const second=await manager.ensureLoaded('fixture');assert.notEqual(second.pid,first.pid);assert.equal(f.children.length,2);
  old.emit('error',new Error('late old error'));assert.equal(manager.getStatus().pid,second.pid);
 }finally{await manager.shutdown();}
});

test('a ready child error invalidates readiness and remains owned until replacement',async(t)=>{
 const f=fixtures(t);catalog();
 try{await manager.ensureLoaded('fixture');const old=f.children[0];old.emit('error',new Error('fixture process error'));assert.equal(manager.getStatus().state,'failed');
 const replacement=await manager.ensureLoaded('fixture');assert.equal(old.exitCode,0);assert.equal(f.children.length,2);old.emit('error',new Error('late old error'));assert.equal(manager.getStatus().pid,replacement.pid);
 }finally{await manager.shutdown();}
});

test('exit during readiness promptly rejects and cannot publish a dead child as ready',async(t)=>{
 const f=fixtures(t);catalog();
 t.mock.method(globalThis,'fetch',async()=>{const child=f.children.at(-1)!;child.signalCode='SIGTERM';child.emit('exit',null,'SIGTERM');return Response.json({status:'ok'});});
 await assert.rejects(manager.ensureLoaded('fixture'),/exited/);assert.notEqual(manager.getStatus().state,'ready');
});
