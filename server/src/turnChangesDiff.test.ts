import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCheckpoint, previewCheckpointRevert, revertToCheckpoint } from './gitSnapshots.js';
import { computeDiff } from './gitDiff.js';
import { summarizeTurnChanges } from './turnChanges.js';

test('home provider state is excluded from change summaries and never reverted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arco-provider-state-'));
  const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE, oldArco = process.env.ARCO_HOME;
  try {
    for (const mode of ['shadow', 'git']) {
      const home = join(root, mode); await mkdir(home);
      process.env.HOME = home; process.env.USERPROFILE = home; process.env.ARCO_HOME = join(root, `${mode}-state`);
      if (mode === 'git') execFileSync('git', ['init', '--quiet'], { cwd: home });
      for (const dir of ['.claude', '.codex', '.cursor', '.gemini']) {
        await mkdir(join(home, dir)); await writeFile(join(home, dir, 'session.db'), 'before');
      }
      await writeFile(join(home, '.claude.json'), 'before');
      await writeFile(join(home, 'work.txt'), 'before');
      const first = await createCheckpoint({ cwd: home, workflowId: 'fixture', seq: 1 });
      assert.ok(first);
      for (const dir of ['.claude', '.codex', '.cursor', '.gemini']) await writeFile(join(home, dir, 'session.db'), 'after');
      await writeFile(join(home, '.claude.json'), 'after');
      await writeFile(join(home, 'work.txt'), 'after');
      const second = await createCheckpoint({ cwd: home, workflowId: 'fixture', seq: 2 });
      assert.ok(second);
      assert.deepEqual((await summarizeTurnChanges(home, first.ref, second.ref))?.paths, ['work.txt']);
      assert.ok(await revertToCheckpoint({ cwd: home, workflowId: 'fixture', seq: 1 }));
      assert.equal(await readFile(join(home, 'work.txt'), 'utf8'), 'before');
      for (const dir of ['.claude', '.codex', '.cursor', '.gemini']) assert.equal(await readFile(join(home, dir, 'session.db'), 'utf8'), 'after');
      assert.equal(await readFile(join(home, '.claude.json'), 'utf8'), 'after');
      if (mode === 'git') {
        execFileSync('git', ['add', '--', '.gemini'], { cwd: home });
        execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: home });
        execFileSync('git', ['update-ref', 'refs/arco/fixture/3', 'HEAD'], { cwd: home });
        await writeFile(join(home, '.gemini', 'session.db'), 'keep');
        const preview = await previewCheckpointRevert({ cwd: home, workflowId: 'fixture', seq: 3 });
        assert.equal(preview.ok, false);
        assert.equal(await revertToCheckpoint({ cwd: home, workflowId: 'fixture', seq: 3 }), null);
        assert.equal(await readFile(join(home, '.gemini', 'session.db'), 'utf8'), 'keep');
      }
    }
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    if (oldArco === undefined) delete process.env.ARCO_HOME; else process.env.ARCO_HOME = oldArco;
    await rm(root, { recursive: true, force: true });
  }
});

test('relocated Arco state inside the workspace stays outside checkpoints and restores', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arco-state-inside-'));
  const previous = process.env.ARCO_HOME;
  try {
    for (const mode of ['shadow', 'git']) {
      const cwd = join(root, mode), state = join(cwd, 'runtime-state');
      await mkdir(cwd); await mkdir(state);
      process.env.ARCO_HOME = state;
      if (mode === 'git') execFileSync('git', ['init', '--quiet'], { cwd });
      await writeFile(join(state, 'session.json'), 'before');
      await writeFile(join(cwd, 'work.txt'), 'before');
      const first = await createCheckpoint({ cwd, workflowId: 'fixture', seq: 1 }); assert.ok(first);
      await writeFile(join(state, 'session.json'), 'after'); await writeFile(join(cwd, 'work.txt'), 'after');
      const second = await createCheckpoint({ cwd, workflowId: 'fixture', seq: 2 }); assert.ok(second);
      assert.deepEqual((await summarizeTurnChanges(cwd, first.ref, second.ref))?.paths, ['work.txt']);
      assert.ok(await revertToCheckpoint({ cwd, workflowId: 'fixture', seq: 1 }));
      assert.equal(await readFile(join(state, 'session.json'), 'utf8'), 'after');
      assert.equal(await readFile(join(cwd, 'work.txt'), 'utf8'), 'before');
      assert.equal(await createCheckpoint({ cwd: state, workflowId: 'fixture', seq: 5 }), null);
      if (mode === 'git') {
        execFileSync('git', ['add', '--', 'runtime-state/session.json'], { cwd });
        execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd });
        execFileSync('git', ['update-ref', 'refs/arco/fixture/3', 'HEAD'], { cwd });
        assert.equal((await previewCheckpointRevert({ cwd, workflowId: 'fixture', seq: 3 })).ok, false);
        assert.equal(await revertToCheckpoint({ cwd, workflowId: 'fixture', seq: 3 }), null);
        assert.equal(await readFile(join(state, 'session.json'), 'utf8'), 'after');
      }
    }
  } finally {
    if (previous === undefined) delete process.env.ARCO_HOME; else process.env.ARCO_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

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
