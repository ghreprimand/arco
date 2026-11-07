import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { binaryOnPath } from './demucs.js';

test('Windows Demucs discovery accepts the pip executable on Path', async (t) => {
  t.mock.method(fs, 'access', async () => { throw new Error('outside fixture'); });
  assert.equal(await binaryOnPath('demucs', {
    platform: 'win32',
    env: { Path: 'C:\\Tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    isFile: (file) => file === 'C:\\Tools\\demucs.exe',
  }), true);
});
