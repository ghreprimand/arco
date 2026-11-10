import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectServer } from './client.js';
import type { McpServerDef } from '@arco/shared';

test('mixed and image-only MCP results retain typed images without printing base64', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arco-mcp-media-'));
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const script = join(root, 'server.cjs');
  await writeFile(script, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'picture',inputSchema:{type:'object'}}]}:{content:[...(m.params.arguments.mixed?[{type:'text',text:'Synthetic screenshot'}]:[]),{type:'image',mimeType:'image/png',data:'${png}'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  const session = await connectServer({ id:'fixture', name:'Fixture', command:process.execPath, args:[script], enabled:true } as McpServerDef);
  try {
    for (const mixed of [true,false]) {
      const result=await session.callTool('picture',{mixed});
      const blocks=(result as unknown as {blocks?:Array<{type:string}>}).blocks;
      assert.ok(blocks?.some(b=>b.type==='image'));
      assert.ok(!result.text.includes(png));
      if(mixed)assert.match(result.text,/Synthetic screenshot/);
    }
  } finally {session.close();await rm(root,{recursive:true,force:true});}
});

test('an oversized MCP response closes its session before parsing the payload',async()=>{
  const root=await mkdtemp(join(tmpdir(),'arco-mcp-bound-')),script=join(root,'server.cjs');
  await writeFile(script,`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[]}:{content:[{type:'text',text:'x'.repeat(8192)}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  const session=await connectServer({id:'bound',name:'Bound',command:process.execPath,args:[script],env:{},enabled:true,createdAt:0},{maxResponseBytes:4096} as never);
  try{const result=await session.callTool('large',{});assert.equal(result.isError,true);assert.match(result.text,/response.*limit/);assert.equal(session.isClosed(),true);}
  finally{session.close();await rm(root,{recursive:true,force:true});}
});
