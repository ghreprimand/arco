// Persistent +SKILL pins — headless WS smoke (no model call / API spend).
//
// Covers the new protocol surface: create a workflow, replace its pinned set,
// observe the durable pinned_skills_set acknowledgement + byte count, verify
// meta.json, then clear and verify reversibility.
//
// Run with the dev server up: npm run smoke:pinned-skills

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { connect, step, assert, assertEq, summary } from './lib.js';

async function main(): Promise<void> {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), 'arco-pinned-skills-smoke-'));
  const skillDir = path.join(cwd, '.arco', 'skills', 'standing-check');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), [
    '---',
    'name: Standing Check',
    'description: A persistent smoke-test playbook.',
    'operator-only: true',
    '---',
    '',
    'Always verify the requested change.',
  ].join('\n'));

  const c = await connect();
  let workflowId = '';
  try {
    await step('create workflow without starting a model turn', async () => {
      c.send({
        type: 'create_workflow',
        config: {
          name: 'Pinned skills smoke',
          primaryProvider: 'claude',
          primaryModel: 'claude-sonnet-4-6',
          primaryEffort: 'normal',
          skipPermissions: true,
          workingDirectory: cwd,
          claudeTransport: 'native',
        },
      });
      const created = await c.waitFor((m) => m.type === 'workflow_created', 8000, 'workflow_created');
      workflowId = created.workflowId as string;
      assert(workflowId.length > 0, 'workflow id returned');
    });

    await step('pin set is acknowledged with resolved name + bytes', async () => {
      c.send({
        type: 'update_primary_config',
        workflowId,
        pinnedSkills: [{ scope: 'project', slug: 'standing-check' }],
      });
      const event = await c.waitFor((m) => m.type === 'pinned_skills_set', 5000, 'pinned_skills_set');
      const skills = event.skills as Array<{ scope: string; slug: string; name: string }>;
      assertEq(skills.length, 1, 'one pin active');
      assertEq(skills[0]?.name, 'Standing Check', 'server resolved display name');
      assert((event.bytes as number) > 0, 'standing prompt byte count returned');
      assertEq((event.missing as string[]).length, 0, 'nothing skipped');
    });

    await step('pin is durable in meta.json', async () => {
      const meta = JSON.parse(await fs.readFile(path.join(cwd, '.arco', 'workflows', workflowId, 'meta.json'), 'utf8'));
      assertEq(meta.pinnedSkills?.[0]?.scope, 'project', 'scope persisted');
      assertEq(meta.pinnedSkills?.[0]?.slug, 'standing-check', 'slug persisted');
    });

    await step('empty replacement unpins and clears meta.json', async () => {
      c.send({ type: 'update_primary_config', workflowId, pinnedSkills: [] });
      const event = await c.waitFor((m) => m.type === 'pinned_skills_set', 5000, 'pinned_skills_set clear');
      assertEq((event.skills as unknown[]).length, 0, 'event reports zero pins');
      const meta = JSON.parse(await fs.readFile(path.join(cwd, '.arco', 'workflows', workflowId, 'meta.json'), 'utf8'));
      assert(meta.pinnedSkills === undefined, 'meta pin field removed');
    });
  } finally {
    await c.close();
    await fs.rm(cwd, { recursive: true, force: true });
  }

  summary('pinned-skills');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
