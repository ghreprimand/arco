import assert from 'node:assert/strict';
import test from 'node:test';
import { PNG } from 'pngjs';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileContentFromBytes, readFileContent } from '../fileContent.js';
function icon(payloads: {width:number;height:number;bytes:Buffer}[]) {
  const header = Buffer.alloc(6 + 16 * payloads.length); header.writeUInt16LE(1,2);header.writeUInt16LE(payloads.length,4);
  let offset=header.length;
  payloads.forEach((p,i)=>{const at=6+16*i;header[at]=p.width===256?0:p.width;header[at+1]=p.height===256?0:p.height;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(p.bytes.length,at+8);header.writeUInt32LE(offset,at+12);offset+=p.bytes.length;});
  return Buffer.concat([header,...payloads.map(p=>p.bytes)]);
}
function png(width:number,height:number) {const p=new PNG({width,height});p.data.fill(255);return PNG.sync.write(p);}
test('ICO selects largest PNG entry and fits it without external programs',async()=>{
  const r=await fileContentFromBytes(icon([{width:1,height:1,bytes:png(1,1)},{width:32,height:32,bytes:png(32,32)}]),'icon.data',{limits:{maxImageEdge:16}});
  assert.equal(r.isError,false); assert.ok(r.blocks.some(b=>b.type==='image'&&b.width===16&&b.height===16));
});
test('ICO decodes BMP entry including alpha and transparency mask',async()=>{
  const dib=Buffer.alloc(48);dib.writeUInt32LE(40,0);dib.writeInt32LE(1,4);dib.writeInt32LE(2,8);dib.writeUInt16LE(1,12);dib.writeUInt16LE(32,14);dib[42]=255;dib[43]=255;
  const r=await fileContentFromBytes(icon([{width:1,height:1,bytes:dib}]),'icon.ico');
  const b=r.blocks.find(b=>b.type==='image');assert.ok(b&&b.type==='image');assert.deepEqual([...PNG.sync.read(Buffer.from(b.data,'base64')).data],[255,0,0,255]);
  dib[44]=128;const transparent=await fileContentFromBytes(icon([{width:1,height:1,bytes:dib}]),'icon.ico');const t=transparent.blocks.find(b=>b.type==='image');assert.ok(t&&t.type==='image');assert.equal(PNG.sync.read(Buffer.from(t.data,'base64')).data[3],0);
});
test('SVG supplies bounded source and capped raster from file and bytes',async()=>{
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="20000"><rect width="10000" height="20000" fill="red"/></svg>';
  const root=await realpath(await mkdtemp(join(tmpdir(),'arco-svg-')));
  try {const path=join(root,'drawing.txt');await writeFile(path,svg);
    for(const r of [await fileContentFromBytes(Buffer.from(svg),'drawing.data',{limits:{maxImageEdge:64,maxTextBytes:90}}),await readFileContent(path,{limits:{maxImageEdge:64,maxTextBytes:90}})]) {
      assert.equal(r.kind,'svg');assert.equal(r.isError,false);assert.ok(r.blocks.some(b=>b.type==='image'&&b.width===32&&b.height===64));assert.ok(r.truncated);assert.ok(r.blocks.filter(b=>b.type==='text').every(b=>Buffer.byteLength(b.text)<200));
    }
    const text=await readFileContent(path,{limits:{images:false}});assert.equal(text.blocks.length,1);assert.match(text.text,/<svg/);
  } finally {await rm(root,{recursive:true,force:true});}
});
test('SVG does not resolve external images, entities, stylesheets or system fonts',async()=>{
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><image href="https://example.invalid/picture.png" width="20" height="20"/><image href="file:///example.png"/><text y="10">Sample</text><rect width="2" height="2" fill="red"/></svg>';
  const r=await fileContentFromBytes(Buffer.from(svg),'safe.svg');assert.equal(r.isError,false);assert.ok(r.blocks.some(b=>b.type==='image'));assert.match(r.text,/external|font/i);
  const entity=await fileContentFromBytes(Buffer.from('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///example.txt">]><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>&x;</text></svg>'),'entity.svg');
  assert.match(entity.text,/DOCTYPE|entit/i);assert.ok(!entity.blocks.some(b=>b.type==='image'));
});

import { fileHeaderKind } from '../fileContent.js';
test('AVIF bytes are fitted as images instead of classified as video',async()=>{
  const bytes=Buffer.from('AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAACAAAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAQAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQAMAAAAABNjb2xybmNseAACAAIABoAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAAChtZGF0EgAKCBgEOwQICBoQMhIYAAooooQARmzv9mB1+uPnYcA=','base64');
  assert.equal(fileHeaderKind(bytes),'image/avif');
  const result=await fileContentFromBytes(bytes,'misleading.data',{limits:{maxImageEdge:2}});
  assert.equal(result.isError,false,result.text);assert.ok(result.blocks.some(b=>b.type==='image'&&b.width===2&&b.height===1));
  const text=await fileContentFromBytes(bytes,'image.avif',{limits:{images:false}});assert.equal(text.blocks.length,1);assert.match(text.text,/image\/avif/);
});
