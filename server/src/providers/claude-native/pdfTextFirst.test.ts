import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { executeNativeToolResult, type NativeToolContext } from './tools.js';
import { nativeAttachmentContent } from './fileContent.js';
import { prepareProviderAttachments } from '../providerFileContent.js';
const context=(cwd:string):NativeToolContext=>({cwd,abortSignal:new AbortController().signal,shells:{byId:new Map(),mintId:()=> 'fixture'},readSet:new Set(),planMode:false,onTodos:()=>{}});
test('Claude defaults to PDF text, retains scanned images and offers selected visual pages', async () => {
 const cwd=await mkdtemp(join(tmpdir(),'arco-pdf-text-first-'));
 try {
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);pdf.addPage().drawText('First page text',{font});pdf.addPage([200,300]);
  const path=join(cwd,'fixture.pdf');await writeFile(path,await pdf.save());
  const result=await executeNativeToolResult('Read',{file_path:path},context(cwd));
  assert.match(result.text,/First page text/);assert.ok(!result.content?.some(b=>b.type==='document'));assert.ok(result.content?.some(b=>b.type==='image'));
  const native=await nativeAttachmentContent('Read',[path],[]);assert.ok(!JSON.stringify(native.content).includes('"type":"document"'));assert.match(JSON.stringify(native.content),/First page text/);
  const cli=await prepareProviderAttachments([path],true,undefined,false);assert.equal(cli.documents.length,0);assert.match(cli.text,/First page text/);assert.equal(cli.images.length,1);
  const visual=await executeNativeToolResult('Read',{file_path:path,pages:'1',pdf_mode:'visual'},context(cwd));assert.ok(visual.content?.some(b=>b.type==='document'&&b.arcoPages===1));
 } finally {await rm(cwd,{recursive:true,force:true});}
});
test('a text attachment mentioning a PDF media type has no PDF receipt', async () => {
 const cwd=await mkdtemp(join(tmpdir(),'arco-pdf-receipt-'));
 try { const path=join(cwd,'note.txt');await writeFile(path,'Example media type: application/pdf');const result=await nativeAttachmentContent('Read',[path],[]);assert.doesNotMatch(JSON.stringify(result.content),/PDF sent as text/); }
 finally {await rm(cwd,{recursive:true,force:true});}
});
