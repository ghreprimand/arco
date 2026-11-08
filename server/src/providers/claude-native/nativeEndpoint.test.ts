import test, {after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {installIsolatedTestHome} from '../../testSupport/isolatedHome.js';

const home=mkdtempSync(join(tmpdir(),'arco-native-endpoint-'));
installIsolatedTestHome(home);
const {saveTokens}=await import('./auth.js');
const {ClaudeNativeWorker}=await import('./worker.js');
const {claudeAdapter}=await import('../../smartPickupAdapters.js');
const {writeSettings,readSettings,patchSettings}=await import('../../settings.js');
const savedEnv=process.env.ANTHROPIC_BASE_URL;
const savedKey=process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY='fixture-ambient-proxy-key';
process.env.ANTHROPIC_BASE_URL='https://example.net/ambient';
const cwd=join(home,'project');await fs.mkdir(cwd);
beforeEach(async()=>{await writeSettings({...await readSettings(),claudeNative:undefined});await saveTokens({accessToken:'fixture-saved-login',refreshToken:'fixture-refresh',expiresAt:Date.now()+3600000,obtainedAt:1,tokenType:'Bearer',scope:'fixture'});});
after(async()=>{if(savedEnv===undefined)delete process.env.ANTHROPIC_BASE_URL;else process.env.ANTHROPIC_BASE_URL=savedEnv;if(savedKey===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=savedKey;await fs.rm(home,{recursive:true,force:true});});
const request={model:'claude-opus-4-8',instructions:'Synthetic request',prompt:'Fixture',maxOutputTokens:16,timeoutMs:1000,freeText:true};
const response=()=>Response.json({id:'fixture',type:'message',role:'assistant',model:'claude-opus-4-8',content:[{type:'text',text:'Fixture answer'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}});
async function worker() {const value=new ClaudeNativeWorker({workflowId:'endpoint-fixture',config:{cwd,model:'claude-opus-4-8',effort:'low'}});await value.ensureStarted();return value;}
for(const mode of ['worker','evaluator'] as const)test(`saved-login ${mode} ignores ambient SDK endpoint`,async t=>{
  const calls:string[]=[];
  t.mock.method(globalThis,'fetch',async(target:any,init:any)=>{calls.push(String(target));assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fixture-saved-login');assert.equal(new Headers(init?.headers).get('x-api-key'),null,'saved login must not send the ambient key');return response();});
  if(mode==='worker') {
    const value=await worker();
    try {const client=(value as any).client as Anthropic;assert.equal(client.baseURL,'https://api.anthropic.com');await client.messages.create({model:'claude-opus-4-8',max_tokens:1,messages:[{role:'user',content:'Fixture'}]});}
    finally{await value.dispose();}
  }else assert.equal(await claudeAdapter().evaluate(request),'Fixture answer');
  assert.equal(new URL(calls[0]).origin,'https://api.anthropic.com');
});
test('explicit global endpoint serves both paths and a change rebuilds the worker client',async t=>{
  await writeSettings({claudeNative:{baseUrl:'https://example.com/native'}} as any);
  const calls:string[]=[];t.mock.method(globalThis,'fetch',async(target:any,init:any)=>{calls.push(String(target));assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fixture-saved-login');assert.equal(new Headers(init?.headers).get('x-api-key'),null);return response();});
  const value=await worker();
  try {
    const first=(value as any).client as Anthropic;assert.equal(first.baseURL,'https://example.com/native');
    await first.messages.create({model:'claude-opus-4-8',max_tokens:1,messages:[{role:'user',content:'Fixture'}]});
    await claudeAdapter().evaluate(request);assert.equal(calls.length,2);for(const target of calls)assert.equal(new URL(target).origin,'https://example.com');
    await writeSettings({claudeNative:{baseUrl:'https://example.org/other'}} as any);
    await value.ensureStarted();assert.notEqual((value as any).client,first);assert.equal((value as any).client.baseURL,'https://example.org/other');
  }finally{await value.dispose();}
});
test('project settings cannot retarget saved Native credentials',async()=>{
  await fs.mkdir(join(cwd,'.arco'),{recursive:true});await fs.writeFile(join(cwd,'.arco','settings.json'),JSON.stringify({claudeNative:{baseUrl:'https://example.org/project'}}));
  const value=await worker();try{assert.equal((value as any).client.baseURL,'https://api.anthropic.com');}finally{await value.dispose();}
});
test('global endpoint survives unrelated saves and can be explicitly cleared',async()=>{
  await patchSettings({claudeNative:{baseUrl:'https://example.com/native/'}} as any);
  await patchSettings({queueMode:'follow-up'} as any);
  assert.equal((await readSettings() as any).claudeNative.baseUrl,'https://example.com/native');
  await patchSettings({claudeNative:{baseUrl:null}} as any);
  assert.equal((await readSettings() as any).claudeNative?.baseUrl,undefined);
});
test('environment API-key SDK setup retains its own endpoint and key on requests',async()=>{
  const previous=process.env.ANTHROPIC_API_KEY;process.env.ANTHROPIC_API_KEY='fixture-environment-key';
  const calls:Array<{url:string;headers:Headers}>=[];
  try {
    const client=new Anthropic({authToken:null,fetch:(async(target:any,init:any)=>{calls.push({url:String(target),headers:new Headers(init?.headers)});return response();}) as typeof fetch});
    await client.messages.create({model:'claude-opus-4-8',max_tokens:1,messages:[{role:'user',content:'Fixture'}]});
    assert.equal(client.apiKey,'fixture-environment-key');
    assert.equal(client.baseURL,'https://example.net/ambient');
    assert.equal(new URL(calls[0].url).origin,'https://example.net');
    assert.equal(calls[0].headers.get('x-api-key'),'fixture-environment-key');
    assert.equal(calls[0].headers.get('authorization'),null);
  } finally {if(previous===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=previous;}
});
test('invalid custom endpoint values cannot survive settings validation',async()=>{
  const credentialUrl=new URL('https://example.com');credentialUrl.username='fixture-user';credentialUrl.password='fixture-password';
  for(const baseUrl of ['file:///fixture',credentialUrl.href,'https://example.com/?token=fixture','https://example.com/#fragment']) {
    await writeSettings({claudeNative:{baseUrl}} as any);
    assert.equal((await readSettings() as any).claudeNative?.baseUrl,undefined);
  }
});
