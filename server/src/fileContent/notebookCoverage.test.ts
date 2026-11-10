import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,realpath,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readFileContent,fileContentFromBytes} from '../fileContent.js';
test('notebook files select cells even when metadata hides keys beyond the header',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'arco-notebook-')));
 try {
  const notebook={metadata:{padding:'x'.repeat(6000)},nbformat:4,cells:[{cell_type:'markdown',source:['First cell']},{cell_type:'code',source:['Second cell'],outputs:[]}]};
  const bytes=Buffer.from(JSON.stringify(notebook)),path=join(root,'fixture.ipynb');await writeFile(path,bytes);
  const result=await readFileContent(path,{pages:'2'});assert.equal(result.kind,'notebook');assert.match(result.text,/Second cell/);assert.doesNotMatch(result.text,/First cell|padding/);assert.deepEqual(result,await fileContentFromBytes(bytes,'fixture.ipynb',{pages:'2'}));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('notebook SVG output carries source and fitted raster while unknown rich outputs leave receipts',async()=>{
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20" fill="red"/></svg>';
 const bytes=Buffer.from(JSON.stringify({nbformat:4,cells:[{cell_type:'code',source:['display()'],outputs:[{data:{'image/svg+xml':[svg]}},{data:{'application/pdf':'cGRmIGZpeHR1cmU='}},{data:{'application/vnd.example+json':{answer:42}}}]}]}));
 const result=await fileContentFromBytes(bytes,'output.ipynb');assert.ok(result.blocks.some(b=>b.type==='image'&&b.width===30&&b.height===20));assert.match(result.blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n'),/<svg/);assert.match(result.text,/Cell 1.*application\/pdf/);assert.match(result.text,/application\/vnd\.example\+json/);assert.doesNotMatch(result.text,/cGRmIGZpeHR1cmU=/);
 const text=await fileContentFromBytes(bytes,'output.ipynb',{limits:{images:false}});assert.ok(text.blocks.every(b=>b.type==='text'));assert.match(text.blocks.map(b=>b.type==='text'?b.text:'').join('\n'),/<svg/);
});
