import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUARDRAILS_HEADING, PUBLIC_DRAFT_REQUEST, PUBLIC_GUARDRAILS_TEMPLATE, hasGuardrails, insertGuardrails } from './publicGuardrails.js';

const plan = '# Title\n\nIntro line.\n\n### Phase one\n- [ ] task\n';

test('guardrails insert after the intro and before the first phase', () => {
  const next = insertGuardrails(plan);
  assert.ok(next.startsWith('# Title\n\nIntro line.\n\n## Privacy and public safety'));
  assert.ok(next.indexOf(GUARDRAILS_HEADING) < next.indexOf('### Phase one'));
  assert.ok(next.endsWith('### Phase one\n- [ ] task\n'));
  assert.equal(hasGuardrails(next), true);
});

test('guardrails are never inserted twice', () => {
  const once = insertGuardrails(plan);
  assert.equal(insertGuardrails(once), once);
  assert.equal(hasGuardrails('# T\n\n### Privacy and public safety\n- x\n'), true);
  assert.equal(hasGuardrails(plan), false);
});

test('guardrails append when a plan has no phase heading', () => {
  const next = insertGuardrails('# Title\n\nJust intro.');
  assert.ok(next.startsWith('# Title\n\nJust intro.\n\n## Privacy'));
  assert.ok(next.endsWith('safe: assume anything pushed was seen.\n') || next.endsWith('seen.\n'));
});

test('draft request carries the template', () => {
  assert.ok(PUBLIC_DRAFT_REQUEST.includes('## Privacy and public safety'));
});

test('template has no phase headings and adds no phases to a plan', () => {
  assert.ok(!PUBLIC_GUARDRAILS_TEMPLATE.split('\n').some((line) => line.startsWith('###')));
  assert.ok(!PUBLIC_DRAFT_REQUEST.split('\n').some((line) => line.startsWith('###')));
  const phases = (body: string) => body.split('\n').filter((line) => /^### /.test(line)).length;
  const three = '# T\n\nIntro.\n\n### A\n- [ ] a\n\n### B\n- [ ] b\n\n### C\n- [ ] c\n';
  assert.equal(phases(insertGuardrails(three)), 3);
  assert.equal(phases(insertGuardrails('# T\n\nIntro only.')), 0);
});
