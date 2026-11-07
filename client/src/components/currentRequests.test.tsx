import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const g = globalThis as any;
async function component(relative: string, expose = '', extra: Record<string, string> = {}, transform = (s: string) => s) {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  g.__markdownComponent = (await import('react-markdown')).default;
  g.__remark = (await import('remark-gfm')).default;
  g.__rehype = (await import('rehype-highlight')).default;
  const mocks = {
    'remark-gfm': 'module.exports=globalThis.__remark;',
    'rehype-highlight': 'module.exports=globalThis.__rehype;',
    'react-markdown': 'module.exports=globalThis.__markdownComponent;',
    appStore: 'exports.useAppStore = selector => selector(globalThis.__asyncState);',
    ...extra,
  };
  const result = await build({ stdin: { contents: transform(await readFile(path, 'utf8')) + (expose ? `\nexport { ${expose} };` : ''), resolveDir: dirname(path), sourcefile: path, loader: 'tsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    plugins: [{ name: 'synthetic-ui', setup(b) {
      b.onResolve({ filter: /.*/ }, a => {
        if (['react','react/jsx-runtime'].includes(a.path)) return {path:a.path,external:true};
        if (a.path.endsWith('.css')) return { path: 'empty', namespace: 'fixture' };
        const key = Object.keys(mocks).find(k => a.path === k || a.path.endsWith('/' + k));
        return key ? { path: key, namespace: 'fixture' } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: a.path === 'empty' ? '' : mocks[a.path as keyof typeof mocks] }));
    } }],
  });
  const module = { exports: {} as Record<string, React.ComponentType<any>> };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}
async function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const before = Object.getOwnPropertyDescriptors(globalThis), clock = Date.now;
  const state: any = { settings: {}, jobs: {}, connectionState: 'online', clearRecovered() {}, pushNotification() {} };
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, navigator: dom.window.navigator, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, __asyncState: state };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(g, key, { configurable: true, writable: true, value });
  let id = 0; const timers = new Map<number, () => void>();
  dom.window.setInterval = dom.window.setTimeout = ((fn: () => void) => { timers.set(++id, fn); return id; }) as any;
  dom.window.clearInterval = dom.window.clearTimeout = (n: number) => { timers.delete(n); };
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  const scrolled: string[] = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.id); };
  const root = createRoot(document.getElementById('root')!);
  let mounted = true;
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false; } };
  return { dom, state, timers, root, unmount, scrolled,
    render: async (C: React.ComponentType<any>, props: any = {}) => { await act(async () => root.render(React.createElement(C, props))); },
    click: async (text: string) => { const b = [...document.querySelectorAll('button')].find(b => b.textContent === text); assert.ok(b, text); await act(async () => b.click()); },
    close: async () => { await unmount(); Date.now = clock; dom.window.close(); for (const key of [...Object.keys(globals), 'fetch', '__capture', '__comparison', '__recall', '__pendingUi']) { if (before[key]) Object.defineProperty(g, key, before[key]); else delete g[key]; } },
  };
}

// Mount the actual hook/handler sections when the complete surface requires
// unrelated terminal, drag-and-drop or provider setup. The source is compiled
// in place, so assertions exercise the production callbacks and dependencies.
const harness = (body: string) => `import {useState,useRef,useEffect,useCallback,useMemo} from 'react';export function Harness(props:any){${body}}`;
const section = (s: string, start: string, end: string) => s.slice(s.indexOf(start), s.indexOf(end, s.indexOf(start)));
const noop = () => {};

for (const file of ['ChatModeView.tsx', 'TerminalInput.tsx']) test(`B141: ${file} retains the upload guard until every batch settles`, async () => {
  const f = await fixture(); const pending: Array<(r:any)=>void> = []; const attached: string[] = [];
  try {
    const {Harness} = await component('./'+file, '', {}, s => harness(`
      const {onUpload,addAttachment}=props; const job={id:'fixture'}; const canAttach=true;
      ${section(s,'  const [pendingUploads,','  const uploading =')}const uploading=pendingUploads>0;
      const [uploadError,setUploadError]=useState(null);
      ${section(s, '  const uploadAndAppend =', '\n  //')}
      return <><button onClick={()=>uploadAndAppend([{name:'fixture.txt',type:'text/plain'}])}>UPLOAD</button><button disabled={uploading}>SEND</button></>;
    `));
    await f.render(Harness,{onUpload:()=>new Promise(r=>pending.push(r)),addAttachment:(_:string,a:any)=>attached.push(a.path)});
    await f.click('UPLOAD'); await f.click('UPLOAD'); assert.equal(pending.length,2);
    await act(async()=>pending[0]({ok:true,path:'first',filename:'first'}));
    assert.equal([...document.querySelectorAll('button')].find(b=>b.textContent==='SEND')!.disabled,true);
    await act(async()=>pending[1]({ok:true,path:'second',filename:'second'}));
    assert.equal([...document.querySelectorAll('button')].find(b=>b.textContent==='SEND')!.disabled,false);
    assert.deepEqual(attached,['first','second']);
  } finally {await f.close();}
});

test('B143: history expands prior sessions before scrolling to its target',async()=>{
  const f=await fixture(); const jumps:number[]=[];
  try {
    const {Harness}=await component('./ChatPanel.tsx','',{},s=>harness(`
      const job={id:'fixture'}; const displayMessages=[{id:'old',role:'user',content:'old'},{id:'seed',role:'user',content:'seed'},{id:'new',role:'assistant',content:'new'}];
      const isHandoffSeed=(s:string)=>s==='seed';const [priorSessionsExpanded,setPriorSessionsExpanded]=useState(false);
      ${section(s,'  const { visibleRows,','\n  // Phase 8') .split('  const virtualizer =')[0].split('  // Virtualizer')[0]}
      const virtualizer={scrollToIndex:props.jump};const pinnedToBottom=useRef(true);const useAppStore=(fn:any)=>fn({flashTarget:props.target});
      ${section(s,'  const flashTarget =','\n  // Track scroll-position')}
      return <div>{visibleRows.map((r:any)=><span key={r.key}>{r.kind==='message'?r.message.content:'PRIOR'}</span>)}</div>;
    `));
    await f.render(Harness,{jump:(i:number)=>jumps.push(i),target:{jobId:'fixture',messageId:'old',at:1}});
    assert.ok(document.body.textContent?.includes('old')); assert.ok(jumps.includes(1));
  }finally{await f.close();}
});

test('B146: task drawer follows snapshots and clears auxiliary details on selection',async()=>{
  const f=await fixture();const pending:Array<(r:Response)=>void>=[];g.fetch=()=>new Promise(r=>pending.push(r));
  try {
    const {Harness}=await component('./ClusterTaskBoardTab.tsx','',{},s=>harness(`
      const {tasks,selectedTaskId}=props;const cluster={clusterId:'fixture'};const taskShowReader='member';
      const [details,setDetails]=useState(null);const [detailsError,setDetailsError]=useState(null);const [loadingDetails,setLoadingDetails]=useState(false);
      ${section(s,'  const selectedTask =','  const graph =')}
      ${section(s,'  useEffect(() => {\n    if (!selectedTaskId)', '\n  return (')}
      return <div>{JSON.stringify({selectedTask,details})}</div>;
    `));
    const row={id:'one',status:'todo'};await f.render(Harness,{tasks:[row],selectedTaskId:'one'});
    await act(async()=>pending[0](Response.json({task:row,comments:['old comment'],runs:['old run']})));
    await f.render(Harness,{tasks:[{...row,status:'review'}],selectedTaskId:'one'});
    assert.ok(document.body.textContent?.includes('review'));assert.equal(pending.length,2);
    await act(async()=>pending[1](Response.json({task:{...row,status:'review'},comments:['new comment'],runs:[]})));
    assert.ok(document.body.textContent?.includes('new comment'));
    await f.render(Harness,{tasks:[{id:'two',status:'todo'}],selectedTaskId:'two'});
    assert.ok(!document.body.textContent?.includes('new comment')); assert.ok(!document.body.textContent?.includes('old run'));
    await act(async()=>pending[2](Response.json({task:{id:'two',status:'todo'},comments:[],runs:[]})));
  }finally{await f.close();}
});

test('B151: a palette file result replaces the palette until the viewer closes',async()=>{
  const f=await fixture();let closed=0;
  f.state.activeJobId='fixture';f.state.jobs={fixture:{id:'fixture',config:{workingDirectory:'/projects/fixture'},messages:[]}};
  g.fetch=async()=>Response.json({files:[{name:'notes.txt',path:'/projects/fixture/notes.txt',isDirectory:false}]});
  try {
    const {CommandPalette}=await component('./CommandPalette.tsx','',{FileViewerModal:`exports.FileViewerModal=({onClose})=>require('react').createElement('button',{onClick:onClose},'VIEWER CLOSE');`,computerStore:'exports.useComputerStore=fn=>fn({});'});
    await f.render(CommandPalette,{onClose:()=>closed++});
    const result=[...document.querySelectorAll<HTMLElement>('[data-idx]')].find(b=>b.textContent?.includes('notes.txt'));assert.ok(result,document.body.textContent!);
    await act(async()=>result.click());assert.equal(Boolean(document.querySelector('input')),false);
    await f.click('VIEWER CLOSE');assert.ok(document.querySelector('input'));assert.equal(closed,0);
  }finally{await f.close();}
});

test('B156: history advances the server cursor through pages without narrative rows',async()=>{
  const f=await fixture(); const cursors:string[]=[];
  g.fetch=async(url:string)=>{cursors.push(new URL(url,'http://localhost').searchParams.get('beforeSeq')!);return Response.json({events:[],hasEarlier:true,earlierCursor:cursors.length===1?500:100});};
  try{
    const {HistoryTab}=await component('./HistoryTab.tsx');
    await f.render(HistoryTab,{job:{id:'fixture',config:{workingDirectory:'/projects/fixture'},messages:[],historyEvents:[{seq:1000,category:'user',text:'Latest',at:1}]}});
    await f.click('LOAD EARLIER HISTORY');await f.click('LOAD EARLIER HISTORY');assert.deepEqual(cursors,['1000','500']);
  }finally{await f.close();}
});

test('B160: preview fit uses layout dimensions under root zoom',async()=>{
  const f=await fixture();let resize:()=>void=noop;
  const old=Object.getOwnPropertyDescriptor(g,'ResizeObserver');
  g.ResizeObserver=class{constructor(fn:()=>void){resize=fn;}observe(){}disconnect(){}};
  f.dom.window.HTMLElement.prototype.getBoundingClientRect=function(){return {width:900,height:600} as DOMRect;};
  Object.defineProperty(f.dom.window.HTMLElement.prototype,'clientWidth',{get:()=>600});
  Object.defineProperty(f.dom.window.HTMLElement.prototype,'clientHeight',{get:()=>400});
  try{
    const {PreviewTab}=await component('./PreviewTab.tsx');
    await f.render(PreviewTab,{job:{id:'fixture',config:{workingDirectory:'/projects/fixture'},preview:{port:5173},messages:[]}});
    await act(async()=>resize());
    const iframe=document.querySelector('iframe')!;assert.ok(iframe);
    const box=iframe.parentElement!; assert.ok(parseFloat(box.style.width)<=600,box.style.cssText);assert.ok(parseFloat(box.style.height)<=400,box.style.cssText);
  }finally{if(old)Object.defineProperty(g,'ResizeObserver',old);else delete g.ResizeObserver;await f.close();}
});

test('B161: cluster preview actions dispatch to the member in view',async()=>{
  const f=await fixture();const sent:any[]=[];
  f.state.jobs={member:{id:'member'}};f.state.wsSendRaw=(m:any)=>sent.push(m);
  try{
    const {Harness}=await component('./ClusterRightPanel/index.tsx','',{},s=>`import React from 'react';const useMemberInView=()=>({workflowId:'member'});const useAppStore=fn=>fn(globalThis.__asyncState);const MemberInViewHeader=()=>null;const PreviewTab=({onCapture})=><>{['screenshot','console','network'].map(k=><button key={k} onClick={()=>onCapture?.([k],'mobile')}>{k}</button>)}</>;${section(s,'function ClusterAnchoredPreview(', '\n}',)+ '\n}'};export const Harness=ClusterAnchoredPreview;`);
    await f.render(Harness,{cluster:{clusterId:'fixture'}});
    for(const k of ['screenshot','console','network'])await f.click(k);
    assert.deepEqual(sent,['screenshot','console','network'].map(k=>({type:'preview_capture_request',workflowId:'member',captures:[k],viewport:'mobile'})));
  }finally{await f.close();}
});

test('B162: missing saved summaries expose explicit regeneration',async()=>{
  const f=await fixture();const requests:string[]=[];
  g.__recall={hits:[{wfid:'fixture',title:'Fixture',project:'fixture',cwd:'/projects/fixture',provider:'claude',summaryRef:'missing',lastActiveAt:1,tags:[],links:[],matchedIn:'title',snippet:''}],loading:false,query:'',summarizing:{},summaryBodies:{},fetchSummary:async()=>null,setSummarizing:noop,search:noop,setQuery:noop,setSummarizeOnClose:noop};
  try{
    const {RecallView}=await component('./Recall/RecallView.tsx','',{recallStore:'exports.EMPTY_FILTERS={};exports.useRecallStore=fn=>fn(globalThis.__recall);'});
    await f.render(RecallView,{onClose:noop,requestRecallSummary:(id:string)=>{requests.push(id);return true;}});
    await f.click('OPEN SUMMARY');await f.click('REGENERATE SUMMARY');assert.deepEqual(requests,['fixture']);
  }finally{await f.close();}
});

test('B179: supported skill discovery renders pending and failure states',async()=>{
  const f=await fixture();let reject!:(e:Error)=>void;g.fetch=()=>new Promise((_,r)=>{reject=r;});
  try{
    const {ToolboxMenu}=await component('./ToolboxMenu.tsx');await f.render(ToolboxMenu,{provider:'codex',workflowId:'fixture',onPick:noop});
    assert.ok(document.body.textContent?.includes('Discovering skills'));
    await act(async()=>reject(new Error('fixture discovery failed')));assert.ok(document.body.textContent?.includes('Skill discovery failed: fixture discovery failed'));
  }finally{await f.close();}
});

test('B180: resume selections and out-of-order lists belong to the current folder',async()=>{
  const f=await fixture();const pending:Array<(r:Response)=>void>=[];g.fetch=()=>new Promise(r=>pending.push(r));
  try{
    const {Harness}=await component('./WorkflowCreator/index.tsx','',{},s=>harness(`
      const {workDir}=props;const supportedProvider=true,providerReady=true,connected=true;const nameEdited=useRef(true),projectChoices=[];const setName=()=>{},projectNameForDirectory=()=>'';
      ${section(s,'  const [sessions,','  // Selecting a session')}
      ${section(s,'  const canLaunch =','\n',)}
      return <><button onClick={openResumeMode}>RESUME</button><button onClick={()=>setSelectedSessionId(sessions[0]?.sessionId)}>PICK</button><button disabled={!canLaunch}>LAUNCH</button><div>{sessions.map(s=>s.sessionId).join(',')}</div></>;
    `));
    await f.render(Harness,{workDir:'A'});await act(async()=>pending[0](Response.json({sessions:[{sessionId:'A'}]})));await f.click('RESUME');await act(async()=>pending[1](Response.json({sessions:[{sessionId:'A'}]})));await f.click('PICK');
    assert.equal([...document.querySelectorAll('button')].find(b=>b.textContent==='LAUNCH')!.disabled,false);
    await f.render(Harness,{workDir:'B'});assert.equal([...document.querySelectorAll('button')].find(b=>b.textContent==='LAUNCH')!.disabled,true);
    await f.render(Harness,{workDir:'C'});await act(async()=>pending[3](Response.json({sessions:[{sessionId:'C'}]})));await act(async()=>pending[2](Response.json({sessions:[{sessionId:'B'}]})));
    assert.ok(document.body.textContent?.endsWith('C'));assert.equal([...document.querySelectorAll('button')].find(b=>b.textContent==='LAUNCH')!.disabled,true);
  }finally{await f.close();}
});
