import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { zipSync, strToU8 } from 'fflate';
import { executeNativeToolResult, type NativeToolContext } from './tools.js';
import { nativeAttachmentContent } from './fileContent.js';
import { toWireMessages } from './appendOnlyPrefix.js';
import { imageReceipts, admitImageResult } from './imageRead.js';
import { repairImageBlock } from './contentBlocks.js';
import { projectCompactSummaryMessages } from './workerHelpers.js';
import { buildMessagesFromReplayEvents } from './resumeSummary.js';
import { normalizeMcpFileContent } from '../../mcp/fileContent.js';
const context=(cwd:string):NativeToolContext=>({cwd,abortSignal:new AbortController().signal,shells:{byId:new Map(),mintId:()=> 'fixture'},readSet:new Set(),planMode:false,onTodos:()=>{}});
async function pdf(){const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica);for(const text of ['First page','Second page'])doc.addPage().drawText(text,{font});return doc.save();}
test('Native Read and initial/steer attachment builders carry PDFs and extracted Office text',async()=>{
  const cwd=realpathSync(await mkdtemp(join(tmpdir(),'arco-native-files-')));
  try{
    const path=join(cwd,'fixture.pdf');await writeFile(path,await pdf());
    const result=await executeNativeToolResult('Read',{file_path:path,pages:'2'},context(cwd));
    const document=result.content?.find(b=>b.type==='document');assert.ok(document?.type==='document');assert.equal(document.arcoPages,1);
    const wire=toWireMessages([{role:'user',content:[{type:'tool_result',tool_use_id:'read',content:result.content}]}]);assert.ok(!JSON.stringify(wire).includes('arcoPages'));assert.match(JSON.stringify(wire),/application\/pdf/);
    const word=join(cwd,'letter.docx');await writeFile(word,zipSync({'word/document.xml':strToU8('<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Office fixture text</w:t></w:r></w:p></w:body></w:document>')}));
    for(const prompt of ['Initial attachments','Steered attachments']){const attachment=await nativeAttachmentContent(prompt,[path,word],[]);assert.equal(attachment.notices.length,0);assert.match(JSON.stringify(attachment.content),/Office fixture text/);assert.match(JSON.stringify(attachment.content),/"type":"document"/);}
    const messages=[{role:'user',content:'Inspect document'},{role:'assistant',content:[{type:'thinking',thinking:'private reasoning',signature:'signed'},{type:'tool_use',id:'read',name:'Read',input:{file_path:path}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'read',content:result.content}]}];
    const saved=JSON.stringify(imageReceipts(messages));assert.ok(!saved.includes(document.source.data));assert.ok(!saved.includes('signed'));assert.match(saved,/fixture.pdf/);
    assert.match(JSON.stringify(projectCompactSummaryMessages(messages as never)),/fixture.pdf/);
    assert.equal(admitImageResult(Array(100).fill(document),[],{text:result.text,content:result.content,isError:false}).content,undefined);
    assert.equal(repairImageBlock({type:'document',source:{type:'base64',media_type:'application/pdf',data:''}}).action,'replace');
  }finally{await rm(cwd,{recursive:true,force:true});}
});
test('MCP embedded PDF gets document blocks and linked resources are never fetched',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('No external resource fetch permitted');});
  const result=await normalizeMcpFileContent({content:[{type:'resource',resource:{uri:'fixture.pdf',mimeType:'application/pdf',blob:Buffer.from(await pdf()).toString('base64')}},{type:'resource_link',uri:'https://example.invalid/resource.pdf'}]});
  assert.ok(result.blocks?.some(b=>b.type==='document'));assert.match(result.text,/referenced at https:\/\/example.invalid/);
});
test('image-only operator attachment references survive ordinary replay',()=>{
  const replay=buildMessagesFromReplayEvents([{type:'user_message_echo',content:'',attachments:['fixture.png'],seq:1},{type:'primary_text',text:'The image has a heading.',seq:2},{type:'primary_complete',seq:3}]);
  assert.match(JSON.stringify(replay),/fixture.png; use Read to inspect again/);
});
