import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installIsolatedTestHome} from '../../testSupport/isolatedHome.js';
import {PDFDocument} from 'pdf-lib';
import {normalizeMcpFileContent} from '../../mcp/fileContent.js';
import {buildMessagesFromReplayEvents} from './resumeSummary.js';
const home=realpathSync(mkdtempSync(join(tmpdir(),'arco-media-replay-')));installIsolatedTestHome(home);
const {ClaudeNativeWorker}=await import('./worker.js');
after(()=>rmSync(home,{recursive:true,force:true}));
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
for(const scenario of ['mixed','image-only','pdf'] as const)test(`registry MCP ${scenario} leaves a usable media receipt after ordinary event reload`,async()=>{
 const doc=await PDFDocument.create();doc.addPage([100,100]).drawText('PDF fixture',{x:5,y:50,size:8});const pdf=Buffer.from(await doc.save()).toString('base64');
 const raw={content:scenario==='pdf'?[{type:'resource',resource:{uri:'capture.pdf',mimeType:'application/pdf',blob:pdf}}]:[...(scenario==='mixed'?[{type:'text',text:'Header '.repeat(1000)}]:[]),{type:'image',name:'capture.png',mimeType:'image/png',data:png}]};
 const normalized=await normalizeMcpFileContent(raw);
 const worker=new ClaudeNativeWorker({workflowId:'fixture-media-replay',config:{cwd:home,model:'fixture',effort:'low',skipPermissions:true,mcpRegistryServers:[{key:'reg-fixture',name:'fixture',transport:{type:'stdio',command:'unused'}}] as any}}) as any;
 const events:any[]=[];worker.on('tool_use',(event:any)=>events.push(event));worker.workflowEventBroadcast=()=>{};
 worker.runHooks=async()=>({blocks:[],context:[],systemMessages:[],notices:[],rewrites:[]});
 worker.mcpSessions.set('reg-fixture',{callTool:async()=>normalized,close:async()=>{},listTools:()=>[]});
 try {
  const name='mcp__reg-fixture__capture',input={target:'https://example.invalid/report',page:2};
  const result=await worker.dispatchTool({id:'capture-call',name,input});assert.equal(result.isError,false);assert.ok(result.content.some((b:any)=>b.type==='image'||b.type==='document'));
  const event=events.at(-1);assert.ok(event.mediaReceipt,'receipt is independent of truncated output text');
  const replay=buildMessagesFromReplayEvents([{type:'user_message_echo',content:'Inspect the report',seq:1},{...event,type:'primary_tool_use',tool:event.name,seq:2},{type:'primary_complete',seq:3}]);
  const text=JSON.stringify(replay);assert.match(text,/mcp__reg-fixture__capture/);assert.match(text,/https:\/\/example.invalid\/report/);assert.match(text,scenario==='pdf'?/document/:/image/);assert.doesNotMatch(text,/use Read to inspect again/);assert.ok(!text.includes(png));assert.ok(!text.includes(pdf));
 }finally{await worker.dispose();}
});
