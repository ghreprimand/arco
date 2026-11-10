import { createInflate } from 'node:zlib';
import { once } from 'node:events';
import type { Pixels } from './images.js';
const table=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
export function pngCrc(bytes:Uint8Array):number {let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}

/** Non-interlaced PNG: retain only two scanlines and the fitted output. */
export async function decodePngRows(bytes:Buffer,edge:number):Promise<Pixels|null> {
  if(bytes.length<33)throw new Error('Incomplete PNG');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20),depth=bytes[24],color=bytes[25];
  if(!width||!height||width*height>512_000_000)throw new Error('Image is too large to scale safely (PNG limit 512 megapixels); crop or export a smaller image.');
  if(bytes[28]!==0)return null;
  const channels=({0:1,2:3,3:1,4:2,6:4} as Record<number,number>)[color];
  if(!channels||![1,2,4,8,16].includes(depth)||((color!==0&&color!==3)&&depth<8))throw new Error('Unsupported PNG sample format');
  const stride=Math.ceil(width*channels*depth/8),bpp=Math.max(1,Math.ceil(channels*depth/8));
  const compressed:Buffer[]=[];let palette:Buffer|undefined,transparency:Buffer|undefined,ended=false;
  for(let pos=8;pos+12<=bytes.length;){
    const length=bytes.readUInt32BE(pos),end=pos+12+length;if(end>bytes.length)throw new Error('Incomplete PNG chunk');
    const tag=bytes.toString('ascii',pos+4,pos+8),body=bytes.subarray(pos+8,pos+8+length);
    if(pngCrc(bytes.subarray(pos+4,pos+8+length))!==bytes.readUInt32BE(pos+8+length))throw new Error('PNG checksum mismatch');
    if(tag==='IDAT')compressed.push(body);else if(tag==='PLTE')palette=body;else if(tag==='tRNS')transparency=body;else if(tag==='IEND'){ended=true;break;}
    pos=end;
  }
  if(!ended||!compressed.length)throw new Error('PNG has no complete image data');
  const scale=Math.min(1,edge/Math.max(width,height)),w=Math.max(1,Math.round(width*scale)),h=Math.max(1,Math.round(height*scale));
  const output=new Uint8Array(w*h*4),row=Buffer.alloc(stride+1),previous=Buffer.alloc(stride);
  let used=0,y=0,oy=0;
  const paeth=(a:number,b:number,c:number)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  const sample=(x:number,c:number)=>{const at=(x*channels+c)*depth;if(depth===16)return row[1+at/8];if(depth===8)return row[1+at/8];return ((row[1+Math.floor(at/8)]>>>(8-depth-at%8))&((1<<depth)-1))*255/((1<<depth)-1);};
  const processRow=()=>{
    if(y>=height)throw new Error('PNG contains excess decompressed data');
    const filter=row[0];if(filter>4)throw new Error('Invalid PNG filter');
    if(filter)for(let i=0;i<stride;i++){const a=i>=bpp?row[1+i-bpp]:0,b=previous[i],c=i>=bpp?previous[i-bpp]:0;row[i+1]=(row[i+1]+(filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c)))&255;}
    if(oy<h&&y===Math.min(height-1,Math.floor((oy+.5)*height/h))){
      for(let ox=0;ox<w;ox++){
        const x=Math.min(width-1,Math.floor((ox+.5)*width/w)),at=(oy*w+ox)*4;
        if(color===3){const bit=x*depth,index=(row[1+Math.floor(bit/8)]>>>(8-depth-bit%8))&((1<<depth)-1);if(!palette||index*3+2>=palette.length)throw new Error('Invalid PNG palette');output[at]=palette[index*3];output[at+1]=palette[index*3+1];output[at+2]=palette[index*3+2];output[at+3]=transparency?.[index]??255;}
        else {const r=sample(x,0),g=color===0||color===4?r:sample(x,1),b=color===0||color===4?r:sample(x,2);output[at]=r;output[at+1]=g;output[at+2]=b;output[at+3]=color===4?sample(x,1):color===6?sample(x,3):255;
          const raw=(channel:number)=>{const bit=(x*channels+channel)*depth;return depth===16?row.readUInt16BE(1+bit/8):depth===8?row[1+bit/8]:(row[1+Math.floor(bit/8)]>>>(8-depth-bit%8))&((1<<depth)-1);};
          if(transparency&&color===0&&transparency.length>=2&&raw(0)===transparency.readUInt16BE(0))output[at+3]=0;
          if(transparency&&color===2&&transparency.length>=6&&[0,1,2].every(c=>raw(c)===transparency!.readUInt16BE(c*2)))output[at+3]=0;
        }
      }
      oy++;
    }
    row.copy(previous,0,1);y++;used=0;
  };
  const inflate=createInflate();
  const pump=(async()=>{for(const chunk of compressed){if(!inflate.write(chunk))await once(inflate,'drain');}inflate.end();})().catch(error=>{inflate.destroy(error);});
  try {for await(const raw of inflate){const chunk=raw as Buffer;for(let offset=0;offset<chunk.length;){const n=Math.min(row.length-used,chunk.length-offset);chunk.copy(row,used,offset,offset+n);used+=n;offset+=n;if(used===row.length)processRow();}}await pump;}
  finally {inflate.destroy();}
  if(y!==height||used||oy!==h)throw new Error('Incomplete PNG pixels');
  return {width:w,height:h,data:output,originalWidth:width,originalHeight:height};
}
