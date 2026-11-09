import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../../testSupport/isolatedHome.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-search-boundary-')));
installIsolatedTestHome(root);
after(() => rmSync(root, { recursive: true, force: true }));
const project = join(process.env.HOME!, 'project');
function file(name: string) { const path = join(project, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'needle'); }
file('root.md'); file('.gitignore'); writeFileSync(join(project, '.gitignore'), '.fixture-state/\nlogs/*\n!logs/keep.md\nignored.md\ndocs/local.md\n');
childProcess.execFileSync('git', ['init', '-q'], { cwd: project });
file('ignored.md'); file('docs/local.md');
file('logs/keep.md'); file('logs/ignored-output.md');
file('.github/workflows/visible.md'); file('nested/.git'); file('nested/noise.md');
for (let i = 0; i < 2500; i++) file(`.fixture-state/part-${i}/noise.md`);

// Force the fallback deterministically without changing the process PATH or
// disabling Git's ignore evaluation.
const originalSpawn = childProcess.spawnSync;
childProcess.spawnSync = ((command: string, ...args: any[]) => command === 'rg'
  ? { status: 1, stdout: '', stderr: '' } : (originalSpawn as any)(command, ...args)) as any;
syncBuiltinESMExports();
const { executeNativeTool } = await import('./tools.js');
childProcess.spawnSync = originalSpawn;
syncBuiltinESMExports();
const context = () => ({ cwd: project, abortSignal: new AbortController().signal, shells: { byId: new Map(), mintId: () => 'fixture' }, readSet: new Set<string>(), partialReadSet: new Set<string>(), planMode: false, onTodos: () => {} });

test('Glob skips ignored directories and nested checkouts but can search useful hidden folders', async () => {
  const start = performance.now();
  const result = await executeNativeTool('Glob', { pattern: '**/*.md' }, context());
  assert.match(result, /root.md/); assert.match(result, /keep.md/);
  assert.doesNotMatch(result, /noise.md/);
  const hidden = await executeNativeTool('Glob', { pattern: '.github/**/*.md' }, context());
  assert.match(hidden, /visible.md/);
  assert.ok(performance.now() - start < 1500);
});

test('fallback Grep skips ignored state and nested checkouts while retaining hidden project files', async () => {
  const start = performance.now();
  const result = await executeNativeTool('Grep', { pattern: 'needle', files_only: true }, context());
  assert.match(result, /root.md/); assert.match(result, /visible.md/);
  assert.doesNotMatch(result, /noise.md/);
  assert.ok(performance.now() - start < 1500);
});

test('local-model Glob also excludes nested checkouts and ignored state', async () => {
  const { executeOllamaTool } = await import('../ollamaTools.js');
  const result = await executeOllamaTool('Glob', { pattern: '**/*.md' }, { cwd: project });
  assert.match(result, /root.md/); assert.doesNotMatch(result, /noise.md/);
  assert.match(await executeOllamaTool('Glob', { pattern: '.github/**/*.md' }, { cwd: project }), /visible.md/);
});

test('local-model Grep retains hidden project files without visiting ignored state', async () => {
  const { executeOllamaTool } = await import('../ollamaTools.js');
  const result = await executeOllamaTool('Grep', { pattern: 'needle', files_only: true }, { cwd: project });
  assert.match(result, /root.md/); assert.match(result, /visible.md/); assert.doesNotMatch(result, /noise.md/);
});

test('native and local Glob explicitly report their result budget', async () => {
  const { executeOllamaTool } = await import('../ollamaTools.js');
  const many = join(process.env.HOME!, 'many'); mkdirSync(many);
  for (let i = 0; i < 1001; i++) writeFileSync(join(many, `note-${i}.md`), 'fixture');
  assert.match(await executeNativeTool('Glob', { pattern: '*.md' }, { ...context(), cwd: many }), /results truncated/);
  assert.match(await executeOllamaTool('Glob', { pattern: '*.md' }, { cwd: many }), /results truncated/);
});

test('fallback content search still supports an explicit single-file scope', async () => {
  const { executeOllamaTool } = await import('../ollamaTools.js');
  assert.match(await executeNativeTool('Grep', { pattern: 'needle', path: 'root.md' }, context()), /root.md:1: needle/);
  assert.match(await executeOllamaTool('Grep', { pattern: 'needle', path: 'root.md' }, { cwd: project }), /root.md:1: needle/);
});

test('Glob keeps individually ignored files and explicit scope inside an ignored folder', async () => {
  const { executeOllamaTool } = await import('../ollamaTools.js');
  for (const execute of [
    (args: Record<string, unknown>) => executeNativeTool('Glob', args, context()),
    (args: Record<string, unknown>) => executeOllamaTool('Glob', args, { cwd: project }),
  ]) {
    const result = await execute({ pattern: '**/*.md' });
    assert.match(result, /ignored.md/); assert.match(result, /local.md/);
    const scoped = await execute({ pattern: '*.md', path: '.fixture-state/part-0' });
    assert.match(scoped, /noise.md/);
  }
});

test('fallback Grep honors explicit scope inside an ignored directory', async () => {
  const { executeOllamaTool } = await import('../ollamaTools.js');
  const args = { pattern: 'needle', files_only: true, path: '.fixture-state/part-0' };
  assert.match(await executeNativeTool('Grep', args, context()), /noise.md/);
  assert.match(await executeOllamaTool('Grep', args, { cwd: project }), /noise.md/);
});
