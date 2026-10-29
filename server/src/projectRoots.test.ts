import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'arco-roots-')));
const home = join(sandbox, 'home'), work = join(sandbox, 'work'), personal = join(sandbox, 'personal');
const app = join(work, 'app'), nested = join(work, 'team'), tool = join(nested, 'tool');
for (const folder of [join(home, '.arco'), app, tool, join(personal, 'notes')]) mkdirSync(folder, { recursive: true });
process.env.HOME = home; process.env.USERPROFILE = home;
const settingsFile = join(home, '.arco', 'settings.json');
after(() => rmSync(sandbox, { recursive: true, force: true }));

test('legacy roots migrate once, browser changes stay independent, explicit empty survives every patch', async () => {
  const { readSettings, patchSettings } = await import('./settings.js');
  const { listProjects, addProject } = await import('./projects.js');
  writeFileSync(settingsFile, JSON.stringify({ defaultWorkingDirectory: work }));
  assert.deepEqual((await readSettings()).projectRoots, [{ name: 'work', path: work }]);
  assert.equal((await listProjects()).projects.find(p => p.path === app)?.source, 'scanned');
  const added = await addProject(app); assert.equal(added.ok, true);
  const id = (await listProjects()).projects.find(p => p.path === app)?.id;
  await patchSettings({ defaultWorkingDirectory: personal });
  assert.equal((await readSettings()).projectRoots?.[0].path, work);
  assert.ok(!(await listProjects()).projects.some(p => p.path === join(personal, 'notes')));
  await patchSettings({ projectRoots: [] });
  await patchSettings({ operatorName: 'Operator' });
  assert.deepEqual((await readSettings()).projectRoots, []);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')).projectRoots, []);
  const listed = await listProjects();
  assert.equal(listed.projects.find(p => p.path === app)?.id, id);
  assert.ok(!listed.projects.some(p => p.path === nested));
  assert.equal(listed.projects.find(p => p.path === app)?.rootPath, undefined);
});

test('multiple/nested/missing roots preserve names, select deepest membership and never register discoveries', async () => {
  const { patchSettings } = await import('./settings.js');
  const { listProjects } = await import('./projects.js');
  await patchSettings({ projectRoots: [{ name: 'Work', path: work }, { name: 'Team', path: nested }, { name: 'Personal', path: personal }, { name: 'Offline drive', path: join(sandbox, 'offline') }] });
  const list = await listProjects();
  assert.equal(list.projects.find(p => p.path === tool)?.rootPath, nested);
  assert.equal(list.projects.find(p => p.path === app)?.rootPath, work);
  assert.equal(list.projects.find(p => p.path === join(personal, 'notes'))?.rootPath, personal);
  assert.equal(list.roots?.find(r => r.name === 'Offline drive')?.exists, false);
  assert.equal(list.projects.find(p => p.path === tool)?.id, undefined);
  const data = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(data.projects, [app]);
  assert.equal(data.projectTrust, undefined);
});

test('root aliases collapse while registered session paths and project ids remain unchanged', async (t) => {
  const alias = join(sandbox, 'work-alias');
  try { symlinkSync(work, alias, process.platform === 'win32' ? 'junction' : 'dir'); } catch { t.skip('directory aliases unavailable'); return; }
  const { patchSettings, sanitizeProjectRoots } = await import('./settings.js');
  const { listProjects } = await import('./projects.js');
  assert.deepEqual(sanitizeProjectRoots([{ name: 'Work', path: work }, { name: 'Alias', path: alias }]), [{ name: 'Work', path: work }]);
  const before = (await listProjects()).projects.find(p => p.path === app)!;
  await patchSettings({ projectRoots: [{ name: 'Alias', path: alias }], projects: [app, join(alias, 'app')] });
  const after = (await listProjects()).projects.filter(p => p.path === app || p.path === join(alias, 'app'));
  assert.equal(after.length, 1); assert.equal(after[0].path, app); assert.equal(after[0].id, before.id);
});

test('new browsing default never adds roots and broad or malformed roots are refused', async () => {
  const { readSettings, patchSettings } = await import('./settings.js');
  writeFileSync(settingsFile, '{}');
  await patchSettings({ defaultWorkingDirectory: work });
  assert.deepEqual((await readSettings()).projectRoots, []);
  for (const path of ['relative', home]) await assert.rejects(patchSettings({ projectRoots: [{ name: 'Bad', path }] }));
  assert.deepEqual((await readSettings()).projectRoots, []);
});

test('duplicate location adds and edit collisions are refused without silently dropping either name', async () => {
  const { patchSettings, readSettings } = await import('./settings.js');
  const baseline = [{ name: 'Work', path: work }, { name: 'Personal', path: personal }];
  await patchSettings({ projectRoots: baseline });
  await assert.rejects(patchSettings({ projectRoots: [...baseline, { name: 'Main', path: work }] }), /already uses this folder/);
  assert.deepEqual((await readSettings()).projectRoots, baseline);
  const alias = join(sandbox, 'work-alias');
  try { realpathSync(alias); await assert.rejects(patchSettings({ projectRoots: [...baseline, { name: 'Alias', path: alias }] }), /already uses this folder/); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  assert.deepEqual((await readSettings()).projectRoots, baseline);
  await assert.rejects(patchSettings({ projectRoots: [{ name: 'Main', path: personal }, baseline[1]] }), /already uses this folder/);
  assert.deepEqual((await readSettings()).projectRoots, baseline);
  await patchSettings({ projectRoots: [{ name: 'Main', path: work }, baseline[1]] });
  assert.deepEqual((await readSettings()).projectRoots, [{ name: 'Main', path: work }, baseline[1]]);
});
