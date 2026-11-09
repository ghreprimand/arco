import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { GenesisSeed } from '@arco/shared';
import type { WorkflowState } from '../workflows/types.js';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const root = await fs.mkdtemp(join(tmpdir(), 'arco-genesis-metadata-'));
installIsolatedTestHome(root);
const { gatherProjectContext } = await import('../genesis/creative.js');
const { buildGenesisSystemBlock } = await import('../genesis/prompts.js');
const { handleGenesisCreativeArm } = await import('./genesisHandlers.js');
const { workflows, workflowCwds } = await import('../server/state.js');
const { initWorkflowStore } = await import('../workflowStore.js');
const { settleProjectWrites } = await import('../testSupport/projectWrites.js');
after(async () => { await settleProjectWrites(); await fs.rm(root, { recursive: true, force: true }); });
async function project() { const cwd = join(root, randomUUID()); await fs.mkdir(cwd); return cwd; }
async function arm(cwd: string) {
  const id = randomUUID();
  const messages: Array<{ type: string; seed?: GenesisSeed }> = [];
  const ws = { readyState: 1, send: (raw: string) => messages.push(JSON.parse(raw)) } as unknown as WebSocket;
  const wf = { config: { workingDirectory: cwd }, observers: new Set([ws]), primary: { provider: 'claude' } } as unknown as WorkflowState;
  workflows.set(id, wf); workflowCwds.set(id, cwd);
  await initWorkflowStore(cwd, id);
  try {
    await handleGenesisCreativeArm(ws, { type: 'genesis_creative_arm', workflowId: id });
    const seed = messages.find(message => message.type === 'genesis_creative_armed')?.seed;
    assert.ok(seed, JSON.stringify(messages));
    return { recording: JSON.stringify(messages), system: buildGenesisSystemBlock(seed), seed };
  } finally { workflows.delete(id); workflowCwds.delete(id); await settleProjectWrites(); }
}

test('Creative arming and its system block never collect outside metadata links', async () => {
  const cwd = await project();
  const marker = 'OUTSIDE_SYNTHETIC_METADATA';
  const outside = join(root, 'outside-readme.md'), manifest = join(root, 'outside-package.json');
  await fs.writeFile(outside, `# ${marker}\n${marker} description\n`);
  await fs.writeFile(manifest, JSON.stringify({ name: marker, description: marker }));
  await fs.symlink(outside, join(cwd, 'README.md'), 'file');
  await fs.symlink(manifest, join(cwd, 'package.json'), 'file');
  for (const name of ['CLAUDE.md', 'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'Gemfile', 'composer.json', 'Dockerfile']) await fs.symlink(outside, join(cwd, name), 'file');
  const context = await gatherProjectContext(cwd);
  const result = await arm(cwd);
  for (const text of [context.block, result.recording, result.system]) {
    assert.doesNotMatch(text, /OUTSIDE_SYNTHETIC_METADATA/);
    assert.doesNotMatch(text, /Detected stack markers:|A CLAUDE.md \(agent brief\) is present/);
  }
});

for (const alias of [false, true]) test(`Creative metadata preserves regular in-project content, alias=${alias}`, async () => {
  const cwd = await project();
  await fs.mkdir(join(cwd, 'docs'));
  await fs.writeFile(join(cwd, alias ? 'docs/overview.md' : 'README.md'), '# Inside project\nSafe overview\n');
  await fs.writeFile(join(cwd, alias ? 'docs/manifest.json' : 'package.json'), JSON.stringify({ name: 'inside-fixture', description: 'Safe package description' }));
  if (alias) {
    await fs.symlink('docs/overview.md', join(cwd, 'README.md'), 'file');
    await fs.symlink('docs/manifest.json', join(cwd, 'package.json'), 'file');
  }
  const result = await arm(cwd);
  assert.equal(result.seed.title, 'inside-fixture');
  assert.match(result.system, /README heading: Inside project/);
  assert.match(result.system, /README summary: Safe overview/);
  assert.match(result.system, /Safe package description/);
  assert.match(result.system, /Detected stack markers: Node\/JS/);
});

test('Creative metadata refuses protected aliases, dangling links and directories', async () => {
  const cwd = await project();
  await fs.mkdir(join(cwd, '.git'));
  await fs.writeFile(join(cwd, '.git', 'config'), '# PROTECTED_SYNTHETIC_METADATA\n');
  await fs.symlink('.git/config', join(cwd, 'README.md'), 'file');
  await fs.symlink('missing.json', join(cwd, 'package.json'), 'file');
  await fs.mkdir(join(cwd, 'CLAUDE.md'));
  const context = await gatherProjectContext(cwd);
  assert.doesNotMatch(context.block, /PROTECTED_SYNTHETIC_METADATA|A CLAUDE.md \(agent brief\) is present/);
});

test('Creative metadata reads are bounded and oversized metadata is omitted', async () => {
  const cwd = await project();
  await fs.writeFile(join(cwd, 'README.md'), '# OVERSIZED_SYNTHETIC_METADATA\n' + 'x'.repeat(1024 * 1024));
  await fs.writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'OVERSIZED_SYNTHETIC_METADATA', description: 'x'.repeat(1024 * 1024) }));
  assert.doesNotMatch((await gatherProjectContext(cwd)).block, /OVERSIZED_SYNTHETIC_METADATA/);
});

test('Creative metadata refuses a FIFO without waiting for a writer', { skip: process.platform === 'win32', timeout: 2000 }, async () => {
  const cwd = await project();
  execFileSync('mkfifo', [join(cwd, 'README.md')]);
  assert.doesNotMatch((await gatherProjectContext(cwd)).block, /README heading:|README summary:/);
});
