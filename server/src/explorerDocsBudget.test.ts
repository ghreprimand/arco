import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const fixture = mkdtempSync(join(tmpdir(), 'arco-doc-budget-'));
installIsolatedTestHome(fixture);
after(() => rmSync(fixture, { recursive: true, force: true }));
const { collectDocs, collectProjectDocs } = await import('./explorerDocs.js');
const { collectArtifacts } = await import('./explorerArtifacts.js');
const home = process.env.HOME!;
mkdirSync(process.env.ARCO_HOME!, { recursive: true });
function file(path: string) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'synthetic'); }

test('document discovery skips hidden trees and nested checkouts while retaining ordinary documents', async () => {
  const project = join(home, 'project');
  for (const name of ['README.md', 'docs/guide.md', 'Reports/review.md', '.hidden/secret.md', 'vendor/checkout/.git/HEAD', 'vendor/checkout/noise.md', 'worktree/.git', 'worktree/noise.md']) file(join(project, name));
  for (let i = 0; i < 2500; i++) file(join(project, '.hidden', `part-${i}`, 'noise.md'));
  const start = performance.now();
  const docs = await collectProjectDocs(project);
  assert.deepEqual(docs.map(d => d.rel).sort(), ['README.md', join('Reports', 'review.md'), join('docs', 'guide.md')].sort());
  assert.ok(performance.now() - start < 1000);
});

test('a global discovery finishes promptly across many missing and synthetic projects', async () => {
  const projects = Array.from({ length: 140 }, (_, i) => join(home, `global-${i}`));
  for (const project of projects.slice(0, 100)) { file(join(project, 'README.md')); file(join(project, '.hidden', 'noise.md')); }
  file(join(home, 'temporary', 'README.md'));
  writeFileSync(join(process.env.ARCO_HOME!, 'known-cwds.json'), JSON.stringify([...projects, join(home, 'temporary')]));
  const start = performance.now();
  const docs = await collectDocs();
  assert.ok(performance.now() - start < 1000);
  assert.ok(docs.some(d => d.name === 'README.md'));
  assert.ok(docs.every(d => !d.rel.includes('.hidden')));
});

test('artifact discovery retains every workflow artifact beyond the old result cap', async () => {
  const project = join(home, 'artifacts-project');
  const folder = join(project, '.arco', 'workflows', '11111111-2222-4333-8444-555555555555', 'artifacts');
  for (let i = 0; i < 2005; i++) file(join(folder, `output-${i}.md`));
  assert.equal((await collectArtifacts({ project })).length, 2005);
});

test('entry and time budgets stop traversal and report partial results without blocking timers', async () => {
  const { projectFiles, scanBudget } = await import('./projectScan.js');
  const project = join(home, 'budgeted');
  for (let i = 0; i < 30; i++) file(join(project, `part-${i}`, 'note.md'));
  const budget = scanBudget(4, 1000);
  let yielded = false;
  setImmediate(() => { yielded = true; });
  for await (const _file of projectFiles(project, { budget, skip: new Set() })) { /* consume */ }
  assert.equal(budget.partial, true);
  assert.equal(budget.entries, 0);
  assert.equal(yielded, true);
  const expired = scanBudget(100, 0);
  const results = [];
  for await (const file of projectFiles(project, { budget: expired, skip: new Set() })) results.push(file);
  assert.deepEqual(results, []);
  assert.equal(expired.partial, true);
});

test('capped document results carry an explicit partial marker', async () => {
  const { collectProjectDocsPage } = await import('./explorerDocs.js');
  const project = join(home, 'capped');
  for (let i = 0; i < 4; i++) file(join(project, `note-${i}.md`));
  const result = await collectProjectDocsPage(project, 2);
  assert.equal(result.entries.length, 2);
  assert.equal(result.partial, true);
});
