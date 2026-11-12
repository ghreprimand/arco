import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, chmodSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'arco-builtin-test-'));
installIsolatedTestHome(root);
const cwd = join(root, 'project'); mkdirSync(cwd);
const skills = await import('./skills.js');
after(() => rmSync(root, { recursive: true, force: true }));

test('built-ins expose model skills and their read-only supporting files', async () => {
  const catalog = await skills.listSkills(cwd);
  const manifest = skills.buildSkillsManifest(catalog);
  const { composeBasePrompts } = await import('./ws/turnPrompt.js');
  for (const provider of ['claude', 'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek']) {
    const prompt = composeBasePrompts({ provider, chatMode: false, computerChat: false, chatWeb: false, systemPrompt: undefined, appendSystemPrompt: undefined, pinnedSkills: '', skillsManifest: manifest, claudeMd: null, knowledge: null });
    assert.match(`${prompt.systemPrompt ?? ''}\n${prompt.appendSystemPrompt ?? ''}`, /name="domain-modeling"/);
  }
  for (const name of ['grilling', 'domain-modeling', 'tdd', 'diagnosing-bugs', 'codebase-design', 'prototype', 'writing-for-agents']) assert.match(manifest, new RegExp(`name="${name}"`));
  for (const name of ['grill-me', 'grill-with-docs', 'wait-what', 'retro', 'architecture-review']) assert.doesNotMatch(manifest, new RegExp(`name="${name}"`));
  const model = catalog.builtin.find((s) => s.slug === 'domain-modeling')!;
  assert.match(readFileSync(model.path!, 'utf8'), /GLOSSARY/);
  assert.match(skills.readBuiltinVirtualFile(join(model.path!, '..', 'GLOSSARY-FORMAT.md'))!, /Glossary/i);
  assert.equal(skills.readBuiltinVirtualFile(join(root, 'secret')), undefined);
  const { executeOllamaTool } = await import('./providers/ollamaTools.js');
  const { executeNativeTool } = await import('./providers/claude-native/tools.js');
  const native = { cwd, abortSignal: new AbortController().signal, shells: {} as never, readSet: new Set<string>(), planMode: false, onTodos: () => {} };
  for (const result of [await executeOllamaTool('Read', { file_path: model.path }, { cwd }), await executeNativeTool('Read', { file_path: model.path }, native)]) assert.match(result, /Domain Modeling/);
  for (const result of [await executeOllamaTool('Write', { file_path: model.path, content: 'changed' }, { cwd }), await executeNativeTool('Write', { file_path: model.path, content: 'changed' }, native)]) assert.match(result, /\[error\]/);
});

test('proportionate-testing is a registered model skill in the first catalog manifest', async () => {
  const catalog = await skills.listSkills(cwd);
  const skill = catalog.builtin.find(s => s.slug === 'proportionate-testing');
  assert.ok(skill);
  assert.equal(skill.operatorOnly, false);
  assert.ok(skill.path);
  assert.match(skills.buildSkillsManifest(catalog), /<skill name="proportionate-testing" scope="builtin" path="[^"]+">/);
  assert.match(readFileSync(skill.path, 'utf8'), /# Proportionate testing/);
});

test('user skill replaces a built-in; OFF removes it from the manifest', async () => {
  await skills.setBuiltinSkillOff('grilling', true);
  assert.doesNotMatch(skills.buildSkillsManifest(await skills.listSkills(cwd)), /name="grilling"/);
  await skills.setBuiltinSkillOff('grilling', false);
  await skills.writeSkill({ scope: 'project', name: 'grilling', description: 'Own version', body: 'Custom.' }, cwd);
  const catalog = await skills.listSkills(cwd);
  assert.equal(catalog.builtin.find((s) => s.slug === 'grilling')?.replaced, true);
  assert.equal((skills.buildSkillsManifest(catalog).match(/name="grilling"/g) ?? []).length, 1);
  assert.match(skills.buildSkillsManifest(catalog), /Own version/);
});

test('editable copies include linked reference files', async () => {
  for (const slug of ['grill-me', 'grill-with-docs', 'wait-what', 'retro', 'grilling', 'domain-modeling', 'tdd', 'diagnosing-bugs', 'codebase-design', 'prototype', 'writing-for-agents']) {
    const copy = await skills.copyBuiltinSkill(slug, 'project', cwd);
    assert.equal(copy.name, slug);
    if (slug === 'tdd') assert.match(readFileSync(join(copy.path, '..', 'tests.md'), 'utf8'), /test/i);
  }
});

test('built-in files persist in Arco home and are restored for each catalog', async () => {
  const { arcoHome } = await import('./arcoHome.js');
  const { APP_VERSION } = await import('./appVersion.js');
  const file = (await skills.listSkills(cwd)).builtin.find(s => s.slug === 'tdd')!.path!;
  assert.ok(file.startsWith(join(arcoHome(), 'builtin-skills', APP_VERSION) + sep));
  const original = readFileSync(file, 'utf8');
  chmodSync(file, 0o600);
  writeFileSync(file, 'changed');
  await skills.listSkills(cwd);
  assert.equal(readFileSync(file, 'utf8'), original);
  rmSync(join(arcoHome(), 'builtin-skills'), { recursive: true, force: true });
  await skills.listSkills(cwd);
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('built-in refresh refuses linked files without changing the target', { skip: process.platform === 'win32' }, async () => {
  const catalog = await skills.listSkills(cwd);
  const file = catalog.builtin.find(s => s.slug === 'tdd')!.path!;
  const target = join(root, 'unrelated');
  writeFileSync(target, 'keep');
  rmSync(file);
  symlinkSync(target, file);
  await assert.rejects(skills.listSkills(cwd), /symbolic link/);
  assert.equal(readFileSync(target, 'utf8'), 'keep');
  rmSync(file);
  await skills.listSkills(cwd);
});
