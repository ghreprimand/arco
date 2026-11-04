import test from 'node:test';
import assert from 'node:assert/strict';
import { RulePickupGuard } from './rulePickupGuard.js';
import { DEFAULT_RULE_PICKUP_LIMITS as limits } from '@arco/shared';

test('alternation pauses a pair and third-party mail or operator clears it', () => {
  const g = new RulePickupGuard();
  for (const [a,b] of [['a','b'], ['b','a'], ['a','b'], ['b','a']]) { assert.equal(g.admit('c', a, b, limits, 1), null); g.stamp('c', a, b, limits, 1); }
  assert.equal(g.admit('c','a','b',limits,1), 'pair_paused');
  g.mail('c','third','a'); assert.equal(g.admit('c','a','b',limits,1), null);
});

test('per-member rolling and per-arming budgets, resume retains hourly cap', () => {
  const g = new RulePickupGuard(); const l = { ...limits, wakesPerMemberHour: 1, wakesPerArming: 2 };
  g.stamp('c','a','b',l,100); assert.equal(g.admit('c','a','b',l,100), 'member_capped');
  g.stamp('c','a','d',l,100); assert.equal(g.admit('c','a','e',l,100), 'budget_paused');
  g.resume('c'); assert.equal(g.admit('c','a','b',l,100), 'member_capped');
  assert.equal(g.admit('c','a','b',l,3_600_101), null);
});

test('arming budget and hourly cap survive reconstruction', () => {
  let saved: string | undefined;
  const create = () => new RulePickupGuard(() => saved, (_id, content) => { saved = content; });
  const l = { ...limits, wakesPerMemberHour: 1, wakesPerArming: 1 };
  create().stamp('c', 'a', 'b', l, 100);
  const restarted = create();
  assert.equal(restarted.admit('c', 'a', 'b', l, 100), 'budget_paused');
  restarted.resume('c');
  assert.equal(create().admit('c', 'a', 'b', l, 100), 'member_capped');
});

test('corrupt durable state fails closed', () => {
  const g = new RulePickupGuard(() => '{bad');
  assert.throws(() => g.admit('c', 'a', 'b', limits));
});

test('board changes break an active sequence but do not clear an established pause', () => {
  const g = new RulePickupGuard();
  for (const [a,b] of [['a','b'], ['b','a'], ['a','b']]) g.stamp('c', a, b, limits, 1);
  g.changed('c'); g.stamp('c', 'b', 'a', limits, 1);
  assert.equal(g.admit('c', 'a', 'b', limits, 1), null);
  for (const [a,b] of [['a','b'], ['b','a'], ['a','b']]) g.stamp('c', a, b, limits, 1);
  g.changed('c'); assert.equal(g.admit('c', 'a', 'b', limits, 1), 'pair_paused');
  g.interrupt('c', 'a'); assert.equal(g.admit('c', 'a', 'b', limits, 1), null);
});
