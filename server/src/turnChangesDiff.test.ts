import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCheckpoint } from './gitSnapshots.js';
import { computeDiff } from './gitDiff.js';
import { summarizeTurnChanges } from './turnChanges.js';

test('non-git checkpoints render an immutable shadow-store diff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arco-shadow-diff-'));
  const prior = process.env.ARCO_HOME;
  process.env.ARCO_HOME = join(root, 'home');
  const cwd = join(root, 'project');
  await import('node:fs/promises').then(fs => fs.mkdir(cwd));
  try {
    await writeFile(join(cwd, 'demo.txt'), 'before\n');
    const a = await createCheckpoint({cwd, workflowId:'fixture', seq:1});
    await writeFile(join(cwd, 'demo.txt'), 'after\n');
    const b = await createCheckpoint({cwd, workflowId:'fixture', seq:2});
    assert.ok(a && b);
    const diff = await computeDiff({cwd, from:a.ref, to:b.ref});
    assert.equal(diff.isRepo, true); assert.match(diff.patch, /-before/); assert.match(diff.patch, /\+after/);
    assert.deepEqual(await summarizeTurnChanges(cwd, a.ref, b.ref), {fileCount:1,added:1,removed:1,binaryFiles:0,paths:['demo.txt'],pathsTruncated:false});
    const c = await createCheckpoint({cwd, workflowId:'fixture', seq:3}); assert.ok(c);
    assert.equal((await summarizeTurnChanges(cwd, b.ref, c.ref))?.fileCount, 0);
    assert.equal(await summarizeTurnChanges(cwd, a.ref, 'refs/arco/other/2'), null);
    const other = await computeDiff({cwd, from:a.ref, to:'refs/arco/other/2'});
    assert.equal(other.isRepo, false);
  } finally {
    if (prior === undefined) delete process.env.ARCO_HOME; else process.env.ARCO_HOME = prior;
    await rm(root, {recursive:true, force:true});
  }
});

test('git-backed checkpoints report the captured change without modifying the index', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-git-diff-'));
  try {
    execFileSync('git', ['init', '--quiet'], {cwd});
    await writeFile(join(cwd, 'a.txt'), 'one\n');
    const first = await createCheckpoint({cwd, workflowId:'fixture', seq:1});
    await writeFile(join(cwd, 'a.txt'), 'two\n');
    await writeFile(join(cwd, 'b.txt'), 'new\n');
    const second = await createCheckpoint({cwd, workflowId:'fixture', seq:2});
    assert.ok(first && second);
    assert.deepEqual(await summarizeTurnChanges(cwd, first.ref, second.ref), {fileCount:2,added:2,removed:1,binaryFiles:0,paths:['a.txt','b.txt'],pathsTruncated:false});
    const status = execFileSync('git', ['status','--porcelain'], {cwd,encoding:'utf8'});
    assert.match(status, /\?\? a.txt/); assert.match(status, /\?\? b.txt/);
  } finally { await rm(cwd, {recursive:true,force:true}); }
});
