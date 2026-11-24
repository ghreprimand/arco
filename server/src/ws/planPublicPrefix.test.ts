import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowState } from '../workflows/types.js';

const root = mkdtempSync(join(tmpdir(), 'arco-public-prefix-'));
installIsolatedTestHome(root);
const { trackRecallFixture } = await import('../testSupport/recallFixture.test-support.js');
const closeRecall = trackRecallFixture();
const { setPublicProjectChoice } = await import('../publicProjectChoice.js');
const { buildPlanPrefix, stripPlanPrefix } = await import('./turnEngine.js');
// Windows refuses to remove a folder while the recall index inside it is open.
after(async () => {
  const { settleProjectWrites } = await import('../testSupport/projectWrites.js');
  await settleProjectWrites();
  await closeRecall();
  rmSync(root, { recursive: true, force: true });
});

test('an agent without an attached plan is told to add privacy rules for a public project', async () => {
  const cwd = join(root, 'project'); mkdirSync(cwd);
  const workflow = {} as WorkflowState;
  const plain = await buildPlanPrefix(cwd, workflow, 'fixture');
  assert.doesNotMatch(plain, /This project is public/);
  await setPublicProjectChoice(cwd, true);
  const publicPrefix = await buildPlanPrefix(cwd, workflow, 'fixture');
  assert.match(publicPrefix, /This project is public.*Privacy and public safety/);
  assert.equal(stripPlanPrefix(publicPrefix + 'Make a plan'), 'Make a plan');
  await setPublicProjectChoice(cwd, false);
  assert.equal(await buildPlanPrefix(cwd, workflow, 'fixture'), plain);
});


test('a plan edit remains unseen after failure and is recorded only after success', async () => {
  const { randomUUID } = await import('node:crypto');
  const { createPlan, updatePlan } = await import('../planStore.js');
  const { persistInitialMeta, updateMeta, readMeta } = await import('../workflowMeta.js');
  const { recordPlanSeen, geminiPlanLine } = await import('./turnEngine.js');
  const cwd = join(root, 'seen-project'); mkdirSync(cwd);
  const id = randomUUID();
  const config = { name: 'Fixture', workingDirectory: cwd, primaryProvider: 'codex', primaryModel: 'fixture', primaryEffort: 'low' } as any;
  await persistInitialMeta(cwd, id, config, { provider: 'codex', model: 'fixture', effort: 'low' });
  const plan = await createPlan(cwd, { title: 'Fixture plan', body: '- [ ] Task' });
  await updateMeta(cwd, id, meta => { meta.planId = plan.id; meta.planLastSeenUpdatedAt = plan.updatedAt - 1; });
  const wf = { planId: plan.id } as WorkflowState;
  let snapshot: any;
  const first = await buildPlanPrefix(cwd, wf, id, value => { snapshot = value; });
  assert.match(first, /edited since last turn/);
  assert.match(geminiPlanLine(snapshot, cwd, false), /edited since your last turn/);
  await recordPlanSeen(cwd, id, wf, snapshot, false);
  assert.equal((await readMeta(cwd, id))?.planLastSeenUpdatedAt, plan.updatedAt - 1);
  assert.match(await buildPlanPrefix(cwd, wf, id), /edited since last turn/);
  await recordPlanSeen(cwd, id, wf, snapshot, true);
  assert.equal((await readMeta(cwd, id))?.planLastSeenUpdatedAt, plan.updatedAt);
  assert.doesNotMatch(await buildPlanPrefix(cwd, wf, id), /edited since last turn/);
  await new Promise(resolve => setTimeout(resolve, 5));
  const edit = await updatePlan(cwd, plan.id, { body: '- [ ] Changed' });
  assert.ok(edit && edit.updatedAt > plan.updatedAt);
  assert.match(await buildPlanPrefix(cwd, wf, id), /edited since last turn/);
});
