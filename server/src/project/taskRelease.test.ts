import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as taskLedger from './taskLedger.js';

test('release labels are optional, trimmed, bounded and clearable', () => {
  const plain = taskLedger.newTask({ title: 'Plain' });
  assert.equal('release' in plain, false);
  const labeled = taskLedger.newTask({ title: 'Labeled', release: '  0.1.4  ' });
  assert.equal(labeled.release, '0.1.4');
  assert.equal(taskLedger.newTask({ title: 'Long', release: 'x'.repeat(80) }).release?.length, taskLedger.RELEASE_MAX);
  assert.equal('release' in taskLedger.newTask({ title: 'Blank', release: '   ' }), false);

  const tasks = [plain, labeled];
  const set = taskLedger.applyUpdate(tasks, plain.id, { release: '0.1.5' });
  assert.equal(set?.updated.release, '0.1.5');
  const untouched = taskLedger.applyUpdate(set!.tasks, plain.id, { notes: 'n' });
  assert.equal(untouched?.updated.release, '0.1.5');
  const cleared = taskLedger.applyUpdate(untouched!.tasks, plain.id, { release: '' });
  assert.equal('release' in (cleared?.updated ?? {}), false);
  assert.equal(taskLedger.formatBoardForModel([labeled]).includes('0.1.4'), true);
});

test('an older ledger without release labels loads unchanged', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-release-'));
  try {
    const dir = path.join(cwd, '.arco', 'project');
    await mkdir(dir, { recursive: true });
    const old = { id: 'a', title: 'Old task', status: 'todo', links: [], notes: '', createdAt: 1, updatedAt: 1 };
    await writeFile(path.join(dir, 'tasks.json'), JSON.stringify({ version: 1, tasks: [old] }));
    const tasks = await taskLedger.load(cwd);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, 'Old task');
    assert.equal('release' in tasks[0], false);
    await writeFile(path.join(dir, 'tasks.json'), JSON.stringify({ version: 1, tasks: [{ ...old, release: ' 0.1.4 ' }, { ...old, id: 'b', release: 7 }] }));
    const labeled = await taskLedger.load(cwd);
    assert.equal(labeled[0].release, '0.1.4');
    assert.equal('release' in labeled[1], false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
