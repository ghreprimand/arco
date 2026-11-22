import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURSOR_OWN_OUTPUT, researchToolBoundaryWarning } from './researchTripwires.js';

const home = CURSOR_OWN_OUTPUT.replace(/\/\.cursor\/projects$/, '');

test('a Cursor researcher reading its own tool output raises no sandbox access warning', () => {
  const ownOutput = JSON.stringify({ pattern: '330|antenna', path: `${CURSOR_OWN_OUTPUT}/work/agent-tools/a416ab0d.txt` });
  assert.equal(researchToolBoundaryWarning('Grep', ownOutput), false);
  // Its sign-in and the rest of its home still warn.
  assert.equal(researchToolBoundaryWarning('Read', JSON.stringify({ path: `${home}/.config/cursor/auth.json` })), true);
  assert.equal(researchToolBoundaryWarning('Read', JSON.stringify({ path: `${home}/.cursor/projects-other/x` })), true);
});
