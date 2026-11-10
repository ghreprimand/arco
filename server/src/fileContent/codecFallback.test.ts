import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,realpath,writeFile,rm,readFile} from 'node:fs/promises';
import {join,delimiter} from 'node:path';
import {tmpdir} from 'node:os';
import {PNG} from 'pngjs';
import UTIF from 'utif';
import {fileContentFromBytes} from '../fileContent.js';
// Synthetic 16-square solid-color image, encoded with libheif 1.19.8 and x265.
const heic=Buffer.from('AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAX1tZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAAA5waXRtAAAAAAABAAAAImlsb2MAAAAAREAAAQABAAAAAAGhAAEAAAAAAAAANQAAACNpaW5mAAAAAAABAAAAFWluZmUCAAAAAAEAAGh2YzEAAAAA/WlwcnAAAADdaXBjbwAAAHZodmNDAQNwAAAAAAAAAAAAHvAA/P34+AAADwMgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQCEAAQAqQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbqrprm4CGgwIAAAAMAgAAAAwCEIgABAAZEAcFzwYkAAAATY29scm5jbHgAAQANAAaAAAAAFGlzcGUAAAAAAAAAQAAAAEAAAAAoY2xhcAAAABAAAAABAAAAEAAAAAH////QAAAAAv///9AAAAACAAAAEHBpeGkAAAAAAwgICAAAABhpcG1hAAAAAAAAAAEAAQWBAgMFhAAAAD1tZGF0AAAAMSgBrwTyFmc0cWTS3/sr///pOey/WSkEm1Qjs/RSxGAmv3XroGTEzROpbNAoK6inXqY=','base64');
function bitmap(){const b=Buffer.alloc(54+16*16*3);b.write('BM');b.writeUInt32LE(b.length,2);b.writeUInt32LE(54,10);b.writeUInt32LE(40,14);b.writeInt32LE(16,18);b.writeInt32LE(16,22);b.writeUInt16LE(1,26);b.writeUInt16LE(24,28);for(let i=54;i<b.length;i+=3){b[i]=80;b[i+1]=40;b[i+2]=200;}return b;}
const rgba=Uint8Array.from({length:16*16*4},(_,i)=>[200,40,80,255][i%4]);
const fixtures=[['HEIC',heic],['BMP',bitmap()],['TIFF',Buffer.from(UTIF.encodeImage(rgba,16,16))]] as const;
test('HEIC, standalone BMP and TIFF use bundled codecs when external programs are disabled',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'arco-codec-fallback-'))),marker=join(root,'invocations');const previous=process.env.PATH;
 try {
  if(process.platform!=='win32') {
   const wrong=new PNG({width:1,height:1});wrong.data.fill(255);
   const script=`#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'called\\n');if(process.argv.includes('-version'))console.log('fixture converter');else if(process.argv.includes('identify'))console.log('1 1');else fs.writeFileSync(process.argv.at(-1).replace(/^png:/,''),Buffer.from('${PNG.sync.write(wrong).toString('base64')}','base64'));`;
   await writeFile(join(root,'magick'),script,{mode:0o755});process.env.PATH=root+delimiter+(previous??'');
  }
  for(const [format,data] of fixtures) {
   const result=await fileContentFromBytes(data,'fixture.'+format.toLowerCase(),{externalPrograms:false});
   assert.equal(result.isError,false,result.text);const image=result.blocks.find(b=>b.type==='image');assert.ok(image&&image.type==='image');assert.equal(image.width,16,format);assert.equal(image.height,16,format);
   const pixels=PNG.sync.read(Buffer.from(image.data,'base64')).data;for(const [index,expected] of [200,40,80,255].entries())assert.ok(Math.abs(pixels[index]-expected)<=8,`${format} channel ${index}`);
  }
  await assert.rejects(readFile(marker),{code:'ENOENT'});
  if(process.platform!=='win32') {await fileContentFromBytes(bitmap(),'probe.bmp',{externalPrograms:true});assert.match(await readFile(marker,'utf8'),/called/,'the fake accelerator is observable when enabled');}
 }finally{if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;await rm(root,{recursive:true,force:true});}
});
