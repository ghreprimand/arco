import test from 'node:test';
import assert from 'node:assert/strict';
import { isAutoPickupAcknowledgement } from './autoPickupAck.js';

test('only unambiguous short acknowledgements are skipped', () => {
  for (const body of ['Thanks!', 'acknowledged', 'Standing by.', 'Got it', 'no action needed']) assert.equal(isAutoPickupAcknowledgement(body), true, body);
  for (const body of ['', 'Thanks, please review the patch.', 'Thanks?', 'Done: tests failed.', 'Waiting for your answer.', 'x'.repeat(161)]) assert.equal(isAutoPickupAcknowledgement(body), false, body);
});

import { DEFAULT_RULE_PICKUP_LIMITS, sanitizeRulePickupLimits } from './protocol/autoPickup.js';
test('rule limits preserve valid choices and bound invalid input', () => {
  assert.deepEqual(sanitizeRulePickupLimits(undefined), DEFAULT_RULE_PICKUP_LIMITS);
  assert.deepEqual(sanitizeRulePickupLimits({ pingPongWakes: 2, wakesPerMemberHour: 30, wakesPerArming: 201, maxChainDepth: 1 }), { pingPongWakes: 2, wakesPerMemberHour: 30, wakesPerArming: 40, maxChainDepth: 1 });
});
