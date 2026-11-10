import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMcpFileContent } from './fileContent.js';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
test('encoded text resources do not consume the MCP decoded-media cap', async () => {
  const text = { type: 'resource', resource: { uri: 'fixture.txt', mimeType: 'text/plain', blob: Buffer.from('Fixture text').toString('base64') } };
  const result = await normalizeMcpFileContent({ content: [...Array(20).fill(text), { type: 'image', mimeType: 'image/png', data: png }] });
  assert.equal(result.blocks?.filter(block => block.type === 'image').length, 1);
  assert.doesNotMatch(result.text, /exceeded.*budget/);
});
test('real image blocks still consume the MCP decoded-media cap', async () => {
  const result = await normalizeMcpFileContent({ content: Array(21).fill({ type: 'image', mimeType: 'image/png', data: png }) });
  assert.equal(result.blocks?.filter(block => block.type === 'image').length, 20);
  assert.match(result.text, /exceeded.*budget/);
});
