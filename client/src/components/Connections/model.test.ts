import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionCatalog } from '../../../../server/src/connectionCatalog.js';
import { connectionState,credentialSource,parseConnectionCatalog,parseConnectionStatus,safeEndpoint } from './model.js';
const catalog=connectionCatalog({});
const codex=catalog.providers.find(p=>p.id==='codex')!;
test('a failed or stale check never turns into an instruction to sign in again',()=>{
  assert.equal(connectionState(codex,{loggedIn:true,probeFailed:true},true,false),'Status unknown');
  assert.equal(connectionState(codex,{loggedIn:true},false,false),'Disabled');
  assert.equal(connectionState(codex,{loggedIn:true},true,false),'Connected');
  assert.equal(connectionState(codex,undefined,true,false),'Status unknown');
});
test('credential descriptions report evidence without inventing an account or billing identity',()=>{
  assert.match(credentialSource(codex,{loggedIn:true,apiProvider:'openai-api-key'},catalog),/API usage is billed separately/);
  assert.match(credentialSource(codex,{loggedIn:true,accountStatuses:[{id:'a',label:'Account A',loggedIn:true}]},catalog),/profiles/);
  assert.equal(safeEndpoint('https://user:private-value@example.invalid/v1?secret=private-value#private-value'),'https://example.invalid/v1');
  assert.equal(safeEndpoint('!private command'),'');
});
test('malformed runtime responses are rejected rather than replacing known status',()=>{
  assert.equal(parseConnectionCatalog(catalog),catalog);
  for(const bad of [null,{}, {...catalog,version:2},{...catalog,providers:catalog.providers.slice(1)},{...catalog,environmentKeys:[true]}])assert.equal(parseConnectionCatalog(bad),null);
  assert.equal(parseConnectionStatus(false,{}),null);
  for (const bad of [{}, [], {error:'unavailable'}, {claude:{loggedIn:'yes'}}]) assert.equal(parseConnectionStatus(true,bad),null);
});

test('older provider payloads keep known status and default missing integrations to unavailable',()=>{
  const parsed=parseConnectionStatus(true,{claude:{loggedIn:true},ollama:{loggedIn:true,installedModels:['fixture']}})!;
  assert.equal(parsed.claude.loggedIn,true);
  assert.deepEqual(parsed.ollama.installedModels,['fixture']);
  for(const provider of ['codex','deepseek','strata','github'] as const) {
    assert.deepEqual(parsed[provider],{loggedIn:false,installed:false,cliInstalled:false});
  }
});
