import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '@arco/shared';
import { DEFAULT_TRANSCRIPT_INCLUDE, formatRow } from './transcriptFormat';
import { useMessageSelectionStore } from '../stores/messageSelectionStore';

const msg = (role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: content, role, content, isStreaming: false, timestamp: 1, ...extra }) as ChatMessage;

test('defaults keep operator, agent and received mail but drop the shortened sent-mail echo', () => {
  const inc = DEFAULT_TRANSCRIPT_INCLUDE;
  assert.match(formatRow(msg('user', 'do it'), 'Alpha', inc) ?? '', /\[operator -> Alpha\]|\[operator/);
  assert.match(formatRow(msg('assistant', 'done'), 'Alpha', inc) ?? '', /\[Alpha\]/);
  assert.match(formatRow(msg('peer-received', 'hello', { senderDisplayName: 'Beta' }), 'Alpha', inc) ?? '', /peer-received/);
  assert.equal(formatRow(msg('peer-sent', 'hel...', { senderDisplayName: 'Beta' }), 'Alpha', inc), null);
});
test('each switch removes its own rows', () => {
  assert.equal(formatRow(msg('user', 'x'), 'A', { ...DEFAULT_TRANSCRIPT_INCLUDE, operator: false }), null);
  assert.equal(formatRow(msg('assistant', 'x'), 'A', { ...DEFAULT_TRANSCRIPT_INCLUDE, agent: false }), null);
  assert.equal(formatRow(msg('peer-received', 'x'), 'A', { ...DEFAULT_TRANSCRIPT_INCLUDE, mail: false }), null);
  assert.notEqual(formatRow(msg('peer-sent', 'x'), 'A', { ...DEFAULT_TRANSCRIPT_INCLUDE, sentEchoes: true }), null);
  assert.equal(formatRow(msg('peer-sent', 'x'), 'A', { ...DEFAULT_TRANSCRIPT_INCLUDE, mail: false, sentEchoes: true }), null);
});
test('selection toggles per tab and clears', () => {
  const s = useMessageSelectionStore.getState();
  s.toggle('t1', 'a'); s.toggle('t1', 'b'); s.toggle('t2', 'c'); s.toggle('t1', 'a');
  assert.deepEqual(useMessageSelectionStore.getState().selected, { t1: ['b'], t2: ['c'] });
  s.clear('t1'); s.clear('t2');
  assert.deepEqual(useMessageSelectionStore.getState().selected, {});
});
