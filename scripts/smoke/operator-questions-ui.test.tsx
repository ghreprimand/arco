import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OperatorQuestionState, ChatMessage } from '@archon/shared';
import { OperatorQuestionNotice } from '../../client/src/components/OperatorQuestionNotice';
import { capMessages } from '../../client/src/stores/memoryTrim';
import { useAppStore } from '../../client/src/stores/appStore';
import { applyOperatorQuestion, reconcileOperatorQuestions } from '../../client/src/ws/operatorQuestions';
(globalThis as any).React = React;
(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const question: OperatorQuestionState = { requestId: 'ui-question', provider: 'codex', threadId: 'thread', turnId: 'turn', itemId: 'item', createdAt: 1, mode: 'blocking', status: 'pending', questions: [
  { id: 'one', header: 'Where', question: 'Where next?', options: [{ label: 'Here', description: 'Keep the current location.' }], allowOther: true, secret: false },
  { id: 'two', header: 'Secret', question: 'Value?', allowOther: false, secret: true },
] };

test('structured questions retain descriptions, freeform and masked inputs, without choosing a default', () => {
  const html = renderToStaticMarkup(<OperatorQuestionNotice workflowId="ui" question={question} />);
  assert.match(html, /Keep the current location/); assert.match(html, /type="password"/);
  assert.match(html, /Or type your own answer/); assert.match(html, /aria-pressed="false"/);
  assert.match(html, /WAITING FOR YOUR ANSWER/);
  assert.doesNotMatch(html, /aria-pressed="true"/);
});

test('answered/cancelled states render no actionable input or button', () => {
  const html = renderToStaticMarkup(<OperatorQuestionNotice workflowId="ui" question={{ ...question, status: 'answered', answers: { one: ['Here'], two: ['[redacted]'] } }} />);
  assert.match(html, /Answer sent \(hidden\)/); assert.doesNotMatch(html, /<input|SEND ANSWERS/);
  assert.doesNotMatch(renderToStaticMarkup(<OperatorQuestionNotice workflowId="ui" question={{ ...question, status: 'cancelled', reason: 'Worker stopped' }} />), /<input|SEND ANSWERS/);
});

test('pending questions remain hot within the bounded message window', () => {
  const messages: ChatMessage[] = [{ id: 'question', role: 'system', content: 'question', timestamp: 1, isStreaming: false, operatorQuestion: question }];
  for (let i = 0; i < 600; i++) messages.push({ id: String(i), role: 'assistant', content: 'fixture', timestamp: 2 + i, isStreaming: false });
  const capped = capMessages(messages);
  assert.equal(capped.length, 500); assert(capped.some((m) => m.id === 'question'));
});

test('replay upserts each request once; authoritative snapshot closes orphaned questions and restores live ones', () => {
  useAppStore.getState().createJob('ui', { name: 'UI question test', workingDirectory: '/tmp', primaryProvider: 'codex', primaryModel: 'gpt-5.5', primaryEffort: 'high' });
  try {
    applyOperatorQuestion('ui', question); applyOperatorQuestion('ui', question);
    assert.equal(useAppStore.getState().jobs.ui.messages.filter((m) => m.operatorQuestion).length, 1);
    reconcileOperatorQuestions('ui', []);
    assert.equal(useAppStore.getState().jobs.ui.messages.find((m) => m.operatorQuestion)?.operatorQuestion?.status, 'cancelled');
    const live = { ...question, requestId: 'live' }; reconcileOperatorQuestions('ui', [live]);
    assert.equal(useAppStore.getState().jobs.ui.messages.find((m) => m.operatorQuestion?.requestId === 'live')?.operatorQuestion?.status, 'pending');
    applyOperatorQuestion('ui', { ...live, status: 'answered' }); applyOperatorQuestion('ui', live);
    assert.equal(useAppStore.getState().jobs.ui.messages.find((m) => m.operatorQuestion?.requestId === 'live')?.operatorQuestion?.status, 'answered');
  } finally { useAppStore.getState().removeJob('ui'); }
});
