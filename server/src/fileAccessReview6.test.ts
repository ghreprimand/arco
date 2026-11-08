import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { assertSpellingSafe, isPathWithin } from './fileAccessPolicy.js';
test('FA6 Windows ambiguous components and alternate data streams are refused', () => {
  for (const file of ['C:\\Project\\name.\\note.txt', 'C:\\Project\\name \\note.txt', 'C:\\Project\\note.txt:stream', 'C:\\Project\\note.txt::$DATA', '\\\\server\\share\\name.\\note.txt']) assert.throws(() => assertSpellingSafe(file, path.win32), file);
});
test('FA6 ordinary Windows drives, UNC names and case remain supported', () => {
  for (const file of ['C:\\Project\\note.txt', 'D:\\Data\\note.txt', '\\\\server\\share\\Project\\note.txt']) assert.doesNotThrow(() => assertSpellingSafe(file, path.win32));
  assert.equal(isPathWithin('C:\\Project', 'c:\\project\\note.txt', path.win32), true);
  assert.equal(isPathWithin('C:\\Project', 'D:\\Project\\note.txt', path.win32), false);
  assert.equal(isPathWithin('\\\\server\\share', '\\\\server\\other\\note.txt', path.win32), false);
});
