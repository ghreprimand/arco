import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { arcoHome } from './arcoHome.js';

test('the Arco home defaults to .arco in the user home', () => {
  const previous = process.env.ARCO_HOME;
  delete process.env.ARCO_HOME;
  try { assert.equal(arcoHome(), join(homedir(), '.arco')); } finally { if (previous !== undefined) process.env.ARCO_HOME = previous; }
});

test('ARCO_HOME relocates the Arco home and is resolved per call', () => {
  const previous = process.env.ARCO_HOME;
  try {
    process.env.ARCO_HOME = '  relative-home  ';
    assert.equal(arcoHome(), resolve('relative-home'));
    process.env.ARCO_HOME = '';
    assert.equal(arcoHome(), join(homedir(), '.arco'));
  } finally { if (previous === undefined) delete process.env.ARCO_HOME; else process.env.ARCO_HOME = previous; }
});
