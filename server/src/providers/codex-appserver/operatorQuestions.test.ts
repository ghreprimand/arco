import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import type { OperatorQuestionState } from '@arco/shared';
import { JsonRpcClient } from './jsonRpc.js';
import { CodexOperatorQuestions, pendingOperatorQuestions, replyToOperatorQuestion, setOperatorQuestionPublisher } from './operatorQuestions.js';
import { CodexAppServerWorker } from './worker.js';

const q = (id = 'choice') => ({ id, header: 'Choice', question: 'Where next?', isOther: true, options: [{ label: 'Stay', description: 'Keep the current location.' }, { label: 'Move', description: 'Use a new location.' }] });
function fixture(id: string) {
  const events: OperatorQuestionState[] = [], responses: unknown[] = [];
  const broker = new CodexOperatorQuestions(id, 'codex', (e) => events.push(e));
  const ask = (questions: unknown[] = [q()], isBlocking?: boolean) => broker.acceptRpc({ id: 77, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', questions, isBlocking } }, (r) => { responses.push(r); });
  return { broker, ask, events, responses, id };
}

test('blocking RPC remains unanswered until the operator replies; exact per-ID answers round trip', async () => {
  const f = fixture('question-roundtrip'); f.ask([q('a'), q('b')]);
  try {
    assert.equal(f.events[0].mode, 'blocking'); assert.deepEqual(f.responses, []);
    const requestId = f.events[0].requestId;
    assert.equal((await replyToOperatorQuestion('other-workflow', requestId, { a: ['Stay'], b: ['Move'] })).ok, false);
    assert.equal((await replyToOperatorQuestion(f.id, requestId, { a: ['Stay'] })).ok, false);
    assert.equal((await replyToOperatorQuestion(f.id, requestId, { a: ['Stay'], b: ['Use a custom destination'] })).ok, true);
    assert.deepEqual(f.responses, [{ answers: { a: { answers: ['Stay'] }, b: { answers: ['Use a custom destination'] } } }]);
    assert.equal(f.events.at(-1)?.status, 'answered'); assert.equal(pendingOperatorQuestions(f.id).length, 0);
    assert.equal((await replyToOperatorQuestion(f.id, requestId, { a: ['Move'], b: ['Stay'] })).ok, false);
    assert.equal(f.responses.length, 1);
  } finally { f.broker.cancel('test cleanup'); }
});

test('closed option sets reject arbitrary input; secret answers reach Codex but are redacted in public state', async () => {
  const f = fixture('question-secret'); f.ask([{ ...q(), isOther: false }, { id: 'secret', header: 'Secret', question: 'Value?', isSecret: true }]);
  try {
    const requestId = f.events[0].requestId;
    assert.equal((await replyToOperatorQuestion(f.id, requestId, { choice: ['Invalid'], secret: ['private-value'] })).ok, false);
    assert.equal((await replyToOperatorQuestion(f.id, requestId, { choice: ['Stay'], secret: ['private-value'] })).ok, true);
    assert.match(JSON.stringify(f.responses), /private-value/);
    assert.doesNotMatch(JSON.stringify(f.events), /private-value/);
    assert.deepEqual(f.events.at(-1)?.answers?.secret, ['[redacted]']);
  } finally { f.broker.cancel('test cleanup'); }
});

test('cancel and upstream resolution invalidate pending handles; resolution does not send a second response', async () => {
  const f = fixture('question-cancel'); f.ask([q()], false);
  const id = f.events[0].requestId;
  assert.equal(f.events[0].mode, 'async');
  f.broker.resolvedRpc(77);
  assert.equal(f.events.at(-1)?.status, 'cancelled'); assert.equal(f.responses.length, 0);
  assert.equal((await replyToOperatorQuestion(f.id, id, { choice: ['Stay'] })).ok, false);
  f.ask(); f.broker.cancel('operator cancelled');
  assert.deepEqual(f.responses, [{ answers: {} }]); assert.equal(f.events.at(-1)?.reason, 'operator cancelled');
});

test('async message questions survive turn completion and use ordinary operator input; failed dispatch remains retryable', async () => {
  const f = fixture('question-async');
  f.broker.acceptAsync('thread', 'turn', { id: 'async-item', questions: [{ title: 'Destination?', options: ['Here', 'There'] }] });
  f.broker.acceptAsync('thread', 'turn', { id: 'async-item', questions: [{ title: 'Destination?' }] });
  assert.equal(f.events.length, 1, 'duplicate completed items do not duplicate forms');
  f.broker.cancel('turn ended', true); assert.equal(pendingOperatorQuestions(f.id).length, 1);
  const requestId = f.events[0].requestId;
  assert.equal((await replyToOperatorQuestion(f.id, requestId, { 'question-1': ['Custom'] }, async () => { throw new Error('offline'); })).ok, false);
  let input = '';
  assert.equal((await replyToOperatorQuestion(f.id, requestId, { 'question-1': ['Custom'] }, async (s) => { input = s; })).ok, true);
  assert.match(input, /Destination\?\nAnswer: Custom/); assert.equal(f.responses.length, 0);
  assert.equal(f.events.at(-1)?.status, 'answered');
  f.broker.acceptAsync('thread', 'turn', { id: 'async-item', questions: [{ title: 'Destination?' }] });
  assert.equal(pendingOperatorQuestions(f.id).length, 0, 'a repeated completed item cannot reopen an answered question');
});

test('malformed requests fail before creating a pending form', () => {
  const f = fixture('question-invalid');
  assert.throws(() => f.ask([])); assert.throws(() => f.ask([q('dup'), q('dup')]));
  assert.throws(() => f.broker.acceptAsync('thread', 'turn', { id: 'x', questions: [{ title: 'Bad', options: [3] }] }));
  assert.equal(pendingOperatorQuestions(f.id).length, 0);
});

test('interactive JSON-RPC interception preserves noninteractive approvals and split UTF-8', async () => {
  const f = fixture('question-rpc');
  const input = new PassThrough(), output = new PassThrough();
  const written: any[] = []; input.on('data', (b) => written.push(JSON.parse(b.toString())));
  const client = new JsonRpcClient(input, output, (req) => {
    if (req.method !== 'item/tool/requestUserInput') return false;
    f.broker.acceptRpc(req, (r) => client.respond(req.id, r)); return true;
  });
  const bytes = Buffer.from(JSON.stringify({ id: 'question-id', method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', questions: [{ ...q(), question: 'Choose → 日本語' }] } }) + '\n');
  for (const byte of bytes) output.write(Buffer.from([byte]));
  assert.equal(written.length, 0); assert.equal(f.events[0].questions[0].question, 'Choose → 日本語');
  await replyToOperatorQuestion(f.id, f.events[0].requestId, { choice: ['Move'] });
  assert.deepEqual(written[0], { id: 'question-id', result: { answers: { choice: { answers: ['Move'] } } } });
  output.write(JSON.stringify({ id: 5, method: 'item/commandExecution/requestApproval', params: {} }) + '\n');
  assert.deepEqual(written[1], { id: 5, result: { decision: 'decline' } });
  client.close();
});

test('worker routes async notifications and cancels questions on transport death', () => {
  const events: OperatorQuestionState[] = [];
  setOperatorQuestionPublisher((_id, state) => events.push(state));
  const worker = new CodexAppServerWorker('question-worker', { provider: 'codex' } as any, undefined);
  const internals = worker as any;
  internals.threadId = 'thread'; internals.current.startedAt = Date.now(); internals.current.turnId = 'turn';
  internals.onNotification({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { id: 'async', type: 'agentMessage', delivery: 'async', text: 'A question', questions: [{ title: 'Continue?' }] } } });
  assert.equal(events[0].status, 'pending');
  internals.settleTurn({ result: { usage: {} } }); assert.equal(pendingOperatorQuestions('question-worker').length, 1);
  internals.teardownProcess(); assert.equal(events.at(-1)?.status, 'cancelled');
  assert.equal(pendingOperatorQuestions('question-worker').length, 0);
});
