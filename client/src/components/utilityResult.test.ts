import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeUtilityFailure, utilityAttribution } from './utilityResult';
import type { UtilityJobResult } from '@arco/shared';

const base: UtilityJobResult = { jobId: 'fixture', status: 'error', agent: { provider: 'claude', model: 'example' }, facts: [], elapsedMs: 1 };
test('utility failures show the cause and identify the attempted model', () => {
  for (const [reason, expected] of [['not_signed_in', /Sign in/], ['empty_answer', /empty reply/], ['unreadable_answer', /unreadable reply/], ['non_text_answer', /non-text/], ['output_too_long', /too long/], ['provider_http_404', /HTTP 404/], ['timeout', /did not answer in time/]] as const) {
    const result = { ...base, reason };
    assert.match(describeUtilityFailure(result), expected);
    assert.equal(utilityAttribution(result), 'Tried CLAUDE / example.');
  }
  assert.equal(utilityAttribution({ ...base, status: 'ok', text: 'A reply.' }), 'Answered by CLAUDE / example.');
});
