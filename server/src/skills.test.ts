import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildPinnedSkillsBlock,
  resolvePinnedSkills,
  writeSkill,
} from './skills.js';

test('pinned skill block is standing, framed, and byte-counted', () => {
  const block = buildPinnedSkillsBlock([
    { name: 'Review Code', scope: 'global', body: 'Inspect the diff before reporting.' },
  ]);
  assert.match(block.text, /every turn until the operator removes the pin/i);
  assert.match(block.text, /<archon-pinned-skill name="Review Code" scope="global">/);
  assert.match(block.text, /Inspect the diff before reporting\./);
  assert.equal(block.bytes, Buffer.byteLength(block.text, 'utf8'));
});

test('resolvePinnedSkills de-dupes references and reports missing skills', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'archon-pinned-skills-'));
  try {
    const skill = await writeSkill({
      scope: 'project',
      name: 'Project Check',
      description: 'Check the project.',
      body: 'Run the project checks.',
      operatorOnly: true,
    }, cwd);
    const resolved = await resolvePinnedSkills([
      { scope: 'project', slug: skill.slug },
      { scope: 'project', slug: skill.slug },
      { scope: 'project', slug: 'does-not-exist' },
    ], cwd);
    assert.equal(resolved.skills.length, 1);
    assert.equal(resolved.skills[0]?.name, 'Project Check');
    assert.deepEqual(resolved.missing, ['project:does-not-exist']);
    assert.deepEqual(resolved.truncated, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
