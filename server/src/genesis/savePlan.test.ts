import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveGenesisPlan } from './savePlan.js';
import { readPlan, readPlanRef } from '../planStore.js';

const seed = { title: 'Fixture', spark: 'A small tool', concept: 'Read fixtures', theCase: 'Repeatable checks', buildDirection: 'Start with one fixture', planOnly: true };

for (const existing of [false, true]) test(`plan ending preserves project files (existing docs: ${existing})`, async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-genesis-plan-'));
  try {
    await fs.writeFile(path.join(cwd, 'README.md'), 'original readme');
    if (existing) for (const name of ['SPEC.md', 'TODO.md']) await fs.writeFile(path.join(cwd, name), 'original');
    const saved = await saveGenesisPlan(cwd, seed, true);
    assert.deepEqual(saved.written, existing ? [] : ['SPEC.md', 'TODO.md']);
    assert.equal(await fs.readFile(path.join(cwd, 'README.md'), 'utf8'), 'original readme');
    for (const name of ['SPEC.md', 'TODO.md']) {
      const body = await fs.readFile(path.join(cwd, name), 'utf8');
      if (existing) assert.equal(body, 'original'); else assert.match(body, /Fixture/);
    }
    const plan = await readPlan(cwd, saved.planId);
    assert.match(plan!.body, /- \[ \]/);
    assert.match(plan!.body, /Privacy and public safety/i);
    for (const slug of ['concept', 'case', 'build-direction', 'first-steps', 'spec']) assert.ok(await readPlanRef(cwd, saved.planId, slug));
    assert.match((await readPlanRef(cwd, saved.planId, 'spec'))!.body, /Repeatable checks/);
    assert.equal(await fs.stat(path.join(cwd, 'ALTERNATIVE')).catch(() => null), null);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

test('exclusive create preserves a symlink and a directory at document names', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-genesis-plan-'));
  try {
    await fs.writeFile(path.join(cwd, 'target'), 'untouched');
    await fs.symlink('target', path.join(cwd, 'SPEC.md'));
    await fs.mkdir(path.join(cwd, 'TODO.md'));
    const saved = await saveGenesisPlan(cwd, seed, false);
    assert.deepEqual(saved.written, []);
    assert.equal(await fs.readFile(path.join(cwd, 'target'), 'utf8'), 'untouched');
    assert.equal((await fs.lstat(path.join(cwd, 'SPEC.md'))).isSymbolicLink(), true);
    assert.equal((await fs.stat(path.join(cwd, 'TODO.md'))).isDirectory(), true);
    assert.equal(await fs.stat(path.join(cwd, 'README.md')).catch(() => null), null);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});
