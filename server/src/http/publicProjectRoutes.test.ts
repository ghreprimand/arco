import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { linkFile, linkFolder } from '../testSupport/links.js';

// RESTORE IGNORE FILE and STOP TRACKING change a project, so they act only on
// registered projects and never through a link at .arco or .arco/.gitignore.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-public-routes-')));
installIsolatedTestHome(root);
const { tryHandlePublicProjectRoutes } = await import('./publicProjectRoutes.js');
const { addProject } = await import('../projects.js');
const { DEFAULT_PROJECT_IGNORE } = await import('../projectStateIgnore.js');
after(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8' });

function project(name: string, register: boolean): Promise<string> | string {
  const cwd = join(root, name);
  mkdirSync(join(cwd, '.arco'), { recursive: true });
  git(cwd, 'init', '-q');
  return register ? addProject(cwd).then((r) => { assert.equal(r.ok, true); return cwd; }) : cwd;
}

async function post(action: string, path: string): Promise<{ code: number; body: Record<string, unknown> }> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ path }))]), { method: 'POST', url: `/api/public-project/${action}` }) as IncomingMessage;
  let code = 0, text = '';
  const res = { writeHead: (status: number) => { code = status; }, end: (value: string) => { text = value; } } as unknown as ServerResponse;
  assert.equal(await tryHandlePublicProjectRoutes(req, res), true);
  return { code, body: JSON.parse(text) };
}

test('a folder that is not a registered project is refused and left alone', async () => {
  const cwd = await project('stray', false);
  writeFileSync(join(cwd, '.arco', 'note.txt'), 'x');
  git(cwd, 'add', '-f', '.arco/note.txt');
  for (const action of ['restore-ignore', 'stop-tracking']) {
    const r = await post(action, cwd);
    assert.equal(r.code, 403, action);
  }
  assert.equal(existsSync(join(cwd, '.arco', '.gitignore')), false);
  assert.equal(git(cwd, 'ls-files', '--', '.arco').trim(), '.arco/note.txt');
});

test('a registered project: restore and stop tracking work', async () => {
  const cwd = await project('registered', true);
  writeFileSync(join(cwd, '.arco', 'note.txt'), 'x');
  git(cwd, 'add', '-f', '.arco/note.txt');
  assert.equal((await post('restore-ignore', cwd)).code, 200);
  assert.equal(readFileSync(join(cwd, '.arco', '.gitignore'), 'utf8'), DEFAULT_PROJECT_IGNORE);
  const stopped = await post('stop-tracking', cwd);
  assert.deepEqual([stopped.code, stopped.body.removed], [200, 1]);
  assert.equal(git(cwd, 'ls-files', '--', '.arco'), '');
});

test('STOP TRACKING through the route leaves a shared skill tracked; RESTORE IGNORE FILE keeps its share lines', async () => {
  const { appendShareBlock } = await import('../projectStateIgnore.js');
  const cwd = await project('shared-skill', true);
  mkdirSync(join(cwd, '.arco', 'skills', 'shared'), { recursive: true });
  writeFileSync(join(cwd, '.arco', 'skills', 'shared', 'SKILL.md'), 'x');
  const withShare = appendShareBlock(DEFAULT_PROJECT_IGNORE, 'shared');
  writeFileSync(join(cwd, '.arco', '.gitignore'), `${withShare}# mine\n`);
  writeFileSync(join(cwd, '.arco', 'note.txt'), 'x');
  git(cwd, 'add', '--', '.arco/skills/shared/SKILL.md');
  git(cwd, 'add', '-f', '--', '.arco/note.txt');
  const stopped = await post('stop-tracking', cwd);
  assert.deepEqual([stopped.code, stopped.body.removed], [200, 1]);
  assert.equal(git(cwd, 'ls-files', '--', '.arco').trim(), '.arco/skills/shared/SKILL.md');
  const restored = await post('restore-ignore', cwd);
  assert.equal(restored.code, 200);
  assert.ok(restored.body.backup);
  assert.equal(readFileSync(join(cwd, '.arco', '.gitignore'), 'utf8'), withShare);
});

test('a linked .arco folder is refused', async () => {
  const cwd = join(root, 'linked-dir'); mkdirSync(cwd); git(cwd, 'init', '-q');
  const elsewhere = join(root, 'elsewhere-dir'); mkdirSync(elsewhere);
  await linkFolder(elsewhere, join(cwd, '.arco'));
  assert.equal((await addProject(cwd)).ok, true);
  for (const action of ['restore-ignore', 'stop-tracking']) {
    const r = await post(action, cwd);
    assert.equal(r.code, 409, action);
    assert.match(String(r.body.error), /link/);
  }
  assert.equal(existsSync(join(elsewhere, '.gitignore')), false);
});

test('a linked .arco/.gitignore is refused and its target is unchanged', async (t) => {
  const cwd = await project('linked-file', true);
  const target = join(root, 'outside-ignore');
  writeFileSync(target, 'outside\n');
  if (!(await linkFile(target, join(cwd, '.arco', '.gitignore')))) { t.skip('file links need extra rights on this system'); return; }
  const r = await post('restore-ignore', cwd);
  assert.equal(r.code, 409);
  assert.equal(readFileSync(target, 'utf8'), 'outside\n');
});
