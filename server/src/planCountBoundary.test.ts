import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { transform } from 'esbuild';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-count-boundary-')));
installIsolatedTestHome(root);

test('a plan folder replaced after authorization cannot redirect task counting', async t => {
  if (process.platform === 'win32') { t.skip('directory replacement requires the real-host checklist'); rmSync(root, { recursive: true, force: true }); return; }
  const cwd = join(root, 'project'), directory = join(cwd, '.arco', 'plans'), outside = join(root, 'outside');
  mkdirSync(directory, { recursive: true }); mkdirSync(outside);
  writeFileSync(join(directory, 'index.json'), JSON.stringify({ plans: [{ id: 'fixture', title: 'Fixture', updatedAt: 1 }] }));
  writeFileSync(join(directory, 'fixture.md'), '- [ ] Ordinary');
  writeFileSync(join(outside, 'fixture.md'), '- [ ] Outside\n- [ ] Not authorized');
  const paths = await import('./managedPath.js'), checked = await import('./checkedFile.js'), atomic = await import('./atomicFile.js');
  const source = readFileSync(new URL('./planStore.ts', import.meta.url), 'utf8');
  const result = await transform(source, { loader: 'ts', format: 'cjs' });
  const require = createRequire(import.meta.url);
  const module = { exports: {} as { listPlansWithTaskCounts: (cwd: string) => Promise<Array<{ taskCount: number | null }>> } };
  let replaced = false;
  new Function('require', 'module', 'exports', result.code)((name: string) => {
    if (name === './checkedFile.js') return checked;
    if (name === './atomicFile.js') return atomic;
    if (name === './projectStateIgnore.js') return { ensureProjectStateIgnore() {} };
    if (name === './managedPath.js') return { ...paths, projectDocumentPath: (project: string, ...parts: string[]) => {
      const authorized = paths.projectDocumentPath(project, ...parts);
      if (!replaced && parts.length === 1 && parts[0] === 'plans') {
        // Replace the checked parent at the store boundary, before opening a
        // body. Re-canonicalizing it would grant the replacement's destination.
        renameSync(directory, directory + '-held'); symlinkSync(outside, directory, 'dir'); replaced = true;
      }
      return authorized;
    } };
    return require(name);
  }, module, module.exports);
  try {
    const plans = await module.exports.listPlansWithTaskCounts(cwd);
    assert.equal(replaced, true);
    assert.equal(plans[0].taskCount, null, 'no count from the replacement directory may be returned');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
