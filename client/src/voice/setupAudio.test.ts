import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downsampleToPcm16, meterPercent, peakLevel } from './setupAudio.js';

test('48 kHz frames become 16 kHz PCM16 with averaged, clamped samples', () => {
  const a = new Float32Array(48000).fill(0.5), b = new Float32Array(2400).fill(-2);
  const pcm = downsampleToPcm16([a, b], 48000);
  assert.equal(pcm.length, 16800);
  assert.equal(pcm[0], Math.round(0.5 * 0x7fff));
  assert.equal(pcm[pcm.length - 1], -0x8000, 'out-of-range input clamps');
  assert.equal(downsampleToPcm16([], 48000).length, 0);
  assert.equal(downsampleToPcm16([new Float32Array(160).fill(0.25)], 16000).length, 160, 'same rate keeps every sample');
});

test('level meter follows the frame peak on a square-root scale', () => {
  assert.equal(peakLevel(new Float32Array([0.1, -0.4, 0.2])), new Float32Array([0.4])[0]);
  assert.equal(meterPercent(0), 0); assert.equal(meterPercent(0.25), 50); assert.equal(meterPercent(4), 100);
});
