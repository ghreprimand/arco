import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { DEFAULT_NOTIFICATION_CHANNELS } from '@arco/shared';
import { useNotificationChannelsStore } from './notificationChannelsStore';

const pause=()=>new Promise(resolve=>setImmediate(resolve));
async function compile(file:string,start:string,end:string,returns:string,scope:Record<string,unknown>) {
  const text=await readFile(new URL(file,import.meta.url),'utf8');const a=text.indexOf(start);assert.ok(a>=0,start);const b=text.indexOf(end,a);assert.ok(b>a,end);
  const code=await transform(text.slice(a,b)+'\nreturn '+returns+';',{loader:'ts'});
  return new Function(...Object.keys(scope),code.code)(...Object.values(scope));
}
test('B166 quick compaction changes retain both edits',async()=>{
  let state:any={ollama:{compaction:{enabled:true,threshold:.85,warn:.75,keepLast:10}}};let tail=Promise.resolve();const pending:Promise<unknown>[]=[];
  const fetch=async(_url:string,opts:any)=>{const body=JSON.parse(opts.body);await pause();state={...state,...body};return new Response(JSON.stringify(state));};
  const queueSettingsPatch=(build:(s:any)=>any)=>{const p=tail.then(async()=>{await fetch('',{body:JSON.stringify(build(state))});});tail=p;pending.push(p);return p;};
  const setField=await compile('../components/RightPanel/ConfigTab.tsx','  const patch = async (next: OllamaCompactionConfig)','\n  return (','setField',{fetch,settings:state,setSettings:(s:any)=>{state=s;},enabled:true,thresholdPct:85,warnPct:75,keepLast:10,queueSettingsPatch});
  setField({enabled:false});setField({keepLast:22});await pause();await Promise.all(pending);await pause();
  assert.equal(state.ollama.compaction.enabled,false);assert.equal(state.ollama.compaction.keepLast,22);
});
test('B166 quick service pins retain both services',async()=>{
  let state:any={pinnedServices:[]};let tail=Promise.resolve();const pending:Promise<unknown>[]=[];
  const fetch=async(_url:string,opts:any)=>{const body=JSON.parse(opts.body);await pause();state={...state,...body};return new Response(JSON.stringify(state));};
  const queueSettingsPatch=(build:(s:any)=>any)=>{const p=tail.then(async()=>{await fetch('',{body:JSON.stringify(build(state))});});tail=p;pending.push(p);return p;};
  const toggle=await compile('../components/ServicesTab.tsx','  const persistPins =','\n  if (loading','togglePin',{fetch,setSettings:(s:any)=>{state=s;},pinned:[],pinnedKeys:new Set(),pinKey:(cwd:string,port:number)=>`${cwd}:${port}`,queueSettingsPatch});
  toggle('fixture',8001);toggle('fixture',8002);await pause();await Promise.all(pending);await pause();assert.deepEqual(state.pinnedServices.map((p:any)=>p.port),[8001,8002]);
});
test('B166 quick notification changes merge after the preceding save',async(t)=>{
  const view={...structuredClone(DEFAULT_NOTIFICATION_CHANNELS),ntfy:{...DEFAULT_NOTIFICATION_CHANNELS.ntfy,tokenSet:false},ntfyFromEnvironment:false};
  useNotificationChannelsStore.setState({view,error:''});let saved:any=view;
  t.mock.method(globalThis,'fetch',async(_url:unknown,opts:any)=>{const payload=JSON.parse(opts.body);await pause();saved={...payload,ntfy:{...payload.ntfy,tokenSet:false},ntfyFromEnvironment:false};return new Response(JSON.stringify(saved));});
  const f=await compile('../components/NotificationChannelsSettings.tsx','  const base =','\n  const addressProblem','({togglePhone,toggleDesktop})',{view,save:useNotificationChannelsStore.getState().save});
  await Promise.all([f.togglePhone('finished',true),f.togglePhone('failed',true)]);
  assert.equal(saved.phone.finished,true);assert.equal(saved.phone.failed,true);assert.deepEqual(useNotificationChannelsStore.getState().view,saved);
});

test('B166 settings writer permits one request at a time and recovers after a refused save',async()=>{
  let state:any={enabledProviders:{claude:true},ollama:{compaction:{enabled:true,keepLast:10}}};
  const requests:Array<{body:any;resolve:(r:Response)=>void}>=[];const notices:string[]=[];
  const source=await readFile(new URL('../utils/settingsRequests.ts',import.meta.url),'utf8');
  const output=await transform(source,{loader:'ts',format:'cjs'});const module={exports:{} as any};
  const require=(name:string)=>name.includes('appStore')?{useAppStore:{getState:()=>({settings:state,setSettings:(s:any)=>{state=s;},pushNotification:(_kind:string,text:string)=>notices.push(text)})}}:{validateSettings:(v:any)=>!!v.enabledProviders};
  new Function('require','module','exports','fetch',output.code)(require,module,module.exports,(_url:unknown,opts:any)=>new Promise<Response>(resolve=>requests.push({body:JSON.parse(opts.body),resolve})));
  const queue=module.exports.queueSettingsPatch;
  const first=queue((current:any)=>({ollama:{compaction:{...current.ollama.compaction,enabled:false}}}));
  const second=queue((current:any)=>({ollama:{compaction:{...current.ollama.compaction,keepLast:22}}}));
  await pause();assert.equal(requests.length,1);
  requests[0].resolve(new Response(JSON.stringify({...state,...requests[0].body})));
  await first;await pause();assert.equal(requests.length,2);assert.equal(requests[1].body.ollama.compaction.enabled,false);
  requests[1].resolve(new Response('{"error":"unavailable"}',{status:500}));assert.equal(await second,false);assert.equal(state.ollama.compaction.keepLast,10);assert.ok(notices.length);
  const third=queue((current:any)=>({ollama:{compaction:{...current.ollama.compaction,keepLast:30}}}));await pause();requests[2].resolve(new Response(JSON.stringify({...state,...requests[2].body})));assert.equal(await third,true);assert.equal(state.ollama.compaction.keepLast,30);
});
