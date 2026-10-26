import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';
import { isChatStorage, mergeProjects, projectDisplayName, scanFolderProjects, withinRoots } from './projects.js';
import { sanitizeProjects } from './settings.js';

const fixturePath = (value: string) => resolve(value);

test('sanitizeProjects keeps absolute, de-duplicated, normalized paths', () => {
  assert.deepEqual(sanitizeProjects([fixturePath('/srv/app'), 'relative', fixturePath('/srv/app/'), ' /srv/other ', 7, fixturePath('/srv/../srv/app')]), [fixturePath('/srv/app'), fixturePath('/srv/other')]);
  assert.equal(sanitizeProjects('nope'), undefined);
  assert.deepEqual(sanitizeProjects([]), []);
});

test('mergeProjects gives registered precedence over scanned and recent', () => {
  const list = mergeProjects(
    { registered: [fixturePath('/work/a')], scanFolder: fixturePath('/work'), scanned: [fixturePath('/work/a'), fixturePath('/work/b')], recent: [fixturePath('/elsewhere/c'), fixturePath('/work/b/')] },
    (p) => p !== fixturePath('/elsewhere/c'),
  );
  assert.deepEqual(list.projects.map((p) => [p.path, p.source, p.exists]), [
    [fixturePath('/work/a'), 'registered', true],
    [fixturePath('/work/b'), 'scanned', true],
    [fixturePath('/elsewhere/c'), 'recent', false],
  ]);
  assert.equal(list.projects[2].name, 'c');
  assert.equal(list.scanFolder, fixturePath('/work'));
});

test('scanFolderProjects lists children unless the folder is itself a repository', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-scan-')));
  try {
    for (const name of ['beta', 'alpha', '.hidden']) mkdirSync(join(root, name));
    assert.deepEqual(await scanFolderProjects(root), [join(root, 'alpha'), join(root, 'beta')]);
    mkdirSync(join(root, '.git'));
    assert.deepEqual(await scanFolderProjects(root), [root]);
    assert.deepEqual(await scanFolderProjects(null), []);
    assert.deepEqual(await scanFolderProjects(join(root, 'missing')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('projectDisplayName prefers the package name, then the Git remote, then the folder', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-name-')));
  try {
    assert.equal(await projectDisplayName(root), basename(root));
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), '[remote "origin"]\n\turl = git@example.test:team/budget-app.git\n');
    assert.equal(await projectDisplayName(root), 'budget-app');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@team/tally' }));
    assert.equal(await projectDisplayName(root), 'tally');
    writeFileSync(join(root, 'package.json'), '{not json');
    assert.equal(await projectDisplayName(root), 'budget-app');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withinRoots accepts a root or its descendants only', () => {
  const roots = [fixturePath('/projects'), fixturePath('/mnt/data/app')];
  assert.equal(withinRoots(fixturePath('/projects'), roots), true);
  assert.equal(withinRoots(fixturePath('/projects/x/y'), roots), true);
  assert.equal(withinRoots(fixturePath('/projects-other'), roots), false);
  assert.equal(withinRoots(fixturePath('/mnt/data'), roots), false);
  assert.equal(withinRoots(fixturePath('/home/operator'), roots), false);
});

test('chat storage folders are never offered as recent projects', () => {
  const root = fixturePath('/data/home/.arco/chats');
  assert.equal(isChatStorage(fixturePath('/data/home/.arco/chats/0f1e2d3c-aaaa-bbbb-cccc-1234567890ab'), root), true);
  assert.equal(isChatStorage(fixturePath('/data/home/.arco/chats'), root), true);
  assert.equal(isChatStorage(fixturePath('/data/home/.arco/chats-old/x'), root), false, 'folder boundary, not string prefix');
  assert.equal(isChatStorage(fixturePath('/projects/app'), root), false);
});
