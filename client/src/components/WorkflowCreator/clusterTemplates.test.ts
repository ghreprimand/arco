import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presetForText } from '@arco/shared';
import { CLUSTER_TEMPLATES, ROLE_GUIDANCE, roleText, templateWorkSize, initialTemplateWorkSize } from './clusterTemplates.js';

test('built-in templates use role presets, optional work sizes for repeated roles and model guidance in words', () => {
  assert.deepEqual(CLUSTER_TEMPLATES.map((t) => t.name), ['Pair', 'Small team', 'Research', 'Medium team', 'Full team', 'Parallel build', 'Large team']);
  assert.deepEqual(CLUSTER_TEMPLATES.map((t) => t.roles.length), [2, 3, 3, 4, 5, 5, 6]);
  for (const id of ['parallel-build', 'large-team']) assert.match(CLUSTER_TEMPLATES.find((t) => t.id === id)!.summary, /large and routine/);
  assert.deepEqual(CLUSTER_TEMPLATES.map((t) => t.roles), [
    ['builder', 'reviewer'], ['director', 'builder', 'tester'], ['director', 'researcher', 'researcher'],
    ['director', 'builder', 'tester', 'documenter'], ['director', 'builder', 'tester', 'researcher', 'documenter'],
    ['director', 'builder', 'builder', 'tester', 'documenter'], ['director', 'builder', 'builder', 'tester', 'researcher', 'documenter'],
  ]);
  for (const t of CLUSTER_TEMPLATES) {
    assert.ok(t.roles.length >= 2, t.name);
    assert.deepEqual(t.roles.map((_, i) => initialTemplateWorkSize(t, i)), t.roles.map((r, i) => r === 'builder' && t.roles.filter((v) => v === r).length === 2 ? (t.roles.slice(0, i).includes(r) ? 'standard' : 'heavy') : ''));
    for (const role of t.roles) {
      assert.equal(presetForText(roleText(role))?.key, role, `${t.name}: ${role} uses its preset text`);
      assert.equal(templateWorkSize(t, role, ''), undefined);
      const repeated = t.roles.filter((r) => r === role).length > 1;
      assert.equal(templateWorkSize(t, role, 'heavy'), repeated ? 'heavy' : undefined);
      assert.equal(templateWorkSize(t, role, 'light'), repeated ? 'light' : undefined);
    }
  }
  for (const [role, g] of Object.entries(ROLE_GUIDANCE)) {
    assert.ok(['low', 'medium', 'high'].includes(g.effort), `${role} starts at most at HIGH`);
    assert.match(g.advice, /(Heavy|Standard|Light) (or (Heavy|Standard|Light) )?model, (LOW|MEDIUM|HIGH)/, role);
    assert.doesNotMatch(`${g.advice} ${g.reason}`, /opus|sonnet|haiku|gpt|claude|codex/i, `${role} names no model`);
  }
});
