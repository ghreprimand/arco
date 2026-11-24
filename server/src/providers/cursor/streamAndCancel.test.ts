import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import type { WorkerConfig } from '@arco/shared';
import { AcpJsonRpcClient } from '../acp/acpJsonRpc.js';
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

test('ACP answers a permission request with a string JSON-RPC id', async () => {
 const stdin = new PassThrough(), stdout = new PassThrough();
 const rpc = new AcpJsonRpcClient(stdin, stdout); let reply = '';
 stdin.on('data', chunk => { reply += chunk.toString(); });
 rpc.onRequest = () => ({ outcome: { outcome: 'cancelled' } });
 stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: {} }) + '\n');
 await tick();
 assert.deepEqual(JSON.parse(reply), { jsonrpc: '2.0', id: 'permission-1', result: { outcome: { outcome: 'cancelled' } } });
 rpc.close();
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

test('ACP permissions wait for a decision, respect skip-permissions and refuse scheduling', async () => {
 const { requestAcpPermission, resolveAcpPermission, cancelAcpPermissions } = await import('../acp/permissionGate.js');
 const options = [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }];
 const params = { toolCall: { title: 'Run command', rawInput: { command: 'printf fixture' } }, options };
 assert.deepEqual(await requestAcpPermission('fixture', params, true), { outcome: { outcome: 'selected', optionId: 'yes' } });
 assert.deepEqual(await requestAcpPermission('fixture', { ...params, toolCall: { title: 'schedule task' } }, true), { outcome: { outcome: 'selected', optionId: 'no' } });
 let settled = false;
 const blocked = requestAcpPermission('fixture', params).then(value => { settled = true; return value; });
 await tick(); assert.equal(settled, false);
 assert.equal(resolveAcpPermission('fixture', 'unknown', 'approve', false), false);
 cancelAcpPermissions('fixture');
 assert.deepEqual(await blocked, { outcome: { outcome: 'selected', optionId: 'no' } });
});

test('stopping an Antigravity turn ends the ACP child process', { skip: process.platform === 'win32' && 'The agy fixture is a POSIX script and cannot be spawned on Windows.' }, async t => {
 const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
 const { tmpdir } = await import('node:os');
 const { join } = await import('node:path');
 const { AntigravityProvider } = await import('../antigravity/index.js');
 const dir = mkdtempSync(join(tmpdir(), 'arco-agy-stop-'));
 const root = join(dir, 'state'); mkdirSync(root);
 // The turn probes `agy --version` before it starts ACP; answer that at once.
 const bin = join(dir, 'agy'); writeFileSync(bin, '#!/bin/sh\n[ "$1" = --version ] && { echo 1.0.0; exit 0; }\nsleep 30\n'); chmodSync(bin, 0o755);
 const priorPath = process.env.PATH, priorHome = process.env.ARCO_HOME;
 process.env.PATH = `${dir}:${priorPath}`; process.env.ARCO_HOME = root;
 let pid: number | undefined;
 t.after(() => { process.env.PATH = priorPath; process.env.ARCO_HOME = priorHome; if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } rmSync(dir, { recursive: true, force: true }); });
 const proc = AntigravityProvider.create('fixture', { provider: 'antigravity-cli', model: 'gemini-fixture', effort: 'low', cwd: dir, workflowId: 'fixture', interactionMode: 'agent', antigravityInteractive: true });
 proc.on('error', () => {}); proc.spawn('fixture');
 const deadline = Date.now() + 5000;
 while (!proc.pid && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
 pid = proc.pid; assert.ok(pid, 'ACP process started');
 proc.kill();
 const alive = () => { try { process.kill(pid!, 0); return true; } catch { return false; } };
 while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
 assert.equal(alive(), false, 'ACP process exits after STOP');
});

test('Antigravity does not stream session-load history as a new answer', { skip: process.platform === 'win32' && 'The agy fixture is a POSIX script and cannot be spawned on Windows.' }, async t => {
 const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
 const { tmpdir } = await import('node:os');
 const { join } = await import('node:path');
 const { AntigravityProvider } = await import('../antigravity/index.js');
 const dir = mkdtempSync(join(tmpdir(), 'arco-agy-replay-')); const root = join(dir, 'state'); mkdirSync(root);
 const bin = join(dir, 'agy');
 writeFileSync(bin, `#!/usr/bin/env node\nconst rl=require('readline').createInterface({input:process.stdin});const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='session/load'){send({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{text:'old answer'}}}});send({jsonrpc:'2.0',id:m.id,result:{sessionId:'fixture',configOptions:[{id:'model',options:[{value:'gemini-fixture'}]},{id:'mode',options:[{value:'default'}]}]}})}else if(m.method==='session/prompt'){send({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{text:'new answer'}}}});send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})}else send({jsonrpc:'2.0',id:m.id,result:{}})});`); chmodSync(bin, 0o755);
 const priorPath = process.env.PATH, priorHome = process.env.ARCO_HOME; process.env.PATH = `${dir}:${priorPath}`; process.env.ARCO_HOME = root;
 t.after(() => { process.env.PATH = priorPath; process.env.ARCO_HOME = priorHome; rmSync(dir, { recursive: true, force: true }); });
 const proc = AntigravityProvider.create('fixture', { provider:'antigravity-cli',model:'gemini-fixture',effort:'low',cwd:dir,workflowId:'fixture',interactionMode:'agent',antigravityInteractive:true,resumeSessionId:'fixture' });
 const chunks: string[] = []; proc.on('text', text => chunks.push(text));
 const result = new Promise<void>((resolve, reject) => { proc.once('result', () => resolve()); proc.once('error', reject); });
 proc.spawn('next'); await result; assert.deepEqual(chunks, ['new answer']);
});

test('Antigravity refuses noninteractive, non-Gemini and Arco-home launches', async t => {
 const { AntigravityProvider } = await import('../antigravity/index.js');
 const { mkdtempSync, rmSync } = await import('node:fs');
 const { tmpdir } = await import('node:os');
 const { join } = await import('node:path');
 const home = mkdtempSync(join(tmpdir(), 'arco-agy-home-')), previous = process.env.ARCO_HOME;
 process.env.ARCO_HOME = home;
 t.after(() => { if (previous === undefined) delete process.env.ARCO_HOME; else process.env.ARCO_HOME = previous; rmSync(home, { recursive: true, force: true }); });
 const base = { provider:'antigravity-cli', model:'gemini-fixture', effort:'low', cwd:home, workflowId:'fixture', interactionMode:'agent', antigravityInteractive:true } as WorkerConfig;
 const failure = async (config: WorkerConfig) => {
   const proc = AntigravityProvider.create('fixture', config);
   const error = new Promise<string>(resolve => proc.once('error', resolve)); proc.spawn('fixture');
   return error;
 };
 assert.match(await failure({ ...base, antigravityInteractive:false }), /interactive/);
 assert.match(await failure({ ...base, model:'claude-fixture' }), /Gemini/);
 assert.match(await failure(base), /Arco home/);
});

test('Antigravity sends the submitted text and attachment without Arco prompt instructions', { skip: process.platform === 'win32' && 'The agy fixture is a POSIX script and cannot be spawned on Windows.' }, async t => {
 const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } = await import('node:fs');
 const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
 const { AntigravityProvider } = await import('../antigravity/index.js');
 const dir = mkdtempSync(join(tmpdir(), 'arco-agy-prompt-')), root = join(dir, 'state'); mkdirSync(root);
 const attachment = join(dir, 'note.txt'), capture = join(dir, 'prompt.json'); writeFileSync(attachment, 'ATTACHMENT CONTENT');
 const bin = join(dir, 'agy'); writeFileSync(bin, `#!${process.execPath}\nconst fs=require('fs');const rl=require('readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);let result={};if(m.method==='session/new')result={sessionId:'s',configOptions:[{id:'model',options:[{value:'gemini-fixture'}]},{id:'mode',options:[{value:'default'}]}]};if(m.method==='session/prompt'){fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(m.params.prompt));result={stopReason:'end_turn'}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`); chmodSync(bin,0o755);
 const priorPath=process.env.PATH, priorHome=process.env.ARCO_HOME;process.env.PATH=`${dir}:${priorPath}`;process.env.ARCO_HOME=root;
 t.after(()=>{process.env.PATH=priorPath;process.env.ARCO_HOME=priorHome;rmSync(dir,{recursive:true,force:true});});
 const { WorkerManager } = await import('../../workers/WorkerManager.js');
 const manager = new WorkerManager();
 const result = await manager.spawn({id:'fixture',task:'  OPERATOR TEXT\n',provider:'antigravity-cli',model:'gemini-fixture',effort:'low',appendSystemPrompt:'HIDDEN ARCO INSTRUCTIONS'} as any,()=>{}, {cwd:dir,workflowId:'prompt-fixture',interactionMode:'agent',antigravityInteractive:true,outputStyle:'terse',attachments:[attachment]});
 assert.equal(result.error, undefined);
 const sent=JSON.parse(readFileSync(capture,'utf8'));assert.equal(sent[0].text,'  OPERATOR TEXT\n');assert.match(sent[1].text,/ATTACHMENT CONTENT/);assert.doesNotMatch(JSON.stringify(sent),/HIDDEN ARCO INSTRUCTIONS/);
});

test('Antigravity passes scoped MCP servers to new and resumed ACP sessions', { skip: process.platform === 'win32' && 'The agy fixture is a POSIX script and cannot be spawned on Windows.' }, async t => {
 const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } = await import('node:fs');
 const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
 const { AntigravityProvider } = await import('../antigravity/index.js');
 const dir=mkdtempSync(join(tmpdir(),'arco-agy-mcp-')), root=join(dir,'state');mkdirSync(root);const capture=join(dir,'sessions.jsonl');
 const bin=join(dir,'agy');writeFileSync(bin, `#!${process.execPath}\nconst fs=require('fs');const rl=require('readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);let result={};if(m.method==='session/new'||m.method==='session/load'){fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({method:m.method,params:m.params})+'\\n');result={sessionId:'s',configOptions:[{id:'model',options:[{value:'gemini-fixture'}]},{id:'mode',options:[{value:'default'}]}]}}if(m.method==='session/prompt')result={stopReason:'end_turn'};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`);chmodSync(bin,0o755);
 const priorPath=process.env.PATH,priorHome=process.env.ARCO_HOME;process.env.PATH=`${dir}:${priorPath}`;process.env.ARCO_HOME=root;
 t.after(()=>{process.env.PATH=priorPath;process.env.ARCO_HOME=priorHome;rmSync(dir,{recursive:true,force:true});});
 for(const resumeSessionId of [undefined,'previous']){const proc=AntigravityProvider.create('fixture',{provider:'antigravity-cli',model:'gemini-fixture',effort:'low',cwd:dir,workflowId:'mcp-fixture',interactionMode:'agent',antigravityInteractive:true,resumeSessionId} as WorkerConfig);const done=new Promise<void>((resolve,reject)=>{proc.once('result',()=>resolve());proc.once('error',reject)});proc.spawn('hello');await done;}
 const rows=readFileSync(capture,'utf8').trim().split('\n').map(line => JSON.parse(line));assert.deepEqual(rows.map((r:any)=>r.method),['session/new','session/load']);for(const row of rows){assert.equal(row.params.mcpServers.length,1);assert.equal(row.params.mcpServers[0].type,'http');assert.match(row.params.mcpServers[0].url,/\/mcp\/[0-9a-f]{32}$/);}
});
