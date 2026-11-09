import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-changed-budget-')));
installIsolatedTestHome(root);
after(() => rmSync(root, { recursive: true, force: true }));
const project = join(process.env.HOME!, 'project');
function file(name: string) { const path = join(project, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'fixture'); }
file('root.md'); file('.github/visible.md'); file('.gitignore'); writeFileSync(join(project, '.gitignore'), '.fixture-state/\n');
execFileSync('git', ['init', '-q'], { cwd: project });
file('nested/.git'); file('nested/noise.md');
for (let i = 0; i < 2500; i++) file(`.fixture-state/part-${i}/noise.md`);
file('.arco/workflows/11111111-2222-4333-8444-555555555555/artifacts/review.md');
const { scanChanged } = await import('./explorerChanged.js');

test('changed-file discovery skips ignored trees and nested checkouts without hiding workflow artifacts', async () => {
  const start = performance.now();
  const files = await scanChanged({ project });
  const paths = files.map(item => item.path).join('\n');
  assert.match(paths, /root.md/); assert.match(paths, /visible.md/); assert.match(paths, /review.md/);
  assert.doesNotMatch(paths, /noise.md/);
  assert.ok(performance.now() - start < 1500);
});

test('the changed-files endpoint model distinguishes a capped sample from a complete list', async () => {
  const many = join(process.env.HOME!, 'many'); mkdirSync(many);
  for (let i = 0; i < 501; i++) writeFileSync(join(many, `note-${i}.md`), 'fixture');
  const { scanChangedPage } = await import('./explorerChanged.js');
  const result = await scanChangedPage({ project: many });
  assert.ok(result.entries.length <= 500);
  assert.equal(result.partial, true);
});

test('a configured Git project root does not admit its nested checkout as another top-level project', async () => {
  const { patchSettings } = await import('./settings.js');
  await patchSettings({ defaultWorkingDirectory: project });
  const result = await scanChanged();
  const paths = result.map(item => item.path).join('\n');
  assert.match(paths, /root.md/); assert.doesNotMatch(paths, /noise.md/);
});
