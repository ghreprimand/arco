import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURSOR_OWN_OUTPUT, researchToolBoundaryWarning } from './researchTripwires.js';
import { WORKER_SANDBOX_HOME as home } from '../workers/linuxWorkerSandbox.js';

test('relative glob is not mistaken for an outside absolute path', () => {
  assert.equal(researchToolBoundaryWarning('Bash', JSON.stringify({ command: "/usr/bin/bash -lc 'pwd; ls -a; ls -d .arco/workflows/*/artifacts'", cwd: '/work' })), false);
  assert.equal(researchToolBoundaryWarning('Bash', JSON.stringify({ command: 'ls /root/private' })), true);
  assert.equal(researchToolBoundaryWarning('Bash', JSON.stringify({ command: 'cat `/etc/hostname`' })), true);
  assert.equal(researchToolBoundaryWarning('Bash', JSON.stringify({ command: 'cat {/work/a,/etc/passwd}' })), true);
});

test('a Cursor researcher reading its own tool output raises no sandbox access warning', () => {
  const ownOutput = JSON.stringify({ pattern: '330|antenna', path: `${CURSOR_OWN_OUTPUT}/work/agent-tools/a416ab0d.txt` });
  assert.equal(researchToolBoundaryWarning('Grep', ownOutput), false);
  // Its sign-in and the rest of its home still warn.
  assert.equal(researchToolBoundaryWarning('Read', JSON.stringify({ path: `${home}/.config/cursor/auth.json` })), true);
  assert.equal(researchToolBoundaryWarning('Read', JSON.stringify({ path: `${home}/.cursor/projects-other/x` })), true);
});
