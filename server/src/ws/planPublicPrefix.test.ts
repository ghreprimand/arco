import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowState } from '../workflows/types.js';

const root = mkdtempSync(join(tmpdir(), 'arco-public-prefix-'));
installIsolatedTestHome(root);
const { setPublicProjectChoice } = await import('../publicProjectChoice.js');
const { buildPlanPrefix, stripPlanPrefix } = await import('./turnEngine.js');
after(() => rmSync(root, { recursive: true, force: true }));

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
