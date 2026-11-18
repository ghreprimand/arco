import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import type { WorkerConfig } from '@arco/shared';
import { CodexAppServerWorker, bootstrapSurfaceKey } from './worker.js';
const config={provider:'codex',model:'fixture',effort:'low'} as WorkerConfig;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('late turn/start acknowledgements cannot resurrect completed turns',async()=>{
 const worker=new CodexAppServerWorker('fixture',config,'thread');const w=worker as any;let turns=0;
 w.rpc={request:async()=>{const id=`turn-${++turns}`;w.onNotification({method:'turn/started',params:{threadId:'thread',turn:{id}}});w.onNotification({method:'turn/completed',params:{threadId:'thread',turn:{id,status:'completed'}}});return {turn:{id}};}};
 w.threadId='thread';
 await worker.beginTurn('one',undefined);await tick();
 assert.equal(w.current.turnId,null);await worker.beginTurn('two',undefined);assert.equal(turns,2);
});
test('generated image persistence and terminal status finish before turn settlement',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'arco-image-settle-'));const worker=new CodexAppServerWorker('fixture',{...config,cwd},'thread');const w=worker as any;w.threadId='thread';Object.assign(w.current,{turnId:'turn',startedAt:Date.now()});
 let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});const events:string[]=[];
 const save=w.writeGeneratedImage.bind(w);w.writeGeneratedImage=async(...args:any[])=>{await pending;return save(...args);};let artifactPath='';
 worker.on('primary_artifact',(artifact:any)=>{artifactPath=artifact.path;events.push('artifact');});worker.on('tool_use',()=>events.push('tool'));worker.on('turn_settled',()=>events.push('settled'));
 w.onNotification({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'imageGeneration',id:'image',status:'completed',result:Buffer.from('fixture-image').toString('base64'),revisedPrompt:null}}});
 w.onNotification({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
 const settled=new Promise(resolve=>worker.once('turn_settled',resolve));
 try{await tick();assert.deepEqual(events,[]);release();await settled;assert.deepEqual(events,['artifact','tool','settled']);assert.equal(readFileSync(join(cwd,artifactPath),'utf8'),'fixture-image');}
 finally{release();rmSync(cwd,{recursive:true,force:true});}
});
test('app-server launch includes enabled registry definitions and recycles on definition changes',async(t)=>{
 const registry={key:'reg-fixture',command:'fixture-mcp',args:['first'],env:{FIXTURE:'value'}};
 const cfg={...config,mcpRegistryServers:[registry]};const worker=new CodexAppServerWorker('fixture',cfg,'thread');let args:string[]=[];
 t.mock.method(childProcess,'spawn',(_bin:any,argv:any)=>{args=argv;throw new Error('fixture captured');});syncBuiltinESMExports();
 try{await assert.rejects(worker.ensureStarted(),/fixture captured/);assert.match(args.join(' '),/reg-fixture/);assert.match(args.join(' '),/fixture-mcp/);
 assert.notEqual(bootstrapSurfaceKey(cfg),bootstrapSurfaceKey({...cfg,mcpRegistryServers:[{...registry,args:['second']}]}));
 assert.doesNotMatch(bootstrapSurfaceKey(cfg),/value/);
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('a late acknowledgement cannot replace the id of a newer turn',async()=>{
 const worker=new CodexAppServerWorker('fixture',config,'thread');const w=worker as any;let release!:(value:any)=>void;let count=0;
 w.threadId='thread';w.rpc={request:()=>++count===1?new Promise(resolve=>{release=resolve;}):Promise.resolve({turn:{id:'new'}})};
 const old=worker.beginTurn('old',undefined);
 w.onNotification({method:'turn/started',params:{threadId:'thread',turn:{id:'old'}}});w.onNotification({method:'turn/completed',params:{threadId:'thread',turn:{id:'old',status:'completed'}}});
 await worker.beginTurn('new',undefined);release({turn:{id:'old'}});await old;assert.equal(w.current.turnId,'new');
});

test('a settled turn keeps its command completion when a newer turn is listening', async () => {
  const worker = new CodexAppServerWorker('fixture', config, 'thread');
  const w = worker as any;
  w.threadId = 'thread';
  Object.assign(w.current, { turnId: 'first', startedAt: Date.now() });
  const foreground: string[] = [];
  const terminal: Array<{ state: string; id: string; exit?: number }> = [];
  const listener = (event: { itemId: string }) => foreground.push(event.itemId);
  worker.on('tool_use', listener);
  worker.on('late_command', (event, marker) => terminal.push({ state: marker.state, id: event.itemId, exit: event.exitCode }));
  worker.once('turn_settled', () => worker.off('tool_use', listener));
  const item = { type: 'commandExecution', id: 'shell', command: 'npm run build', cwd: '.', aggregatedOutput: null, exitCode: null };
  const notify = (method: string, turnId: string, item: object) => w.onNotification({ method, params: { threadId: 'thread', turnId, item } });
  notify('item/started', 'first', item);
  w.onNotification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'first', status: 'completed' } } });
  assert.deepEqual(worker.runningLateCommands.map(command => command.itemId), ['shell']);
  Object.assign(w.current, { turnId: 'next', startedAt: Date.now() });
  worker.on('tool_use', listener);
  notify('item/completed', 'first', { ...item, exitCode: 0, aggregatedOutput: 'Built' });
  assert.deepEqual(foreground, ['shell']);
  assert.deepEqual(terminal, [
    { state: 'running', id: 'shell', exit: undefined },
    { state: 'finished', id: 'shell', exit: 0 },
  ]);
  assert.deepEqual(worker.runningLateCommands, []);
});
