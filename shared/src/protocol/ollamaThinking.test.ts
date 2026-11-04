import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ollamaEffortsFor, ollamaThinkParam, parseOllamaThinking } from './ollamaThinking.js';

// Real /api/show payload from qwen3.8:27b on Ollama 0.34.4.
const qwen = parseOllamaThinking({ values: [false, 'low', 'medium', 'xhigh'], default: 'medium' })!;
const gptOss = parseOllamaThinking({ values: ['high', 'low', 'medium'] })!;

test('parse: levels sorted ascending, unknown names dropped, false ⇒ canDisable', () => {
  assert.deepEqual(qwen, { levels: ['low', 'medium', 'xhigh'], canDisable: true, default: 'medium' });
  assert.deepEqual(parseOllamaThinking({ values: [true, 'weird', 'high'] }), { levels: ['high'], canDisable: false });
  assert.equal(parseOllamaThinking(undefined), null);
  assert.equal(parseOllamaThinking({ values: 'x' }), null);
});

test('picker: LOW (off) + the model levels; legacy pair without level info', () => {
  assert.deepEqual(ollamaEffortsFor(qwen), ['low', 'medium', 'xhigh']);
  assert.deepEqual(ollamaEffortsFor(gptOss), ['low', 'medium', 'high']);
  assert.deepEqual(ollamaEffortsFor(null), ['low', 'high']);
});

test('think param: boolean-only models unchanged', () => {
  assert.equal(ollamaThinkParam('low', null), false);
  assert.equal(ollamaThinkParam('high', null), true);
});

test('think param: levels map exactly; legacy high keeps the model default', () => {
  assert.equal(ollamaThinkParam('low', qwen), false);
  assert.equal(ollamaThinkParam('xhigh', qwen), 'xhigh');
  assert.equal(ollamaThinkParam('high', qwen), true);
  assert.equal(ollamaThinkParam('max', qwen), 'xhigh');
  assert.equal(ollamaThinkParam('low', gptOss), 'low'); // can't disable ⇒ lowest level
  assert.equal(ollamaThinkParam('high', gptOss), 'high');
});
