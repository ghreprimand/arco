import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = mkdtempSync(join(tmpdir(), 'arco-file-review-'));
installIsolatedTestHome(root);
after(() => rmSync(root, { recursive: true, force: true }));
const { executeNativeTool } = await import('./providers/claude-native/tools.js');
let serial = 0;
function folder() { const p = join(root, `fixture-${++serial}`); mkdirSync(p); return p; }
function context(cwd: string) { return { cwd, abortSignal: new AbortController().signal, shells: { byId: new Map(), mintId: () => 'fixture' }, readSet: new Set<string>(), planMode: false, onTodos: () => {} }; }
test('FA1 Native file tools refuse a directory link outside the project', async () => {
  const cwd = folder(), outside = folder();
  writeFileSync(join(outside, 'note.txt'), 'outside fixture');
  symlinkSync(outside, join(cwd, 'linked'), 'junction');
  const ctx = context(cwd);
  assert.match(await executeNativeTool('Read', { file_path: 'linked/note.txt' }, ctx), /^\[error\]/);
  assert.match(await executeNativeTool('Write', { file_path: 'linked/new.txt', content: 'changed' }, ctx), /^\[error\]/);
});
test('FA1 inward links, new nested writes and aliased project roots still work', async () => {
  const cwd = folder(); writeFileSync(join(cwd, 'note.txt'), 'inside');
  symlinkSync(join(cwd, 'note.txt'), join(cwd, 'alias.txt'));
  const alias = join(root, `alias-${++serial}`); symlinkSync(cwd, alias, 'junction');
  const ctx = context(alias);
  assert.equal(await executeNativeTool('Read', { file_path: 'alias.txt' }, ctx), 'inside');
  assert.doesNotMatch(await executeNativeTool('Write', { file_path: 'nested/new.txt', content: 'created' }, ctx), /^\[error\]/);
  assert.equal(readFileSync(join(cwd, 'nested', 'new.txt'), 'utf8'), 'created');
});
test('FA1 local provider reads and writes reject outside and dangling links', async () => {
  const { executeOllamaTool } = await import('./providers/ollamaTools.js');
  const cwd = folder(), outside = folder();
  writeFileSync(join(outside, 'note.txt'), 'outside');
  symlinkSync(outside, join(cwd, 'linked'), 'junction');
  symlinkSync(join(outside, 'missing.txt'), join(cwd, 'dangling.txt'));
  for (const file_path of ['linked/note.txt', 'dangling.txt']) {
    assert.match(await executeOllamaTool('Read', { file_path }, { cwd } as any), /^\[error\]/);
    assert.match(await executeOllamaTool('Write', { file_path, content: 'changed' }, { cwd } as any), /^\[error\]/);
  }
  assert.equal(readFileSync(join(outside, 'note.txt'), 'utf8'), 'outside');
});
test('FA1 Glob patterns cannot enumerate an outside folder', async () => {
  const { executeOllamaTool } = await import('./providers/ollamaTools.js');
  const cwd = folder(), outside = folder();
  writeFileSync(join(outside, 'outside-marker.txt'), 'fixture');
  for (const pattern of [join(outside, '*.txt'), '../*/outside-marker.txt']) {
    const a = await executeNativeTool('Glob', { pattern }, context(cwd));
    const b = await executeOllamaTool('Glob', { pattern }, { cwd });
    assert.doesNotMatch(a, /outside-marker/); assert.doesNotMatch(b, /outside-marker/);
  }
});
