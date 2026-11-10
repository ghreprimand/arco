import assert from 'node:assert/strict';
import test from 'node:test';
import { codexImageToolKey } from './codexImageTool.js';

test('current Codex advertises the image feature under features', () => {
  assert.equal(codexImageToolKey('view_image stable true\n'), 'features.view_image');
});
test('older Codex keeps its tools setting', () => {
  assert.equal(codexImageToolKey('shell_tool stable true\n'), 'tools.view_image');
  assert.equal(codexImageToolKey(''), 'tools.view_image');
});
