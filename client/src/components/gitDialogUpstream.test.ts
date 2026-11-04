import test from 'node:test';
import assert from 'node:assert/strict';
import { upstreamForFinalBranch } from '../utils/gitPushTarget';

const status = {
  currentBranch: 'main',
  upstream: 'origin/main',
  branches: [
    { name: 'main', upstream: 'origin/main' },
    { name: 'feature/x', upstream: 'origin/feature/x' },
    { name: 'local-only', upstream: null },
  ],
};

test('a new branch has no upstream even when the tab was on main', () => {
  assert.equal(upstreamForFinalBranch(status, 'feature/new', true), null);
});
test('staying on the current branch keeps its upstream', () => {
  assert.equal(upstreamForFinalBranch(status, 'main', false), 'origin/main');
});
test('switching uses the picked branch upstream, or none', () => {
  assert.equal(upstreamForFinalBranch(status, 'feature/x', false), 'origin/feature/x');
  assert.equal(upstreamForFinalBranch(status, 'local-only', false), null);
});
