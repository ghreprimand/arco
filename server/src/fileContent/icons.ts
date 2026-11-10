import bmp from 'bmp-js';
import type { Pixels } from './images.js';
/** ICO directories select the largest entry, never concatenate image payloads. */
export function iconPayload(bytes: Buffer): Buffer {
  if (bytes.length < 6) throw new Error('Incomplete icon directory');
  const count=bytes.readUInt16LE(4);
  if (!count || count > 4096 || bytes.length < 6+16*count) throw new Error('Invalid icon directory');
  let largest=-1, selected:Buffer|undefined;
  for(let i=0;i<count;i++) {
    const at=6+16*i, area=(bytes[at]||256)*(bytes[at+1]||256), length=bytes.readUInt32LE(at+8), offset=bytes.readUInt32LE(at+12);
    if(offset<6+16*count || !length || offset+length>bytes.length) throw new Error('Invalid icon entry');
    if(area>largest){largest=area;selected=bytes.subarray(offset,offset+length);}
  }
  return selected!;
}
export function iconBitmap(dib:Buffer):Pixels {
  if(dib.length<40 || dib.readUInt32LE(0)!==40) throw new Error('Unsupported icon bitmap header');
  const width=dib.readInt32LE(4), storedHeight=dib.readInt32LE(8), height=Math.abs(storedHeight)/2, bits=dib.readUInt16LE(14);
  if(width<1||width>256||height<1||height>256||!Number.isInteger(height)||![1,4,8,16,24,32].includes(bits)||dib.readUInt32LE(16)!==0) throw new Error('Unsupported icon bitmap dimensions or encoding');
  const colors=bits<=8?(dib.readUInt32LE(32)||2**bits):0;
  if(colors>256) throw new Error('Invalid icon palette');
  const start=40+colors*4, stride=Math.ceil(width*bits/32)*4, maskStride=Math.ceil(width/32)*4, maskStart=start+stride*height;
  if(dib.length<maskStart) throw new Error('Incomplete icon pixels');
  const header=Buffer.alloc(14);header.write('BM');header.writeUInt32LE(14+dib.length,2);header.writeUInt32LE(14+start,10);
  const body=Buffer.from(dib);body.writeInt32LE(storedHeight<0?-height:height,8);
  const decoded=bmp.decode(Buffer.concat([header,body]));
  const data=new Uint8Array(width*height*4);
  let hasAlpha=false;
  if(bits===32)for(let y=0;y<height;y++)for(let x=0;x<width;x++)hasAlpha ||= dib[start+y*stride+x*4+3]!==0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const i=(y*width+x)*4, row=storedHeight<0?y:height-1-y;
    data[i]=decoded.data[i+3];data[i+1]=decoded.data[i+2];data[i+2]=decoded.data[i+1];
    data[i+3]=bits===32&&hasAlpha?dib[start+row*stride+x*4+3]:255;
    if(dib.length>=maskStart+maskStride*height && (dib[maskStart+row*maskStride+(x>>3)]&(128>>(x%8))))data[i+3]=0;
  }
  return {width,height,data};
}
