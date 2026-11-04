import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnIdentityProblem } from './handoffHandlers.js';
import type { WorkflowConfig } from '@arco/shared';

const cluster = { members: ['a', 'b'], memberRoles: { a: "Director role. Delegate via peer_send, never Task; don't write code; verify claims; plan = rules + tasks; you land." } } as never;
const claudeNative = { primaryProvider: undefined, claudeTransport: 'native' } as unknown as WorkflowConfig;
const codex = { primaryProvider: 'codex' } as unknown as WorkflowConfig;

test('no identity is fine', () => assert.equal(spawnIdentityProblem(undefined, cluster, claudeNative), null));
test('a second director is refused', () => {
  assert.match(spawnIdentityProblem({ role: 'Director role. Own outcome' }, cluster, claudeNative) ?? '', /multiple_directors/);
});
test('ordinary role, tier, focus and blind access pass', () => {
  assert.equal(spawnIdentityProblem({ role: 'Tester role', tier: 'heavy', focus: 'browser suites', accessMode: 'blind' }, cluster, codex), null);
});
test('isolated needs Claude native', () => {
  assert.equal(spawnIdentityProblem({ accessMode: 'isolated' }, cluster, claudeNative), null);
  assert.equal(spawnIdentityProblem({ accessMode: 'isolated' }, cluster, codex), 'isolated_requires_claude_native');
});
test('unknown tier or access mode is refused', () => {
  assert.equal(spawnIdentityProblem({ tier: 'huge' as never }, cluster, codex), 'invalid_tier');
  assert.equal(spawnIdentityProblem({ accessMode: 'wide' as never }, cluster, codex), 'invalid_access_mode');
});
