import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyDraftTask, readOnlyFileTools } from './runCompare.js';

test('the reply-draft task carries the material and the question, and says whether tools exist', () => {
  const off = buildReplyDraftTask('What do I tell it?', 'worker: shall I refactor now?', false);
  assert.match(off, /Draft the reply the operator could send/);
  assert.match(off, /shall I refactor now\?/);
  assert.match(off, /What do I tell it\?/);
  assert.match(off, /You have no tools/);
  assert.match(buildReplyDraftTask('', 'material', true), /read-only tools/);
  assert.match(buildReplyDraftTask('', 'material', true), /none given/);
});
test('file access is read-only: no write, shell or web tools for any provider', () => {
  for (const provider of ['claude', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek']) {
    const tools = readOnlyFileTools(provider);
    assert.deepEqual(tools, ['Read', 'Grep', 'Glob']);
  }
  assert.deepEqual(readOnlyFileTools('codex'), []);
  assert.deepEqual(readOnlyFileTools('cursor'), []);
});
