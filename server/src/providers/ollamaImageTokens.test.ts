import assert from 'node:assert/strict';
import test from 'node:test';
import { PNG } from 'pngjs';
import { estimateMessageTokens, estimatePromptTokens } from './ollamaTokens.js';

function image(edge: number, deflateLevel: 0 | 9): string {
  const png = new PNG({ width: edge, height: edge });
  png.data.fill(255);
  return PNG.sync.write(png, { deflateLevel }).toString('base64');
}
test('Ollama compaction estimates depend on image pixels rather than compression size', () => {
  const compressed = image(256, 9), uncompressed = image(256, 0);
  assert.ok(uncompressed.length > compressed.length * 10);
  const cost = (data: string) => estimatePromptTokens({ messages: [{ role: 'user', content: 'Inspect', images: [data] }] });
  assert.equal(cost(compressed), cost(uncompressed));
  assert.ok(cost(uncompressed) < 8192 * 0.7, 'compression alone must not cross the compaction threshold');
});
test('Ollama image estimates follow pixel area and count every image', () => {
  const text = estimateMessageTokens({ role: 'user', content: '' });
  const small = estimateMessageTokens({ role: 'user', content: '', images: [image(128, 9)] }) - text;
  const large = estimateMessageTokens({ role: 'user', content: '', images: [image(512, 9)] }) - text;
  assert.equal(small, 25); assert.equal(large, 361);
  const both = estimateMessageTokens({ role: 'user', content: '', images: [image(128, 9), image(512, 9)] }) - text;
  assert.equal(both, small + large);
});
test('unknown image headers use the same bounded conservative cost regardless of encoded length', () => {
  const estimate = (data: string) => estimateMessageTokens({ role: 'user', images: [data] });
  assert.equal(estimate(Buffer.from('unknown').toString('base64')), estimate(Buffer.alloc(1024 * 1024).toString('base64')));
});
