import assert from 'node:assert/strict';
import test from 'node:test';
import { closeSummaryPlan, recallSummarizerFor } from './closeSummary.js';

const cfg = { name: 'Fix login', primaryProvider: 'codex', primaryModel: 'gpt-6-luna', primaryEffort: 'low', providerAccountRef: 'acct' } as never;
const job = (over: Record<string, unknown> = {}, config: Record<string, unknown> = {}) => ({
  id: 'wf-1234567890', messages: [{ role: 'user' }, { role: 'assistant' }], config: { ...(cfg as object), ...config }, ...over,
}) as never;

test('closing starts a summary only when armed, saved and not Incognito', () => {
  assert.equal(closeSummaryPlan(job(), false), null, 'unchecked box does nothing');
  assert.equal(closeSummaryPlan(undefined, true), null);
  assert.equal(closeSummaryPlan(job({}, { incognito: true }), true), null, 'Incognito tabs do nothing');
  assert.equal(closeSummaryPlan(job({ messages: [{ role: 'system' }] }), true), null, 'no session, nothing to summarize');
  const plan = closeSummaryPlan(job(), true)!;
  assert.equal(plan.wfid, 'wf-1234567890');
  assert.equal(plan.title, 'Fix login');
  assert.deepEqual(plan.summarizer, { provider: 'codex', model: 'gpt-6-luna', effort: 'low', providerAccountRef: 'acct' });
  assert.ok(closeSummaryPlan(job({ messages: [], resumedVia: 'native' }), true), 'a resumed session counts');
  assert.equal(closeSummaryPlan(job({}, { name: '' }), true)!.title, 'wf-12345');
});

test('the summarizer is the one the Recall Summarize action uses', () => {
  assert.deepEqual(recallSummarizerFor(undefined, 'claude'), { provider: 'claude', model: 'default', effort: 'high', providerAccountRef: undefined });
  assert.deepEqual(recallSummarizerFor(cfg, 'claude'), { provider: 'codex', model: 'gpt-6-luna', effort: 'low', providerAccountRef: 'acct' });
});
