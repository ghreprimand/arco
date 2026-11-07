// Concurrent saved-store regressions.
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function sandbox(name: string): { root: string; project: string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `arco-bug-${name}-`)));
  installIsolatedTestHome(root);
  mkdirSync(process.env.ARCO_HOME!, { recursive: true });
  const project = path.join(root, 'project');
  mkdirSync(project, { recursive: true });
  return { root, project };
}


test('B48: concurrent creates of one skill name keep every body', async () => {
  const { root, project } = sandbox('b48');
  try {
    const skills = await import('./skills.js');
    const saved = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) => skills.writeSkill({
      scope: 'project', name: 'Alpha', description: 'd', body: `BODY-${i}`,
    }, project)));
    const slugs = new Set(saved.map((s) => s.slug));
    const bodies = saved.map((s) => readFileSync(s.path, 'utf8'));
    assert.equal(slugs.size, 8, `eight creates kept ${slugs.size} slug(s)`);
    for (let i = 0; i < 8; i++) assert.ok(bodies.some((b) => b.includes(`BODY-${i}`)), `BODY-${i} was overwritten`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('B51: concurrent template saves all remain listed', async () => {
  const { root } = sandbox('b51');
  try {
    const store = await import('./templates/store.js');
    const config = { primaryProvider: 'claude', primaryModel: 'm', primaryEffort: 'low', skipPermissions: false };
    await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) => store.saveTemplate({ name: `Template ${i}`, config })));
    const names = (await store.listTemplates()).map((t) => t.name).sort();
    assert.deepEqual(names, [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `Template ${i}`), `list returned ${names.join(', ')}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('B61: concurrent MCP registry creates all remain listed', async () => {
  const { root } = sandbox('b61');
  try {
    const registry = await import('./mcp/registry.js');
    await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) => registry.create({ name: `Server ${i}`, command: 'true' })));
    const names = (await registry.list()).map((s) => s.name).sort();
    assert.deepEqual(names, [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `Server ${i}`), `registry returned ${names.join(', ')}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
