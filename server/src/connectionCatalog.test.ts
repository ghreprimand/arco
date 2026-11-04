import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionCatalog } from './connectionCatalog.js';

test('Connections metadata reveals only allowlisted key presence, never secret values or paths',()=>{
  const env={ARCO_DEPLOYMENT:'docker',OPENAI_API_KEY:'synthetic-never-display',ANTHROPIC_API_KEY:'another-secret',UNRELATED_SECRET:'must-not-appear',HOME:'/synthetic/private-home'};
  const catalog=connectionCatalog(env);
  assert.equal(catalog.deployment,'docker');
  assert.deepEqual(catalog.environmentKeys,['ANTHROPIC_API_KEY','OPENAI_API_KEY']);
  const encoded=JSON.stringify(catalog);
  for(const secret of ['synthetic-never-display','another-secret','must-not-appear','/synthetic/private-home'])assert.ok(!encoded.includes(secret));
  assert.equal(catalog.providers.length,9);
  assert.equal(new Set(catalog.providers.map(p=>p.id)).size,9);
  assert.deepEqual(new Set(catalog.providers.map(p=>p.kind)),new Set(['plan','local','tool']));
  for(const p of catalog.providers)assert.ok(p.settingsSection && p.prerequisite && p.recovery);
});
