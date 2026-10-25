// Regression tests for the 2026-07-09 incident: an 18 KB shared plan folded
// ahead of the tail-slicing 16 KB cap silently evicted the peer-mailbox
// notice, role hint, and code-mode addendum from the first live gpt-5.6
// cluster member's turn (docs/CODEX_GPT56_CLUSTER_INCOMPAT.md §10). The plan
// must be the ONLY block that shrinks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeClusterAppend, APPEND_CLUSTER_MAX, CODEX_APP_SERVER_CLUSTER_MAX } from './clusterStringFold.js';
import { codexCodeModeClusterAddendum } from './providers/codexCodeMode.js';

const ROLE = 'Your role in this cluster: Implementer role. Focus on your assigned tasks.';

test('small plan + tail blocks join verbatim, no truncation', () => {
  const { combined, planTruncatedFrom } = composeClusterAppend(
    '--- Shared cluster plan ---\nShip the thing.',
    [ROLE, 'doctrine'],
  );
  assert.equal(combined, `--- Shared cluster plan ---\nShip the thing.\n\n${ROLE}\n\ndoctrine`);
  assert.equal(planTruncatedFrom, undefined);
});

test('oversized plan is truncated; role + real addendum survive verbatim (incident replica)', () => {
  // Tonight's plan block was 18 746 bytes when the old cap sliced at 16 384.
  const plan = '--- Shared cluster plan ---\n' + 'plan line about Bugs 3-5.\n'.repeat(720);
  assert.ok(plan.length > 18_000);
  const addendum = codexCodeModeClusterAddendum();
  const notice = '--- PEER MAILBOX ---\nYou have 1 pending peer message waiting. Read them now with the peer_read tool and act on their contents.';
  const { combined, planTruncatedFrom } = composeClusterAppend(plan, [ROLE, addendum], notice.length);
  assert.ok(combined);
  // Total including the already-folded notice fits the cap.
  assert.ok(combined.length + 2 + notice.length <= APPEND_CLUSTER_MAX, `total ${combined.length + 2 + notice.length}`);
  assert.equal(planTruncatedFrom, plan.length);
  // The load-bearing blocks survive byte-for-byte — this is the incident.
  assert.ok(combined.includes(ROLE));
  assert.ok(combined.includes(addendum));
  assert.ok(combined.includes('mcp__arco_cluster__peer_send'));
  // The plan carries the recover-via-tools marker and still leads the block.
  assert.ok(combined.includes('truncated to fit the cluster appendSystemPrompt cap'));
  assert.ok(combined.startsWith('--- Shared cluster plan ---'));
});

test('plan-only fold still respects the cap', () => {
  const plan = 'x'.repeat(APPEND_CLUSTER_MAX * 2);
  const { combined, planTruncatedFrom } = composeClusterAppend(plan, []);
  assert.ok(combined && combined.length <= APPEND_CLUSTER_MAX);
  assert.equal(planTruncatedFrom, plan.length);
});

test('no plan, tail only → joined untouched even past the cap (tail never shrinks)', () => {
  const bigTail = 'y'.repeat(APPEND_CLUSTER_MAX + 100);
  const { combined, planTruncatedFrom } = composeClusterAppend(undefined, [bigTail]);
  assert.equal(combined, bigTail);
  assert.equal(planTruncatedFrom, undefined);
});

test('nothing to fold → undefined', () => {
  const { combined } = composeClusterAppend(undefined, []);
  assert.equal(combined, undefined);
  assert.equal(composeClusterAppend('', ['']).combined, undefined);
});

test('outline fallback replaces an oversized plan; tail intact', () => {
  const plan = '--- Shared cluster plan ---\n' + 'prose '.repeat(4000);
  const fallback = '--- Shared cluster plan (OUTLINE) ---\n- [ ] task one\n- [x] task two';
  const { combined, planTruncatedFrom, usedFallback } = composeClusterAppend(plan, [ROLE], 0, APPEND_CLUSTER_MAX, fallback);
  assert.ok(combined);
  assert.equal(usedFallback, true);
  assert.equal(planTruncatedFrom, plan.length);
  assert.ok(combined.startsWith(fallback));
  assert.ok(combined.includes(ROLE));
  assert.ok(!combined.includes('truncated to fit'));
});

test('oversized fallback is itself truncated, tail still intact', () => {
  const plan = 'p'.repeat(APPEND_CLUSTER_MAX * 3);
  const fallback = '- [ ] task\n'.repeat(3000); // ~33 KB of checkboxes
  const { combined, usedFallback } = composeClusterAppend(plan, [ROLE], 0, APPEND_CLUSTER_MAX, fallback);
  assert.ok(combined && combined.length <= APPEND_CLUSTER_MAX);
  assert.equal(usedFallback, true);
  assert.ok(combined.includes('truncated to fit the cluster appendSystemPrompt cap'));
  assert.ok(combined.includes(ROLE));
});

test('fitting plan ignores the fallback', () => {
  const plan = '--- Shared cluster plan ---\nsmall';
  const { combined, usedFallback } = composeClusterAppend(plan, [ROLE], 0, APPEND_CLUSTER_MAX, 'outline');
  assert.ok(combined && combined.startsWith(plan));
  assert.equal(usedFallback, undefined);
});

test('reserved bytes squeeze the plan, not the tail', () => {
  const plan = 'p'.repeat(APPEND_CLUSTER_MAX);
  const reserved = 4096;
  const { combined } = composeClusterAppend(plan, [ROLE], reserved);
  assert.ok(combined);
  assert.ok(combined.length + 2 + reserved <= APPEND_CLUSTER_MAX);
  assert.ok(combined.includes(ROLE));
});

test('app-server cap carries a maximum-size plan plus director doctrine', () => {
  const plan = `--- Shared cluster plan ---\n${'p'.repeat(32 * 1024)}`;
  const doctrine = 'd'.repeat(8 * 1024);
  const result = composeClusterAppend(plan, [doctrine], 1024, CODEX_APP_SERVER_CLUSTER_MAX);
  assert.equal(result.planTruncatedFrom, undefined);
  assert.ok(result.combined?.includes(plan));
  assert.ok(CODEX_APP_SERVER_CLUSTER_MAX > APPEND_CLUSTER_MAX);
});
