import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = mkdtempSync(join(tmpdir(), 'arco-file-review-'));
installIsolatedTestHome(root);
after(() => rmSync(root, { recursive: true, force: true }));
const { collectFromFolder } = await import('./skillManagement.js');
let serial = 0;
function folder() { const p = join(root, `fixture-${++serial}`); mkdirSync(p); return p; }
function context(cwd: string) { return { cwd, abortSignal: new AbortController().signal, shells: { byId: new Map(), mintId: () => 'fixture' }, readSet: new Set<string>(), planMode: false, onTodos: () => {} }; }
test('FA3 skill folder imports refuse an alias of protected state', async () => {
  const cwd = folder(), privateDir = join(cwd, '.ssh'); mkdirSync(privateDir);
  writeFileSync(join(privateDir, 'SKILL.md'), '# Synthetic fixture');
  const alias = join(cwd, 'source'); symlinkSync(privateDir, alias, 'junction');
  await assert.rejects(collectFromFolder(alias));
  assert.equal(readFileSync(join(privateDir, 'SKILL.md'), 'utf8'), '# Synthetic fixture');
});
test('FA3 ordinary folder imports remain available while private child files are refused', async () => {
  const cwd = folder(); writeFileSync(join(cwd, 'SKILL.md'), '# Fixture');
  assert.equal((await collectFromFolder(cwd)).files.size, 1);
  writeFileSync(join(cwd, 'credentials.json'), '{"fixture":true}');
  await assert.rejects(collectFromFolder(cwd));
});
