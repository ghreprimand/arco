// DD13 — llama.cpp serve-failure diagnosis tests. Pure regex classifier: a
// simulated port-collision / OOM / ctx / gguf / arch / binary tail yields the
// right cause + the right one-click fix; an unrecognised tail falls back to
// `unknown` (matched:false) without inventing a fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diagnoseLlamacppServeFailure } from './llamacppServeDiagnose.js';

test('port collision → port-in-use, with a change-port fix', () => {
  const d = diagnoseLlamacppServeFailure('llama_server_init: failed\nbind: Address already in use\n');
  assert.equal(d.matched, true);
  assert.equal(d.cause, 'port-in-use');
  assert.ok(d.fixes.some((f) => f.kind === 'add-extra-arg' && /--port/.test(f.arg)), 'offers a --port fix');
});

test('OOM → oom, suggests a concrete reduced ctx (halved) and lower ngl', () => {
  const d = diagnoseLlamacppServeFailure('CUDA error: out of memory\ncudaMalloc failed', { currentCtxSize: 32768, currentNgl: 40 });
  assert.equal(d.cause, 'oom');
  const ctxFix = d.fixes.find((f) => f.kind === 'set-ctx-size');
  assert.ok(ctxFix && ctxFix.kind === 'set-ctx-size' && ctxFix.ctxSize < 32768, 'ctx fix is below the current ctx');
  const nglFix = d.fixes.find((f) => f.kind === 'set-ngl');
  assert.ok(nglFix && nglFix.kind === 'set-ngl' && nglFix.ngl < 40, 'ngl fix offloads fewer layers');
});

test('OOM with no known ctx → falls back to a default suggested ctx, no ngl fix', () => {
  const d = diagnoseLlamacppServeFailure('ggml_backend_cuda_buffer_type_alloc_buffer: failed to allocate device buffer');
  assert.equal(d.cause, 'oom');
  assert.ok(d.fixes.some((f) => f.kind === 'set-ctx-size'), 'still offers a ctx fix');
  assert.ok(!d.fixes.some((f) => f.kind === 'set-ngl'), 'no ngl fix without a known current ngl');
});

test('OOM wins over ctx-too-large when both phrasings appear (order matters)', () => {
  const d = diagnoseLlamacppServeFailure('failed to allocate KV cache\nout of memory', { currentCtxSize: 16384 });
  assert.equal(d.cause, 'oom', 'OOM rule is ordered before ctx-too-large');
});

test('ctx-too-large (no OOM phrasing) → ctx-too-large with a ctx fix', () => {
  const d = diagnoseLlamacppServeFailure('llama_kv_cache_init: failed to allocate KV cache for n_ctx = 131072', { currentCtxSize: 131072 });
  assert.equal(d.cause, 'ctx-too-large');
  assert.ok(d.fixes.some((f) => f.kind === 'set-ctx-size'), 'offers a ctx reduction');
});

test('missing GGUF → gguf-missing, advisory only (no auto-fix)', () => {
  const d = diagnoseLlamacppServeFailure('error loading model: failed to open the GGUF file');
  assert.equal(d.cause, 'gguf-missing');
  assert.deepEqual(d.fixes, [], 'a wrong path is not a catalog-editor fix');
});

test('unsupported architecture → unsupported-arch, advisory only', () => {
  const d = diagnoseLlamacppServeFailure('llama_model_load: error: unknown model architecture: \'somearch\'');
  assert.equal(d.cause, 'unsupported-arch');
  assert.deepEqual(d.fixes, []);
});

test('missing binary → binary-missing', () => {
  const d = diagnoseLlamacppServeFailure('spawn llama-server ENOENT');
  assert.equal(d.cause, 'binary-missing');
});

test('unrecognised tail → unknown (matched:false), no invented fix', () => {
  const d = diagnoseLlamacppServeFailure('some entirely novel failure mode 0xdeadbeef');
  assert.equal(d.matched, false);
  assert.equal(d.cause, 'unknown');
  assert.deepEqual(d.fixes, []);
});

test('empty tail → unknown with no message noise', () => {
  const d = diagnoseLlamacppServeFailure('   ');
  assert.equal(d.matched, false);
  assert.equal(d.cause, 'unknown');
  assert.deepEqual(d.fixes, []);
});
