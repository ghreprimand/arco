import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-discovery-fallback-')));
installIsolatedTestHome(root);
after(() => rmSync(root, { recursive: true, force: true }));
const project = join(process.env.HOME!, 'project');
mkdirSync(join(project, 'nested-repo'), { recursive: true });
writeFileSync(join(project, 'root.ts'), 'export const fixture = true;');
writeFileSync(join(project, 'nested-repo', '.git'), 'gitdir: fixture');
for (let i = 0; i < 1200; i++) writeFileSync(join(project, 'nested-repo', `file-${i}.ts`), 'export const fixture = true;');
const { gatherArchitectureFacts } = await import('./architectureReview.js');
const { assessCodebase } = await import('./genesis/creative.js');

test('architecture fallback discovery excludes a nested checkout', async () => {
  const facts = await gatherArchitectureFacts(project);
  assert.equal(facts.git, false);
  assert.equal(facts.sourceFiles, 1);
  assert.deepEqual(facts.largest.map(item => item.path), ['root.ts']);
});

test('Genesis fallback file counting excludes nested checkouts', async () => {
  const result = await assessCodebase(project);
  assert.equal(result.fileCount, 1);
  assert.equal(result.established, false);
});

test('a truncated Genesis fallback is conservative and explains the incomplete assessment', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => { now += 1001; return now; });
  const result = await assessCodebase(project);
  assert.equal(result.established, true);
  assert.match(result.warning!, /results truncated.*treat.*established/is);
});

test('architecture facts mark truncated fallback discovery instead of presenting complete counts', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => { now += 1001; return now; });
  const { renderArchitectureFacts } = await import('./architectureReview.js');
  const facts = await gatherArchitectureFacts(project);
  assert.equal(facts.partial, true);
  assert.match(renderArchitectureFacts(facts), /Results truncated/);
});
