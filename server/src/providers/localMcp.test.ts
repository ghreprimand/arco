import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { WorkerConfig } from '@arco/shared';
import { LocalMcp } from './localMcp.js';
const config={cwd:'/fixture',interactionMode:'agent',mcpRegistryServers:[{key:'reg-fixture',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/file-mcp.mjs',import.meta.url))],disabledTools:['disabled_picture']}]} as WorkerConfig;
test('local MCP advertises and dispatches only configured enabled tools, retaining image results',async()=>{
 const bridge=new LocalMcp(config);
 try {
  const tools=await bridge.open();
  assert.deepEqual(tools.map(t=>t.function.name),['mcp__reg-fixture__read_picture']);
  const images:any[]=[];
  assert.equal(await bridge.call('mcp__reg-fixture__write_picture',{},images),'[error] MCP tool is not enabled for this turn.');
  assert.equal(await bridge.call('mcp__reg-missing__read_picture',{},images),'[error] MCP tool is not enabled for this turn.');
  const text=await bridge.call('mcp__reg-fixture__read_picture',{label:'fixture'},images);
  assert.match(text,/fixture picture/); assert.equal(images.length,1); assert.equal(images[0].type,'image');
  assert.ok(!text.includes('iVBOR'));
 }finally{bridge.close();}
});
test('local MCP read-only boundary and explicit tool allowlist apply at dispatch too',async()=>{
 const bridge=new LocalMcp({...config,sandbox:'read-only',tools:['mcp__reg-fixture__write_picture'],mcpRegistryServers:[{...config.mcpRegistryServers![0],allowedDangerousTools:['write_picture']}]});
 try {assert.deepEqual(await bridge.open(),[]);assert.match(await bridge.call('mcp__reg-fixture__write_picture',{},[]),/not enabled/);}finally{bridge.close();}
 const chat=new LocalMcp({...config,interactionMode:'chat'});try{assert.deepEqual(await chat.open(),[]);}finally{chat.close();}
});


test('local MCP converts document blocks to readable text for non-document transports', async () => {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([200, 200]).drawText('MCP document fixture', { x: 10, y: 100, font, size: 10 });
  const data = Buffer.from(await doc.save()).toString('base64');
  const bridge = new LocalMcp(config) as any;
  bridge.sessions.set('reg-fixture', {
    listTools: () => [{ name: 'read_picture', annotations: { readOnlyHint: true } }],
    callTool: async () => ({ text: 'document receipt', isError: false, blocks: [{ type: 'document', mediaType: 'application/pdf', name: 'fixture.pdf', data, pages: 1 }] }),
    close: () => {},
  });
  try {
    const text = await bridge.call('mcp__reg-fixture__read_picture', {}, []);
    assert.match(text, /MCP document fixture/);
  } finally { bridge.close(); }
});
