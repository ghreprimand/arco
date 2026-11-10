import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileContentFromBytes } from './fileContent.js';

test('shared decoder keeps UTF-8 text and explains invalid UTF-8 and binary data', async () => {
  assert.equal((await fileContentFromBytes(Buffer.from('first\nsecond'), 'file.data', { offset: 2 })).text, 'second');
  const bad = await fileContentFromBytes(Buffer.from([0xff, 0xfe, 0x80]), 'invalid.txt');
  assert.match(bad.text, /UTF-8|binary/); assert.ok(!bad.text.includes('\ufffd'));
  const binary = await fileContentFromBytes(Buffer.from([0, 1, 2, 3]), 'file.bin');
  assert.match(binary.text, /binary/);
});
test('shared decoder returns PNG with no system image converter', async () => {
  const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
  const image = await fileContentFromBytes(data, 'file.data', { limits: { images: true } });
  assert.ok(image.blocks.some(b => b.type === 'image')); assert.match(image.text, /1x1/);
});

import { PDFDocument, StandardFonts } from 'pdf-lib';
test('PDF page ranges deliver document blocks or extracted text without external executables', async () => {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of ['First page', 'Second page']) { const p = doc.addPage([200, 200]); p.drawText(label, { x: 20, y: 100, size: 12, font }); }
  const data = await doc.save();
  const result = await fileContentFromBytes(data, 'file.bin', { pages: '2', limits: { documents: true } });
  assert.ok(result.blocks.some(b => b.type === 'document' && b.pages === 1));
  assert.match(result.text, /Second page/); assert.doesNotMatch(result.text, /First page/);
  const text = await fileContentFromBytes(data, 'file.bin', { pages: '1', limits: { documents: false, images: false } });
  assert.match(text.text, /First page/); assert.ok(text.blocks.every(b => b.type === 'text'));
});
test('scanned PDF becomes page images for a vision model', async () => {
  const doc = await PDFDocument.create(); doc.addPage([200, 300]);
  const result = await fileContentFromBytes(await doc.save(), 'scan.pdf', { limits: { documents: false, images: true } });
  assert.ok(result.blocks.some(b => b.type === 'image')); assert.match(result.text, /No extractable text/);
});

import { zipSync, strToU8 } from 'fflate';
import * as XLSX from 'xlsx';
import * as CFB from 'cfb';
const zip = (parts: Record<string,string>) => zipSync(Object.fromEntries(Object.entries(parts).map(([k,v]) => [k,strToU8(v)])));
test('modern Word, PowerPoint and OpenDocument parse paragraphs and slide ranges by bytes', async () => {
  const word = zip({ 'word/document.xml': '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Heading</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell value</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>' });
  const docx = await fileContentFromBytes(word,'misleading.bin'); assert.equal(docx.kind,'docx'); assert.match(docx.text,/Heading/);assert.match(docx.text,/Cell value/);
  const ppt = zip({ 'ppt/slides/slide1.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:t>Slide one</a:t></a:p></p:sld>', 'ppt/slides/slide2.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:t>Slide two</a:t></a:p></p:sld>' });
  const pptx=await fileContentFromBytes(ppt,'slides.data',{pages:'2'});assert.match(pptx.text,/Slide two/);assert.doesNotMatch(pptx.text,/Slide one/);
  for (const [format,body] of [['odt','<office:text><text:h>ODF Heading</text:h><text:p>Body text</text:p></office:text>'],['odp','<office:presentation><draw:page><text:p>ODF Slide</text:p></draw:page></office:presentation>']]) {
    const parts=zip({'content.xml':`<office:document xmlns:office="urn:office" xmlns:text="urn:text" xmlns:draw="urn:draw">${body}</office:document>`});
    const result=await fileContentFromBytes(parts,'odf.bin');assert.equal(result.kind,format);assert.match(result.text,/ODF/);
  }
});
test('Excel modern, legacy and ODS preserve sheet names and rows', async () => {
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Item','Value'],['Synthetic',42]]),'First');XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Selected',7]]),'Second');
  for (const bookType of ['xlsx','biff8','ods'] as const) {
    const result=await fileContentFromBytes(XLSX.write(book,{type:'buffer',bookType}),'spreadsheet.bin',{pages:'2'});
    assert.equal(result.isError,false,result.text);assert.match(result.text,/Sheet: Second/);assert.match(result.text,/Selected\t7/);assert.doesNotMatch(result.text,/Synthetic/);
  }
});
test('legacy Word and PowerPoint decode generated compound documents', async () => {
  const word=Buffer.alloc(4096),label='Synthetic Word\r';word.writeUInt16LE(0xa5ec,0);word.writeUInt32LE(1024,0x18);word.writeUInt32LE(label.length,0x4c);word.write(label,1024,'utf16le');
  const table=Buffer.alloc(4096);table[0]=2;table.writeUInt32LE(16,1);table.writeUInt32LE(label.length,9);table.writeUInt32LE(1024,15);
  const compound=CFB.utils.cfb_new();CFB.utils.cfb_add(compound,'WordDocument',word);CFB.utils.cfb_add(compound,'0Table',table);
  const doc=await fileContentFromBytes(CFB.write(compound,{type:'buffer'}),'legacy.bin');assert.equal(doc.isError,false,doc.text);assert.match(doc.text,/Synthetic Word/);
  const text=Buffer.from('Synthetic slide','utf16le'),record=Buffer.alloc(8+text.length);record.writeUInt16LE(4000,2);record.writeUInt32LE(text.length,4);text.copy(record,8);
  const ppt=CFB.utils.cfb_new();CFB.utils.cfb_add(ppt,'PowerPoint Document',record);
  const slide=await fileContentFromBytes(CFB.write(ppt,{type:'buffer'}),'legacy.bin');assert.equal(slide.isError,false,slide.text);assert.match(slide.text,/Synthetic slide/);
});
test('RTF and notebook cells preserve text and image outputs without executing anything', async () => {
  const rtf=await fileContentFromBytes(Buffer.from('{\\rtf1\\ansi Heading\\par Row\\tab Value\\par Unicode \\u233?}'),'document.data');
  assert.equal(rtf.kind,'rtf');assert.match(rtf.text,/Heading\nRow\tValue/);assert.match(rtf.text,/Unicode é/);
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const notebook={nbformat:4,cells:[{cell_type:'code',source:['print("fixture")'],outputs:[{data:{'text/plain':['fixture'],'image/png':png}}]}]};
  const result=await fileContentFromBytes(Buffer.from(JSON.stringify(notebook)),'notebook.data');assert.equal(result.kind,'notebook');assert.match(result.text,/Cell 1/);assert.match(result.text,/Output: fixture/);assert.ok(result.blocks.some(b=>b.type==='image'));
});

import { readFileContent } from './fileContent.js';
import { promises as fs, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('shared text reads preserve capped I/O and exact later-line output', async t => {
  const cwd=realpathSync(await fs.mkdtemp(join(tmpdir(),'arco-shared-text-'))),path=join(cwd,'file.txt');
  await fs.writeFile(path,'first\n'+'x'.repeat(300000)+'\nlast');
  const open=fs.open.bind(fs);let readBytes=0;
  t.mock.method(fs,'open',async (...args:any[])=>{const h=await (open as any)(...args);const read=h.read.bind(h);h.read=async(...a:any[])=>{const r=await read(...a);if(args[0]===path)readBytes+=r.bytesRead;return r;};return h;});
  syncBuiltinESMExports();
  try {
    const result=await readFileContent(path,{limits:{maxTextBytes:32768}});assert.match(result.text,/truncated/);assert.ok(readBytes>0,'the read observer must see real I/O');assert.ok(readBytes<=49152,`read ${readBytes}`);t.diagnostic(`bounded reader observed ${readBytes} bytes`);
    assert.equal((await readFileContent(path,{offset:3,limits:{maxTextBytes:32768}})).text,'last');
  } finally {t.mock.restoreAll();syncBuiltinESMExports();await fs.rm(cwd,{recursive:true,force:true});}
});

import { createDeflate } from 'node:zlib';
import { once } from 'node:events';
import { pngCrc, decodePngRows } from './fileContent/pngRows.js';
function pngChunk(name:string,data:Buffer):Buffer {const h=Buffer.alloc(8),tail=Buffer.alloc(4);h.writeUInt32BE(data.length);h.write(name,4);tail.writeUInt32BE(pngCrc(Buffer.concat([h.subarray(4),data])));return Buffer.concat([h,data,tail]);}
async function solidPng(width:number,height:number):Promise<Buffer>{
  const deflate=createDeflate(),chunks:Buffer[]=[];deflate.on('data',c=>chunks.push(c));
  const row=Buffer.alloc(width*3+1);row.fill(240,1);
  for(let y=0;y<height;y++)if(!deflate.write(row))await once(deflate,'drain');
  deflate.end();await once(deflate,'end');
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('IDAT',Buffer.concat(chunks)),pngChunk('IEND',Buffer.alloc(0))]);
}
test('70 MB image source is fitted instead of refused by the document source limit',async()=>{
  const small=await solidPng(2,3),large=Buffer.concat([small.subarray(0,small.length-12),pngChunk('tEXt',Buffer.alloc(70*1024*1024,65)),small.subarray(-12)]);
  const dir=realpathSync(await fs.mkdtemp(join(tmpdir(),'arco-large-image-'))),path=join(dir,'large.png');
  try{await fs.writeFile(path,large);const result=await readFileContent(path);assert.equal(result.isError,false,result.text);assert.ok(result.blocks.some(b=>b.type==='image'&&b.width===2&&b.height===3));}
  finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('20000 by 20000 PNG scales row by row without a full-size bitmap',async()=>{
  const source=await solidPng(20000,20000),image=await decodePngRows(source,2000);
  assert.ok(image);assert.equal(image.width,2000);assert.equal(image.height,2000);assert.equal(image.data.length,16_000_000);assert.equal(image.data[0],240);
  assert.ok(process.resourceUsage().maxRSS<768*1024,'decoder stays below 768 MB peak process RSS');
});

test('scanline PNG fitting retains transparent RGB samples',async()=>{
  const {deflateSync}=await import('node:zlib');
  const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;
  const transparency=Buffer.alloc(6);[12,34,56].forEach((n,i)=>transparency.writeUInt16BE(n,i*2));
  const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('tRNS',transparency),pngChunk('IDAT',deflateSync(Buffer.from([0,12,34,56]))),pngChunk('IEND',Buffer.alloc(0))]);
  const image=await decodePngRows(bytes,2000);assert.deepEqual(Array.from(image!.data),[12,34,56,0]);
});
test('ordinary source identifiers do not masquerade as ZIP or BMP headers',async()=>{
  for(const text of ['PKG_VERSION=1\n','BMP_HEADER = "example"\n']) {
    const result=await fileContentFromBytes(Buffer.from(text),'source.txt');assert.equal(result.kind,'text');assert.equal(result.text,text);
  }
});

test('a cancelled decode waiting for a worker slot settles without waiting for other files',async()=>{
  const bytes=await solidPng(20000,20000),first=fileContentFromBytes(bytes,'first.png'),second=fileContentFromBytes(bytes,'second.png');
  const controller=new AbortController();
  const queued=fileContentFromBytes(bytes,'cancelled.png',{signal:controller.signal});controller.abort(new Error('fixture cancelled'));
  try {
    const settled=await Promise.race([queued.then(()=>false,()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),500))]);
    assert.equal(settled,true,'cancellation must not wait for the active decoders');
  }finally{await Promise.allSettled([first,second,queued]);}
});

test('UTF-16 byte-order marks take precedence over MPEG frame signatures',async()=>{
  const le=Buffer.concat([Buffer.from([255,254]),Buffer.from('Example text','utf16le')]);
  const be=Buffer.concat([Buffer.from([254,255]),Buffer.from('Example text','utf16le').swap16()]);
  for(const data of [le,be]){const result=await fileContentFromBytes(data,'unicode.txt');assert.equal(result.kind,'text');assert.equal(result.text,'Example text');}
});

test('selected text containing a NUL after the header gets the same binary receipt as bytes', async () => {
  const root=realpathSync(await fs.mkdtemp(join(tmpdir(),'arco-late-binary-')));
  try {
    const path=join(root,'sample.txt'),data=Buffer.from('a'.repeat(5000)+'\0tail');
    await fs.writeFile(path,data);
    const fromFile=await readFileContent(path),fromBytes=await fileContentFromBytes(data,'sample.txt');
    assert.equal(fromFile.kind,'binary');assert.deepEqual(fromFile,fromBytes);assert.ok(!fromFile.text.includes('\0'));
    await fs.writeFile(path,'a'.repeat(5000)+'\nsecond\0binary\nclean');
    const selected=await readFileContent(path,{offset:2,limit:1});
    assert.equal(selected.kind,'binary');assert.match(selected.text,/not sent as text/);assert.ok(!selected.text.includes('\0'));
    assert.equal((await readFileContent(path,{offset:3,limit:1})).text,'clean');
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
