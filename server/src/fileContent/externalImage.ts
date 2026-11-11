import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { Pixels } from './images.js';
const run=promisify(execFile);
function validDimensions(width:number,height:number):boolean {
  return Number.isSafeInteger(width)&&Number.isSafeInteger(height)
    &&width>0&&height>0&&width*height<=512_000_000;
}
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
          if(!validDimensions(width,height))return null;
          await run(tool,['-Z',String(Math.min(edge,Math.max(width,height))),'-s','format','png',input,'--out',output],{timeout:8000,maxBuffer:8192});
        }else{
          const probe=await run(tool==='magick'?'magick':'identify',[...(tool==='magick'?['identify']:[]),'-format','%w %h',`${input}[0]`],{timeout:2000,maxBuffer:8192});
          [width,height]=probe.stdout.trim().split(/\s+/).map(Number);
          if(!validDimensions(width,height))return null;
          // The JPEG decoder hint can upscale before the shrink-only resize.
          const decodeWidth=Math.min(edge,width),decodeHeight=Math.min(edge,height);
          await run(tool,['-limit','thread','1','-limit','memory','256MiB','-limit','map','512MiB','-define',`jpeg:size=${decodeWidth}x${decodeHeight}`,`${input}[0]`,'-auto-orient','-resize',`${edge}x${edge}>`,`png:${output}`],{timeout:8000,maxBuffer:8192});
        }
        if((await stat(output)).size>32*1024*1024)continue;
        const png=PNG.sync.read(await readFile(output));
        // Auto-orientation may swap axes, but must never enlarge either edge.
        if(png.width>edge||png.height>edge
          ||Math.max(png.width,png.height)>Math.max(width,height)
          ||Math.min(png.width,png.height)>Math.min(width,height))return null;
        return {width:png.width,height:png.height,data:png.data,originalWidth:width,originalHeight:height};
      }catch{ return null; /* Bound the optional attempt before the worker deadline. */ }
    }
    return null;
  }finally{if(directory)await rm(directory,{recursive:true,force:true});}
}
