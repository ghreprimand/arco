import assert from 'node:assert/strict';
import test from 'node:test';
import * as CFB from 'cfb';
import * as XLSX from 'xlsx';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { fileContentFromBytes } from '../fileContent.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64');
test('legacy Word includes its embedded raster image',async()=>{
  const word=Buffer.alloc(4096),text='Embedded fixture\r';word.writeUInt16LE(0xa5ec);word.writeUInt32LE(1024,0x18);word.writeUInt32LE(text.length,0x4c);word.write(text,1024,'utf16le');
  const table=Buffer.alloc(4096);table[0]=2;table.writeUInt32LE(16,1);table.writeUInt32LE(text.length,9);table.writeUInt32LE(1024,15);
  const file=CFB.utils.cfb_new();CFB.utils.cfb_add(file,'WordDocument',word);CFB.utils.cfb_add(file,'0Table',table);CFB.utils.cfb_add(file,'Data',Buffer.concat([Buffer.alloc(20),png]));
  const result=await fileContentFromBytes(CFB.write(file,{type:'buffer'}),'fixture.doc');assert.equal(result.isError,false,result.text);assert.ok(result.blocks.some(b=>b.type==='image'));
});
test('a selected Excel sheet retains its own drawing image',async()=>{
  const book=XLSX.utils.book_new();for(const name of ['First','Second'])XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([[name]]),name);
  const parts=unzipSync(XLSX.write(book,{type:'buffer',bookType:'xlsx'}));
  let sheet=Buffer.from(parts['xl/worksheets/sheet2.xml']).toString();if(!sheet.includes('xmlns:r='))sheet=sheet.replace('<worksheet','<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
  parts['xl/worksheets/sheet2.xml']=strToU8(sheet.replace('</worksheet>','<drawing r:id="draw"/></worksheet>'));
  parts['xl/worksheets/_rels/sheet2.xml.rels']=strToU8('<Relationships><Relationship Id="draw" Target="../drawings/drawing2.xml"/></Relationships>');
  parts['xl/drawings/drawing2.xml']=strToU8('<x:wsDr xmlns:x="urn:x" xmlns:a="urn:a" xmlns:r="urn:r"><a:blip r:embed="picture"/></x:wsDr>');
  parts['xl/drawings/_rels/drawing2.xml.rels']=strToU8('<Relationships><Relationship Id="picture" Target="../media/picture.png"/></Relationships>');parts['xl/media/picture.png']=png;
  const result=await fileContentFromBytes(zipSync(parts),'fixture.xlsx',{pages:'2'});assert.equal(result.isError,false,result.text);assert.match(result.text,/Sheet: Second/);assert.ok(result.blocks.some(b=>b.type==='image'));
  const first=await fileContentFromBytes(zipSync(parts),'fixture.xlsx',{pages:'1'});assert.ok(first.blocks.every(b=>b.type==='text'));
});
