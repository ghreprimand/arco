import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '@arco/shared';
import { pendingDecisions } from './PendingQuestionsButton';

const msg = (fields: Partial<ChatMessage>): ChatMessage => ({ id: String(Math.random()), role: 'system', content: '', timestamp: 0, ...fields } as ChatMessage);

test('the mobile view lists ordinary Claude Native questions and parked gates as decisions; PENDING QUESTIONS keeps batches only', () => {
  const messages = [
    msg({ content: '[ASK:claude-native:q1] Continue with the migration?' }),
    msg({ content: '[ASK:claude-native:q2] Already answered elsewhere' }),
    msg({ id: 'gate::g1', toolUse: { tool: 'Gate', toolUseId: 'g1', input: { gateId: 'g1', toolName: 'Bash', status: 'pending' } } as ChatMessage['toolUse'] }),
    msg({ id: 'gate::g2', toolUse: { tool: 'Gate', toolUseId: 'g2', input: { gateId: 'g2', toolName: 'Bash', status: 'approve' } } as ChatMessage['toolUse'] }),
  ];
  const all = pendingDecisions(messages, ['q1'], true);
  assert.deepEqual(all.asks.map((a) => a.ask.questionId), ['q1']);
  assert.deepEqual(all.gates.map((g) => g.id), ['gate::g1']);
  assert.equal(all.count, 2);
  const desktop = pendingDecisions(messages, ['q1'], false);
  assert.equal(desktop.count, 0);
});
