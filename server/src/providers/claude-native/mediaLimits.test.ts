import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeMediaLimits } from './mediaLimits.js';

test('Native image and PDF caps follow the selected context window independently', () => {
  for (const [window, images, pages] of [[200_000, 100, 100], [500_000, 600, 100], [1_000_000, 600, 600]] as const) {
    const limits = nativeMediaLimits(window, 'https://api.anthropic.com');
    assert.equal(limits.images, images); assert.equal(limits.pdfPages, pages);
  }
});
test('first-party API has its published byte cap and custom endpoints stay conservative', () => {
  assert.equal(nativeMediaLimits(1_000_000, 'https://api.anthropic.com').encodedBytes, 128 * 1024 * 1024);
  for (const endpoint of [undefined, 'https://example.com', 'https://api.anthropic.com.example.com', 'invalid']) {
    assert.equal(nativeMediaLimits(1_000_000, endpoint).encodedBytes, 20 * 1024 * 1024);
  }
});
test('unknown or invalid context windows use conservative image and PDF caps', () => {
  for (const window of [undefined, 0, -1, NaN, Infinity]) {
    assert.equal(nativeMediaLimits(window).images, 100);
    assert.equal(nativeMediaLimits(window).pdfPages, 100);
  }
});

test('pre-request repair uses the same PDF page cap as request admission', async () => {
  const { repairImageBlock } = await import('./contentBlocks.js');
  const document = { type: 'document', arcoPages: 101, source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF-1.7\nfixture').toString('base64') } };
  assert.equal(repairImageBlock(document, nativeMediaLimits(1_000_000, 'https://api.anthropic.com')).action, 'keep');
  assert.equal(repairImageBlock(document, nativeMediaLimits(200_000, 'https://api.anthropic.com')).action, 'replace');
});
