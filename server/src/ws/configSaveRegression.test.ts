import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const root=mkdtempSync(join(tmpdir(),'arco-config-save-'));installIsolatedTestHome(root);
const {workflows}=await import('../server/state.js');
const {handleUpdatePrimaryConfig}=await import('./updatePrimaryConfig.js');
after(()=>rmSync(root,{recursive:true,force:true}));
function fixture(cwd?:string) {
  const sent:any[]=[];const ws={readyState:1,send:(payload:string)=>sent.push(JSON.parse(payload))} as any;
  const wf={config:{name:'fixture',workingDirectory:cwd},primary:{provider:'claude',model:'sonnet',effort:'low'},observers:new Set([ws]),bootMaterialized:true} as any;
  const id=crypto.randomUUID();workflows.set(id,wf);
  return {wf,sent,update:(patch:any)=>handleUpdatePrimaryConfig(ws,{} as any,{type:'update_primary_config',workflowId:id,...patch}),close:()=>workflows.delete(id)};
}
test('B124 validates the proposed north star before changing any settings',async()=>{
  const f=fixture();try {
    await f.update({goal:'new direction',goalRun:{enabled:true,total:3}});
    assert.equal(f.wf.config.goal,'new direction');assert.equal(f.wf.config.goalRun?.enabled,true);
    const before=structuredClone(f.wf.config);f.sent.length=0;
    await f.update({goal:'',goalRun:{enabled:true,total:3},model:'opus'});
    assert.ok(f.sent.some(m=>m.type==='error'));assert.deepEqual(f.wf.config,before);assert.equal(f.wf.primary.model,'sonnet');
  } finally {f.close();}
});
test('B125 unavailable metadata produces an explicit temporary-setting outcome',async()=>{
  for(const patch of [{model:'opus'},{goal:'new goal'},{codexTransport:'cli'}]) {
    const f=fixture(join(root,crypto.randomUUID()));try {
      await f.update(patch);
      assert.ok(f.sent.some(m=>m.type==='error'&&/not saved|could not (?:be )?save/i.test(m.message)));
      assert.ok(f.sent.some(m=>m.type==='system_notice'&&/temporary/i.test(m.content)));
      assert.equal(f.sent.some(m=>m.type==='goal_set'),false);
    } finally {f.close();}
  }
});
