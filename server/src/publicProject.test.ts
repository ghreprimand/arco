import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_PROJECT_IGNORE } from './projectStateIgnore.js';
import { checkProjectState, clearRemoteCache, githubIsPublic, parseRemotes, restoreIgnoreFile, stopTrackingState, suggestFromRemote } from './publicProject.js';

const AT = '@';
const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arco-pp-'));
  g(dir, 'init', '-q');
  g(dir, 'config', 'user.email', `a${AT}example.invalid`);
  g(dir, 'config', 'user.name', 'a');
  return dir;
}

test('remote parsing handles https and ssh forms on known hosts', () => {
  const text = [
    'upstream\thttps://gitlab.com/group/proj.git (fetch)',
    `origin\tgit${AT}github.com:owner/repo.git (fetch)`,
    `origin\tgit${AT}github.com:owner/repo.git (push)`,
    `mirror\tssh://git${AT}codeberg.org/o/r (fetch)`,
    `other\thttps://token${AT}bitbucket.org/team/app.git (fetch)`,
    'self\thttps://git.example.invalid/o/r.git (fetch)',
  ].join('\n');
  const list = parseRemotes(text);
  assert.deepEqual(list.map((r) => `${r.name}:${r.host}:${r.owner}/${r.repo}`), [
    'origin:github.com:owner/repo', 'upstream:gitlab.com:group/proj', 'mirror:codeberg.org:o/r', 'other:bitbucket.org:team/app',
  ]);
  assert.deepEqual(parseRemotes(''), []);
});

test('visibility: public, private, missing, timeout and rate limit', async () => {
  const reply = (status: number, body: unknown) => async () => ({ status, json: async () => body });
  assert.equal(await githubIsPublic('o', 'r', reply(200, { private: false })), true);
  assert.equal(await githubIsPublic('o', 'r', reply(200, { private: true })), false);
  assert.equal(await githubIsPublic('o', 'r', reply(404, {})), false);
  assert.equal(await githubIsPublic('o', 'r', reply(403, {})), false);
  assert.equal(await githubIsPublic('o', 'r', async () => { throw new Error('timeout'); }), false);
  assert.equal(await githubIsPublic('o/../x', 'r', reply(200, { private: false })), false);
});

test('suggestion: none, hosted, public, and one request per day', async () => {
  clearRemoteCache();
  const dir = repo();
  try {
    assert.deepEqual(await suggestFromRemote(dir), { state: 'none' });
    clearRemoteCache();
    g(dir, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
    let calls = 0;
    const fetchImpl = async () => { calls++; return { status: 200, json: async () => ({ private: false }) }; };
    assert.deepEqual(await suggestFromRemote(dir, { fetchImpl, now: 1000 }), { state: 'public', host: 'github.com' });
    await suggestFromRemote(dir, { fetchImpl, now: 2000 });
    assert.equal(calls, 1);
    await suggestFromRemote(dir, { fetchImpl, now: 1000 + 25 * 3600 * 1000 });
    assert.equal(calls, 2);
    clearRemoteCache();
    g(dir, 'remote', 'set-url', 'origin', 'https://gitlab.com/o/r.git');
    assert.deepEqual(await suggestFromRemote(dir, { fetchImpl: async () => { throw new Error('no'); } }), { state: 'hosted', host: 'gitlab.com' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('state check: non-git, healthy, missing, edited and tracked', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'arco-pp-'));
  const dir = repo();
  try {
    assert.equal((await checkProjectState(plain)).isGit, false);
    assert.equal((await checkProjectState(dir)).hasState, false);
    mkdirSync(join(dir, '.arco', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.arco', '.gitignore'), DEFAULT_PROJECT_IGNORE);
    const healthy = await checkProjectState(dir);
    assert.deepEqual([healthy.ignored, healthy.ignoreFile, healthy.tracked], [true, 'default', 0]);
    rmSync(join(dir, '.arco', '.gitignore'));
    const missing = await checkProjectState(dir);
    assert.deepEqual([missing.ignored, missing.ignoreFile], [false, 'missing']);
    writeFileSync(join(dir, '.arco', '.gitignore'), '# mine\n');
    const edited = await checkProjectState(dir);
    assert.deepEqual([edited.ignored, edited.ignoreFile], [false, 'edited']);
    writeFileSync(join(dir, '.arco', 'settings.json'), '{}');
    g(dir, 'add', '-f', '.arco/settings.json');
    const tracked = await checkProjectState(dir);
    assert.equal(tracked.tracked, 1);
    assert.deepEqual(tracked.trackedSample, ['.arco/settings.json']);
  } finally { rmSync(plain, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('restore backs up an edited ignore file; stop tracking keeps files', async () => {
  const dir = repo();
  try {
    mkdirSync(join(dir, '.arco'), { recursive: true });
    writeFileSync(join(dir, '.arco', '.gitignore'), '# mine\n');
    writeFileSync(join(dir, '.arco', 'settings.json'), '{"a":1}');
    g(dir, 'add', '-f', '.arco/settings.json');
    const restored = restoreIgnoreFile(dir);
    assert.ok(restored.backup);
    assert.equal(readFileSync(join(dir, '.arco', '.gitignore'), 'utf8'), DEFAULT_PROJECT_IGNORE);
    assert.equal(readFileSync(join(dir, '.arco', restored.backup!), 'utf8'), '# mine\n');
    assert.deepEqual(restoreIgnoreFile(dir), {});
    assert.equal(readdirSync(join(dir, '.arco')).filter((f) => f.startsWith('.gitignore.backup')).length, 1);
    const stopped = await stopTrackingState(dir);
    assert.deepEqual([stopped.ok, stopped.removed], [true, 1]);
    assert.equal(existsSync(join(dir, '.arco', 'settings.json')), true);
    assert.equal(g(dir, 'ls-files', '--', '.arco').trim(), '');
    assert.equal((await checkProjectState(dir)).ignored, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
