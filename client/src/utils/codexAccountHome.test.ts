import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexProfileHomeLabel } from './codexAccountHome';

test('a Codex profile without its own home is not shown as the default Codex home', () => {
  assert.equal(codexProfileHomeLabel({}), 'Arco data folder');
  assert.equal(codexProfileHomeLabel({ codexHome: '  ' }), 'Arco data folder');
  assert.equal(codexProfileHomeLabel({ codexHome: '/data/codex-work' }), '/data/codex-work');
});
