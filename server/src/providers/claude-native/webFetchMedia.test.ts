import assert from 'node:assert/strict';
import test from 'node:test';
import {buildClaudeServerTools,buildChatWebTools} from './contentBlocks.js';
test('Native advertises a portable URL reader while retaining server web fetch',()=>{
 for(const tools of [buildClaudeServerTools(),buildChatWebTools()]) {
  const fetch=tools.find(t=>t.name==='read_url') as unknown as Record<string,unknown>;
  assert.ok(fetch);assert.ok('input_schema' in fetch);assert.ok(tools.some(t=>t.name==='web_fetch' && 'type' in t && t.type==='web_fetch_20260309'));
  assert.ok(tools.some(t=>t.name==='web_search'),'server search stays available');
 }
});

import {after} from 'node:test';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {installIsolatedTestHome} from '../../testSupport/isolatedHome.js';
import {fileContentFromBytes} from '../../fileContent.js';
import {PDFDocument} from 'pdf-lib';
import {buildMessagesFromReplayEvents} from './resumeSummary.js';
const home=realpathSync(mkdtempSync(join(tmpdir(),'arco-native-url-')));installIsolatedTestHome(home);
const {ClaudeNativeWorker}=await import('./worker.js');
after(()=>rmSync(home,{recursive:true,force:true}));
function fixture(config:Record<string,unknown>={}) {
 const worker=new ClaudeNativeWorker({workflowId:'fixture-url-media',config:{cwd:home,model:'fixture',effort:'low',skipPermissions:true,...config}}) as any;
 worker.workflowEventBroadcast=()=>{};worker.runHooks=async()=>({blocks:[],context:[],systemMessages:[],notices:[],rewrites:[]});return worker;
}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64');
for(const kind of ['image','document'] as const)test(`Native URL ${kind} reaches typed content and a source receipt after reload`,async()=>{
 const worker=fixture(),events:any[]=[];worker.on('tool_use',(event:any)=>events.push(event));
 const pdf=await PDFDocument.create();for(const text of ['First page','Second page'])pdf.addPage().drawText(text);
 const bytes=kind==='image'?png:Buffer.from(await pdf.save()),url='https://example.invalid/'+(kind==='image'?'capture.png':'report.pdf');
 let called=0;worker.fetchUrlContent=async(inputUrl:string,options:any)=>{called++;assert.equal(inputUrl,url);assert.equal(options.limits.images,true);assert.equal(options.limits.documents,kind==='document');assert.ok(options.signal instanceof AbortSignal);return {...await fileContentFromBytes(bytes,kind==='image'?'capture.png':'report.pdf',options),url};};
 try {
  const input={url,...(kind==='document'?{pages:'2',pdf_mode:'visual'}:{})},result=await worker.dispatchTool({id:'url-call',name:'read_url',input});
  assert.equal(called,1);assert.equal(result.isError,false,result.text);assert.ok(result.content?.some((b:any)=>b.type===kind));if(kind==='document'){
   const doc=result.content.find((b:any)=>b.type==='document');
   const selected=Buffer.from(doc.source.data,'base64');assert.equal((await PDFDocument.load(selected)).getPageCount(),1);
   const extracted=await fileContentFromBytes(selected,'selected.pdf',{limits:{documents:false}});
   assert.match(extracted.text,/Second page/);assert.doesNotMatch(extracted.text,/First page/);
  }
  const event=events.at(-1),replay=buildMessagesFromReplayEvents([{type:'user_message_echo',content:'Inspect URL',seq:1},{...event,type:'primary_tool_use',tool:event.name,seq:2},{type:'primary_complete',seq:3}]);
  assert.match(JSON.stringify(replay),/read_url/);assert.ok(JSON.stringify(replay).includes(url));assert.ok(!JSON.stringify(replay).includes(bytes.toString('base64')));
 }finally{await worker.dispose();}
});
test('Native portable URL reader obeys web permission, posture and per-turn call limits',async()=>{
 for(const config of [{interactionMode:'chat',chatWebAccess:false},{toolPosture:'coding'}]){
  const worker=fixture(config);let deniedCalls=0;worker.fetchUrlContent=async()=>{deniedCalls++;throw new Error('must not fetch');};try{const r=await worker.dispatchTool({id:'blocked',name:'read_url',input:{url:'https://example.invalid/image.png'}});assert.equal(r.isError,true);assert.equal(deniedCalls,0);}finally{await worker.dispose();}
 }
 const worker=fixture({interactionMode:'chat',chatWebAccess:true,webSearchMaxUses:1});let calls=0;
 worker.fetchUrlContent=async(url:string)=>{calls++;return {text:'fixture',blocks:[{type:'text',text:'fixture'}],kind:'text',truncated:false,isError:false,url};};
 try{assert.ok(worker.buildToolDefs().some((t:any)=>t.name==='read_url'));assert.equal((await worker.dispatchTool({id:'first',name:'read_url',input:{url:'https://example.invalid/page'}})).isError,false);const second=await worker.dispatchTool({id:'second',name:'read_url',input:{url:'https://example.invalid/page'}});assert.equal(second.isError,true);assert.match(second.text,/budget|limit/);assert.equal(calls,1);}finally{await worker.dispose();}
});
test('Native URL PDF defaults to extracted text without document media',async()=>{
 const worker=fixture();const pdf=await PDFDocument.create();pdf.addPage().drawText('URL text fixture');const bytes=await pdf.save();
 worker.fetchUrlContent=async(url:string,options:any)=>({...await fileContentFromBytes(bytes,'fixture.pdf',options),url});
 try { const result=await worker.dispatchTool({id:'url-text',name:'read_url',input:{url:'https://example.invalid/fixture.pdf'}});assert.equal(result.isError,false,result.text);assert.match(result.text,/URL text fixture/);assert.ok(!result.content?.some((block:any)=>block.type==='document')); }
 finally {await worker.dispose();}
});
