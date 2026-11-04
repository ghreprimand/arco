// Unit tests for H50 — multi-strategy fuzzy Edit apply.
//
// Contracts:
//  • exact match unchanged (incl. uniqueness rule + replace_all);
//  • escape-drift: literal \n/\t in old_string still matches the real file;
//  • trailing-ws: a dropped trailing space still matches;
//  • indent: a re-indented block still matches (and stays unambiguous-guarded);
//  • a true no-match returns applied:false + a "closest lines" hint;
//  • the file's ACTUAL bytes are spliced (never the drifted old_string).
//
// Run: node --conditions development --import tsx --test src/providers/claude-native/editApply.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, closestLinesHint } from './editApply.js';

test('exact: unique match applies', () => {
  const r = applyEdit('const a = 1;\nconst b = 2;\n', 'const a = 1;', 'const a = 10;', false);
  assert.equal(r.applied, true);
  assert.equal(r.strategy, 'exact');
  assert.equal(r.updated, 'const a = 10;\nconst b = 2;\n');
});

test('exact: non-unique without replace_all is refused', () => {
  const r = applyEdit('x\nx\n', 'x', 'y', false);
  assert.equal(r.applied, false);
  assert.match(r.reason!, /not unique/);
});

test('exact: replace_all replaces every occurrence', () => {
  const r = applyEdit('x\nx\nx\n', 'x', 'y', true);
  assert.equal(r.applied, true);
  assert.equal(r.count, 3);
  assert.equal(r.updated, 'y\ny\ny\n');
});

test('escape-drift: literal \\n in old_string matches real newlines', () => {
  const file = 'line one\nline two\n';
  const r = applyEdit(file, 'line one\\nline two', 'replaced', false);
  assert.equal(r.applied, true);
  assert.equal(r.strategy, 'escape-drift');
  assert.equal(r.updated, 'replaced\n');
});

test('escape-drift: literal \\t matches a real tab', () => {
  const file = 'a\tb\n';
  const r = applyEdit(file, 'a\\tb', 'c', false);
  assert.equal(r.applied, true);
  assert.equal(r.strategy, 'escape-drift');
  assert.equal(r.updated, 'c\n');
});

test('trailing-ws: old_string carries trailing spaces the file lacks', () => {
  // old_string drifted EXTRA trailing whitespace (+ dropped the final newline),
  // so exact substring fails; trailing-ws normalization recovers it and the
  // file's actual (space-free) bytes are written.
  const file = 'function f() {\n  return 1;\n}\n';
  const oldStr = 'function f() {\n  return 1;   \n}';
  const r = applyEdit(file, oldStr, 'function g() {\n  return 2;\n}', false);
  assert.equal(r.applied, true);
  assert.equal(r.strategy, 'trailing-ws');
  assert.equal(r.updated, 'function g() {\n  return 2;\n}\n');
});

test('indent: a re-indented block matches', () => {
  const file = '    if (x) {\n      go();\n    }\n';
  // old_string lost the leading indentation entirely
  const r = applyEdit(file, 'if (x) {\ngo();\n}', 'done();', false);
  assert.equal(r.applied, true);
  assert.equal(r.strategy, 'indent');
  assert.equal(r.updated, 'done();\n');
});

test('indent: ambiguous fuzzy match is refused without replace_all', () => {
  const file = '  a();\n\n  a();\n';
  const r = applyEdit(file, 'a();', 'b();', false);
  // exact 'a();' is non-unique → refused at the exact stage already
  assert.equal(r.applied, false);
  assert.match(r.reason!, /not unique|matched/);
});

test('true no-match → hint with closest region + line number', () => {
  const file = 'export function alpha() {\n  return 42;\n}\n';
  const r = applyEdit(file, 'export function alfa() {', 'x', false);
  assert.equal(r.applied, false);
  assert.match(r.reason!, /not found/);
  assert.match(r.reason!, /Closest region \(line 1\)/);
  assert.match(r.reason!, /alpha/);
});

test('closestLinesHint: no similar region → Read-again guidance', () => {
  const hint = closestLinesHint('totally\nunrelated\ncontent\n', 'zzzzzzzzzzzz qqqqqqqq');
  assert.match(hint, /No similar region|Read the file again/);
});

test('exact wins over fuzzy when both could match (precision)', () => {
  const file = 'value = 1;\nvalue = 1; \n'; // 2nd line has trailing space
  // exact 'value = 1;' matches BOTH (line1 exact, line2 as prefix) → non-unique
  // exact stage refuses; we never silently fuzzy-apply when exact is ambiguous.
  const r = applyEdit(file, 'value = 1;', 'value = 2;', false);
  assert.equal(r.applied, false, 'exact ambiguity refused, not fuzzed');
});
