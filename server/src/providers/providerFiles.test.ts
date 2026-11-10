import { codexImageToolConfig, installedCodexImageToolKey } from './codexImageTool.js';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
const storage = await mkdtemp(join(tmpdir(),'arco-provider-storage-'));
process.env.ARCO_UPLOADS_DIR = join(storage,'uploads');
test.after(async()=>{await rm(storage,{recursive:true,force:true});});
const { executeOllamaTool } = await import('./ollamaTools.js');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
test('local Read delivers an image as media, never UTF-8, including a misleading extension', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-file-'));
  try {
    await writeFile(join(cwd, 'picture.data'), png);
    const images: unknown[] = [];
    const result = await executeOllamaTool('Read', { file_path: 'picture.data' }, { cwd, onImages: (blocks: unknown[]) => images.push(...blocks) } as any);
    assert.equal(images.length, 1);
    assert.match(result, /picture.data/);
    assert.ok(!result.includes('IHDR'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
test('local Read returns notebook cells and a binary note', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-file-'));
  try {
    await writeFile(join(cwd, 'data.bin'), Buffer.from([0,1,2,3,4,255]));
    assert.match(await executeOllamaTool('Read', { file_path: 'data.bin' }, {cwd}), /binary/i);
    await writeFile(join(cwd, 'notes.ipynb'), JSON.stringify({nbformat:4, cells:[{cell_type:'markdown',source:['Fixture heading']},{cell_type:'code',source:['print(42)'],outputs:[]}]}));
    const result = await executeOllamaTool('Read', {file_path:'notes.ipynb'}, {cwd});
    assert.match(result, /print\(42\)/);
    assert.ok(!result.includes('"nbformat"'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

const { OllamaProvider } = await import('./ollama.js');
const { LlamacppProvider } = await import('./llamacpp.js');
const { LmstudioProvider, probeLmstudio } = await import('./lmstudio.js');
const { StrataProvider } = await import('./strata.js');
const { DeepSeekProvider } = await import('./deepseek.js');
const { ToolLoopDetector } = await import('./ollamaTools.js');
const { prepareProviderAttachments, openAiVisionMessages, ollamaVisionMessages } = await import('./providerFileContent.js');
const { CursorAcpWorker } = await import('./cursor/worker.js');
const { registerFileTools } = await import('../mcp/fileMcpTools.js');
import type { WorkerConfig } from '@arco/shared';

const providers = {ollama:OllamaProvider,llamacpp:LlamacppProvider,lmstudio:LmstudioProvider,strata:StrataProvider,deepseek:DeepSeekProvider};
test('all local providers retain tool-result images as native media after paired tool results',async()=>{
  const cwd = await mkdtemp(join(tmpdir(),'arco-file-'));
  try {
    await writeFile(join(cwd,'fixture.png'),png);
    for (const [kind,provider] of Object.entries(providers)) {
      const worker = provider.create('fixture',{cwd,workflowId:'fixture',interactionMode:'agent'} as WorkerConfig) as any;
      worker.advertisedTools = new Set(['Read']);
      const args = {file_path:'fixture.png'};
      const calls = kind === 'ollama' ? [{function:{name:'Read',arguments:args}}] : [{id:'read1',function:{name:'Read',arguments:JSON.stringify(args)}}];
      const results = await worker.dispatchToolCalls(calls,true,new ToolLoopDetector());
      assert.equal(results[0].role,'tool',kind);
      assert.equal(results[1]?.role,'user',kind);
      if (kind === 'ollama') assert.ok(results[1].images[0].length>0);
      else assert.match(results[1].content.find((part:any)=>part.type==='image_url').image_url.url,/^data:image\//);
      assert.ok(!JSON.stringify(results[0]).includes('IHDR'));
    }
  } finally { await rm(cwd,{recursive:true,force:true}); }
});
test('local wire vision gates are per request and preserve labels without mutating history',()=>{
  const ollama=[{role:'user',content:'figure.png',images:['fixture']}];
  assert.deepEqual(ollamaVisionMessages(ollama,true),ollama);
  assert.equal(ollamaVisionMessages(ollama,false)[0].images,undefined);
  assert.match(ollamaVisionMessages(ollama,false)[0].content,/vision support/);
  assert.deepEqual(ollama[0].images,['fixture']);
  const openai=[{role:'user',content:[{type:'text',text:'figure.png'},{type:'image_url',image_url:{url:'data:image/png;base64,fixture'}}]}];
  assert.deepEqual(openAiVisionMessages(openai,true),openai);
  assert.equal(openAiVisionMessages(openai,false)[0].content.filter(p=>p.type==='image_url').length,0);
  assert.equal(openai[0].content.length,2);
});
test('attachments decode RTF and notebooks, and text-only models receive an image note',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'arco-file-'));
  try {
    await writeFile(join(cwd,'memo.rtf'),'{\\rtf1\\ansi Fixture document}');
    await writeFile(join(cwd,'picture.png'),png);
    const prepared=await prepareProviderAttachments([join(cwd,'memo.rtf'),join(cwd,'picture.png')],false);
    assert.match(prepared.text,/Fixture document/);
    assert.ok(!prepared.text.includes('\\rtf1'));
    assert.equal(prepared.images.length,0);
    assert.match(prepared.text,/image/i);
  }finally{await rm(cwd,{recursive:true,force:true});}
});
test('Cursor ACP file callback decodes binary safely and points images to its visual tool',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'arco-file-'));
  try{
    await writeFile(join(cwd,'image.png'),png);
    const worker=new CursorAcpWorker('fixture',{cwd,provider:'cursor'} as WorkerConfig,undefined) as any;
    const reply=await worker.handleAgentRequest({method:'fs/read_text_file',params:{path:join(cwd,'image.png')}});
    assert.match(reply.content,/read_file/);
    assert.ok(!reply.content.includes('IHDR'));
  }finally{await rm(cwd,{recursive:true,force:true});}
});
test('read_file MCP returns real image content, confines paths and supports document ranges',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'arco-file-'));
  try{
    await writeFile(join(cwd,'image.png'),png);
    let name='';let spec:any;let read:any;
    registerFileTools({registerTool:(n:string,s:any,handler:any)=>{if(n==='read_file'){name=n;spec=s;read=handler;}}} as any,cwd);
    assert.equal(name,'read_file'); assert.equal(spec.annotations.readOnlyHint,true);
    const result=await read({file_path:'image.png'});
    assert.equal(result.isError,false);
    assert.ok(result.content.some((b:any)=>b.type==='image'&&b.mimeType.startsWith('image/')));
    const refused=await read({file_path:'../outside.docx'});
    assert.equal(refused.isError,true); assert.match(refused.content[0].text,/escapes/);
  }finally{await rm(cwd,{recursive:true,force:true});}
});
test('LM Studio native metadata gates vision by selected loaded instance',async(t)=>{
  t.mock.method(globalThis,'fetch',async(url:any)=> new Response(JSON.stringify(String(url).includes('/api/v1/models')
    ? {models:[{key:'fixture-key',capabilities:{vision:true},loaded_instances:[{id:'fixture-instance'}]}]}
    : {data:[{id:'fixture-instance'},{id:'text-model'}]}),{status:200,headers:{'Content-Type':'application/json'}}));
  const probe=await probeLmstudio();
  assert.equal(probe.capabilities?.['fixture-instance'].vision,true);
  assert.equal(probe.capabilities?.['text-model'].vision,false);
});

import dns from 'node:dns/promises';
test('WebFetch decodes image and binary bytes without a browser fallback',async(t)=>{
  t.mock.method(dns,'lookup',async()=>[{address:'203.0.113.1',family:4}] as any);
  let body:Buffer=png;
  t.mock.method(globalThis,'fetch',async()=>new Response(Uint8Array.from(body),{headers:{'content-type':'image/png'}}));
  const images:any[]=[];
  const text=await executeOllamaTool('WebFetch',{url:'https://example.com/figure.png'},{cwd:tmpdir(),onImages:b=>images.push(...b)});
  assert.equal(images.length,1);assert.ok(!text.includes('IHDR'));assert.match(text,/figure.png/);
  body=Buffer.from([0,1,2,255]);
  const binary=await executeOllamaTool('WebFetch',{url:'https://example.com/file.bin',mode:'fast'},{cwd:tmpdir()});
  assert.match(binary,/binary|failed safely/);assert.ok(!binary.includes('\ufffd'));
});

import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
const { ClaudeProvider }=await import('./claude.js');
const { CodexProvider }=await import('./codex.js');
const { CursorPrintProvider }=await import('./cursor/print.js');
const { CodexAppServerWorker, buildThreadConfigOverrides }=await import('./codex-appserver/worker.js');
async function tickUntil(predicate:()=>boolean):Promise<void>{for(let i=0;i<200&&!predicate();i++)await new Promise(r=>setTimeout(r,10));assert.ok(predicate(),'fixture subprocess did not start');}
test('Claude CLI, Codex exec and Cursor print receive decoded document text and fitted images',async(t)=>{
 const cwd=await mkdtemp(join(tmpdir(),'arco-file-'));
 try{
  await writeFile(join(cwd,'memo.rtf'),'{\\rtf1\\ansi Fixture document}');await writeFile(join(cwd,'picture.data'),png);
  for(const [kind,provider] of [['claude',ClaudeProvider],['codex',CodexProvider],['cursor',CursorPrintProvider]] as const){
   let captured:any;
   const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
   t.mock.method(childProcess,'spawn',((command:any,args:any,options:any)=>{captured={command,args,options};return child;}) as any);syncBuiltinESMExports();
   try{
    let input='';child.stdin.on('data',b=>{input+=String(b);});
    const worker=provider.create('fixture',{cwd,provider:kind,model:'fixture',effort:'medium',attachments:[join(cwd,'memo.rtf'),join(cwd,'picture.data')],tools:[],interactionMode:'chat'} as WorkerConfig);
    worker.on('error',()=>{});worker.spawn('Inspect these files');await tickUntil(()=>!!captured);
    assert.match(input,/Fixture document/,kind);assert.ok(!input.includes('\\rtf1'),kind);
    if(kind==='claude'){
     const payload=JSON.parse(input);assert.ok(payload.message.content.some((b:any)=>b.type==='image'&&b.source.data.length));
    }else if(kind==='codex'){
     assert.ok(captured.args.includes(`${installedCodexImageToolKey()}=true`));
     const image=captured.args[captured.args.indexOf('-i')+1];assert.notEqual(image,join(cwd,'picture.data'));assert.ok((await readFile(image)).length);
    }else{
     assert.equal(captured.args[captured.args.indexOf('--mode')+1],'ask');assert.equal(captured.options.cwd,cwd);
     assert.ok(!captured.args.includes('--plugin-dir'), 'Chat must not attach project file tools');assert.ok(!input.includes('Use Arco read_file'));assert.ok(!captured.args.includes('--approve-mcps'));
     const roots=captured.args.flatMap((arg:string,index:number)=>arg==='--add-dir'?[captured.args[index+1]]:[]);
     assert.ok(roots.includes(await realpath(join(storage,'uploads'))),'fitted image upload directory must be readable by Cursor');
    }
    child.emit('close',0,null);child.emit('exit',0,null);
   }finally{t.mock.restoreAll();syncBuiltinESMExports();}
  }
 }finally{await rm(cwd,{recursive:true,force:true});}
});
test('Codex app-server uses fitted localImage and decoded document attachment input',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'arco-file-'));
 try{
  await writeFile(join(cwd,'memo.rtf'),'{\\rtf1\\ansi Appserver document}');await writeFile(join(cwd,'picture.data'),png);
  const config={cwd,provider:'codex',model:'fixture',attachments:[join(cwd,'memo.rtf'),join(cwd,'picture.data')]} as WorkerConfig;
  const worker=new CodexAppServerWorker('fixture',config,undefined) as any;
  let request:any;worker.rpc={request:async(method:string,p:any)=>{request={method,p};return{turn:{id:'turn1'}};}};worker.threadId='thread1';
  await worker.beginTurn('Inspect');
  assert.match(request.p.input.find((i:any)=>i.type==='text').text,/Appserver document/);
  assert.ok((await readFile(request.p.input.find((i:any)=>i.type==='localImage').path)).length);
  assert.deepEqual((await buildThreadConfigOverrides(config))[installedCodexImageToolKey().split('.')[0]],{view_image:true});
 }finally{await rm(cwd,{recursive:true,force:true});}
});


test('PDF attachment text and selected Read pages reach local and portable CLI tools', async () => {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of ['First transport page', 'Second transport page']) {
    doc.addPage([200, 200]).drawText(label, { x: 10, y: 100, size: 10, font });
  }
  const cwd = await mkdtemp(join(tmpdir(), 'arco-file-'));
  try {
    const path = join(cwd, 'document.data');
    await writeFile(path, await doc.save());
    const attachment = await prepareProviderAttachments([path], false);
    assert.match(attachment.text, /First transport page/);
    assert.match(attachment.text, /Second transport page/);
    const read = await executeOllamaTool('Read', { file_path: path, pages: '2' }, { cwd });
    assert.match(read, /Second transport page/);
    assert.doesNotMatch(read, /First transport page/);
    let handler: any;
    registerFileTools({ registerTool: (_n: string, _s: unknown, callback: any) => { if (_n === 'read_file') handler = callback; } } as any, cwd);
    const cli = await handler({ file_path: path, pages: '1' });
    const text = cli.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    assert.match(text, /First transport page/);
    assert.doesNotMatch(text, /Second transport page/);
    assert.ok(cli.content.every((b: any) => b.type === 'text'));
    const visual = await handler({ file_path: path, pages: '2', pdf_mode: 'visual' });
    assert.equal(visual.content.filter((b: any) => b.type === 'image').length, 1);
    const missing = await handler({ file_path: path, pdf_mode: 'visual' });
    assert.equal(missing.isError, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});


test('every local provider closes its registry bridge when a turn settles', async () => {
  for (const [kind, provider] of Object.entries(providers)) {
    const worker = provider.create('fixture', { interactionMode: 'agent' } as WorkerConfig) as any;
    let closed = false;
    worker.run = async () => {};
    worker.registry.close = () => { closed = true; };
    worker.spawn('fixture');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, true, kind);
  }
});


test('Cursor cancellation during attachment decoding never submits the prompt', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-file-'));
  try {
    const attachment = join(cwd, 'picture.png');
    await writeFile(attachment, png);
    const worker = new CursorAcpWorker('fixture', { attachments: [attachment] } as WorkerConfig, undefined) as any;
    let prompts = 0;
    Object.assign(worker, {
      bootstrapped: true, sessionId: 'fixture', promptImages: true,
      applyModelIfChanged: async () => {},
      rpc: { request: async () => { prompts++; return { stopReason: 'end_turn' }; } },
    });
    const pending = worker.beginTurn('Inspect');
    await new Promise(resolve => setImmediate(resolve));
    worker.turnCancelRequested = true;
    await pending;
    assert.equal(prompts, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});


test('decoded local text reads preserve the bounded I/O contract', async (t) => {
  const fs = (await import('node:fs')).promises;
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'arco-file-')));
  const path = join(cwd, 'large.txt');
  await writeFile(path, 'first\n' + 'x'.repeat(300000) + '\nlast');
  const open = fs.open.bind(fs);
  let bytes = 0;
  t.mock.method(fs, 'open', async (...args: any[]) => {
    const handle = await (open as any)(...args);
    if (String(args[0]) === path) {
      const read = handle.read.bind(handle);
      handle.read = async (...values: any[]) => {
        const result = await read(...values);
        bytes += result.bytesRead;
        return result;
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const text = await executeOllamaTool('Read', { file_path: path }, { cwd });
    assert.match(text, /truncated/);
    assert.ok(bytes <= 49152, `Read consumed ${bytes} bytes for a 32768-byte text result`);
    assert.ok(bytes > 0, 'the fixture must observe the checked-file open binding');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(cwd, { recursive: true, force: true });
  }
});


test('Codex cancellation during attachment decoding never starts a provider turn', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-file-'));
  try {
    const attachment = join(cwd, 'picture.png');
    await writeFile(attachment, png);
    const worker = new CodexAppServerWorker('fixture', { attachments: [attachment] } as WorkerConfig, undefined) as any;
    let starts = 0;
    worker.threadId = 'fixture';
    worker.rpc = { request: async () => { starts++; return { turn: { id: 'unexpected' } }; } };
    const pending = worker.beginTurn('Inspect').then(() => undefined, () => undefined);
    await new Promise(resolve => setImmediate(resolve));
    await worker.cancelCurrentTurn();
    await pending;
    assert.equal(starts, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});


test('WebFetch recognizes split TIFF magic without an image Content-Type', async (t) => {
  const UTIF = (await import('utif')).default;
  const rgba = new Uint8Array(400 * 400 * 4).fill(127);
  for (let index = 3; index < rgba.length; index += 4) rgba[index] = 255;
  const bytes = new Uint8Array(UTIF.encodeImage(rgba, 400, 400));
  assert.ok(bytes.length > 128 * 1024);
  t.mock.method(dns, 'lookup', async () => [{ address: '203.0.113.1', family: 4 }] as any);
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes.subarray(0, 3)); controller.enqueue(bytes.subarray(3)); controller.close(); },
  }), { headers: { 'content-type': 'application/octet-stream' } }));
  const images: any[] = [];
  const text = await executeOllamaTool('WebFetch', { url: 'https://example.com/figure.data', mode: 'fast' }, { cwd: tmpdir(), onImages: blocks => images.push(...blocks) });
  assert.equal(images.length, 1, text);
  const { PNG } = await import('pngjs');
  const fitted = PNG.sync.read(Buffer.from(images[0].data, 'base64'));
  assert.deepEqual([...fitted.data.subarray(-4)], [127, 127, 127, 255], 'the final pixels must survive fetching');
});
