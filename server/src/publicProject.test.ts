import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_PROJECT_IGNORE, appendShareBlock } from './projectStateIgnore.js';
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

// A project with skill `shared` shared the way SHARE WITH REPOSITORY does it
// and committed, plus a private skill that stays ignored.
function sharedSkillRepo(): string {
  const dir = repo();
  mkdirSync(join(dir, '.arco', 'skills', 'shared'), { recursive: true });
  mkdirSync(join(dir, '.arco', 'skills', 'private'), { recursive: true });
  writeFileSync(join(dir, '.arco', 'skills', 'shared', 'SKILL.md'), '---\nname: Shared\n---\nbody\n');
  writeFileSync(join(dir, '.arco', 'skills', 'shared', 'notes.md'), 'n\n');
  writeFileSync(join(dir, '.arco', 'skills', 'private', 'SKILL.md'), '---\nname: Private\n---\nbody\n');
  writeFileSync(join(dir, '.arco', '.gitignore'), appendShareBlock(DEFAULT_PROJECT_IGNORE, 'shared'));
  g(dir, 'add', '--', '.arco');
  g(dir, 'commit', '-q', '-m', 'share');
  assert.deepEqual(g(dir, 'ls-files', '--', '.arco').trim().split('\n'), ['.arco/skills/shared/SKILL.md', '.arco/skills/shared/notes.md']);
  return dir;
}

test('a skill shared with SHARE WITH REPOSITORY and committed gives no warning', async () => {
  const dir = sharedSkillRepo();
  try {
    const report = await checkProjectState(dir);
    assert.deepEqual([report.tracked, report.trackedSample, report.ignored, report.ignoreFile, report.sharedSkills], [0, [], true, 'default', ['shared']]);
    assert.deepEqual(await stopTrackingState(dir), { ok: true, removed: 0 });
    assert.deepEqual(restoreIgnoreFile(dir), {}, 'the ignore file with its share lines counts as restored');
    assert.equal(g(dir, 'ls-files', '--', '.arco').trim().split('\n').length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a shared skill plus another tracked state file: only the other file warns, and STOP TRACKING untracks only it', async () => {
  const dir = sharedSkillRepo();
  try {
    writeFileSync(join(dir, '.arco', 'settings.json'), '{}');
    g(dir, 'add', '-f', '--', '.arco/settings.json');
    const report = await checkProjectState(dir);
    assert.deepEqual([report.tracked, report.trackedSample], [1, ['.arco/settings.json']]);
    const stopped = await stopTrackingState(dir);
    assert.deepEqual([stopped.ok, stopped.removed], [true, 1]);
    assert.deepEqual(g(dir, 'ls-files', '--', '.arco').trim().split('\n'), ['.arco/skills/shared/SKILL.md', '.arco/skills/shared/notes.md']);
    assert.equal(existsSync(join(dir, '.arco', 'settings.json')), true);
    assert.equal((await checkProjectState(dir)).tracked, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('RESTORE IGNORE FILE keeps the share lines and the shared skill stays trackable', async () => {
  const dir = sharedSkillRepo();
  try {
    const file = join(dir, '.arco', '.gitignore');
    const edited = appendShareBlock(DEFAULT_PROJECT_IGNORE, 'shared').replace('*\n', '# broken\n');
    writeFileSync(file, edited);
    const before = await checkProjectState(dir);
    assert.deepEqual([before.ignored, before.ignoreFile, before.sharedSkills, before.tracked], [false, 'edited', ['shared'], 0]);
    const restored = restoreIgnoreFile(dir);
    assert.ok(restored.backup);
    assert.equal(readFileSync(file, 'utf8'), appendShareBlock(DEFAULT_PROJECT_IGNORE, 'shared'));
    assert.equal(readFileSync(join(dir, '.arco', restored.backup!), 'utf8'), edited);
    const after = await checkProjectState(dir);
    assert.deepEqual([after.ignored, after.ignoreFile, after.tracked], [true, 'default', 0]);
    assert.equal(g(dir, 'status', '--porcelain', '--', '.arco').trim(), '', 'nothing about the shared skill changed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shared means the exception lines: a comment alone or a force-added skill still warns', async () => {
  const dir = repo();
  try {
    mkdirSync(join(dir, '.arco', 'skills', 'forced'), { recursive: true });
    writeFileSync(join(dir, '.arco', 'skills', 'forced', 'SKILL.md'), 'x\n');
    writeFileSync(join(dir, '.arco', '.gitignore'), `${DEFAULT_PROJECT_IGNORE}# Shared with the repository: forced\n`);
    g(dir, 'add', '-f', '--', '.arco/skills/forced/SKILL.md');
    const report = await checkProjectState(dir);
    assert.deepEqual([report.tracked, report.sharedSkills], [1, []]);
    assert.deepEqual((await stopTrackingState(dir)).removed, 1);
    assert.equal(g(dir, 'ls-files', '--', '.arco').trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('visibility checks ignore an inherited Git repository override', async () => {
  const project = repo(); const other = repo(); const prior = process.env.GIT_DIR;
  try {
    g(project, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
    process.env.GIT_DIR = join(other, '.git'); clearRemoteCache();
    const result = await suggestFromRemote(project, { fetchImpl: async () => ({ status: 200, json: async () => ({ private: false }) }) });
    assert.deepEqual(result, { state: 'public', host: 'github.com' });
  } finally {
    if (prior === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prior;
    clearRemoteCache(); rmSync(project, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true });
  }
});
