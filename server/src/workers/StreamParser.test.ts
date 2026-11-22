import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { StreamParser } from './StreamParser.js';

test('snapshot fallback emits every block once and preserves a shorter final answer', () => {
  const parser = new StreamParser();
  const text: string[] = [];
  let finalText = '';
  parser.on('text', (chunk) => text.push(chunk));
  parser.on('result', (result) => { finalText = result.text; });
  const send = (event: unknown) => (parser as any).handleEvent(event);
  const first = { type: 'assistant', message: { id: 'first', content: [
    { type: 'text', text: 'A long first paragraph.' }, { type: 'text', text: 'Second.' },
  ] } };
  send(first);
  send(first);
  send({ type: 'assistant', message: { id: 'last', content: [{ type: 'text', text: 'Final.' }] } });
  send({ type: 'result', result: 'Final.' });
  assert.equal(text.join(''), 'A long first paragraph.Second.Final.');
  assert.equal(finalText, 'Final.');
});

test('a final result supplies text absent from earlier snapshots', () => {
  const parser = new StreamParser();
  const text: string[] = [];
  parser.on('text', (chunk) => text.push(chunk));
  const send = (event: unknown) => (parser as any).handleEvent(event);
  send({ type: 'assistant', message: { id: 'first', content: [{ type: 'text', text: 'Long intermediate paragraph.' }] } });
  send({ type: 'result', result: 'Done.' });
  assert.equal(text.join(''), 'Long intermediate paragraph.Done.');
});

test('snapshots fill missing blocks without repeating streamed message text', () => {
  const parser = new StreamParser();
  const text: string[] = [];
  parser.on('text', (chunk) => text.push(chunk));
  const send = (event: unknown) => (parser as any).handleEvent(event);
  const stream = (event: unknown) => send({ type: 'stream_event', event });
  stream({ type: 'message_start', message: { id: 'one' } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } });
  const snapshot = { type: 'assistant', message: { id: 'one', content: [
    { type: 'text', text: 'first' }, { type: 'text', text: 'second' },
  ] } };
  send(snapshot);
  send(snapshot);
  stream({ type: 'message_start', message: { id: 'two' } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'end' } });
  send({ type: 'assistant', message: { id: 'two', content: [{ type: 'text', text: 'end' }] } });
  send({ type: 'result', result: 'end' });
  assert.equal(text.join(''), 'firstsecondend');
});

test('a result repeating the final snapshot block is not appended twice', () => {
  const parser = new StreamParser();
  const text: string[] = [];
  parser.on('text', (chunk) => text.push(chunk));
  const send = (event: unknown) => (parser as any).handleEvent(event);
  send({ type: 'assistant', message: { id: 'one', content: [
    { type: 'text', text: 'A long first paragraph.' }, { type: 'text', text: 'Second.' },
  ] } });
  send({ type: 'result', result: 'Second.' });
  assert.equal(text.join(''), 'A long first paragraph.Second.');
});


test('a revoked OAuth pass in an error result is reported as authentication failure', async () => {
  const parser = new StreamParser();
  let authenticationError = false, finalText = 'not received', emittedText = '';
  parser.on('text', text => { emittedText += text; });
  parser.on('stream_error', error => { authenticationError = error.errorType === 'authentication_error'; });
  parser.on('result', result => { finalText = result.text; });
  const message = 'Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.';
  parser.parse(Readable.from([
    JSON.stringify({ type: 'assistant', message: { id: 'failure', content: [{ type: 'text', text: message }] } }) + '\n',
    JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: message }) + '\n',
  ]));
  await new Promise<void>(resolve => parser.once('done', resolve));
  assert.equal(authenticationError, true);
  assert.equal(emittedText, '');
  assert.equal(finalText, '');
});

test('Claude CLI tool results are available for the research independence check', async () => {
  const parser = new StreamParser();
  const results: string[] = [];
  parser.on('tool_result', text => results.push(text));
  parser.parse(Readable.from([JSON.stringify({ type: 'user', message: { content: [
    { type: 'tool_result', content: 'fixture result' },
    { type: 'tool_result', content: [{ type: 'text', text: 'second result' }] },
  ] } }) + '\n']));
  await new Promise<void>(resolve => parser.once('done', resolve));
  assert.deepEqual(results, ['fixture result', 'second result']);
});
