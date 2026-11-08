import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = mkdtempSync(join(tmpdir(), 'arco-file-review-'));
installIsolatedTestHome(root);
after(() => rmSync(root, { recursive: true, force: true }));
const { createPlan, readPlanRef, writePlanRef, planRefsDir } = await import('./planStore.js');
let serial = 0;
function folder() { const p = join(root, `fixture-${++serial}`); mkdirSync(p); return p; }
function context(cwd: string) { return { cwd, abortSignal: new AbortController().signal, shells: { byId: new Map(), mintId: () => 'fixture' }, readSet: new Set<string>(), planMode: false, onTodos: () => {} }; }
test('FA2 plan references refuse linked files outside plan storage', async () => {
  const cwd = folder(), outside = folder();
  const plan = await createPlan(cwd, { title: 'Fixture', body: 'Body' });
  mkdirSync(planRefsDir(cwd, plan.id));
  writeFileSync(join(outside, 'note.md'), 'outside fixture');
  symlinkSync(join(outside, 'note.md'), join(planRefsDir(cwd, plan.id), 'notes.md'));
  await assert.rejects(readPlanRef(cwd, plan.id, 'notes'));
});
test('FA2 plan reference writes refuse an outside directory link', async () => {
  const cwd = folder(), outside = folder();
  const plan = await createPlan(cwd, { title: 'Fixture', body: 'Body' });
  symlinkSync(outside, planRefsDir(cwd, plan.id), 'junction');
  await assert.rejects(writePlanRef(cwd, plan.id, 'notes', 'changed'));
});
test('FA2 skills and knowledge refuse linked document files', async () => {
  const { writeSkill, readSkillBody } = await import('./skills.js');
  const { createArticle, readArticle } = await import('./knowledge/store.js');
  const cwd = folder(), outside = folder();
  const skill = await writeSkill({ scope: 'project', name: 'Fixture', description: '', body: 'inside' }, cwd);
  const article = await createArticle(cwd, { title: 'Fixture', body: 'inside' });
  const external = join(outside, 'fixture.md'); writeFileSync(external, 'outside');
  for (const target of [skill.path, join(cwd, '.arco', 'knowledge', `${article.id}.md`)]) { rmSync(target); symlinkSync(external, target); }
  await assert.rejects(readSkillBody('project', skill.slug, cwd));
  await assert.rejects(writeSkill({ scope: 'project', slug: skill.slug, name: 'Fixture', description: '', body: 'changed' }, cwd));
  await assert.rejects(readArticle(cwd, article.id));
  assert.equal(readFileSync(external, 'utf8'), 'outside');
});
