import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox=mkdtempSync(join(tmpdir(),'arco-catalog-fallback-'));
const keys=['HOME','USERPROFILE','ARCO_HOME','CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','PATH'] as const;
const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
for(const key of keys) process.env[key]=sandbox;
const {getCatalog}=await import('./claude-native/catalog.js');
const {getCodexCatalog}=await import('./codex-appserver/catalog.js');
const {getCursorCatalog}=await import('./cursor/catalog.js');
test.after(()=>{for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}rmSync(sandbox,{recursive:true,force:true});});
for(const [name,read] of [['Native',()=>getCatalog(true)],['Codex',()=>getCodexCatalog(true,sandbox)],['Cursor',()=>getCursorCatalog(true)]] as const){
  test(`${name} concurrent unavailable catalog reads both resolve to the same fallback`,async()=>{
    const results=await Promise.allSettled([read(),read()]);
    assert.deepEqual(results.map(r=>r.status),['fulfilled','fulfilled']);
    if(results[0].status==='fulfilled'&&results[1].status==='fulfilled'){
      assert.deepEqual(results[0].value,results[1].value);
      assert.equal(results[0].value.fresh,false);
    }
  });
}
