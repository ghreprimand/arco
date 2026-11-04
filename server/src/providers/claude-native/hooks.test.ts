// §4.2 — regression guard for the hook-output contract the Native worker
// consumes. parseHookOutput is the pure extraction; worker.ts folds
// updatedInput into the dispatched tool input (PreToolUse) and appends
// additionalContext to the tool_result (PostToolUse). This test pins the
// parser so a refactor can't silently drop those fields — the wiring was
// already in-tree (EFFICIENCY_PLAN Phase B0) when Phase 6 §4.2 verified it.
//
// Run: node --conditions development --import tsx --test src/providers/claude-native/hooks.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHookOutput } from './hooks.js';

test('non-JSON / empty stdout → empty object (never throws)', () => {
  assert.deepEqual(parseHookOutput(''), {});
  assert.deepEqual(parseHookOutput('   '), {});
  assert.deepEqual(parseHookOutput('not json at all'), {});
  assert.deepEqual(parseHookOutput('[1,2,3]'), {}, 'top-level array ignored');
});

test('PreToolUse updatedInput is extracted', () => {
  const out = parseHookOutput(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'ls -la' } },
  }));
  assert.deepEqual(out.hookSpecificOutput?.updatedInput, { command: 'ls -la' });
});

test('updatedInput must be a plain object — array/scalar dropped', () => {
  const arr = parseHookOutput(JSON.stringify({ hookSpecificOutput: { updatedInput: [1, 2] } }));
  assert.equal(arr.hookSpecificOutput, undefined, 'array updatedInput rejected');
  const scalar = parseHookOutput(JSON.stringify({ hookSpecificOutput: { updatedInput: 'x' } }));
  assert.equal(scalar.hookSpecificOutput, undefined, 'scalar updatedInput rejected');
});

test('PostToolUse additionalContext is extracted', () => {
  const out = parseHookOutput(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'remember: lint runs on commit' },
  }));
  assert.equal(out.hookSpecificOutput?.additionalContext, 'remember: lint runs on commit');
});

test('both fields coexist on one hookSpecificOutput', () => {
  const out = parseHookOutput(JSON.stringify({
    hookSpecificOutput: { updatedInput: { a: 1 }, additionalContext: 'ctx' },
  }));
  assert.deepEqual(out.hookSpecificOutput?.updatedInput, { a: 1 });
  assert.equal(out.hookSpecificOutput?.additionalContext, 'ctx');
});

test('decision:block + reason are surfaced (PostToolUse retry path)', () => {
  const out = parseHookOutput(JSON.stringify({ decision: 'block', reason: 'tests must pass first' }));
  assert.equal(out.decision, 'block');
  assert.equal(out.reason, 'tests must pass first');
});

test('permissionDecision allow/deny/ask preserved; junk dropped', () => {
  assert.equal(parseHookOutput(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } })).hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(parseHookOutput(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'maybe' } })).hookSpecificOutput, undefined);
});

test('empty hookSpecificOutput object → no field on result', () => {
  const out = parseHookOutput(JSON.stringify({ hookSpecificOutput: {} }));
  assert.equal(out.hookSpecificOutput, undefined);
});
