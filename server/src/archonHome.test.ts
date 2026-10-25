import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { archonHome } from './archonHome.js';

test('the Arco home defaults to .archon in the user home', () => {
  const previous = process.env.ARCHON_HOME;
  delete process.env.ARCHON_HOME;
  try { assert.equal(archonHome(), join(homedir(), '.archon')); } finally { if (previous !== undefined) process.env.ARCHON_HOME = previous; }
});

test('ARCHON_HOME relocates the Arco home and is resolved per call', () => {
  const previous = process.env.ARCHON_HOME;
  try {
    process.env.ARCHON_HOME = '  relative-home  ';
    assert.equal(archonHome(), resolve('relative-home'));
    process.env.ARCHON_HOME = '';
    assert.equal(archonHome(), join(homedir(), '.archon'));
  } finally { if (previous === undefined) delete process.env.ARCHON_HOME; else process.env.ARCHON_HOME = previous; }
});
