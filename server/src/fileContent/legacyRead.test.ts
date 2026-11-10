import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readFileContent,fileContentFromBytes} from '../fileContent.js';
test('Windows-1252 reads preserve selected lines and identify the decoding',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'arco-legacy-read-')));
 try {
  const path=join(root,'cafe.txt'),bytes=Buffer.concat([Buffer.from('first\ncaf'),Buffer.from([0xe9]),Buffer.from('\nlast')]);await writeFile(path,bytes);
  const file=await readFileContent(path,{offset:2,limit:1}),buffer=await fileContentFromBytes(bytes,'cafe.txt',{offset:2,limit:1});
  assert.equal(file.kind,'text');assert.equal(file.text,'[decoded as Windows-1252]\ncafé');assert.equal(buffer.kind,'text');assert.match(buffer.text,/^\[decoded as Windows-1252\]\ncafé(?:\n|$)/);assert.doesNotMatch(file.text+buffer.text,/first|last/);
  assert.deepEqual(await readFileContent(path,{offset:2}),await fileContentFromBytes(bytes,'cafe.txt',{offset:2}));
  const late=Buffer.concat([Buffer.from('a'.repeat(5000)+'\ncaf'),Buffer.from([0xe9]),Buffer.from('\nlast')]);await writeFile(path,late);
  assert.equal((await readFileContent(path,{offset:2,limit:1})).text,'[decoded as Windows-1252]\ncafé');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('NUL-free random bytes with excessive controls remain a binary receipt',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'arco-random-bytes-')));
 try {
  const bytes=Buffer.from(Array.from({length:200},(_,i)=>i%10===0?1:255)),path=join(root,'random.txt');await writeFile(path,bytes);
  for(const result of [await readFileContent(path),await fileContentFromBytes(bytes,'random.txt')]){assert.equal(result.kind,'binary');assert.match(result.text,/not sent as text/);assert.doesNotMatch(result.text,/decoded as Windows/);}
 }finally{await rm(root,{recursive:true,force:true});}
});
