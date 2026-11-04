import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scrubPeDebugPaths } from './pe-scrub.mjs';

test('removes debug and diagnostic source paths from the Windows terminal binaries', () => {
  for (const arch of ['x64', 'arm64']) {
    for (const name of ['pty.node', 'conpty.node', 'conpty_console_list.node', 'winpty-agent.exe', 'winpty.dll']) {
      const file = fileURLToPath(new URL(`../../node_modules/node-pty/prebuilds/win32-${arch}/${name}`, import.meta.url));
      const before = readFileSync(file), result = scrubPeDebugPaths(before);
      assert.equal(result.bytes.length, before.length);
      assert.equal(result.modified, true, `${arch}/${name}`);
      assert.equal(/[A-Za-z]:[\\/]a[\\/]/i.test(result.bytes.toString('latin1')), false);
      for (const offset of [0, 1]) assert.equal(/(?:^|\0)[A-Za-z]:[\\/]a[\\/]/i.test(result.bytes.subarray(offset).toString('utf16le')), false);
    }
  }
});

test('rejects malformed PE inputs without returning a modified image', () => {
  assert.throws(() => scrubPeDebugPaths(Buffer.from('fixture')), /Invalid PE/);
});

test('refuses to modify a signed PE image', () => {
  const file = fileURLToPath(new URL('../../node_modules/node-pty/prebuilds/win32-x64/conpty.node', import.meta.url));
  const bytes = readFileSync(file); const pe = bytes.readUInt32LE(0x3c); const optional = pe + 24;
  const directory = optional + (bytes.readUInt16LE(optional) === 0x20b ? 112 : 96);
  bytes.writeUInt32LE(1, directory + 32); bytes.writeUInt32LE(1, directory + 36);
  assert.throws(() => scrubPeDebugPaths(bytes), /signed native artifact/);
});

test('does not alter signed optional console binaries', () => {
  for (const arch of ['x64', 'arm64']) {
    const file = fileURLToPath(new URL(`../../node_modules/node-pty/prebuilds/win32-${arch}/conpty/OpenConsole.exe`, import.meta.url));
    assert.throws(() => scrubPeDebugPaths(readFileSync(file)), /signed native artifact/);
  }
});
