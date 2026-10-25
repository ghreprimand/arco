// §5.1 — primitive drift-guard tests. Pure: driftFlag formatting + checkModelDrift
// over an injected catalog probe (fail-open semantics). No live server / catalog.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkModelDrift, driftFlag } from './primitiveDrift.js';

test('driftFlag labels per primitive and names the selection', () => {
  assert.match(driftFlag('review', 'claude', 'claude-opus-4-8', 'gone'), /\[REVIEW — MODEL DRIFT\]/);
  assert.match(driftFlag('handoff', 'codex', 'gpt-5', 'gone'), /\[HANDOFF — MODEL DRIFT\]/);
  assert.match(driftFlag('spawn', 'zai', 'glm-4', 'gone'), /\[SPAWN — MODEL DRIFT\]/);
  assert.match(driftFlag('review', 'claude', 'claude-opus-4-8', 'gone'), /selected claude:claude-opus-4-8/);
});

test('checkModelDrift flags a model the probe says is gone', async () => {
  const probe = async (_p: string, m: string) => m === 'still-here';
  const drift = await checkModelDrift('claude', 'retired-model', probe);
  assert.equal(drift.drifted, true);
  assert.match(drift.reason ?? '', /no longer in claude's live catalog/);
});

test('checkModelDrift passes a model the probe still knows', async () => {
  const probe = async () => true;
  const drift = await checkModelDrift('codex', 'gpt-5', probe);
  assert.equal(drift.drifted, false);
});

test('checkModelDrift fails open on a probe error', async () => {
  const probe = async () => { throw new Error('catalog down'); };
  const drift = await checkModelDrift('claude', 'whatever', probe);
  assert.equal(drift.drifted, false, 'a probe error must never flag');
});

test('checkModelDrift fails open with no probe / empty inputs', async () => {
  assert.equal((await checkModelDrift('claude', 'x', null)).drifted, false);
  assert.equal((await checkModelDrift('', 'x', async () => false)).drifted, false);
  assert.equal((await checkModelDrift('claude', '', async () => false)).drifted, false);
});
