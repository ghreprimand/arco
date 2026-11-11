import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {useAppStore} from '../stores/appStore';
import {WorkflowStatusChip} from './WorkflowStatusChip';
test('expired chip hides on its own clock without a server message and fresh reconnect snapshot stays clear',async t=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',pretendToBeVisual:true});
 const saved=Object.getOwnPropertyDescriptors(globalThis),before=useAppStore.getState(),storage=useAppStore.persist.getOptions().storage;
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,key,{configurable:true,value});
 useAppStore.persist.setOptions({storage:{getItem:()=>null,setItem(){},removeItem(){}}});
 t.mock.timers.enable({apis:['Date','setInterval'],now:100_000});
 const root=createRoot(dom.window.document.getElementById('root')!);
 try{
  useAppStore.setState({quotaState:{codex:{throttled:true,resetsAt:101_000}} as any});
  await act(async()=>root.render(createElement(WorkflowStatusChip)));
  assert.match(dom.window.document.body.textContent!,/PROVIDER THROTTLING/);
  await act(async()=>t.mock.timers.tick(3_000));assert.doesNotMatch(dom.window.document.body.textContent!,/PROVIDER THROTTLING/);
  await act(async()=>useAppStore.setState({quotaState:{codex:{throttled:false}} as any}));
  assert.doesNotMatch(dom.window.document.body.textContent!,/PROVIDER THROTTLING/);
 }finally{
  await act(async()=>root.unmount());useAppStore.setState(before,true);useAppStore.persist.setOptions({storage});
  for(const name of ['window','document','localStorage','IS_REACT_ACT_ENVIRONMENT']){if(saved[name])Object.defineProperty(globalThis,name,saved[name]);else Reflect.deleteProperty(globalThis,name);}dom.window.close();
 }
});

test('usage recheck without headroom keeps the notice; Clear posts the provider and follows a broadcast',async t=>{
 const dom=new JSDOM('<button data-testid="header-layout">Layout</button><div id="root"></div>',{url:'http://localhost',pretendToBeVisual:true});
 const saved=Object.getOwnPropertyDescriptors(globalThis),before=useAppStore.getState(),storage=useAppStore.persist.getOptions().storage;
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,key,{configurable:true,value});
 useAppStore.persist.setOptions({storage:{getItem:()=>null,setItem(){},removeItem(){}}});
 const calls:unknown[]=[];
 t.mock.method(globalThis,'fetch',(async(_url:unknown,options:any)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({usage:{status:'unavailable',cleared:false,message:'Fresh usage is unavailable. The remembered limit is unchanged.'},providers:{codex:{throttled:false}}})};}) as any);
 const root=createRoot(dom.window.document.getElementById('root')!);
 try{
  useAppStore.setState({quotaState:{codex:{throttled:true}} as any});
  await act(async()=>root.render(createElement(WorkflowStatusChip)));
  await act(async()=>dom.window.document.querySelector('button[aria-haspopup]')!.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));
  assert.match(dom.window.document.body.textContent!,/does not re-arm a stopped goal run/);
  assert.match(dom.window.document.body.textContent!,/When usage shows headroom it clears the notice/);
  await act(async()=>dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Recheck CODEX usage"]')!.click());
  assert.match(dom.window.document.body.textContent!,/Fresh usage is unavailable/);assert.match(dom.window.document.body.textContent!,/PROVIDER THROTTLING/);
  await act(async()=>dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  assert.equal(dom.window.document.querySelector('[role="dialog"]'),null);
  assert.equal(dom.window.document.activeElement?.getAttribute('aria-haspopup'),'dialog');
  await act(async()=>dom.window.document.querySelector<HTMLButtonElement>('button[aria-haspopup]')!.click());
  const clear=dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Clear CODEX throttle"]')!;
  await act(async()=>{clear.focus();clear.click();});
  assert.deepEqual(calls,[{provider:'codex',action:'recheck'},{provider:'codex',action:'clear'}]);
  assert.match(dom.window.document.body.textContent!,/PROVIDER THROTTLING/,'HTTP snapshot must not overwrite a newer websocket event');
  await act(async()=>useAppStore.setState({quotaState:{codex:{throttled:false}} as any}));
  assert.doesNotMatch(dom.window.document.body.textContent!,/PROVIDER THROTTLING/);
  assert.equal(dom.window.document.activeElement?.textContent,'Layout');
  await act(async()=>useAppStore.setState({quotaState:{ollama:{throttled:true}} as any}));
  await act(async()=>dom.window.document.querySelector<HTMLButtonElement>('button[aria-haspopup]')!.click());
  assert.ok(dom.window.document.querySelector('[aria-label="Clear OLLAMA throttle"]'));
  assert.equal(dom.window.document.querySelector('[aria-label^="Recheck"]'),null);

 }finally{
  await act(async()=>root.unmount());useAppStore.setState(before,true);useAppStore.persist.setOptions({storage});t.mock.restoreAll();
  for(const name of ['window','document','localStorage','IS_REACT_ACT_ENVIRONMENT']){if(saved[name])Object.defineProperty(globalThis,name,saved[name]);else Reflect.deleteProperty(globalThis,name);}dom.window.close();
 }
});

async function harness(t:any,html:string,body:(dom:JSDOM,root:ReturnType<typeof createRoot>)=>Promise<void>){
 const dom=new JSDOM(html,{url:'http://localhost',pretendToBeVisual:true});
 const saved=Object.getOwnPropertyDescriptors(globalThis),before=useAppStore.getState(),storage=useAppStore.persist.getOptions().storage;
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,key,{configurable:true,value});
 useAppStore.persist.setOptions({storage:{getItem:()=>null,setItem(){},removeItem(){}}});
 const root=createRoot(dom.window.document.getElementById('root')!);
 try{await body(dom,root);}finally{
  await act(async()=>root.unmount());useAppStore.setState(before,true);useAppStore.persist.setOptions({storage});t.mock.restoreAll();t.mock.timers.reset();
  for(const name of ['window','document','localStorage','IS_REACT_ACT_ENVIRONMENT']){if(saved[name])Object.defineProperty(globalThis,name,saved[name]);else Reflect.deleteProperty(globalThis,name);}dom.window.close();
 }
}
const reply=(usage:unknown)=>(async()=>({ok:true,json:async()=>({usage,providers:{}})})) as any;

test('headroom recheck shows its result, then the cleared row goes and focus returns from the panel',async t=>{
 await harness(t,'<button data-testid="header-layout">Layout</button><div id="root"></div>',async(dom,root)=>{
  const doc=dom.window.document;
  t.mock.timers.enable({apis:['Date','setInterval','setTimeout'],now:100_000});
  t.mock.method(globalThis,'fetch',reply({status:'headroom',cleared:true,message:'Usage shows headroom. Notice cleared. If the provider is still limiting requests, the next turn will show it again.'}));
  useAppStore.setState({quotaState:{codex:{throttled:true}} as any});
  await act(async()=>root.render(createElement(WorkflowStatusChip)));
  await act(async()=>doc.querySelector<HTMLButtonElement>('button[aria-haspopup]')!.click());
  const recheck=doc.querySelector<HTMLButtonElement>('[aria-label="Recheck CODEX usage"]')!;
  await act(async()=>{recheck.focus();recheck.click();});
  await act(async()=>useAppStore.setState({quotaState:{codex:{throttled:false}} as any}));
  assert.match(doc.body.textContent!,/Usage shows headroom\. Notice cleared\./);assert.match(doc.body.textContent!,/notice cleared/);
  assert.equal(doc.activeElement,recheck);
  await act(async()=>t.mock.timers.tick(4_000));
  assert.doesNotMatch(doc.body.textContent!,/PROVIDER THROTTLING/);
  assert.equal(doc.activeElement?.textContent,'Layout');
 });
});

test('a row expiring by clock or by broadcast never takes focus from a composer after a recheck',async t=>{
 await harness(t,'<button data-testid="header-layout">Layout</button><textarea id="composer"></textarea><div id="root"></div>',async(dom,root)=>{
  const doc=dom.window.document;
  t.mock.timers.enable({apis:['Date','setInterval','setTimeout'],now:100_000});
  t.mock.method(globalThis,'fetch',reply({status:'unavailable',cleared:false,message:'Fresh usage is unavailable. The remembered limit is unchanged.'}));
  useAppStore.setState({quotaState:{codex:{throttled:true,resetsAt:101_000},claude:{throttled:true}} as any});
  await act(async()=>root.render(createElement(WorkflowStatusChip)));
  await act(async()=>doc.querySelector<HTMLButtonElement>('button[aria-haspopup]')!.click());
  for(const label of ['Recheck CODEX usage','Recheck CLAUDE usage']){const b=doc.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;await act(async()=>{b.focus();b.click();});}
  // Panel stays open; the user moves to the composer and types.
  const composer=doc.getElementById('composer') as HTMLTextAreaElement;
  await act(async()=>composer.focus());
  await act(async()=>t.mock.timers.tick(3_000));
  assert.equal(doc.querySelector('[aria-label="Recheck CODEX usage"]'),null,'codex row expired by clock');
  assert.equal(doc.activeElement,composer);
  await act(async()=>useAppStore.setState({quotaState:{codex:{throttled:false},claude:{throttled:false}} as any}));
  assert.doesNotMatch(doc.body.textContent!,/PROVIDER THROTTLING/);
  assert.equal(doc.activeElement,composer);
  // Panel closed after a recheck: a later broadcast expiry leaves focus alone too.
  useAppStore.setState({quotaState:{codex:{throttled:true}} as any});
  await act(async()=>{});
  await act(async()=>doc.querySelector<HTMLButtonElement>('button[aria-haspopup]')!.click());
  const again=doc.querySelector<HTMLButtonElement>('[aria-label="Recheck CODEX usage"]')!;
  await act(async()=>{again.focus();again.click();});
  await act(async()=>doc.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  await act(async()=>composer.focus());
  await act(async()=>useAppStore.setState({quotaState:{codex:{throttled:false}} as any}));
  assert.equal(doc.activeElement,composer);
 });
});

test('headroom result stays readable when the clearing broadcast arrives before the HTTP reply',async t=>{
 await harness(t,'<button data-testid="header-layout">Layout</button><div id="root"></div>',async(dom,root)=>{
  const doc=dom.window.document;
  t.mock.timers.enable({apis:['Date','setInterval','setTimeout'],now:100_000});
  let answer!:(v:unknown)=>void;
  t.mock.method(globalThis,'fetch',(async()=>({ok:true,json:()=>new Promise(r=>{answer=r;})})) as any);
  useAppStore.setState({quotaState:{codex:{throttled:true}} as any});
  await act(async()=>root.render(createElement(WorkflowStatusChip)));
  await act(async()=>doc.querySelector<HTMLButtonElement>('button[aria-haspopup]')!.click());
  const recheck=doc.querySelector<HTMLButtonElement>('[aria-label="Recheck CODEX usage"]')!;
  await act(async()=>{recheck.focus();recheck.click();});
  // The server broadcasts the clear before it answers the request.
  await act(async()=>useAppStore.setState({quotaState:{codex:{throttled:false}} as any}));
  assert.ok(doc.querySelector('[role="dialog"]'),'panel stays open while the recheck is pending');
  assert.equal(doc.activeElement,recheck);
  await act(async()=>answer({usage:{status:'headroom',cleared:true,message:'Usage shows headroom. Notice cleared. If the provider is still limiting requests, the next turn will show it again.'},providers:{}}));
  assert.match(doc.body.textContent!,/Usage shows headroom\. Notice cleared\./);
  await act(async()=>t.mock.timers.tick(4_000));
  assert.doesNotMatch(doc.body.textContent!,/PROVIDER THROTTLING/);
  assert.equal(doc.activeElement?.textContent,'Layout');
 });
});
