import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insertGuardrails } from '@arco/shared';
import { planDraftPrompt, planRefinePrompt } from './planDraft.js';

test('public flag adds the guardrails request and leaves the plain prompt unchanged', () => {
  const plain = planDraftPrompt('', 'review', true);
  assert.equal(plain, planDraftPrompt('', 'review', true, false));
  assert.ok(!plain.includes('Privacy and public safety'));
  const flagged = planDraftPrompt('', 'review', true, true);
  assert.ok(flagged.startsWith(plain));
  assert.ok(flagged.includes('## Privacy and public safety'));
});

test('refine keeps the guardrails section only when the draft has it', () => {
  const draft = '# T\n\n### Phase\n- [ ] a\n';
  assert.ok(!planRefinePrompt(draft, 'shorter').includes('Keep the "Privacy and public safety" section'));
  assert.ok(planRefinePrompt(draft, 'shorter', false, true).includes('## Privacy and public safety'));
  assert.ok(planRefinePrompt(insertGuardrails(draft), 'shorter').includes('Keep the "Privacy and public safety" section'));
});
