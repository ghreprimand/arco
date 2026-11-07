import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addGoalRunTokens, normalizeGoalRunArm } from './goalRun.js';

test('Codex cached input consumes the same goal budget as equivalent Claude usage', () => {
  const claude = normalizeGoalRunArm({ enabled: true, total: 2 }, true);
  const codex = normalizeGoalRunArm({ enabled: true, total: 2 }, true);
  assert.notEqual(typeof claude, 'string');
  assert.notEqual(typeof codex, 'string');
  if (typeof claude === 'string' || typeof codex === 'string') return;
  addGoalRunTokens(claude, { input: 100, cacheRead: 900, output: 1 }, 'claude');
  addGoalRunTokens(codex, { input: 1000, cacheRead: 900, output: 1 }, 'codex');
  assert.equal(claude.tokensUsed, 1001);
  assert.equal(codex.tokensUsed, claude.tokensUsed);
});
