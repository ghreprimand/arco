import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupAndWriteInstructionFile } from './runMdTuneup.js';

test('B129 accepting an old proposal preserves an intervening edit',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'arco-tune-revision-')),file=join(cwd,'NOTES.md');
  try {
    await writeFile(file,'intervening edit');
    await assert.rejects((backupAndWriteInstructionFile as any)(cwd,file,'proposal',1,'reviewed original'),/changed.*review/i);
    assert.equal(await readFile(file,'utf8'),'intervening edit');
    await (backupAndWriteInstructionFile as any)(cwd,file,'proposal',2,'intervening edit');
    assert.equal(await readFile(file,'utf8'),'proposal');
  } finally {await rm(cwd,{recursive:true,force:true});}
});
