import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PROJECT_IGNORE, ensureProjectStateIgnore } from './projectStateIgnore.js';
import { createPlan } from './planStore.js';
import { saveKernel } from './project/taskLedger.js';
import { store as knowledgeStore } from './knowledge/store.js';
import { initWorkflowStore, forgetWorkflowBuffer } from './workflowStore.js';
import { acquireProjectSettingsWatcher, releaseProjectSettingsWatcher } from './settings.js';

function project() { return mkdtempSync(join(tmpdir(), 'arco-ignore-')); }
function ignored(cwd: string, file: string) { return spawnSync('git', ['-c', `core.excludesFile=${devNull}`, 'check-ignore', '-q', '--', file], { cwd }).status === 0; }

test('new project state is ignored by git and an explicit exception works', () => {
  const cwd = project();
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    ensureProjectStateIgnore(cwd);
    assert.equal(readFileSync(join(cwd, '.arco', '.gitignore'), 'utf8'), DEFAULT_PROJECT_IGNORE);
    mkdirSync(join(cwd, '.arco', 'plans'));
    writeFileSync(join(cwd, '.arco', 'plans', 'fixture.md'), 'private fixture');
    writeFileSync(join(cwd, '.arco', 'settings.json'), '{}');
    for (const file of ['.arco/.gitignore', '.arco/settings.json', '.arco/plans/fixture.md', '.arco/project/tasks.json', '.arco/STATE.md']) assert.equal(ignored(cwd, file), true, file);
    execFileSync('git', ['-c', `core.excludesFile=${devNull}`, 'add', '-A'], { cwd });
    assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd, encoding: 'utf8' }), '');
    writeFileSync(join(cwd, '.arco', '.gitignore'), DEFAULT_PROJECT_IGNORE + '!settings.json\n');
    assert.equal(ignored(cwd, '.arco/settings.json'), false);
    assert.equal(ignored(cwd, '.arco/STATE.md'), true);
  } finally { rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('only the exact old default is upgraded', () => {
  const cwd = project();
  try {
    mkdirSync(join(cwd, '.arco'));
    const file = join(cwd, '.arco', '.gitignore');
    const legacy = "# Arco per-workflow state \u2014 ephemeral, don't commit\nworkflows/\nsession-index.json\ntitle-events.jsonl\n";
    writeFileSync(file, legacy);
    ensureProjectStateIgnore(cwd);
    assert.equal(readFileSync(file, 'utf8'), DEFAULT_PROJECT_IGNORE);
    const edited = legacy + '!settings.json\n';
    writeFileSync(file, edited); ensureProjectStateIgnore(cwd);
    assert.equal(readFileSync(file, 'utf8'), edited);
  } finally { rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('plan, board and knowledge first writes establish the ignore file', async () => {
  for (const kind of ['plan', 'board', 'knowledge'] as const) {
    const cwd = project();
    try {
      if (kind === 'plan') await createPlan(cwd, { title: 'Fixture', body: 'A plan' });
      else if (kind === 'board') await saveKernel(cwd, { tasks: [], comments: [], runs: [] });
      else await knowledgeStore.save(cwd, { id: 'fixture', title: 'Fixture', body: 'Example', tags: [], alwaysInclude: false, createdAt: 1, updatedAt: 1, bytes: 7 });
      assert.equal(readFileSync(join(cwd, '.arco', '.gitignore'), 'utf8'), DEFAULT_PROJECT_IGNORE, kind);
    } finally { rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }
});


test('workflow initialization and project settings watcher protect a fresh project', async () => {
  for (const kind of ['workflow', 'settings'] as const) {
    const cwd = project();
    try {
      if (kind === 'workflow') await initWorkflowStore(cwd, 'fixture-workflow');
      else acquireProjectSettingsWatcher(cwd);
      assert.equal(readFileSync(join(cwd, '.arco', '.gitignore'), 'utf8'), DEFAULT_PROJECT_IGNORE, kind);
      if (kind === 'workflow') forgetWorkflowBuffer(cwd, 'fixture-workflow');
      else releaseProjectSettingsWatcher(cwd);
    } finally { rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }
});

test('workflow initialization fails closed and can retry when protection cannot be written', async () => {
  const cwd = project();
  try {
    mkdirSync(join(cwd, '.arco', '.gitignore'), { recursive: true });
    await assert.rejects(initWorkflowStore(cwd, 'fixture-retry'));
    assert.equal((await import('node:fs')).existsSync(join(cwd, '.arco', 'workflows')), false);
    rmSync(join(cwd, '.arco', '.gitignore'), { recursive: true });
    await initWorkflowStore(cwd, 'fixture-retry');
    assert.equal(readFileSync(join(cwd, '.arco', '.gitignore'), 'utf8'), DEFAULT_PROJECT_IGNORE);
    forgetWorkflowBuffer(cwd, 'fixture-retry');
  } finally { rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
