// Unit tests for Native protocol-parity decisions that are easy to regress
// while tuning Opus 4.8. These are pure guards; the real web-search smoke still
// covers the quota-spending end-to-end path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptiveMaxTokensForModel,
  buildContextManagementEditsForRequest,
  shouldSendCompactBeta,
  shouldContinueNativeToolLoop,
  shouldSendInterleavedThinkingBeta,
  buildThinkingParams,
  chooseMaxTokens,
  lookupCtx,
} from './worker.js';
import { nativeContextEstimate } from '../../contextEstimator.js';
import { resolveClaudeAliasFromCatalog } from './catalog.js';
import { claudeAliasFamily, CLAUDE_ALIAS_FALLBACK, isClaudeModelAlias } from '@archon/shared';

test('context management: clear_thinking / clear_tool_uses are not default-on', () => {
  const edits = buildContextManagementEditsForRequest({
    supportsClearThinking: true,
    supportsClearToolUses: true,
    supportsCompact: false,
  }, true);
  assert.deepEqual(edits, []);
});

test('context management: compact is preserved when supported and enabled', () => {
  const edits = buildContextManagementEditsForRequest({
    supportsClearThinking: true,
    supportsClearToolUses: true,
    supportsCompact: true,
  }, true);
  assert.deepEqual(edits, [{ type: 'compact_20260112' }]);
});

test('context management: compact is skipped when disabled or catalog is missing', () => {
  assert.deepEqual(buildContextManagementEditsForRequest({
    supportsClearThinking: false,
    supportsClearToolUses: false,
    supportsCompact: true,
  }, false), []);
  assert.deepEqual(buildContextManagementEditsForRequest(null, true), []);
});

// NATIVE_COMPACTION_PLAN Phase 1 — the Anthropic server-side compaction beta
// (`compact_20260112` edit + `compact-2026-01-12` header) must be OFF by
// default. The WS smoke harness can't see outgoing Anthropic HTTP, so the
// wire-shape guard lives here on the pure builders.
test('compaction default-off: no compact edit and no compact beta when claudeNativeCompact is falsy', () => {
  const caps = { supportsClearThinking: true, supportsClearToolUses: true, supportsCompact: true };
  // compactEnabled false ⇒ the per-tab/global default left it OFF.
  assert.deepEqual(buildContextManagementEditsForRequest(caps, false), []);
  assert.equal(shouldSendCompactBeta(caps, false), false);
});

test('compaction opt-in: compact edit + beta reappear when enabled AND caps.supportsCompact', () => {
  const caps = { supportsClearThinking: true, supportsClearToolUses: true, supportsCompact: true };
  assert.deepEqual(buildContextManagementEditsForRequest(caps, true), [{ type: 'compact_20260112' }]);
  assert.equal(shouldSendCompactBeta(caps, true), true);
});

test('compaction opt-in is still gated on catalog support: no beta when caps lack supportsCompact', () => {
  const caps = { supportsClearThinking: true, supportsClearToolUses: true, supportsCompact: false };
  assert.deepEqual(buildContextManagementEditsForRequest(caps, true), []);
  assert.equal(shouldSendCompactBeta(caps, true), false);
  // Catalog miss (null) also stays off even with the opt-in armed.
  assert.equal(shouldSendCompactBeta(null, true), false);
});

test('tool loop: client tool_use continues even when Opus mislabels stop_reason=end_turn', () => {
  assert.equal(shouldContinueNativeToolLoop([
    { type: 'text' },
    { type: 'tool_use' },
  ], 'end_turn'), true);
});

test('tool loop: bare server_tool_use under end_turn does not drive another Arco round-trip', () => {
  assert.equal(shouldContinueNativeToolLoop([
    { type: 'server_tool_use' },
  ], 'end_turn'), false);
});

test('tool loop: pause_turn continues, max_tokens always stops', () => {
  assert.equal(shouldContinueNativeToolLoop([], 'pause_turn'), true);
  assert.equal(shouldContinueNativeToolLoop([{ type: 'tool_use' }], 'max_tokens'), false);
});

test('Pi parity: adaptive Claude models skip interleaved-thinking beta', () => {
  assert.equal(shouldSendInterleavedThinkingBeta('claude-fable-5'), false);
  assert.equal(shouldSendInterleavedThinkingBeta('claude-opus-5'), false);
  assert.equal(shouldSendInterleavedThinkingBeta('claude-opus-4-8'), false);
  assert.equal(shouldSendInterleavedThinkingBeta('claude-opus-4-7'), false);
  assert.equal(shouldSendInterleavedThinkingBeta('claude-sonnet-4-6'), false);
  assert.equal(shouldSendInterleavedThinkingBeta('claude-sonnet-4-20250514'), true);
});

test('debug override: adaptive Claude models can force interleaved-thinking beta', () => {
  assert.equal(shouldSendInterleavedThinkingBeta('claude-fable-5', true), true);
  assert.equal(shouldSendInterleavedThinkingBeta('claude-opus-4-8', true), true);
  assert.equal(shouldSendInterleavedThinkingBeta('claude-sonnet-4-6', true), true);
});

test('Pi parity: adaptive max_tokens follows model-family output caps', () => {
  assert.equal(adaptiveMaxTokensForModel('claude-fable-5'), 128_000);
  assert.equal(adaptiveMaxTokensForModel('claude-mythos-5'), 128_000);
  assert.equal(adaptiveMaxTokensForModel('claude-opus-5'), 128_000);
  assert.equal(adaptiveMaxTokensForModel('claude-opus-4-8'), 128_000);
  assert.equal(adaptiveMaxTokensForModel('claude-opus-4-7'), 128_000);
  assert.equal(adaptiveMaxTokensForModel('claude-opus-4-6'), 128_000);
  assert.equal(adaptiveMaxTokensForModel('claude-sonnet-4-6'), 64_000);
});

// Opus-5 plan Phase 2 — the `opus` / `opus[1m]` family aliases are absent from
// /v1/models, so before the static entries an alias tab silently fell through
// to no-thinking + 8192 max_tokens + an undefined ctx window. Pin the turn-1
// request shape: adaptive thinking, 128K output, 1M window, no stray
// interleaved-thinking beta.
test('alias tabs (opus / opus[1m]) get the modern adaptive shape from turn 1', () => {
  for (const alias of ['opus', 'opus[1m]']) {
    const thinking = buildThinkingParams(alias, 'xhigh');
    assert.deepEqual(thinking.thinking, { type: 'adaptive', display: 'omitted' }, alias);
    assert.deepEqual(thinking.output_config, { effort: 'xhigh' }, alias);
    assert.equal(chooseMaxTokens(alias, 'high'), 128_000, alias);
    assert.equal(adaptiveMaxTokensForModel(alias), 128_000, alias);
    assert.equal(lookupCtx(alias), 1_000_000, alias);
    assert.equal(shouldSendInterleavedThinkingBeta(alias), false, alias);
  }
});

// 2026-07-28 incident — the Messages API has no family-alias resolution:
// `model: "opus"` comes back `not_found_error: model: opus`, so every alias tab
// on the Native transport died on turn 1. The worker must dispatch a concrete
// id. These pin the resolution's contract; the catalog cache is cold in-process
// here, which is exactly the fallback path a first turn after restart takes.
test('alias resolution: families map to concrete ids, never back to an alias', () => {
  assert.equal(claudeAliasFamily('opus'), 'opus');
  assert.equal(claudeAliasFamily('opus[1m]'), 'opus');
  assert.equal(claudeAliasFamily('sonnet'), 'sonnet');
  assert.equal(claudeAliasFamily('haiku'), 'haiku');
  assert.equal(claudeAliasFamily('claude-opus-5'), null);
  for (const [family, target] of Object.entries(CLAUDE_ALIAS_FALLBACK)) {
    assert.ok(target.startsWith('claude-'), `${family} fallback must be a concrete id, got ${target}`);
    assert.equal(isClaudeModelAlias(target), false, `${family} fallback must not be another alias`);
    assert.ok(target.includes(family), `${family} fallback must stay in-family, got ${target}`);
  }
});

test('alias resolution: cold catalog still yields a dispatchable id', () => {
  for (const alias of ['opus', 'opus[1m]', 'sonnet', 'haiku']) {
    const resolved = resolveClaudeAliasFromCatalog(alias);
    assert.equal(isClaudeModelAlias(resolved), false, `${alias} resolved to another alias`);
    assert.ok(resolved.startsWith('claude-'), `${alias} → ${resolved} is not a concrete id`);
  }
});

test('alias resolution: concrete ids pass through untouched', () => {
  for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5-20251001']) {
    assert.equal(resolveClaudeAliasFromCatalog(id), id);
  }
});

test('CTX estimator: Fable uses the 1M Claude window', () => {
  const est = nativeContextEstimate('claude-fable-5', 22_000, 1234);
  assert.ok(est);
  assert.equal(est.windowSize, 1_000_000);
  assert.equal(est.percentOfWindow, 2);
});

test('CTX estimator: current 1M Claude families do not fall back to 200K', () => {
  assert.equal(nativeContextEstimate('claude-opus-4-6', 220_000)?.windowSize, 1_000_000);
  assert.equal(nativeContextEstimate('claude-opus-5', 220_000)?.windowSize, 1_000_000);
  assert.equal(nativeContextEstimate('claude-sonnet-4-6', 220_000)?.windowSize, 1_000_000);
});
