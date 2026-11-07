import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { promises as fs, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-skill-revision-')));
installIsolatedTestHome(root);
after(() => rmSync(root, { recursive: true, force: true }));
const management = await import('./skillManagement.js');
const skills = await import('./skills.js');
const text = (body: string) => skills.renderSkillFile('Fixture', 'Fixture skill', body);
let sequence = 0;
async function reviewed() {
  const cwd = join(root, `project-${++sequence}`), source = join(root, `source-${sequence}`);
  mkdirSync(cwd); mkdirSync(source);
  writeFileSync(join(source, 'SKILL.md'), text('Original'));
  writeFileSync(join(source, 'notes.md'), 'Original notes');
  const imported = await management.confirmImport((await management.previewImport({ kind: 'folder', path: source })).token, 'project', cwd);
  writeFileSync(join(source, 'SKILL.md'), text('Remote update'));
  const preview = await management.previewUpdate('project', imported.slug, cwd);
  return { cwd, slug: imported.slug, dir: join(cwd, '.arco', 'skills', imported.slug), token: preview.token };
}

for (const name of ['SKILL.md', 'notes.md', '.local-note', 'new-note.md']) {
  test(`B49: a local ${name} edit invalidates the update preview`, async () => {
    const f = await reviewed();
    writeFileSync(join(f.dir, name), 'Accepted local edit');
    await assert.rejects(management.confirmUpdate(f.token), /changed|review|preview/i);
    assert.equal(readFileSync(join(f.dir, name), 'utf8'), 'Accepted local edit');
  });
}

test('B49: a supporting-file edit during update staging is preserved', async (t) => {
  const f = await reviewed(), original = fs.rename;
  t.mock.method(fs, 'rename', async (...args: any[]) => {
    const value = await Reflect.apply(original, fs, args);
    if (String(args[1]).includes('.updating-')) writeFileSync(join(f.dir, 'notes.md'), 'Edited during staging');
    return value;
  });
  await assert.rejects(management.confirmUpdate(f.token), /changed|review|preview/i);
  assert.equal(readFileSync(join(f.dir, 'notes.md'), 'utf8'), 'Edited during staging');
});

test('B49: an accepted editor save overlapping update commit remains installed', async (t) => {
  const f = await reviewed(), original = fs.rename;
  let saving: Promise<unknown> | undefined;
  t.mock.method(fs, 'rename', async (...args: any[]) => {
    const value = await Reflect.apply(original, fs, args);
    if (String(args[1]).includes('.updating-')) {
      saving = skills.writeSkill({ scope: 'project', slug: f.slug, name: 'Fixture', description: 'Fixture skill', body: 'Accepted editor save' }, f.cwd);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return value;
  });
  await management.confirmUpdate(f.token);
  await saving;
  assert.match(readFileSync(join(f.dir, 'SKILL.md'), 'utf8'), /Accepted editor save/);
});
