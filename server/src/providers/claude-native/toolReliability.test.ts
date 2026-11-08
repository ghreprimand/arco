import assert from 'node:assert/strict';
import test from 'node:test';
import fsSync, { mkdtempSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeNativeTool, type NativeToolContext } from './tools.js';
import { checkPartialReadFullWrite, checkConfigProtection, checkFactForceFirstEdit } from './pretoolGuards.js';
import { registryToolDefs } from './registryTools.js';
import { commandShell } from '../../commandShell.js';
import { OutputAccumulator } from './outputAccumulator.js';

function context(cwd:string): NativeToolContext {
  return {cwd,abortSignal:new AbortController().signal,shells:{byId:new Map(),mintId:()=> 'fixture'},readSet:new Set(),partialReadSet:new Set(),planMode:false,onTodos:()=>{}};
}

test('MCP schemas retain referenced definitions and validation metadata', () => {
  const raw = {type:'object',properties:{filter:{$ref:'#/$defs/Filter'}},$defs:{Filter:{type:'object',properties:{value:{type:'string'}}}},definitions:{Legacy:{type:'string'}},required:['filter'],additionalProperties:false,oneOf:[]};
  const defs = registryToolDefs([{key:'reg-fixture'} as any],new Map([['reg-fixture',{listTools:()=>[{name:'search',inputSchema:raw}]} as any]]));
  const schema = defs[0].input_schema as Record<string,unknown>;
  assert.deepEqual(schema.$defs,raw.$defs);
  assert.deepEqual(schema.definitions,raw.definitions);
  assert.equal(schema.additionalProperties,false);
  assert.equal(schema.oneOf,undefined);
});

test('capped Native reads preserve the unseen-tail warning until a complete read', async () => {
  const cwd=mkdtempSync(join(tmpdir(),'arco-read-cap-'));
  try {
    const file=join(cwd,'large.txt');writeFileSync(file,'A'.repeat(300000));
    const ctx=context(cwd);
    assert.match(await executeNativeTool('Read',{file_path:file},ctx),/truncated/);
    assert.equal(checkPartialReadFullWrite('Write',{file_path:file},cwd,ctx.partialReadSet!).warn,true);
    writeFileSync(file,'short');await executeNativeTool('Read',{file_path:file},ctx);
    assert.equal(checkPartialReadFullWrite('Write',{file_path:file},cwd,ctx.partialReadSet!).warn,false);
  } finally {rmSync(cwd,{recursive:true,force:true});}
});

test('Native Grep distinguishes invalid patterns and missing paths from no matches',async()=>{
  const cwd=mkdtempSync(join(tmpdir(),'arco-grep-errors-'));
  try {
    writeFileSync(join(cwd,'fixture.txt'),'needle');const ctx=context(cwd);
    assert.match(await executeNativeTool('Grep',{pattern:'[',path:'.'},ctx),/^\[error\]/);
    assert.match(await executeNativeTool('Grep',{pattern:'needle',path:'missing'},ctx),/^\[error\]/);
    assert.equal(await executeNativeTool('Grep',{pattern:'absent',path:'.'},ctx),'(no matches)');
    assert.match(await executeNativeTool('Grep',{pattern:'needle',path:'.'},ctx),/needle/);
  }finally{rmSync(cwd,{recursive:true,force:true});}
});

for (const failure of ['open','write'] as const) test(`spill ${failure} failure keeps the newest bounded tail and reports incomplete retention`,()=>{
  let writes=0;
  const acc=new OutputAccumulator({tailByteBudget:32,maxLines:100,spillThresholdBytes:32,openSpill:()=>{
    if(failure==='open') throw new Error('fixture open failure');
    return {path:'fixture-spill',write:()=>{if(++writes===2)throw new Error('fixture write failure');}};
  }});
  assert.doesNotThrow(()=>{acc.push(Buffer.from('A'.repeat(40)));acc.push(Buffer.from('B'.repeat(50)+'TAIL_FIXTURE'));});
  const result=acc.result() as ReturnType<OutputAccumulator['result']>&{spillError?:string};
  assert.ok(result.text.endsWith('TAIL_FIXTURE'));
  assert.ok(result.spillError);assert.equal(result.spillPath,undefined);
});

test('Native Bash reports unavailable retention while returning its real newest tail',async(t)=>{
  const cwd=mkdtempSync(join(tmpdir(),'arco-spill-failure-'));
  t.mock.method(fsSync,'openSync',()=>{throw new Error('fixture spill unavailable');});
  syncBuiltinESMExports();
  try {
    const shell=commandShell();
    const prefix=shell.ok&&shell.kind==='powershell'?'& ':'';
    const executable=process.execPath.replaceAll('\\','/');
    const result=await executeNativeTool('Bash',{command:prefix+`"${executable}" -e "process.stdout.write('A'.repeat(70000)+'TAIL_FIXTURE')"`,timeout:10000},context(cwd));
    assert.match(result,/full output unavailable/);
    assert.match(result,/TAIL_FIXTURE$/);
    assert.doesNotMatch(result,/full output saved/);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();rmSync(cwd,{recursive:true,force:true});}
});


test('Native file guards identify linked aliases as the same file', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-guard-alias-'));
  try {
    const file = join(cwd, 'tsconfig.json');
    writeFileSync(file, '{}');
    try { symlinkSync('tsconfig.json', join(cwd, 'alias.json')); }
    catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('File symlinks require Windows developer mode or privileges'); return; }
      throw error;
    }
    assert.equal(checkConfigProtection('Write', { file_path: 'alias.json' }, cwd).blocked, true);
    const first = checkFactForceFirstEdit('Edit', { file_path: 'alias.json' }, cwd, new Set());
    assert.equal(first.blocked, true);
    assert.equal(first.resolvedPath, realpathSync(file));
    const edited = new Set([first.resolvedPath!]);
    assert.equal(checkFactForceFirstEdit('Edit', { file_path: file }, cwd, edited).blocked, false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
