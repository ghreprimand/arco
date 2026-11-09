import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-tuneup-budget-')));
installIsolatedTestHome(root);
after(() => rmSync(root, { recursive: true, force: true }));
const project = join(process.env.HOME!, 'project');
function file(name: string, content = 'fixture') { const path = join(project, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content); }
file('AGENTS.md'); file('.github/AGENTS.md'); file('.gitignore', '.fixture-state/\n');
execFileSync('git', ['init', '-q'], { cwd: project });
file('nested/.git'); file('nested/AGENTS.md');
for (let i = 0; i < 2500; i++) file(`.fixture-state/part-${i}/AGENTS.md`);
const { discoverInstructionFilesWithLinks } = await import('./runMdTuneup.js');

test('TUNE MD skips ignored state and nested checkouts while retaining useful hidden guidance', async () => {
  const start = performance.now();
  const result = await discoverInstructionFilesWithLinks(project);
  assert.deepEqual(result.candidates.map(item => item.path).sort(), [join('.github', 'AGENTS.md'), 'AGENTS.md'].sort());
  assert.ok(performance.now() - start < 1500);
});

for (const mode of ['project', 'global'] as const) test(`TUNE MD retains instruction files ignored by ${mode} Git rules`, async () => {
  const folder = join(process.env.HOME!, `ignored-${mode}`);
  mkdirSync(folder);
  execFileSync('git', ['init', '-q'], { cwd: folder });
  for (const name of ['CLAUDE.md', 'AGENTS.md']) writeFileSync(join(folder, name), 'fixture');
  const previous = process.env.GIT_CONFIG_GLOBAL;
  try {
    if (mode === 'project') writeFileSync(join(folder, '.gitignore'), 'CLAUDE.md\nAGENTS.md\n');
    else {
      const ignore = join(root, 'global-ignore'); writeFileSync(ignore, 'CLAUDE.md\nAGENTS.md\n');
      const config = join(root, 'global-gitconfig');
      writeFileSync(config, `[core]\n\texcludesFile = ${JSON.stringify(ignore)}\n`);
      process.env.GIT_CONFIG_GLOBAL = config;
    }
    const result = await discoverInstructionFilesWithLinks(folder);
    assert.deepEqual(result.candidates.map(item => item.path).sort(), ['AGENTS.md', 'CLAUDE.md']);
  } finally { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; }
});

test('TUNE MD explicit root inside an ignored folder remains searchable', async () => {
  const folder = join(project, '.fixture-state', 'part-0');
  const result = await discoverInstructionFilesWithLinks(folder);
  assert.deepEqual(result.candidates.map(item => item.path), ['AGENTS.md']);
});
