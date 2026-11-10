import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupCtx } from './modelParams.js';
import { nativeContextEstimate } from '../../contextEstimator.js';
import { nativeMediaLimits } from './mediaLimits.js';

for (const model of ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929']) {
  test(`${model} uses a 200K Native context window`, () => {
    assert.equal(lookupCtx(model), 200_000);
  });
  test(`${model} uses 200K and 50% at 100K in the normal context meter`, () => {
    const meter = nativeContextEstimate(model, 100_000)!;
    assert.equal(meter.windowSize, 200_000);
    assert.equal(meter.percentOfWindow, 50);
  });
  test(`${model} admits 100 images and 100 PDF pages`, () => {
    const limits = nativeMediaLimits(lookupCtx(model), 'https://api.anthropic.com');
    assert.equal(limits.images, 100);
    assert.equal(limits.pdfPages, 100);
  });
}

for (const model of ['claude-sonnet-4-6', 'claude-sonnet-4-6-20260217', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-opus-5', 'claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2', 'claude-mythos-5', 'claude-mythos-5-1', 'claude-mythos-5-2']) {
  test(`${model} retains its 1M context and larger visual limits`, () => {
    assert.equal(lookupCtx(model), 1_000_000);
    assert.equal(nativeContextEstimate(model, 100_000)?.windowSize, 1_000_000);
    assert.equal(nativeContextEstimate(model, 100_000)?.percentOfWindow, 10);
    assert.equal(nativeMediaLimits(lookupCtx(model)).images, 600);
    assert.equal(nativeMediaLimits(lookupCtx(model)).pdfPages, 600);
  });
}

for (const model of ['claude-sonnet-4', 'claude-sonnet-4-0', 'claude-sonnet-4-20250514', 'claude-opus-4', 'claude-opus-4-0', 'claude-opus-4-20250514', 'claude-opus-4-1', 'claude-opus-4-1-20250805', 'claude-opus-4-5', 'claude-opus-4-5-20251101', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001']) {
  test(`${model} uses the documented 200K window in both lookups`, () => {
    assert.equal(lookupCtx(model), 200_000);
    assert.equal(nativeContextEstimate(model, 100_000)?.windowSize, 200_000);
    assert.equal(nativeContextEstimate(model, 100_000)?.percentOfWindow, 50);
    assert.equal(nativeMediaLimits(lookupCtx(model)).images, 100);
    assert.equal(nativeMediaLimits(lookupCtx(model)).pdfPages, 100);
  });
}
for (const model of ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-haiku-5-5-20261007']) {
  test(`${model} uses the documented 1M window in both lookups`, () => {
    assert.equal(lookupCtx(model), 1_000_000);
    assert.equal(nativeContextEstimate(model, 100_000)?.windowSize, 1_000_000);
    assert.equal(nativeContextEstimate(model, 100_000)?.percentOfWindow, 10);
    assert.equal(nativeMediaLimits(lookupCtx(model)).images, 600);
    assert.equal(nativeMediaLimits(lookupCtx(model)).pdfPages, 600);
  });
}
