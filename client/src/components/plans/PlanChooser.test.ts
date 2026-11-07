import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countPlanTasks } from './PlanChooser';

test('plan chooser counts checked and unchecked checklist tasks, including nested tasks', () => {
  assert.equal(countPlanTasks('# Phase\n- [ ] First\n  - [x] Child\n- [X] Done\n- ordinary bullet\n'), 3);
  assert.equal(countPlanTasks('A note without tasks'), 0);
});
