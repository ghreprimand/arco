import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { glob, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../../testSupport/isolatedHome.js';
import { resolveToolPath } from '../../toolPath.js';
const root = await mkdtemp(join(tmpdir(), 'arco-glob-parity-'));
installIsolatedTestHome(root);
after(() => rm(root, { recursive: true, force: true }));
const cwd = join(root, 'project');
await mkdir(join(cwd, 'src', 'nested'), { recursive: true });
for (const name of ['README.md', 'local.md', 'not-dir', 'src/guide.md', 'src/extra.ts', 'src/nested/deep.md']) await writeFile(join(cwd, name), 'fixture');
const { executeNativeTool } = await import('./tools.js');
const { executeOllamaTool } = await import('../ollamaTools.js');
const context = () => ({ cwd, abortSignal: new AbortController().signal, shells: { byId: new Map(), mintId: () => 'fixture' }, readSet: new Set<string>(), partialReadSet: new Set<string>(), planMode: false, onTodos: () => {} });
const executors = {
  native: (pattern: string) => executeNativeTool('Glob', { pattern }, context()),
  local: (pattern: string) => executeOllamaTool('Glob', { pattern }, { cwd }),
};
async function previous(pattern: string): Promise<string[]> {
  const results: string[] = [];
  for await (const entry of glob(pattern, { cwd })) {
    try { resolveToolPath(cwd, entry); results.push(entry); } catch { /* refused by the previous tool */ }
  }
  return results.sort();
}
for (const [provider, execute] of Object.entries(executors)) {
  for (const pattern of ['*.md', './*.md', '././src/*.md', 'src/', 'src/**', 'src/**/*.md', '**/', 'not-dir/', 'src/*/']) {
    test(`${provider} Glob preserves the previous path set for ${pattern}`, async () => {
      const result = await execute(pattern);
      assert.deepEqual(result === '(no matches)' ? [] : result.split('\n').sort(), await previous(pattern));
    });
  }
}

for (const [provider, execute] of Object.entries(executors)) {
  test(`${provider} Glob returns confined link entries without walking directory links`, async (t) => {
    try {
      await symlink('src/guide.md', join(cwd, 'guide-link.md'), 'file');
      await symlink('src', join(cwd, 'src-link'), 'dir');
      await writeFile(join(root, 'outside.md'), 'outside');
      await symlink(join(root, 'outside.md'), join(cwd, 'outside-link.md'), 'file');
      await symlink('missing.md', join(cwd, 'dangling.md'), 'file');
      await symlink('.', join(cwd, 'loop'), 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') { /* second provider uses the same fixture */ }
      else if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('File links need Windows permission'); return; }
      else throw error;
    }
    for (const pattern of ['guide-link.md', 'src-link', '*.md', '**/*.md', 'outside-link.md', 'dangling.md']) {
      await t.test(pattern, async () => {
        const result = await execute(pattern);
        assert.deepEqual(result === '(no matches)' ? [] : result.split('\n').sort(), await previous(pattern));
      });
    }
    assert.equal(await execute('loop'), 'loop');
    const all = await execute('**');
    assert.doesNotMatch(all, /loop[\\/]|src-link[\\/]|outside-link|dangling|truncated/);
  });
}
