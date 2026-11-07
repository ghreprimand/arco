import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { chatHtml } from './console.js';
const settled=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('phone transcript polling updates the same row and removes rows outside the retained window',async()=>{
 const dom=new JSDOM(chatHtml('instance','workflow','Fixture'),{url:'http://localhost',runScripts:'outside-only'});const win=dom.window;win.setInterval=(()=>0) as any;win.setTimeout=(()=>0) as any;
 const requests:string[]=[];let data:any={turns:[{role:'user',text:'old',seq:1},{role:'assistant',text:'first',seq:2}],totalTurns:2,cursor:2,startCursor:1,busy:true};
 win.fetch=async(url:any)=>{requests.push(String(url));return Response.json(data);};
 try{win.eval(win.document.querySelector('script')!.textContent!);await settled();
 data={turns:[{role:'assistant',text:'first second',seq:2}],totalTurns:2,cursor:3,startCursor:2,busy:false};await win.eval('poll()');
 assert.equal(win.document.querySelectorAll('.t-turn').length,1);assert.equal(win.document.querySelector('.t-text')?.textContent,'first second');assert.ok(requests.some(url=>url.includes('after=2')));assert.match(requests.at(-1)!,/after=0/);
 }finally{win.close();}
});

test('a byte-window shift fetches a complete replacement and inserts its first row in order',async()=>{
 const dom=new JSDOM(chatHtml('instance','workflow','Fixture'),{url:'http://localhost',runScripts:'outside-only'});const win=dom.window;win.setInterval=(()=>0) as any;win.setTimeout=(()=>0) as any;
 let phase=0;const requests:string[]=[];
 win.fetch=async(url:any)=>{const query=String(url);requests.push(query);if(phase===0)return Response.json({turns:[{role:'assistant',text:'old partial',seq:1},{role:'user',text:'middle user',seq:5},{role:'assistant',text:'middle answer',seq:6}],totalTurns:3,cursor:9,startCursor:1});
 return Response.json(query.includes('after=0')?{turns:[{role:'assistant',text:'retained partial',seq:4},{role:'user',text:'middle user',seq:5},{role:'assistant',text:'middle answer',seq:6}],totalTurns:3,cursor:10,startCursor:4}:{turns:[],totalTurns:3,cursor:10,startCursor:4});};
 try{win.eval(win.document.querySelector('script')!.textContent!);await settled();phase=1;await win.eval('poll()');assert.deepEqual([...win.document.querySelectorAll('.t-turn')].map(row=>row.getAttribute('data-seq')),['4','5','6']);assert.equal(win.document.querySelector('.t-text')?.textContent,'retained partial');assert.match(requests.at(-1)!,/after=0/);}
 finally{win.close();}
});
test('a service upgrade replaces legacy rows once stable cursors become available',async()=>{
 const dom=new JSDOM(chatHtml('instance','workflow','Fixture'),{url:'http://localhost',runScripts:'outside-only'});const win=dom.window;win.setInterval=(()=>0) as any;win.setTimeout=(()=>0) as any;let modern=false;
 win.fetch=async()=>Response.json(modern?{turns:[{role:'user',text:'same prompt',seq:1},{role:'assistant',text:'same answer',seq:2}],totalTurns:2,cursor:3,startCursor:1}:{turns:[{role:'user',text:'same prompt'},{role:'assistant',text:'same answer'}],totalTurns:2});
 try{win.eval(win.document.querySelector('script')!.textContent!);await settled();modern=true;await win.eval('poll()');assert.equal(win.document.querySelectorAll('.t-turn').length,2);assert.equal(win.document.querySelectorAll('.t-turn[data-seq]').length,2);}
 finally{win.close();}
});
