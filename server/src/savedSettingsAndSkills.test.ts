import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs, mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-saved-settings-')));
  installIsolatedTestHome(root);
  const project = join(root, 'project'); mkdirSync(project);
  return { root, project };
}

test('B17: unrelated saves preserve DeepSeek and Strata endpoints; explicit empty blocks reset them', async () => {
  const f = fixture();
  try {
    const settings = await import('./settings.js');
    const deepseek = { baseUrl: 'http://localhost:11435' }, strata = { baseUrl: 'http://localhost:11436' };
    await settings.patchSettings({ deepseek, strata });
    const saved = await settings.patchSettings({ crispText: true });
    assert.deepEqual(saved.deepseek, deepseek); assert.deepEqual(saved.strata, strata);
    const disk = JSON.parse(readFileSync(join(process.env.ARCO_HOME!, 'settings.json'), 'utf8'));
    assert.deepEqual(disk.deepseek, deepseek); assert.deepEqual(disk.strata, strata);
    const reset = await settings.patchSettings({ deepseek: {}, strata: {} });
    assert.deepEqual(reset.deepseek, {}); assert.deepEqual(reset.strata, {});
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('B46: quoted skill metadata survives repeated edit cycles', async () => {
  const { renderSkillFile, parseSkillFile } = await import('./skills.js');
  const name = 'Inspect "quoted" \\ paths', description = 'A \\ folder and "quote"';
  let text = renderSkillFile(name, description, 'Body');
  for (let i = 0; i < 5; i++) {
    const parsed = parseSkillFile(text);
    assert.equal(parsed.name, name); assert.equal(parsed.description, description);
    text = renderSkillFile(parsed.name!, parsed.description!, parsed.body);
  }
});

test('B47: repeated creates keep a maximum-length skill slug valid', async () => {
  const f = fixture();
  try {
    const { writeSkill, isValidSlug } = await import('./skills.js');
    const first = await writeSkill({ scope: 'global', name: 'a'.repeat(64), description: 'Fixture', body: 'First' }, f.project);
    const second = await writeSkill({ scope: 'global', name: 'a'.repeat(64), description: 'Fixture', body: 'Second' }, f.project);
    assert.ok(isValidSlug(second.slug)); assert.notEqual(second.slug, first.slug);
    assert.equal(readFileSync(second.path, 'utf8').includes('Second'), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('B47: moving a full-length slug reserves room for a collision suffix', async (t) => {
  const f = fixture();
  try {
    const { writeSkill, isValidSlug, rootForScope } = await import('./skills.js');
    const { moveSkill } = await import('./skillManagement.js');
    const slug = 'a'.repeat(64);
    await writeSkill({ scope: 'global', name: slug, description: 'Fixture', body: 'Global' }, f.project);
    await writeSkill({ scope: 'project', name: slug, description: 'Fixture', body: 'Project' }, f.project);
    const occupied = join(rootForScope('project', f.project), slug);
    const original = fs.lstat; let probes = 0;
    t.mock.method(fs, 'lstat', async (...args: any[]) => {
      if (args[0] === occupied && ++probes > 8) throw new Error('Fixture stopped a repeated collision probe.');
      return Reflect.apply(original, fs, args);
    });
    const moved = await moveSkill('global', slug, f.project, 'project');
    assert.ok(isValidSlug(moved.slug)); assert.notEqual(moved.slug, slug); assert.ok(probes <= 2);
    assert.match(readFileSync(join(rootForScope('project', f.project), slug, 'SKILL.md'), 'utf8'), /Project/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('B26: a refused plan move keeps its attachment and emits no detach', async () => {
  const f = fixture();
  try {
    const { createPlan } = await import('./planStore.js');
    const { workflowCwds } = await import('./server/state.js');
    workflowCwds.set('move-fixture', f.project);
    const { tryHandleWorkflowDataRoutes } = await import('./http/workflowDataRoutes.js');
    const plan = await createPlan(f.project, { title: 'Fixture', body: '# Fixture\n- [ ] Task' });
    let detached = 0, status = 0;
    const req = Object.assign(Readable.from([JSON.stringify({ targetCwd: f.project })]), { method: 'POST', url: `/api/plans/move?path=${encodeURIComponent(f.project)}&planId=${plan.id}`, headers: {} });
    const res = { writeHead(n: number) { status = n; }, end() {} };
    await tryHandleWorkflowDataRoutes(req as never, res as never, { detachAllForPlan: async () => { detached++; } } as never);
    assert.equal(status, 400); assert.equal(detached, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
