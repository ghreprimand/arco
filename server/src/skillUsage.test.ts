// §5.2 — skill-usage sidecar tests. Pure predicates + a fs round-trip against a
// temp file (the `file` override exists for exactly this). No live server / API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  isSkillMdPath,
  extractReadPath,
  canonicalSkillKey,
  recordSkillRead,
  readSkillUsage,
} from './skillUsage.js';

test('isSkillMdPath matches a .arco/skills/<slug>/SKILL.md path', () => {
  assert.equal(isSkillMdPath('/home/u/proj/.arco/skills/deploy/SKILL.md'), true);
  assert.equal(isSkillMdPath('/home/u/.arco/skills/foo/SKILL.md'), true);
});

test('isSkillMdPath rejects non-skill SKILL.md and non-SKILL files', () => {
  assert.equal(isSkillMdPath('/home/u/proj/SKILL.md'), false, 'SKILL.md outside skills root');
  assert.equal(isSkillMdPath('/home/u/proj/.arco/skillsfoo/x/SKILL.md'), false, 'sibling dir, not skills');
  assert.equal(isSkillMdPath('/home/u/proj/.arco/skills/foo/README.md'), false, 'not SKILL.md');
  assert.equal(isSkillMdPath(''), false);
});

test('extractReadPath pulls file_path from a Read tool_use input JSON', () => {
  assert.equal(extractReadPath('{"file_path":"/a/b/SKILL.md"}'), '/a/b/SKILL.md');
  assert.equal(extractReadPath('{"file_path":""}'), null, 'empty path → null');
  assert.equal(extractReadPath('{"other":1}'), null, 'no file_path → null');
  assert.equal(extractReadPath('not json'), null, 'malformed → null');
  assert.equal(extractReadPath(undefined), null);
});

test('canonicalSkillKey resolves to absolute', () => {
  assert.equal(canonicalSkillKey('/a/b/../b/SKILL.md'), '/a/b/SKILL.md');
});

test('recordSkillRead increments count and stamps lastUsed; no-op for non-skill', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-skillusage-'));
  const file = path.join(dir, 'skill-usage.json');
  try {
    const skill = '/repo/.arco/skills/deploy/SKILL.md';

    await recordSkillRead(skill, 1000, file);
    let usage = await readSkillUsage(file);
    assert.equal(usage[skill]?.count, 1);
    assert.equal(usage[skill]?.lastUsed, 1000);

    await recordSkillRead(skill, 2000, file);
    usage = await readSkillUsage(file);
    assert.equal(usage[skill]?.count, 2, 'second Read increments');
    assert.equal(usage[skill]?.lastUsed, 2000, 'lastUsed advances');

    // Non-skill path must not write anything new.
    await recordSkillRead('/repo/src/index.ts', 3000, file);
    usage = await readSkillUsage(file);
    assert.equal(Object.keys(usage).length, 1, 'non-skill Read is a no-op');
    assert.equal(usage[skill]?.count, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readSkillUsage returns empty for a missing file', async () => {
  const usage = await readSkillUsage(path.join(os.tmpdir(), 'arco-nonexistent-usage-xyz.json'));
  assert.deepEqual(usage, {});
});
