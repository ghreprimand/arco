import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { JobState } from '../stores/appStore';
import { PrimaryStatus } from './PrimaryStatus';
import { MemberCard } from './MemberCard';

test('header holds a step and member cards retain settled content without streaming fragments', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url:'http://localhost/', pretendToBeVisual:true });
  const names = ['window','document','localStorage','HTMLElement','Node','navigator','IS_REACT_ACT_ENVIRONMENT'];
  const prior = new Map(names.map((name) => [name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  for (const name of names) Object.defineProperty(globalThis,name,{configurable:true,value:name==='IS_REACT_ACT_ENVIRONMENT'?true:(dom.window as any)[name]});
  const host=dom.window.document.createElement('div');dom.window.document.body.append(host);const root=createRoot(host);
  const first={id:'one',kind:'tool_use',tool:'Read',input:'{"file_path":"first.txt"}',status:'started',at:Date.now()};
  const second={id:'two',kind:'tool_use',tool:'Read',input:'{"file_path":"second.txt"}',status:'started',at:Date.now()};
  const job={id:'fixture',busy:true,config:{name:'Fixture',primaryProvider:'claude'},messages:[{role:'assistant',content:'Last settled answer.',timestamp:1,isStreaming:false},{role:'assistant',content:'incomplete stream',timestamp:2,isStreaming:true}],activity:[first],turnStartedAt:Date.now(),totalTokens:{output:0}} as unknown as JobState;
  const render=async()=>act(async()=>{root.render(createElement('div',null,createElement(PrimaryStatus,{job}),createElement(MemberCard,{job,displayName:'Fixture',status:'busy',focused:false,onClick:()=>{}})));});
  try {
    await render();assert.match(host.textContent??'',/Reading first.txt/);assert.match(host.textContent??'',/Last settled answer/);assert.doesNotMatch(host.textContent??'',/incomplete stream/);
    job.activity=[second] as any;await render();assert.match(host.querySelector('[data-testid="header-turn-step"]')?.textContent??'',/first.txt/);
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1600));});assert.match(host.querySelector('[data-testid="header-turn-step"]')?.textContent??'',/second.txt/);
    job.activity=[{...second,status:'completed',updatedAt:Date.now()}] as any;await render();await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1050));});assert.match(host.querySelector('[data-help="cluster.member-card"]')?.textContent??'',/Reading second.txt/);
    job.busy=false; job.lastTurnEndedAt=Date.now(); await render(); assert.match(host.querySelector('[data-help="cluster.member-card"]')?.textContent??'',/Reading second.txt/);
    job.busy=true; job.activity=[];await render();await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1050));});assert.match(host.querySelector('[data-help="cluster.member-card"]')?.textContent??'',/Reading second.txt/);
  } finally {await act(async()=>root.unmount());dom.window.close();for(const [name,desc] of prior){if(desc)Object.defineProperty(globalThis,name,desc);else delete (globalThis as any)[name];}}
});
