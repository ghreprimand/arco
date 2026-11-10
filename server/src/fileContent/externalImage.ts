import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { Pixels } from './images.js';
const run=promisify(execFile);
/** Optional acceleration only; portable codecs always remain the fallback. */
export async function externalImage(bytes:Buffer,media:string,edge:number,enabled=true):Promise<Pixels|null>{
  if(!enabled)return null;
  let directory:string|undefined;
  try {
    for(const tool of ['magick','convert',...(process.platform==='darwin'?['/usr/bin/sips']:[])]){
      try {await run(tool,tool.endsWith('sips')?['--version']:['-version'],{timeout:1000,maxBuffer:8192});}catch{continue;}
      directory??=await mkdtemp(join(tmpdir(),'arco-file-image-'));
      const input=join(directory,'source.'+media.split('/')[1]),output=join(directory,'fitted.png');
      await writeFile(input,bytes);
      try {
        let width:number|undefined,height:number|undefined;
        if(tool.endsWith('sips')){
          const probe=await run(tool,['-g','pixelWidth','-g','pixelHeight',input],{timeout:2000,maxBuffer:8192});
          width=Number(/pixelWidth:\s*(\d+)/.exec(probe.stdout)?.[1]);height=Number(/pixelHeight:\s*(\d+)/.exec(probe.stdout)?.[1]);
          await run(tool,['-Z',String(edge),'-s','format','png',input,'--out',output],{timeout:8000,maxBuffer:8192});
        }else{
          const probe=await run(tool==='magick'?'magick':'identify',[...(tool==='magick'?['identify']:[]),'-format','%w %h',`${input}[0]`],{timeout:2000,maxBuffer:8192});
          [width,height]=probe.stdout.trim().split(/\s+/).map(Number);
          if(width*height>512_000_000)return null;
          await run(tool,['-limit','thread','1','-limit','memory','256MiB','-limit','map','512MiB','-define',`jpeg:size=${edge}x${edge}`,`${input}[0]`,'-auto-orient','-resize',`${edge}x${edge}>`,`png:${output}`],{timeout:8000,maxBuffer:8192});
        }
        if((await stat(output)).size>32*1024*1024)continue;
        const png=PNG.sync.read(await readFile(output));
        if(png.width>edge||png.height>edge)continue;
        return {width:png.width,height:png.height,data:png.data,originalWidth:width,originalHeight:height};
      }catch{ return null; /* Bound the optional attempt before the worker deadline. */ }
    }
    return null;
  }finally{if(directory)await rm(directory,{recursive:true,force:true});}
}
