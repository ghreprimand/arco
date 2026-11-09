import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-checkpoint-scope-')));
installIsolatedTestHome(root);
after(() => rmSync(root, { recursive: true, force: true }));
const snapshots = await import('./gitSnapshots.js');
const workflowId = '11111111-2222-4333-8444-555555555555';
function fixture(name: string, nestedGit = true) {
  const cwd = join(process.env.HOME!, name), nested = join(cwd, 'nested');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(cwd, 'root.txt'), 'original root');
  writeFileSync(join(nested, 'working.txt'), 'original nested');
  if (nestedGit) execFileSync('git', ['init', '-q'], { cwd: nested });
  return { cwd, nested };
}

test('shadow counts, preview and restore agree while naming excluded nested repositories', async () => {
  const { cwd, nested } = fixture('consistent');
  const checkpoint = await snapshots.createCheckpoint({ cwd, workflowId, seq: 1 });
  assert.ok(checkpoint); assert.equal(checkpoint.fileCount, 1);
  assert.match((checkpoint as any).limitation, /Nested repositories not included.*nested/);
  writeFileSync(join(cwd, 'root.txt'), 'edited root'); writeFileSync(join(nested, 'working.txt'), 'edited nested');
  const preview = await snapshots.previewCheckpointRevert({ cwd, workflowId, seq: 1 });
  assert.ok(preview.ok); assert.equal(preview.changes.changed, 1); assert.equal(preview.changes.removed, 0);
  assert.match((preview as any).limitation, /nested/);
  const result = await snapshots.revertToCheckpoint({ cwd, workflowId, seq: 1 });
  assert.ok(result); assert.equal(result.fileCount, 1); assert.match(result.limitation!, /nested/);
  assert.equal(readFileSync(join(cwd, 'root.txt'), 'utf8'), 'original root');
  assert.equal(readFileSync(join(nested, 'working.txt'), 'utf8'), 'edited nested');
});

test('recorded nested exclusions survive removal of the Git marker', async () => {
  const { cwd, nested } = fixture('marker-removed');
  assert.ok(await snapshots.createCheckpoint({ cwd, workflowId, seq: 2 }));
  renameSync(join(nested, '.git'), join(root, 'removed-git'));
  writeFileSync(join(nested, 'working.txt'), 'keep nested');
  assert.ok(await snapshots.revertToCheckpoint({ cwd, workflowId, seq: 2 }));
  assert.equal(readFileSync(join(nested, 'working.txt'), 'utf8'), 'keep nested');
});

test('a folder that became a nested repository cannot be overwritten by an older target', async () => {
  const { cwd, nested } = fixture('new-nested', false);
  assert.ok(await snapshots.createCheckpoint({ cwd, workflowId, seq: 3 }));
  execFileSync('git', ['init', '-q'], { cwd: nested });
  writeFileSync(join(cwd, 'root.txt'), 'keep root'); writeFileSync(join(nested, 'working.txt'), 'keep nested');
  const preview = await snapshots.previewCheckpointRevert({ cwd, workflowId, seq: 3 });
  assert.equal(preview.ok, false);
  if (!preview.ok) assert.match(preview.error, /nested/);
  assert.equal(await snapshots.revertToCheckpoint({ cwd, workflowId, seq: 3 }), null);
  assert.equal(readFileSync(join(cwd, 'root.txt'), 'utf8'), 'keep root');
  assert.equal(readFileSync(join(nested, 'working.txt'), 'utf8'), 'keep nested');
});

test('older manifests without nested scope preserve unrecorded folders and explain that limitation', async () => {
  const { cwd, nested } = fixture('legacy');
  assert.ok(await snapshots.createCheckpoint({ cwd, workflowId, seq: 4 }));
  const store = join(process.env.ARCO_HOME!, 'checkpoints', createHash('sha256').update(cwd).digest('hex').slice(0, 16));
  writeFileSync(join(store, `${workflowId}.4.skipped.json`), JSON.stringify({ version: 1, paths: [] }));
  renameSync(join(nested, '.git'), join(root, 'legacy-git'));
  writeFileSync(join(cwd, 'root.txt'), 'edited root'); writeFileSync(join(nested, 'working.txt'), 'keep legacy nested');
  const preview = await snapshots.previewCheckpointRevert({ cwd, workflowId, seq: 4 });
  assert.ok(preview.ok); assert.equal(preview.changes.removed, 0);
  assert.match((preview as any).limitation, /Older checkpoint.*nested/);
  assert.ok(await snapshots.revertToCheckpoint({ cwd, workflowId, seq: 4 }));
  assert.equal(readFileSync(join(cwd, 'root.txt'), 'utf8'), 'original root');
  assert.equal(readFileSync(join(nested, 'working.txt'), 'utf8'), 'keep legacy nested');
});

test('older manifests still remove new files inside a folder represented in the target', async () => {
  const { cwd, nested } = fixture('legacy-known', false);
  assert.ok(await snapshots.createCheckpoint({ cwd, workflowId, seq: 5 }));
  const store = join(process.env.ARCO_HOME!, 'checkpoints', createHash('sha256').update(cwd).digest('hex').slice(0, 16));
  writeFileSync(join(store, `${workflowId}.5.skipped.json`), JSON.stringify({ version: 1, paths: [] }));
  writeFileSync(join(nested, 'new.txt'), 'new');
  const preview = await snapshots.previewCheckpointRevert({ cwd, workflowId, seq: 5 });
  assert.ok(preview.ok); assert.equal(preview.changes.removed, 1);
  assert.ok(await snapshots.revertToCheckpoint({ cwd, workflowId, seq: 5 }));
  assert.throws(() => readFileSync(join(nested, 'new.txt')), { code: 'ENOENT' });
});

test('nested scope disclosure names at most three folders and reports the remainder', async () => {
  const { cwd } = fixture('bounded-names', false);
  for (let i = 0; i < 5; i++) {
    const folder = join(cwd, `repository-${i}`); mkdirSync(folder);
    writeFileSync(join(folder, '.git'), 'gitdir: fixture'); writeFileSync(join(folder, 'working.txt'), 'outside scope');
  }
  const checkpoint = await snapshots.createCheckpoint({ cwd, workflowId, seq: 6 });
  assert.ok(checkpoint); assert.equal(checkpoint.fileCount, 2);
  assert.match(checkpoint.limitation!, /repository-0.*repository-1.*repository-2.*2 more/);
  assert.doesNotMatch(checkpoint.limitation!, /repository-3|repository-4/);
});
