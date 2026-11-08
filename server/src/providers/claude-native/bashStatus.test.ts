import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installIsolatedTestHome} from '../../testSupport/isolatedHome.js';
import {commandShell} from '../../commandShell.js';
import {runFilterPipeline} from './filterToolResult.js';
import {bashCargoTest} from './filterConfigs/bash-cargo-test.js';
import {bashJestVitest} from './filterConfigs/bash-jest-vitest.js';
import {bashPytest} from './filterConfigs/bash-pytest.js';

const home=mkdtempSync(join(tmpdir(),'arco-bash-status-home-'));installIsolatedTestHome(home);
const {ClaudeNativeWorker}=await import('./worker.js');
after(()=>rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100}));

for(const scenario of ['success','nonzero','timeout','cancel'] as const)test(`Native shell ${scenario} carries failure state through dispatch, hooks and filtering`,async(t)=>{
 const shell=commandShell();
 if(!shell.ok){t.skip('command shell unavailable');return;}
 const cwd=mkdtempSync(join(tmpdir(),'arco-bash-status-'));
 const worker=new ClaudeNativeWorker({workflowId:'fixture-bash-status',config:{cwd,model:'fixture',effort:'low',skipPermissions:true,efficiencyToolFilter:'conservative'}}) as any;
 const hooks:any[]=[],activities:any[]=[],filters:any[]=[];
 worker.runHooks=async(event:string,_matcher:string,extra:any)=>{hooks.push({event,extra});return {blocks:[],context:[],systemMessages:[],notices:[],rewrites:[]};};
 worker.workflowEventBroadcast=()=>{};
 worker.on('tool_use',(event:any)=>activities.push(event));
 const filter=worker.filterToolOutput.bind(worker);
 worker.filterToolOutput=async(...args:any[])=>{filters.push({isError:args[3],exitCode:args[4]});return filter(...args);};
 const script=scenario==='success'?"process.stdout.write('fixture success')":scenario==='nonzero'?"process.stderr.write('fixture failed');process.exit(2)":"setTimeout(()=>{},30000)";
 const command=`${shell.kind==='powershell'?'& ':''}${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
 try{
  const pending=worker.dispatchTool({id:'fixture-call',name:shell.kind==='powershell'?'PowerShell':'Bash',input:{command,timeout:1000}});
  if(scenario==='cancel')setTimeout(()=>worker.toolAbort?.abort(),40);
  const result=await pending;
  const failed=scenario!=='success';
  assert.equal(result.isError,failed);
  assert.equal(activities.at(-1)?.status,failed?'failed':'completed');
  assert.equal(filters.at(-1)?.isError,failed);
  const post=hooks.find(h=>h.event===(failed?'PostToolUseFailure':'PostToolUse'));assert.ok(post);
  if(scenario==='timeout')assert.equal(post.extra.timed_out,true);
  if(scenario==='cancel')assert.equal(post.extra.is_interrupt,true);
  if(scenario==='nonzero')assert.equal(post.extra.exit_code,2);
  if(scenario==='nonzero')assert.equal(filters.at(-1)?.exitCode,2);
 }finally{await worker.dispose();rmSync(cwd,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

for(const [label,pack,text] of [
 ['compiler',bashCargoTest,'error[E0308]: mismatched types\n --> src/lib.rs:9:2\n  expected usize, found String\nhelp: convert the value'],
 ['configuration',bashJestVitest,'Validation Error:\n  Module fixture-transform was not found.\n  Check transform configuration.'],
 ['collection',bashPytest,'================ ERRORS ================\n________ ERROR collecting tests/test_fixture.py ________\nImportError while importing test module\nTraceback:\nE   ModuleNotFoundError: fixture_dependency\n================ short test summary info ================'],
] as const)test(`failure filter preserves ${label} diagnostics`,()=>{
 const result=runFilterPipeline(text,2,pack);
 for(const line of text.split('\n').filter(Boolean))assert.ok(result.filtered.includes(line),result.filtered);
});


test('a cancelled shell selects the failure tail even when its exit code is null',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'arco-filter-signal-'));
 const worker=new ClaudeNativeWorker({workflowId:'fixture-filter-signal',config:{cwd,model:'fixture',effort:'low',efficiencyToolFilter:'conservative'}}) as any;
 worker.workflowEventBroadcast=()=>{};
 try{
  const raw='FIRST_LINE\n'+Array.from({length:5000},(_,i)=>`fixture ${i}`).join('\n')+'\nLAST_DIAGNOSTIC';
  const result=await worker.filterToolOutput({id:'fixture-signal',name:'Bash'}, {command:'find .'},raw,true,null);
  assert.ok(result.includes('LAST_DIAGNOSTIC'));assert.ok(!result.includes('FIRST_LINE'));
 }finally{await worker.dispose();rmSync(cwd,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
