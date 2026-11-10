import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { fittedImage } from './images.js';
import { positive, textResult, type FileContentOptions, type FileContentResult } from './types.js';
const require=createRequire(import.meta.url);
let initialized:Promise<void>|undefined;
/** WASM receives only SVG bytes and empty font buffers, with no resource resolver. */
export async function svgResult(source:string,name:string,options:FileContentOptions):Promise<FileContentResult> {
  const result=textResult('svg',source,options);
  if(options.limits?.images===false)return result;
  const note='SVG preview omits external resources and text that requires system fonts.';
  try {
    if(/<!DOCTYPE|<!ENTITY/i.test(source))throw new Error('SVG DOCTYPE and entity declarations are not rendered.');
    const doc=new DOMParser({onError:()=>{throw new Error('Invalid SVG XML');}}).parseFromString(source,'image/svg+xml');
    if(doc.documentElement?.localName!=='svg')throw new Error('Invalid SVG root');
    // Keep local fragment references. Never resolve files, URLs or embedded resources.
    for(const node of Array.from(doc.getElementsByTagName('*'))) {
      for(const attr of Array.from(node.attributes))if((attr.localName==='href'||attr.name==='src')&&!attr.value.startsWith('#'))node.removeAttributeNode(attr);
    }
    initialized ??= initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
    await initialized;
    const xml=new XMLSerializer().serializeToString(doc);
    const base={font:{fontBuffers:[] as Uint8Array[],loadSystemFonts:false}};
    const measure=new Resvg(xml,base);
    const width=measure.width,height=measure.height;measure.free();
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new Error('Invalid SVG dimensions');
    const edge=positive(options.limits?.maxImageEdge,2000,2000);
    const renderer=new Resvg(xml,{...base,fitTo:{mode:width>=height?'width':'height',value:Math.min(edge,Math.max(width,height))}});
    try {
      const rendered=renderer.render();
      try {result.blocks.push(fittedImage({width:rendered.width,height:rendered.height,data:rendered.pixels},name,options));}
      finally {rendered.free();}
    } finally {renderer.free();}
    result.text+='\n['+note+']';result.blocks.push({type:'text',text:note});
  } catch(error) {
    const note='SVG source retained; preview unavailable: '+(error instanceof Error?error.message:'rendering failed');
    result.text+='\n['+note+']';result.blocks.push({type:'text',text:note});
  }
  return result;
}
