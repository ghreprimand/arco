import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fsSync, { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { executeNativeTool, type NativeToolContext } from './claude-native/tools.js';
import { executeOllamaTool } from './ollamaTools.js';

for(const provider of ['Native','local'] as const)test(`${provider} Write creates the Windows parent rather than a filename directory`,async(t)=>{
  const cwd=path.win32.resolve('C:', 'fixture');const target=path.win32.join(cwd,'new','nested','file.txt');
  const parents:string[]=[];const writes:string[]=[];
  for(const key of ['resolve','relative','isAbsolute','dirname','join','basename'] as const)t.mock.method(path,key,path.win32[key]);
  t.mock.method(fsSync, 'realpathSync', (name: unknown) => String(name));
  t.mock.method(fsSync, 'lstatSync', (name: unknown) => {
    if (String(name) === cwd) return {} as never;
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
  syncBuiltinESMExports();
  t.mock.method(fs,'stat',async()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'});});
  t.mock.method(fs,'mkdir',async(name:unknown)=>{parents.push(String(name));return undefined;});
  t.mock.method(fs,'writeFile',async(name:unknown)=>{writes.push(String(name));});
  const info = { isFile: () => true, isSymbolicLink: () => false, dev: 1, ino: 1 };
  t.mock.method(fs, 'lstat', async () => info as never);
  t.mock.method(fs, 'open', async (name: unknown) => ({ stat: async () => info, truncate: async () => {}, writeFile: async () => { writes.push(String(name)); }, close: async () => {} }) as never);
  syncBuiltinESMExports();
  try{
    const ctx:NativeToolContext={cwd,abortSignal:new AbortController().signal,shells:{byId:new Map(),mintId:()=> 'fixture'},readSet:new Set(),planMode:false,onTodos:()=>{}};
    const result=provider==='Native'?await executeNativeTool('Write',{file_path:target,content:'fixture'},ctx):await executeOllamaTool('Write',{file_path:target,content:'fixture'},{cwd});
    assert.doesNotMatch(result,/^\[error\]/);
    assert.deepEqual(parents,[path.win32.dirname(target)]);assert.deepEqual(writes,[target]);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
