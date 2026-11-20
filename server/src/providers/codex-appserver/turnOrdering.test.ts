import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import type { SteerItem, WorkerConfig } from '@arco/shared';
import { CodexAppServerWorker, bootstrapSurfaceKey } from './worker.js';
import { CodexAppServerProvider, CodexAppServerTurn, disposeCodexAppServerWorker } from './index.js';
import { HELD_BATCH_MS, HELD_WAIT_LIMIT_MS } from './heldCommands.js';
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

// docs/PROVIDERS.md - a Codex turn that ends while a command it started is
// still running stays open, and the command's result continues the agent.
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
function heldTurn(extra: Partial<WorkerConfig> = {}) {
  const cfg = { ...config, ...extra } as WorkerConfig;
  const worker = new CodexAppServerWorker('fixture', cfg, 'thread');
  const w = worker as any;
  w.threadId = 'thread';
  worker.ensureStarted = async () => {};
  worker.prepareIsolatedTurn = async () => {};
  const starts: string[] = []; const steers: string[] = []; const markers: Array<{ id: string; state: string; waiting?: boolean }> = [];
  const text = (params: any) => params.input.map((part: any) => part.text ?? '').join('\n');
  w.rpc = { request: async (method: string, params: any) => {
    if (method === 'turn/start') { starts.push(text(params)); return { turn: { id: `turn-${starts.length}` } }; }
    if (method === 'turn/steer') { steers.push(text(params)); return { turnId: params.expectedTurnId }; }
    return {};
  } };
  worker.on('late_command', (event, marker) => markers.push({ id: event.itemId, state: marker.state, ...(marker.waiting ? { waiting: true } : {}) }));
  const turn = new CodexAppServerTurn('turn', worker, cfg, undefined, 'fixture');
  const results: any[] = []; const errors: string[] = []; const notices: string[] = [];
  turn.on('result', result => results.push(result)); turn.on('error', error => errors.push(error)); turn.on('system_notice', notice => notices.push(notice));
  const notify = (method: string, params: object) => w.onNotification({ method, params: { threadId: 'thread', ...params } });
  const command = (turnId: string, id: string, line: string, done?: { exitCode: number; output: string }) => notify(done ? 'item/completed' : 'item/started', { turnId, item: {
    type: 'commandExecution', id, command: line, cwd: '/work', processId: null, source: 'agent', status: done ? 'completed' : 'inProgress',
    commandActions: [], aggregatedOutput: done ? done.output : null, exitCode: done ? done.exitCode : null, durationMs: null } });
  const finalAnswer = (turnId: string) => notify('item/started', { turnId, item: { type: 'agentMessage', id: `final-${turnId}`, text: '', phase: 'final_answer', memoryCitation: null } });
  const complete = (turnId: string) => notify('turn/completed', { turn: { id: turnId, status: 'completed', items: [], error: null } });
  const failAuth = (turnId: string) => notify('turn/completed', { turn: { id: turnId, status: 'failed', items: [], error: { message: 'unauthorized', codexErrorInfo: 'unauthorized' } } });
  turn.spawn('work');
  return { worker, turn, starts, steers, markers, results, errors, notices, command, finalAnswer, complete, failAuth };
}

test('a Codex researcher retries one authentication failure before reporting it', async () => {
  const h = heldTurn({ clusterAccessMode: 'researcher' });
  await settle();
  h.failAuth('turn-1'); await settle();
  assert.equal(h.starts.length, 2);
  assert.match(h.starts[1], /Continue the task without repeating completed tool actions/);
  assert.deepEqual(h.errors, []);
  assert.equal(h.notices.some(notice => notice.startsWith('[AUTH:codex]')), false);
  h.failAuth('turn-2'); await settle();
  assert.equal(h.starts.length, 2);
  assert.equal(h.errors.length, 1);
});

test('a command that outlives its Codex turn continues the agent once with its result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = heldTurn(); await settle();
  h.command('turn-1', 'build', 'npm run build'); h.command('turn-1', 'check', 'npm run check'); h.complete('turn-1'); await settle();
  assert.equal(h.results.length, 0, 'the Arco turn stays open while the command runs');
  assert.ok(h.markers.some(marker => marker.id === 'build' && marker.waiting));
  h.command('turn-1', 'build', 'npm run build', { exitCode: 0, output: 'built\n' });
  h.command('turn-1', 'check', 'npm run check', { exitCode: 0, output: 'checked\n' });
  t.mock.timers.tick(HELD_BATCH_MS); await settle();
  assert.equal(h.starts.length, 2);
  assert.match(h.starts[1], /npm run build[\s\S]*exit 0[\s\S]*built/);
  assert.match(h.starts[1], /npm run check[\s\S]*exit 0[\s\S]*checked/);
  assert.deepEqual(h.notices, ['2 commands finished. Codex continues.']);
  assert.deepEqual(h.markers.filter(marker => marker.state === 'finished').map(marker => marker.id), ['build', 'check']);
  h.complete('turn-2'); await settle();
  assert.equal(h.results.length, 1);
  assert.equal(h.starts.length, 2, 'the result is delivered once');
});

test('a command that ends after the final answer began continues the agent after the turn, not inside it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = heldTurn(); await settle();
  h.command('turn-1', 'check', 'npm run lint'); h.finalAnswer('turn-1');
  h.command('turn-1', 'check', 'npm run lint', { exitCode: 2, output: 'lint failed\n' }); await settle();
  assert.deepEqual(h.steers, [], 'nothing joins the final answer');
  h.complete('turn-1'); await settle();
  assert.equal(h.starts.length, 2);
  assert.match(h.starts[1], /npm run lint[\s\S]*exit 2[\s\S]*lint failed/);
  assert.deepEqual(h.notices, ['1 command finished (1 failed). Codex continues.']);
});

test('STOP during the wait ends the turn and a later result starts nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = heldTurn(); await settle();
  h.command('turn-1', 'tests', 'npm test'); h.complete('turn-1'); await settle();
  h.turn.kill(); await settle();
  assert.deepEqual(h.errors, ['Worker killed']);
  assert.deepEqual(h.markers.at(-1), { id: 'tests', state: 'running' }, 'the wait is released');
  h.command('turn-1', 'tests', 'npm test', { exitCode: 1, output: 'failed\n' });
  t.mock.timers.tick(HELD_WAIT_LIMIT_MS); await settle();
  assert.equal(h.starts.length, 1);
  assert.equal(h.worker.hasHeldResults(), false);
});

test('operator steering during the wait starts the continuation and the result joins that turn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let queue: SteerItem[] = []; const delivered: SteerItem[][] = [];
  const h = heldTurn({ pendingInput: () => queue.length ? 'steer' : undefined, peekSteer: () => queue, drainSteer: () => queue.splice(0), onSteerDelivered: items => delivered.push(items) });
  await settle();
  h.command('turn-1', 'deploy', './deploy.sh'); h.complete('turn-1'); await settle();
  queue = [{ content: 'also update the notes' }];
  t.mock.timers.tick(500); await settle();
  assert.equal(h.starts.length, 2);
  assert.match(h.starts[1], /also update the notes[\s\S]*Still running: \.\/deploy\.sh/);
  assert.equal(delivered.length, 1);
  h.command('turn-1', 'deploy', './deploy.sh', { exitCode: 0, output: 'deployed\n' }); await settle();
  assert.equal(h.steers.length, 1, 'the result joins the running turn');
  assert.match(h.steers[0], /deploy\.sh[\s\S]*exit 0/);
  assert.deepEqual(h.notices, [], 'routine results joining a running turn stay quiet');
  h.complete('turn-2'); await settle();
  assert.equal(h.results.length, 1);
  assert.equal(h.starts.length, 2);
});

test('a dev server is shown running but never waited on, and the wait limit ends a held turn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const server = heldTurn(); await settle();
  server.command('turn-1', 'dev', 'npm run dev -- --port 5173'); server.complete('turn-1'); await settle();
  assert.equal(server.results.length, 1);
  assert.ok(server.markers.length > 0 && server.markers.every(marker => !marker.waiting));
  const long = heldTurn(); await settle();
  long.command('turn-1', 'soak', './soak-test.sh'); long.complete('turn-1'); await settle();
  assert.ok(long.markers.some(marker => marker.waiting));
  t.mock.timers.tick(HELD_WAIT_LIMIT_MS); await settle();
  assert.equal(long.results.length, 1);
  assert.ok(long.notices.some(line => /stopped waiting after 30m 0s[\s\S]*soak-test\.sh/.test(line)));
  assert.equal(long.markers.at(-1)?.waiting, undefined);
  long.command('turn-1', 'soak', './soak-test.sh', { exitCode: 0, output: '' }); await settle();
  assert.equal(long.starts.length, 1);
});


test('isolated Codex keeps a long-running command alive after the turn', async () => {
  const cfg = { ...config, workflowId: 'isolated-late-fixture', clusterAccessMode: 'isolated' } as WorkerConfig;
  const turn = CodexAppServerProvider.create('turn', cfg) as CodexAppServerTurn;
  const worker = (turn as any).worker as CodexAppServerWorker;
  const w = worker as any;
  let disposed = false;
  worker.ensureStarted = async () => {};
  worker.prepareIsolatedTurn = async () => {};
  worker.dispose = async () => { disposed = true; };
  w.threadId = 'thread';
  w.rpc = { request: async () => ({ turn: { id: 'turn-1' } }) };
  const result = new Promise<void>((resolve, reject) => { turn.on('result', () => resolve()); turn.on('error', reject); });
  try {
    turn.spawn('work'); await settle();
    w.onNotification({ method: 'item/started', params: { threadId: 'thread', turnId: 'turn-1', item: { type: 'commandExecution', id: 'server', command: 'npm run dev -- --port 5173', cwd: '/work', status: 'inProgress' } } });
    w.onNotification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-1', status: 'completed', items: [], error: null } } });
    await result;
    assert.equal(disposed, false, 'the running command keeps its app-server');
    assert.ok(worker.runningLateCommands.some(command => command.itemId === 'server'));
  } finally { disposeCodexAppServerWorker('isolated-late-fixture'); }
});

test('a retained isolated Codex worker reissues its pass for the next Arco turn', async () => {
  const worker = new CodexAppServerWorker('fixture-reissue', { ...config, clusterAccessMode: 'researcher' } as WorkerConfig, undefined);
  let reissues = 0;
  (worker as any).reissueIsolationPass = async () => { reissues++; };
  await worker.prepareIsolatedTurn();
  assert.equal(reissues, 0, 'startup already prepared the first pass');
  await worker.prepareIsolatedTurn();
  assert.equal(reissues, 1, 'the next turn gets a new pass without disposing the worker');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(worker.prepareIsolatedTurn(abort.signal), /stopped/);
  assert.equal(reissues, 1);
});
