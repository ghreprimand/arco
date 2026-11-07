import { test } from 'node:test';
import assert from 'node:assert/strict';
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
