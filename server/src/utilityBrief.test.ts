import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UTILITY_BRIEF_MAX_FACTS, UTILITY_BRIEF_VALUE_MAX } from '@arco/shared';
import { BRIEF_INSTRUCTIONS, parseBriefFacts } from './utilityBrief.js';
import { runUtilityJob } from './utilityJob.js';
import { setEvaluatorAdaptersForTest, type EvaluatorRequest } from './smartPickupAdapters.js';

test('brief facts are validated, flattened and bounded', () => {
  assert.equal(parseBriefFacts(undefined), null);
  assert.equal(parseBriefFacts([]), null);
  assert.equal(parseBriefFacts([{ label: '', value: 'x' }]), null);
  assert.equal(parseBriefFacts([{ label: 'A', value: 3 }]), null);
  assert.equal(parseBriefFacts(Array.from({ length: UTILITY_BRIEF_MAX_FACTS + 1 }, () => ({ label: 'A', value: 'b' }))), null);
  const facts = parseBriefFacts([{ label: ' Step \n one', value: `a\nb${'x'.repeat(UTILITY_BRIEF_VALUE_MAX * 2)}` }])!;
  assert.equal(facts[0]!.label, 'Step one');
  assert.ok(facts[0]!.value.startsWith('a / b'));
  assert.equal(facts[0]!.value.length, UTILITY_BRIEF_VALUE_MAX);
});

test('instructions forbid guessing and advice for both scopes', () => {
  for (const scope of ['worker', 'cluster'] as const) {
    assert.match(BRIEF_INSTRUCTIONS[scope], /not visible/);
    assert.match(BRIEF_INSTRUCTIONS[scope], /never guess/);
    assert.match(BRIEF_INSTRUCTIONS[scope], /do not propose actions/);
  }
  assert.match(BRIEF_INSTRUCTIONS.worker, /thinking with no actions/);
  assert.match(BRIEF_INSTRUCTIONS.cluster, /Waiting on the operator/);
});

test('a brief runs with no tools, facts first and returns the facts shown', async () => {
  let seen: EvaluatorRequest | null = null;
  const restore = setEvaluatorAdaptersForTest({ ollama: { provider: 'ollama', capability: async () => ({ provider: 'ollama', available: true }), evaluate: async (r) => { seen = r; return 'Working on a build.'; } } });
  try {
    const r = await runUtilityJob({ jobId: 'brief-test-1', instructions: BRIEF_INSTRUCTIONS.worker, facts: [{ label: 'Turn', value: 'working 2m' }], agent: { provider: 'ollama', model: 'small' } });
    assert.equal(r.status, 'ok');
    assert.equal(r.text, 'Working on a build.');
    assert.deepEqual(r.facts, [{ label: 'Turn', value: 'working 2m' }]);
    assert.ok(seen!.prompt.startsWith('Facts:\n- Turn: working 2m'));
    assert.equal(seen!.freeText, true);
  } finally { restore(); }
});
