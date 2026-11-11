import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from '@arco/shared';
import { latestHandoffSeed } from './handoffSeeds';
const seed = (id: string, key?: string): ChatMessage => ({ id, isStreaming: false, role: 'user', content: '[HANDOFF: new session initialized for this tab.]', timestamp: 1, handoffSourceKey: key });
test('only the latest seed owns the current source control', () => {
  const messages = [seed('old', 'old-key'), seed('new', 'new-key')];
  assert.equal(latestHandoffSeed(messages)?.id, 'new');
  assert.equal(latestHandoffSeed(messages)?.handoffSourceKey, 'new-key');
});
test('a later seed without a saved link cannot display the old source', () => {
  const messages = [seed('old', 'old-key'), seed('failed')];
  assert.equal(latestHandoffSeed(messages)?.id, 'failed');
  assert.equal(latestHandoffSeed(messages)?.handoffSourceKey, undefined);
  assert.equal(latestHandoffSeed(JSON.parse(JSON.stringify(messages)))?.handoffSourceKey, undefined);
});
test('same-tab emitted prefix and Spawn are both recognized', () => {
  const rotation = { ...seed('rotation'), content: '[HANDOFF \u2014 new session initialized for this tab.]' };
  const spawn = { ...seed('spawn'), content: 'summary\n\n---\n\nNew direction: fix it' };
  assert.equal(latestHandoffSeed([rotation])?.id, 'rotation');
  assert.equal(latestHandoffSeed([rotation, spawn])?.id, 'spawn');
});
