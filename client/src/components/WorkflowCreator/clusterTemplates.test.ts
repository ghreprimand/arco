import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MEMBER_TIERS, presetForText } from '@arco/shared';
import { CLUSTER_TEMPLATES, ROLE_GUIDANCE, roleText } from './clusterTemplates.js';

test('built-in templates use role presets, valid tiers, efforts at most HIGH and words instead of model names', () => {
  assert.deepEqual(CLUSTER_TEMPLATES.map((t) => t.name), ['Pair', 'Small team', 'Full team', 'Parallel build', 'Research']);
  for (const t of CLUSTER_TEMPLATES) {
    assert.ok(t.roles.length >= 2, t.name);
    for (const role of t.roles) assert.equal(presetForText(roleText(role))?.key, role, `${t.name}: ${role} uses its preset text`);
  }
  for (const [role, g] of Object.entries(ROLE_GUIDANCE)) {
    assert.ok((MEMBER_TIERS as readonly string[]).includes(g.tier), role);
    assert.ok(['low', 'medium', 'high'].includes(g.effort), `${role} starts at most at HIGH`);
    assert.match(g.advice, /(Heavy|Standard|Light) (or (Heavy|Standard|Light) )?model, (LOW|MEDIUM|HIGH)/, role);
    assert.doesNotMatch(`${g.advice} ${g.reason}`, /opus|sonnet|haiku|gpt|claude|codex/i, `${role} names no model`);
  }
});
