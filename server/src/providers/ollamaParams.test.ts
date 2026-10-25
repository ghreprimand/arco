import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOllamaParams, clampNumCtx, effectiveNumCtx, numCtxCeiling, parseArchContextLength } from './ollamaParams.js';

// Real /api/show model_info shape for stock qwen3.8:27b (Ollama 0.35) — no
// Modelfile num_ctx, 262K trained window.
const QWEN_INFO = {
  'general.architecture': 'qwen35',
  'qwen35.context_length': 262144,
  'qwen35.vision.context_length': 8192,
};

test('parseArchContextLength reads <arch>.context_length, not nested keys', () => {
  assert.equal(parseArchContextLength(QWEN_INFO), 262144);
  assert.equal(parseArchContextLength({ 'llama.context_length': 131072 }), 131072);
  assert.equal(parseArchContextLength({ 'x.vision.context_length': 8192 }), undefined);
  assert.equal(parseArchContextLength(undefined), undefined);
  assert.equal(parseArchContextLength({ 'general.architecture': 'qwen35' }), undefined);
});

test('clampNumCtx: Modelfile value wins as the ceiling', () => {
  assert.equal(clampNumCtx(300_000, 196_608, 262_144), 196_608);
  assert.equal(clampNumCtx(65_536, 196_608, 262_144), 65_536);
});

test('clampNumCtx: arch max is the ceiling when the Modelfile sets none (stock tag)', () => {
  // The 2026-09-29 bug: this returned undefined, dropping SET TO FIT's value.
  assert.equal(clampNumCtx(131_072, undefined, 262_144), 131_072);
  assert.equal(clampNumCtx(500_000, undefined, 262_144), 262_144);
});

test('clampNumCtx: no probe at all still omits (trusted-only)', () => {
  assert.equal(clampNumCtx(131_072, undefined, undefined), undefined);
  assert.equal(numCtxCeiling({}), undefined);
});

test('applyOllamaParams sends the operator num_ctx on a stock model', () => {
  const applied = applyOllamaParams({ num_ctx: 131072, temperature: 0.7 }, undefined, 262_144);
  assert.equal(applied.options.num_ctx, 131_072);
  assert.deepEqual(applied.appliedKeys.sort(), ['num_ctx', 'temperature']);
});

test('effectiveNumCtx: the window the daemon really runs', () => {
  // Operator value below the Modelfile value — the CTX bar / compaction must
  // use the smaller, applied window.
  assert.equal(effectiveNumCtx({ num_ctx: 65_536 }, { numCtx: 196_608, archCtx: 262_144 }), 65_536);
  // No operator value → Modelfile value.
  assert.equal(effectiveNumCtx(undefined, { numCtx: 196_608, archCtx: 262_144 }), 196_608);
  // Stock model, operator set one → that value.
  assert.equal(effectiveNumCtx({ num_ctx: 131_072 }, { archCtx: 262_144 }), 131_072);
  // Stock model, nothing set → unknown (daemon default); arch max is NOT a window.
  assert.equal(effectiveNumCtx(undefined, { archCtx: 262_144 }), undefined);
  // ...until /api/ps measured the daemon default on a prior turn.
  assert.equal(effectiveNumCtx(undefined, { archCtx: 262_144, loadedCtx: 32_768 }), 32_768);
  // An operator value still beats the measurement.
  assert.equal(effectiveNumCtx({ num_ctx: 131_072 }, { archCtx: 262_144, loadedCtx: 32_768 }), 131_072);
});
