// DD7 — pure-core unit tests for the project-trust gate.
//
// Run: npm run test:project-trust
//   node --conditions development --import tsx --test server/src/projectTrust.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalizePath,
  isAncestorOrSelf,
  decideTrust,
  type TrustEntry,
} from './projectTrust.js';

test('canonicalizePath strips trailing separator, resolves absolute', () => {
  assert.equal(canonicalizePath('/a/b/'), '/a/b');
  assert.equal(canonicalizePath('/a/b'), '/a/b');
  assert.equal(canonicalizePath('/'), '/'); // root keeps its single sep
});

test('isAncestorOrSelf is segment-aware', () => {
  assert.equal(isAncestorOrSelf('/a/b', '/a/b'), true, 'self matches');
  assert.equal(isAncestorOrSelf('/a', '/a/b/c'), true, 'parent matches');
  assert.equal(isAncestorOrSelf('/a/bc', '/a/bcd'), false, 'no prefix-segment false match');
  assert.equal(isAncestorOrSelf('/a/b/c', '/a/b'), false, 'child is not ancestor of parent');
});

test('decideTrust falls back to the user-scope default when no entry matches', () => {
  const entries: Record<string, TrustEntry> = {};
  assert.equal(decideTrust(entries, '/repo', 'ask').status, 'ask');
  assert.equal(decideTrust(entries, '/repo', 'always').status, 'always');
  assert.equal(decideTrust(entries, '/repo', 'never').status, 'never');
});

test('decideTrust matches an exact recorded entry', () => {
  const entries: Record<string, TrustEntry> = { '/repo': { decision: 'always', at: 1 } };
  const r = decideTrust(entries, '/repo', 'ask');
  assert.equal(r.status, 'always');
  assert.equal(r.matchedPath, '/repo');
});

test('decideTrust applies an ancestor decision to a subdirectory', () => {
  const entries: Record<string, TrustEntry> = { '/repo': { decision: 'always', at: 1 } };
  assert.equal(decideTrust(entries, '/repo/sub/deeper', 'ask').status, 'always');
});

test('decideTrust: deepest ancestor wins (subdir never overrides parent always)', () => {
  const entries: Record<string, TrustEntry> = {
    '/repo': { decision: 'always', at: 1 },
    '/repo/danger': { decision: 'never', at: 2 },
  };
  assert.equal(decideTrust(entries, '/repo/danger/x', 'ask').status, 'never', 'deepest never wins');
  assert.equal(decideTrust(entries, '/repo/safe/x', 'ask').status, 'always', 'parent always elsewhere');
});

test('decideTrust ignores non-ancestor entries', () => {
  const entries: Record<string, TrustEntry> = { '/other': { decision: 'always', at: 1 } };
  assert.equal(decideTrust(entries, '/repo', 'ask').status, 'ask', 'unrelated entry does not leak');
});

test('decideTrust normalizes trailing-separator keys', () => {
  const entries: Record<string, TrustEntry> = { '/repo/': { decision: 'never', at: 1 } };
  assert.equal(decideTrust(entries, '/repo', 'ask').status, 'never');
  assert.equal(decideTrust(entries, '/repo/sub', 'ask').status, 'never');
});
