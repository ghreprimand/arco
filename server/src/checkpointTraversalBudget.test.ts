import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-checkpoint-budget-')));
installIsolatedTestHome(root);
after(() => rmSync(root, { recursive: true, force: true }));
const { createCheckpoint, previewCheckpointRevert, revertToCheckpoint } = await import('./gitSnapshots.js');
const workflowId = '11111111-2222-4333-8444-555555555555';
function project(name: string, count = 12): string {
  const folder = join(process.env.HOME!, name); mkdirSync(folder, { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(folder, `file-${i}.txt`), 'original');
  return folder;
}
function limit(name: string, value: string, fn: () => Promise<void>): Promise<void> {
  const previous = process.env[name]; process.env[name] = value;
  return fn().finally(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
}

test('an entry-budget refusal publishes no partial shadow checkpoint and explains the limits', () => limit('ARCO_CHECKPOINT_SCAN_ENTRIES', '3', async () => {
  const cwd = project('entries'); const notices: string[] = [];
  const result = await createCheckpoint({ cwd, workflowId, seq: 1, ...{ onSkipped: (message: string) => notices.push(message) } });
  assert.equal(result, null);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /folder is too large/);
  assert.match(notices[0], /ARCO_CHECKPOINT_TOTAL_CAP_BYTES/);
  assert.match(notices[0], /ARCO_CHECKPOINT_SCAN_ENTRIES/);
  assert.equal((await previewCheckpointRevert({ cwd, workflowId, seq: 1 })).ok, false);
}));

test('the elapsed-time budget also refuses the entire shadow checkpoint', async t => {
  const cwd = project('time');
  let clock = 0;
  t.mock.method(performance, 'now', () => { clock += 1000; return clock; });
  assert.equal(await createCheckpoint({ cwd, workflowId, seq: 2 }), null);
});

test('a budget-limited shadow revert changes no files', async () => {
  const cwd = project('restore', 2);
  assert.ok(await createCheckpoint({ cwd, workflowId, seq: 3 }));
  writeFileSync(join(cwd, 'file-0.txt'), 'keep edited');
  writeFileSync(join(cwd, 'added.txt'), 'keep added');
  await limit('ARCO_CHECKPOINT_SCAN_ENTRIES', '1', async () => {
    const preview = await previewCheckpointRevert({ cwd, workflowId, seq: 3 });
    assert.equal(preview.ok, false);
    if (!preview.ok) assert.match(preview.error, /ARCO_CHECKPOINT_TOTAL_CAP_BYTES/);
    assert.equal(await revertToCheckpoint({ cwd, workflowId, seq: 3 }), null);
  });
  assert.equal(readFileSync(join(cwd, 'file-0.txt'), 'utf8'), 'keep edited');
  assert.equal(readFileSync(join(cwd, 'added.txt'), 'utf8'), 'keep added');
});

test('Git-backed checkpoints retain their existing scope and ignore semantics', () => limit('ARCO_CHECKPOINT_SCAN_ENTRIES', '1', async () => {
  const cwd = project('git'); execFileSync('git', ['init', '-q'], { cwd });
  writeFileSync(join(cwd, '.gitignore'), 'ignored.txt\n'); writeFileSync(join(cwd, 'ignored.txt'), 'ignored');
  const result = await createCheckpoint({ cwd, workflowId, seq: 4 });
  assert.ok(result); assert.equal(result.backend, 'git');
  assert.equal(execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8' }), '');
}));
