import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const root=mkdtempSync(join(tmpdir(),'arco-connections-'));
const home=join(root,'home');mkdirSync(join(home,'.arco'),{recursive:true});
process.env.HOME=home;
process.env.USERPROFILE=home;
process.env.ARCO_DEPLOYMENT='docker';
for(const key of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','ZAI_API_KEY'])delete process.env[key];
let server:Server, model:Server, base:string;
const requested:string[]=[];
const settings=join(home,'.arco','settings.json');
before(async()=>{
  model=createServer((req,res)=>{requested.push(req.url!);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({models:[{name:'synthetic-model',details:{family:'test'}}]}));});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  writeFileSync(settings,JSON.stringify({enabledProviders:{ollama:true,codex:false},ollama:{baseUrl:`http://127.0.0.1:${(model.address() as AddressInfo).port}`}}));
  const {tryHandleConnectionsRoutes}=await import('./connectionsRoutes.js');
  server=createServer((req,res)=>{void tryHandleConnectionsRoutes(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async()=>{
  await Promise.all([new Promise<void>(resolve=>server.close(()=>resolve())),new Promise<void>(resolve=>model.close(()=>resolve()))]);
  rmSync(root,{recursive:true,force:true});
});
test('catalog reads metadata without probing an endpoint or resolving a command credential',async()=>{
  writeFileSync(join(home,'.arco','provider-secrets.json'),JSON.stringify({zaiApiKey:'!false'}));
  const res=await fetch(base+'/api/connections');const body=await res.json();
  assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');
  assert.deepEqual(body.zaiKey,{configured:true,source:'command'});
  assert.equal(body.providers.length,12);assert.deepEqual(requested,[]);
  assert.ok(!JSON.stringify(body).includes('!false'));
});
test('only an explicit supported check reaches the selected fixture runtime',async()=>{
  for(const [url,method,status] of [
    ['/api/connections','POST',405],['/api/connections/check?provider=ollama','GET',405],
    ['/api/connections/check?provider=unknown','POST',400],['/api/connections/check?provider=codex','POST',409],
    ['/api/connections/check?provider=antigravity','POST',409],
  ] as const)assert.equal((await fetch(base+url,{method})).status,status);
  assert.deepEqual(requested,[],'no refused action probes a provider');
  const res=await fetch(base+'/api/connections/check?provider=ollama',{method:'POST'});
  const body=await res.json();assert.equal(res.status,200);assert.equal(body.provider,'ollama');assert.equal(body.status.loggedIn,true);
  assert.ok(body.status.installedModels.includes('synthetic-model'));
  assert.ok(requested.length>0 && requested.every(p=>p==='/api/tags' || p==='/api/show'),'only model metadata is queried; no inference');
});
