// DD8 — operator-only skills + body-inlining smoke.
//
// Headless / module-level (no live server, no API spend). Exercises the
// deterministic skill core the turn path calls: frontmatter `operator-only`
// round-trips through write→scan, the manifest WITHHOLDS operator-only skills
// while keeping normal ones, and buildPickedSkillsBlock inlines the full body.
//
// Uses temp project + global skill roots. Global skills live under ~/.arco —
// to stay hermetic we write a project skill (cwd-scoped) for both cases and
// assert on the project list, so the operator's real ~/.arco is untouched.
//
// Run: npm run smoke:operator-skills   (no server needed)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { step, assert, assertEq, summary } from './lib.js';

async function main(): Promise<void> {
  const skills = await import('../../server/src/skills.js');
  const { writeSkill, listSkills, readSkillBody, buildSkillsManifest, buildPickedSkillsBlock } = skills;

  const cwd = path.join(tmpdir(), `arco-opskills-smoke-${process.pid}`);
  await fs.mkdir(cwd, { recursive: true });

  try {
    await step('DD8.0 write a normal + an operator-only project skill', async () => {
      await writeSkill({ scope: 'project', name: 'Deploy Runbook', description: 'how to deploy', body: 'Step 1. build.\nStep 2. ship.' }, cwd);
      const oo = await writeSkill({ scope: 'project', name: 'Secret Playbook', description: 'operator eyes only', body: 'Do the secret thing.', operatorOnly: true }, cwd);
      assertEq(oo.operatorOnly, true, 'writeSkill returns operatorOnly');
    });

    await step('DD8.1 operator-only flag round-trips through scan', async () => {
      const catalog = await listSkills(cwd);
      const oo = catalog.project.find((s) => s.name === 'Secret Playbook');
      const normal = catalog.project.find((s) => s.name === 'Deploy Runbook');
      assert(oo?.operatorOnly === true, 'operator-only skill parsed as operatorOnly');
      assert(!normal?.operatorOnly, 'normal skill is not operatorOnly');
    });

    await step('DD8.2 manifest WITHHOLDS the operator-only skill, keeps the normal one', async () => {
      const catalog = await listSkills(cwd);
      const manifest = buildSkillsManifest(catalog);
      assert(manifest.includes('Deploy Runbook'), 'normal skill in manifest');
      assert(!manifest.includes('Secret Playbook'), 'operator-only skill absent from manifest');
    });

    await step('DD8.3 buildPickedSkillsBlock inlines the full body + reports bytes', async () => {
      const catalog = await listSkills(cwd);
      const oo = catalog.project.find((s) => s.name === 'Secret Playbook')!;
      const full = await readSkillBody(oo.scope, oo.slug, cwd);
      assert(full, 'operator-only body is readable on pick');
      const block = buildPickedSkillsBlock([{ name: full!.name, scope: full!.scope, body: full!.body }]);
      assert(block.text.includes('Do the secret thing.'), 'full body inlined');
      assert(block.text.includes('Secret Playbook'), 'skill name framed in the block');
      assert(block.bytes > 0, 'byte count reported for the cost notice');
    });

    await step('DD8.4 empty pick list yields an empty block', () => {
      const block = buildPickedSkillsBlock([]);
      assertEq(block.text, '', 'no picks → empty');
      assertEq(block.bytes, 0, 'no picks → 0 bytes');
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }

  summary('operator-skills');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
