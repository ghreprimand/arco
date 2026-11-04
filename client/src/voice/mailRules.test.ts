import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mailRuleToolResult } from './mailRules';
import type { ComputerMailRule } from '@arco/shared';
test('mailbox-rule tool projections fit the relay without truncating JSON or Unicode', () => {
  const rule: ComputerMailRule = {id:'a'.repeat(80),ownerId:'o',clusterId:'c'.repeat(80),label:'😀"\\'.repeat(100),memberIds:[],finalId:'f'.repeat(80),finalName:'😀'.repeat(100),status:'watching',reason:'Long reason '.repeat(100),createdAt:1,expiresAt:2,cooldownMs:30000,maxNudgesPerWorker:8,
    workers:Array.from({length:16},()=>({id:'w'.repeat(80),name:'😀'.repeat(100),nudges:8}))};
  for (const state of [{rule,rules:[rule]}, {rules:Array.from({length:100},(_,i)=>({...rule,status:i<16?'watching' as const:'finished' as const}))}]) {
    const text = mailRuleToolResult(state); assert(text.length<16000); assert.doesNotThrow(()=>JSON.parse(text));
    JSON.parse(text, (_key, value) => { if (typeof value === 'string') assert.doesNotThrow(() => encodeURIComponent(value)); return value; });
  }
});

test('late HTTP replies cannot restore private rule or activity metadata after a context clear', async () => {
  const {mailRuleRequest,useComputerMailRules} = await import('./mailRules');
  const {useComputerStore} = await import('../stores/computerStore');
  const {useAppStore} = await import('../stores/appStore');
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable:true, value:{getItem:()=>null,setItem:()=>undefined,removeItem:()=>undefined} });
  const previousFetch = globalThis.fetch, previousComputer = useComputerStore.getState(), previousConnected = useAppStore.getState().connected;
  let deliver!: (r: Response) => void;
  globalThis.fetch = async () => new Promise<Response>((resolve) => { deliver = resolve; });
  useAppStore.setState({connected:true}); useComputerStore.setState({activeId:'private-owner',contextEpoch:1});
  useComputerMailRules.setState({rules:[],error:null});
  try {
    const pending = mailRuleRequest('private-owner');
    useComputerStore.setState({contextEpoch:2});
    deliver(new Response(JSON.stringify({rules:[{id:'secret',private:true,ownerId:'private-owner',label:'secret',workers:[],status:'finished'}]})));
    await pending; assert.deepEqual(useComputerMailRules.getState().rules,[]);
    const {activityRequest,useComputerActivity}=await import('./activity');
    useComputerActivity.setState({snapshot:null,error:null});
    const activity=activityRequest('private-owner');useComputerStore.setState({contextEpoch:3});
    deliver(new Response(JSON.stringify({policy:{enabled:true,agentUpdates:'workers'},ledger:[{id:'secret',private:true}],deliveries:[],pending:0,updatesPerHour:12})));
    await activity;assert.equal(useComputerActivity.getState().snapshot,null);
    const {conditionRequest,useComputerConditions}=await import('./conditions');
    useComputerConditions.setState({rules:[],error:null});
    const script=conditionRequest('private-owner');useComputerStore.setState({contextEpoch:4});
    deliver(new Response(JSON.stringify({rules:[{id:'secret-script',private:true,ownerId:'private-owner',definition:{label:'secret'}}]})));
    await script;assert.deepEqual(useComputerConditions.getState().rules,[]);
  } finally { globalThis.fetch = previousFetch; useComputerStore.setState(previousComputer); useAppStore.setState({connected:previousConnected});
    useAppStore.persist.clearStorage();
    if (storage) Object.defineProperty(globalThis,'localStorage',storage); else Reflect.deleteProperty(globalThis,'localStorage');
  }
});
