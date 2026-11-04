import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LLAMACPP_NOT_FOUND, resolveLlamaServer } from './llamacppBinary.js';

const files = (...present: string[]) => (c: string) => present.includes(c);

test('the not-found message names PATH and the override', () => {
  assert.equal(LLAMACPP_NOT_FOUND, 'llama-server not found on PATH (set ARCO_LLAMACPP_BIN)');
});

test('linux and macOS search PATH for llama-server', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const env = { PATH: '/opt/none:/opt/llama/bin:/usr/bin' };
    assert.equal(resolveLlamaServer({ env, platform, isFile: files('/opt/llama/bin/llama-server') }), '/opt/llama/bin/llama-server');
    assert.equal(resolveLlamaServer({ env, platform, isFile: files() }), null);
  }
});

test('windows searches PATH with PATHEXT and semicolons', () => {
  const env = { PATH: 'C:\\Tools;"C:\\llama cpp"', PATHEXT: '.COM;.EXE;.BAT' };
  assert.equal(resolveLlamaServer({ env, platform: 'win32', isFile: files('C:\\llama cpp\\llama-server.exe') }), 'C:\\llama cpp\\llama-server.exe');
  assert.equal(resolveLlamaServer({ env, platform: 'win32', isFile: files('C:\\Tools\\llama-server') }), 'C:\\Tools\\llama-server');
  assert.equal(resolveLlamaServer({ env, platform: 'win32', isFile: files('/usr/local/bin/llama-server') }), null);
});

test('ARCO_LLAMACPP_BIN overrides PATH and a missing override is not silently replaced', () => {
  const env = { PATH: '/usr/bin', ARCO_LLAMACPP_BIN: '/custom/llama-server' };
  assert.equal(resolveLlamaServer({ env, platform: 'linux', isFile: files('/custom/llama-server', '/usr/bin/llama-server') }), '/custom/llama-server');
  assert.equal(resolveLlamaServer({ env, platform: 'linux', isFile: files('/usr/bin/llama-server') }), null);
});

test('the old fixed POSIX location is no longer assumed', () => {
  assert.equal(resolveLlamaServer({ env: { PATH: '/usr/bin' }, platform: 'linux', isFile: files('/usr/local/bin/llama-server') }), null);
});
