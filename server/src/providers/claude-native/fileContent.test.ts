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
    assert.equal((await admitImageResult(Array(100).fill(document),[],{text:result.text,content:result.content,isError:false})).content,undefined);
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

test('web fetch text never consumes pasted-image or Read media budgets', async () => {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'arco-web-image-budget-')));
  try {
    const image = join(cwd, 'pasted.png');
    await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));
    const fetched = { type: 'web_fetch_tool_result', content: { type: 'web_fetch_result', content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Web page text' } } } };
    const history = [{ role: 'user', content: [fetched, fetched] }];
    const attached = await nativeAttachmentContent('Describe the image', [image], history);
    assert.equal(attached.notices.length, 0);
    assert.ok(Array.isArray(attached.content) && attached.content.some(block => block.type === 'image'));
    const read = await executeNativeToolResult('Read', { file_path: image }, context(cwd));
    assert.ok((await admitImageResult(history, [], read)).content?.some(block => block.type === 'image'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('pasted budget notice reports counts and gives reattachment advice', async () => {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'arco-paste-limit-')));
  try {
    const image = join(cwd, 'pasted.png');
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
    await writeFile(image, Buffer.from(data, 'base64'));
    const history = Array(100).fill({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
    const attached = await nativeAttachmentContent('', [image], history);
    assert.equal(attached.notices.length, 1);
    assert.match(attached.notices[0], /101 images.*0 PDF pages.*MiB/);
    assert.match(attached.notices[0], /attach.*again/i);
    assert.doesNotMatch(attached.notices[0], /Read again/i);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('wire PDFs without page metadata use measured pages and saved receipts consume none', async () => {
  const data = Buffer.from(await pdf()).toString('base64');
  const document = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  const textDocument = { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'x'.repeat(21 * 1024 * 1024) } };
  const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' } };
  const result = { text: 'image: current.png', content: [image], isError: false };
  assert.ok((await admitImageResult([document, textDocument, ...Array(97).fill(image)], [], result)).content);
  const rejected = await admitImageResult(Array(50).fill(document), [], { text: 'document: current.pdf', content: [document] as any, isError: false });
  assert.equal(rejected.content, undefined); assert.match(rejected.text, /0 images, 102 PDF pages/);
  const internal = [{ role: 'user', content: [{ ...document, arcoPages: 2 }] }];
  const wire = toWireMessages(internal);
  assert.equal(internal[0].content[0].arcoPages, 2);
  assert.ok(!JSON.stringify(wire).includes('arcoPages'));
  assert.ok((await admitImageResult(wire, [], result)).content);
  assert.ok((await admitImageResult(imageReceipts(internal), [], result)).content);
});
