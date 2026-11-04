// Unit tests for §2.1 — the deterministic Fold digest.
//
// The digest is the Fold's whole reason to be cheaper than a Handoff: a
// reproducible, model-free summary of the folded prefix. Contracts:
//  • extracts the original task, files written/read, commands, searches, errors,
//    recent operator asks;
//  • re-injects only UN-ticked todos (completed ones are dropped);
//  • deterministic — same input ⇒ byte-identical output (no Date/random).
//
// Run: node --import tsx --test src/providers/claude-native/foldDigest.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFoldDigest } from './foldDigest.js';

const prefix = [
  { role: 'user', content: 'Implement the token-budget meter for Claude Native.' },
  { role: 'assistant', content: [
    { type: 'text', text: 'On it.' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'server/src/worker.ts' } },
  ] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '…file…' }] },
  { role: 'assistant', content: [
    { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'server/src/contextBudget.ts' } },
    { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm run build' } },
    { type: 'tool_use', id: 't4', name: 'Grep', input: { pattern: 'countTokens' } },
  ] },
  { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't2', content: 'ok' },
    { type: 'tool_result', tool_use_id: 't3', content: 'build failed', is_error: true },
    { type: 'tool_result', tool_use_id: 't4', content: '3 matches' },
  ] },
  { role: 'user', content: 'Also add a smoke test.' },
];

test('digest extracts task, files, commands, searches, errors, recent asks', () => {
  const d = buildFoldDigest(prefix, []);
  assert.match(d, /Original task:.*token-budget meter/);
  assert.match(d, /contextBudget\.ts/);          // file written
  assert.match(d, /worker\.ts/);                  // file read
  assert.match(d, /npm run build/);               // command
  assert.match(d, /countTokens/);                 // search
  assert.match(d, /Tool errors encountered:\*\* 1/); // the failed Bash
  assert.match(d, /Also add a smoke test/);       // recent operator ask
});

test('digest re-injects only un-ticked todos', () => {
  const d = buildFoldDigest(prefix, [
    { content: 'wire the meter', status: 'completed' },
    { content: 'build eviction', status: 'in_progress' },
    { content: 'write the fold', status: 'pending' },
  ]);
  assert.match(d, /build eviction/);
  assert.match(d, /write the fold/);
  assert.doesNotMatch(d, /wire the meter/); // completed → dropped
});

test('digest is deterministic (byte-identical across runs)', () => {
  const a = buildFoldDigest(prefix, [{ content: 'x', status: 'pending' }]);
  const b = buildFoldDigest(prefix, [{ content: 'x', status: 'pending' }]);
  assert.equal(a, b);
});

test('empty prefix still yields a non-empty, sane digest header', () => {
  const d = buildFoldDigest([], []);
  assert.match(d, /Folded context/);
  assert.ok(d.trim().length > 0);
});

test('string-content tool_result batch (no blocks) does not crash', () => {
  const d = buildFoldDigest([
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: 'just text, no tools' },
  ], []);
  assert.match(d, /Original task:.*do it/);
});
