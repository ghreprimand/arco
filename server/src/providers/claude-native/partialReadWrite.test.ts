// Unit tests for H62 — partial-read → full-write warning guard.
//
// The pure decision (checkPartialReadFullWrite) is the load-bearing core: warn
// on a Write to a path that was only partially Read this turn; don't warn for a
// fully-read path, a never-read path, an Edit (targeted splice), or a tool with
// no file_path. The Read-side set transitions (partial adds, full clears) live
// in ReadTool and are exercised by the worker; here we pin the guard contract at
// the set boundary, including the "full read clears the flag" acceptance.
//
// Run with: node --import tsx --test src/providers/claude-native/partialReadWrite.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { checkPartialReadFullWrite } from './pretoolGuards.js';

const cwd = '/work/proj';
const abs = resolve(cwd, 'src/big.ts');

test('warns: Write after a partial Read of the same path', () => {
  const partial = new Set([abs]);
  const r = checkPartialReadFullWrite('Write', { file_path: 'src/big.ts' }, cwd, partial);
  assert.equal(r.warn, true);
  if (r.warn) {
    assert.equal(r.resolvedPath, abs);
    assert.match(r.note, /partial-read-then-full-write/);
    assert.match(r.note, /big\.ts/);
  }
});

test('warns: relative vs absolute input resolve to the same key', () => {
  const partial = new Set([abs]);
  const r = checkPartialReadFullWrite('Write', { file_path: abs }, cwd, partial);
  assert.equal(r.warn, true);
});

test('no warn: path was never read', () => {
  const r = checkPartialReadFullWrite('Write', { file_path: 'src/big.ts' }, cwd, new Set());
  assert.equal(r.warn, false);
});

test('no warn: path was fully read (not in the partial set)', () => {
  // A full Read removes the path from partialReadSet → write is safe.
  const partial = new Set([abs]);
  partial.delete(abs); // simulate a subsequent full read clearing the flag
  const r = checkPartialReadFullWrite('Write', { file_path: 'src/big.ts' }, cwd, partial);
  assert.equal(r.warn, false);
});

test('no warn: Edit is a targeted splice, not a full overwrite', () => {
  const partial = new Set([abs]);
  const r = checkPartialReadFullWrite('Edit', { file_path: 'src/big.ts' }, cwd, partial);
  assert.equal(r.warn, false);
});

test('no warn: non-mutating tool', () => {
  const partial = new Set([abs]);
  const r = checkPartialReadFullWrite('Read', { file_path: 'src/big.ts' }, cwd, partial);
  assert.equal(r.warn, false);
});

test('no warn: Write with no file_path', () => {
  const partial = new Set([abs]);
  const r = checkPartialReadFullWrite('Write', {}, cwd, partial);
  assert.equal(r.warn, false);
});

test('no warn: Write to a DIFFERENT partially-read path', () => {
  const partial = new Set([resolve(cwd, 'other.ts')]);
  const r = checkPartialReadFullWrite('Write', { file_path: 'src/big.ts' }, cwd, partial);
  assert.equal(r.warn, false);
});
