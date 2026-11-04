import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const audit = resolve('scripts/public-audit.mjs');
// Required for new history; the full form is the only one exempt from a
// matching local private term.
const projectIdentity = 'ghreprimand <203024559+ghreprimand@users.noreply.github.com>';
const [, projectName, projectEmail] = /^(.+) <(.+)>$/.exec(projectIdentity);
const legacyIdentity = { name: 'Arco contributors', email: 'contributors@arco.invalid' };
function fixture(run) {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-audit-'));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', projectName);
  git('config', 'user.email', projectEmail);
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  const env = { ...process.env, ARCO_PRIVATE_PATTERNS_FILE: join(cwd, '.git', 'private-patterns') };
  const check = (...args) => spawnSync(process.execPath, [audit, ...args], { cwd, encoding: 'utf8', env });
  const push = input => spawnSync(process.execPath, [audit, '--push'], { cwd, encoding: 'utf8', env, input });
  const commit = (text = 'clean', message = 'Fixture') => {
    writeFileSync(join(cwd, 'sample.txt'), text);
    git('add', 'sample.txt'); git('commit', '-m', message);
    return git('rev-parse', 'HEAD').toString().trim();
  };
  try { run({ cwd, git, check, push, commit }); } finally { rmSync(cwd, { recursive: true, force: true }); }
}
const zero = '0'.repeat(40);
const update = (oid, local = 'refs/heads/main', remote = 'refs/heads/main', old = zero) => `${local} ${oid} ${remote} ${old}\n`;
test('staged audit reads the index and redacts private values', () => fixture(({ cwd, git, check }) => {
  const privateName = 'private-fixture-owner';
  writeFileSync(join(cwd, '.git', 'private-patterns'), privateName);
  writeFileSync(join(cwd, 'sample.txt'), `example: ${privateName}`);
  git('add', 'sample.txt');
  writeFileSync(join(cwd, 'sample.txt'), 'clean working copy');
  const result = check('--staged');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /sample.txt:1: local-private-pattern/);
  assert.ok(!result.stderr.includes(privateName));
}));
test('tree-only patterns apply to current content but not history or push', () => fixture(({ cwd, git, check, push, commit }) => {
  const term = ['synthetic', 'tree', 'sentinel'].join('-');
  const tip = commit(term);
  const patternFile = join(cwd, '.git', 'private-patterns-tree');
  assert.equal(check('--tree').status, 0, 'missing optional file is a no-op');
  writeFileSync(patternFile, `# comment\n  ${term.toUpperCase()}  \n`);
  writeFileSync(join(cwd, 'sample.txt'), `${term} staged`);
  git('add', 'sample.txt');
  for (const scope of ['--tree', '--staged']) {
    const result = check(scope);
    assert.equal(result.status, 1, scope);
    assert.match(result.stderr, /local-private-pattern/);
    assert.ok(!result.stderr.includes(term));
  }
  mkdirSync(join(cwd, 'package'));
  writeFileSync(join(cwd, 'package', 'sample.txt'), term);
  assert.match(check('--package', join(cwd, 'package')).stderr, /local-private-pattern/);
  assert.equal(check('--history').status, 0);
  assert.equal(check('--release-history').status, 0);
  assert.equal(push(update(tip)).status, 0);
  writeFileSync(join(cwd, 'message'), term);
  assert.equal(check('--message', join(cwd, 'message')).status, 0);
}));
test('private words are case-insensitive whole words in staged additions and tree', () => fixture(({ cwd, git, check, commit }) => {
  commit('ordinary text');
  const word = 'ZephyrFixture';
  assert.equal(check('--tree').status, 0, 'a missing optional file is harmless');
  writeFileSync(join(cwd, '.git', 'private-words'), `# private fixture\n${word}\n`);
  writeFileSync(join(cwd, 'sample.txt'), 'prefixZephyrFixtureSuffix and ZephyrFixture2');
  git('add', 'sample.txt');
  assert.equal(check('--staged').status, 0, 'substrings inside identifiers do not match');
  assert.equal(check('--tree').status, 0);
  writeFileSync(join(cwd, 'sample.txt'), 'a zEPHYRfixture, followed by text');
  git('add', 'sample.txt');
  for (const scope of ['--staged', '--tree']) {
    const result = check(scope);
    assert.equal(result.status, 1, scope);
    assert.match(result.stderr, /local-private-word/);
    assert.ok(!result.stderr.toLowerCase().includes(word.toLowerCase()), 'findings redact configured words');
  }
  writeFileSync(join(cwd, 'sample.txt'), 'ordinary text');
  git('add', 'sample.txt');
  assert.equal(check('--staged').status, 0, 'removing a matching word is allowed');
}));

test('private word check covers added paths', () => fixture(({ cwd, git, check, commit }) => {
  commit();
  writeFileSync(join(cwd, '.git', 'private-words'), 'ZephyrFixture\n');
  writeFileSync(join(cwd, 'ZephyrFixture.txt'), 'ordinary');
  git('add', 'ZephyrFixture.txt');
  assert.match(check('--staged').stderr, /local-private-word/);
}));

test('private words are read from the common directory in a linked worktree', () => fixture(({ cwd, git, commit }) => {
  commit();
  const linked = join(cwd, 'linked-worktree');
  git('worktree', 'add', '-b', 'fixture-linked', linked, 'main');
  writeFileSync(join(cwd, '.git', 'private-words'), 'ZephyrFixture\n');
  writeFileSync(join(linked, 'added.txt'), 'ZephyrFixture');
  execFileSync('git', ['add', 'added.txt'], { cwd: linked, stdio: 'pipe' });
  const result = spawnSync(process.execPath, [audit, '--staged'], { cwd: linked, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local-private-word/);
}));

test('linked worktrees use both common private pattern files', () => fixture(({ cwd, git, commit }) => {
  commit();
  const linked = join(cwd, 'linked-patterns');
  git('worktree', 'add', '-b', 'fixture-patterns', linked, 'main');
  writeFileSync(join(cwd, '.git', 'private-patterns'), 'long-fixture-substring\n');
  writeFileSync(join(cwd, '.git', 'private-patterns-tree'), 'tree-fixture-substring\n');
  const run = (...args) => spawnSync(process.execPath, [audit, ...args], { cwd: linked, encoding: 'utf8', env: { ...process.env, ARCO_PRIVATE_PATTERNS_FILE: '' } });
  writeFileSync(join(linked, 'added.txt'), 'long-fixture-substring');
  execFileSync('git', ['add', 'added.txt'], { cwd: linked, stdio: 'pipe' });
  assert.match(run('--staged').stderr, /local-private-pattern/);
  writeFileSync(join(linked, 'added.txt'), 'tree-fixture-substring');
  execFileSync('git', ['add', 'added.txt'], { cwd: linked, stdio: 'pipe' });
  assert.match(run('--staged').stderr, /local-private-pattern/);
  assert.match(run('--tree').stderr, /local-private-pattern/);
  assert.equal(run('--history').status, 0);
}));

test('staged private word check ignores unchanged content and handles literal punctuation', () => fixture(({ cwd, git, check, commit }) => {
  commit('ZephyrFixture old line\nordinary\n');
  writeFileSync(join(cwd, '.git', 'private-words'), 'ZephyrFixture\nC++\n');
  writeFileSync(join(cwd, 'sample.txt'), 'ZephyrFixture old line\nchanged\n');
  git('add', 'sample.txt');
  assert.equal(check('--staged').status, 0, 'unchanged private words are not added by this diff');
  assert.match(check('--tree').stderr, /local-private-word/);
  writeFileSync(join(cwd, 'sample.txt'), 'clean C++ example\n');
  git('add', 'sample.txt');
  assert.match(check('--staged').stderr, /local-private-word/, 'regex metacharacters are literal');
  writeFileSync(join(cwd, 'sample.txt'), '++ZephyrFixture\n');
  git('add', 'sample.txt');
  assert.match(check('--staged').stderr, /local-private-word/, 'added text beginning with plus signs is scanned');
}));

test('staged private words are found in binary additions', () => fixture(({ cwd, git, check, commit }) => {
  commit();
  writeFileSync(join(cwd, '.git', 'private-words'), 'ZephyrFixture\n');
  writeFileSync(join(cwd, 'data.bin'), Buffer.from('prefix\0ZephyrFixture\0suffix'));
  git('add', 'data.bin');
  const result = check('--staged');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local-private-word/);
  assert.match(check('--tree').stderr, /local-private-word/);
}));

test('pre-commit hook rejects an added private word without printing it', () => fixture(({ cwd, git, commit }) => {
  commit();
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  mkdirSync(join(cwd, '.githooks'), { recursive: true });
  cpSync(audit, join(cwd, 'scripts', 'public-audit.mjs'));
  mkdirSync(join(cwd, 'shared', 'src'), { recursive: true });
  cpSync(resolve('shared/src/publicSafetyRules.ts'), join(cwd, 'shared/src/publicSafetyRules.ts'));
  cpSync(resolve('.githooks/pre-commit'), join(cwd, '.githooks', 'pre-commit'));
  git('config', 'core.hooksPath', '.githooks');
  writeFileSync(join(cwd, '.git', 'private-words'), 'ZephyrFixture\n');
  writeFileSync(join(cwd, 'sample.txt'), 'ZephyrFixture');
  mkdirSync(join(cwd, 'devlog'), { recursive: true });
  writeFileSync(join(cwd, 'devlog', `${new Date().toISOString().slice(0, 7)}.md`), 'fixture');
  git('add', 'sample.txt', 'devlog');
  const result = spawnSync('git', ['commit', '-m', 'Fixture change'], { cwd, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /local-private-word/);
  assert.ok(!result.stderr.includes('ZephyrFixture'));
}));

test('encoded personal paths, secret files and private keys fail', () => fixture(({ cwd, check }) => {
  writeFileSync(join(cwd, 'sample.txt'), [['%2Fhome', '%2Fprivate-fixture-owner', '%2Fwork'].join(''), ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')].join('\n'));
  writeFileSync(join(cwd, '.env'), 'fixture=true');
  const result = check();
  assert.equal(result.status, 1);
  for (const rule of ['personal-home-path', 'private-key', 'runtime-or-secret-file']) assert.ok(result.stderr.includes(rule));
}));
test('NUL bytes cannot hide private terms or credentials from the audit', () => fixture(({ cwd, check }) => {
  writeFileSync(join(cwd, '.git', 'private-patterns'), 'private-fixture-owner');
  const token = 'sk-' + 'a'.repeat(30);
  writeFileSync(join(cwd, 'sample.ts'), ['private-fixture-owner'.split('').join('\0'), token].join('\n'));
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local-private-pattern/);
  assert.match(result.stderr, /provider-token/);
  assert.ok(!result.stderr.includes(token));
}));
test('safe source and project identities pass; overrides and messages fail', () => fixture(({ cwd, git, check }) => {
  mkdirSync(join(cwd, 'docs'));
  writeFileSync(join(cwd, 'docs/example.txt'), '/home/operator/Projects/Example\nhttps://example.com');
  assert.equal(check().status, 0);
  assert.equal(check('--identity').status, 0);
  git('config', 'user.email', 'fixture@example.test');
  assert.equal(check('--identity').status, 1);
  writeFileSync(join(cwd, '.git', 'private-patterns'), 'private-fixture-owner');
  writeFileSync(join(cwd, 'message'), 'Change for private-fixture-owner');
  assert.equal(check('--message', join(cwd, 'message')).status, 1);
}));
test('history audit finds content removed in a later commit', () => fixture(({ cwd, git, check }) => {
  writeFileSync(join(cwd, '.git', 'private-patterns'), 'private-fixture-owner');
  writeFileSync(join(cwd, 'sample.txt'), 'private-fixture-owner');
  git('add', 'sample.txt'); git('commit', '-m', 'Initial fixture');
  writeFileSync(join(cwd, 'sample.txt'), 'clean');
  git('add', 'sample.txt'); git('commit', '-m', 'Clean fixture');
  assert.equal(check().status, 0);
  assert.equal(check('--history').status, 1);
}));
test('release history excludes unreferenced runtime checkpoints; strict diagnostic keeps them', () => fixture(({ cwd, git, check, push, commit }) => {
  const clean = commit();
  git('config', 'user.name', 'Checkpoint fixture');
  git('config', 'user.email', 'checkpoint@example.test');
  const checkpoint = commit('clean checkpoint');
  git('update-ref', 'refs/arco/fixture/1', checkpoint);
  git('reset', '--hard', clean);
  assert.equal(check('--release-history').status, 0);
  assert.match(check('--history').stderr, /project-history-identity-required/);
  assert.equal(push(update(clean)).status, 0);
  assert.match(push(update(checkpoint, 'refs/arco/fixture/1')).stderr, /non-publication-ref/);
}));
test('publication history scans runtime ancestors and content removed from the proposed tip', () => fixture(({ cwd, git, check, push, commit }) => {
  writeFileSync(join(cwd, '.git/private-patterns'), 'private-fixture-owner');
  commit();
  const checkpoint = commit('private-fixture-owner');
  git('update-ref', 'refs/arco/fixture/1', checkpoint);
  const tip = commit();
  assert.match(check('--release-history').stderr, /local-private-pattern/);
  const result = push(update(tip, 'refs/heads/main', 'refs/heads/main', checkpoint));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local-private-pattern/);
  assert.ok(!result.stderr.includes('private-fixture-owner'));
}));
test('release history includes branches, remote-tracking refs, detached HEAD and tags', () => fixture(({ cwd, git, check, commit }) => {
  writeFileSync(join(cwd, '.git/private-patterns'), 'private-fixture-owner');
  const clean = commit();
  const dirty = commit('private-fixture-owner');
  git('reset', '--hard', clean);
  for (const ref of ['refs/heads/topic', 'refs/remotes/origin/topic', 'refs/tags/fixture']) {
    git('update-ref', ref, dirty);
    assert.equal(check('--release-history').status, 1, ref);
    git('update-ref', '-d', ref);
  }
  git('checkout', '--detach', dirty);
  assert.equal(check('--release-history').status, 1);
}));
test('HEAD history scope ignores unrelated branches and scans HEAD ancestry and tags', () => fixture(({ cwd, git, check, commit }) => {
  commit();

  git('checkout', '-b', 'unrelated-capture');
  writeFileSync(join(cwd, 'unrelated.png'), 'unapproved capture');
  git('add', 'unrelated.png'); git('commit', '-m', 'Unrelated capture');
  git('checkout', 'main');
  assert.equal(check('--history').status, 1, 'the full local history scope remains strict');
  assert.equal(check('--release-history').status, 1, 'release history still includes all branch refs');
  assert.equal(check('--history-head').status, 0, 'an unrelated branch is outside the publication scope');

  git('merge', '--no-ff', 'unrelated-capture', '-m', 'Merge capture into HEAD history');
  rmSync(join(cwd, 'unrelated.png'));
  git('add', '-u'); git('commit', '-m', 'Remove capture from current tree');
  const reachable = check('--history-head');
  assert.equal(reachable.status, 1, 'a capture reachable from HEAD remains part of its history');
  assert.match(reachable.stderr, /screenshot-or-recording-file/);

  git('checkout', '-b', 'tagged-capture', 'main');
  writeFileSync(join(cwd, 'tagged.png'), 'unapproved tagged capture');
  git('add', 'tagged.png'); git('commit', '-m', 'Tagged capture');
  git('tag', 'capture-review');
  git('checkout', 'main');
  const tagged = check('--history-head');
  assert.equal(tagged.status, 1, 'tagged publication history is included');
  assert.match(tagged.stderr, /screenshot-or-recording-file/);
}));
test('HEAD history scope scans a packed branch when no tags exist', () => fixture(({ cwd, git, check, commit }) => {
  writeFileSync(join(cwd, 'sample.png'), 'unapproved capture');
  git('add', 'sample.png'); git('commit', '-m', 'Capture on main');
  git('pack-refs', '--all');
  assert.equal(existsSync(join(cwd, '.git', 'refs', 'heads', 'main')), false, 'main is packed');
  const result = check('--history-head');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /screenshot-or-recording-file/);
}));
test('push scans exact object IDs even when local ref points to a different clean commit', () => fixture(({ cwd, git, push, commit }) => {
  writeFileSync(join(cwd, '.git/private-patterns'), 'private-fixture-owner');
  const clean = commit();
  const dirty = commit('private-fixture-owner');
  git('reset', '--hard', clean);
  assert.equal(push(update(dirty)).status, 1);
  assert.equal(push(update(clean)).status, 0);
  assert.equal(push(update(clean) + update(dirty, 'HEAD', 'refs/heads/another')).status, 1);
}));
test('push rejects runtime destinations, including deletions, and malformed/missing objects', () => fixture(({ push, commit }) => {
  const tip = commit();
  assert.match(push(update(tip, 'refs/heads/main', 'refs/arco/fixture/1')).stderr, /non-publication-ref/);
  assert.match(push(update(zero, '(delete)', 'refs/arco/fixture/1', tip)).stderr, /non-publication-ref/);
  assert.equal(push(update(zero, '(delete)', 'refs/heads/old', tip)).status, 0);
  for (const input of ['bad input\n', update('f'.repeat(40)), update(zero), update(tip, '(delete)'), update(tip, 'HEAD', 'invalid-ref')]) {
    const result = push(input);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unreadable-or-invalid-audit-input/);
  }
  assert.equal(push('').status, 0);
}));
test('push hold blocks otherwise clean publication without printing its contents', () => fixture(({ cwd, push, commit }) => {
  const tip = commit();
  writeFileSync(join(cwd, '.git/public-push-hold'), 'private review details');
  const result = push(update(tip));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /historical-review-unresolved/);
  assert.ok(!result.stderr.includes('private review details'));
}));
test('annotated tags require project tagger identity and clean messages, including nested tags', () => fixture(({ cwd, git, check, push, commit }) => {
  const tip = commit();
  git('tag', '-a', 'clean', tip, '-m', 'Safe tag');
  assert.equal(check('--release-history').status, 0);
  writeFileSync(join(cwd, '.git/private-patterns'), 'private-fixture-owner');
  git('tag', '-a', 'message', tip, '-m', 'private-fixture-owner');
  const tag = git('rev-parse', 'refs/tags/message').toString().trim();
  git('tag', '-a', 'nested', tag, '-m', 'Safe outer tag');
  const nested = git('rev-parse', 'refs/tags/nested').toString().trim();
  assert.match(push(update(nested, 'refs/tags/nested', 'refs/tags/nested')).stderr, /local-private-pattern/);
  git('config', 'user.email', 'fixture@example.test');
  git('tag', '-a', 'identity', tip, '-m', 'Safe tag');
  assert.match(check('--release-history').stderr, /project-tag-identity-required/);
}));
test('tags of blobs and trees cannot hide private content', () => fixture(({ cwd, git, push, commit }) => {
  writeFileSync(join(cwd, '.git/private-patterns'), 'private-fixture-owner');
  commit('private-fixture-owner');
  for (const spec of ['HEAD:sample.txt', 'HEAD^{tree}']) {
    const oid = git('rev-parse', spec).toString().trim();
    assert.match(push(update(oid, 'HEAD', 'refs/tags/object')).stderr, /local-private-pattern/);
  }
}));
test('replacement refs cannot conceal original publication history', () => fixture(({ cwd, git, push, commit }) => {
  writeFileSync(join(cwd, '.git/private-patterns'), 'private-fixture-owner');
  const dirty = commit('private-fixture-owner');
  const clean = commit();
  git('replace', dirty, clean);
  assert.match(push(update(dirty)).stderr, /local-private-pattern/);
}));
test('shallow, grafted and missing-object history fails closed', () => fixture(({ cwd, git, check, commit }) => {
  const tip = commit();
  writeFileSync(join(cwd, '.git/shallow'), tip + '\n');
  assert.match(check('--release-history').stderr, /incomplete-shallow-history/);
  rmSync(join(cwd, '.git/shallow'));
  mkdirSync(join(cwd, '.git/info'), { recursive: true }); // custom init templates may omit info/
  writeFileSync(join(cwd, '.git/info/grafts'), tip + '\n');
  assert.match(check('--history').stderr, /incomplete-grafted-history/);
  rmSync(join(cwd, '.git/info/grafts'));
  const blob = git('rev-parse', 'HEAD:sample.txt').toString().trim();
  rmSync(join(cwd, '.git/objects', blob.slice(0, 2), blob.slice(2)));
  assert.match(check('--release-history').stderr, /unreadable-or-invalid-audit-input/);
}));
test('a malformed secondary ref cannot be silently omitted from history', () => fixture(({ cwd, check, commit }) => {
  commit();
  writeFileSync(join(cwd, '.git/refs/heads/broken'), 'not-an-object\n');
  assert.equal(check('--history').status, 1);
  assert.equal(check('--release-history').status, 1);
}));
test('generated caches fail staged and historical audits even after working-tree removal', () => fixture(({ cwd, git, check, commit }) => {
  mkdirSync(join(cwd, '__pycache__'));
  const file = '__pycache__/fixture.pyc';
  writeFileSync(join(cwd, file), Buffer.from([0, 1, 2, 3]));
  git('add', file);
  assert.match(check('--staged').stderr, /generated-cache-file/);
  commit();
  git('rm', file); git('commit', '-m', 'Remove cache');
  assert.equal(check().status, 0);
  assert.match(check('--release-history').stderr, /generated-cache-file/);
}));
test('unborn history is valid and unknown audit options fail closed', () => fixture(({ check }) => {
  assert.equal(check('--history').status, 0);
  assert.equal(check('--history-head').status, 0);
  assert.equal(check('--release-history').status, 0);
  assert.equal(check('--historry').status, 1);
  assert.equal(check('--history', '--staged').status, 1);
}));
test('installed hooks reject private staged content and commit messages before creating history', () => fixture(({ cwd, git }) => {
  mkdirSync(join(cwd, 'scripts'));
  cpSync(audit, join(cwd, 'scripts/public-audit.mjs'));
  mkdirSync(join(cwd, 'shared', 'src'), { recursive: true });
  cpSync(resolve('shared/src/publicSafetyRules.ts'), join(cwd, 'shared/src/publicSafetyRules.ts'));
  cpSync(resolve('.githooks'), join(cwd, '.githooks'), { recursive: true });
  execFileSync(process.execPath, [resolve('scripts/setup-hooks.mjs')], { cwd, stdio: 'pipe' });
  writeFileSync(join(cwd, '.git/private-patterns'), 'private-fixture-owner');
  writeFileSync(join(cwd, 'sample.txt'), 'private-fixture-owner');
  git('add', 'sample.txt');
  const commit = message => spawnSync('git', ['commit', '-m', message], { cwd, encoding: 'utf8' });
  const content = commit('Fixture');
  assert.notEqual(content.status, 0);
  assert.match(content.stderr, /local-private-pattern/);
  writeFileSync(join(cwd, 'sample.txt'), 'clean'); git('add', 'sample.txt');
  assert.match(commit('Safe fixture without devlog').stderr, /current-month-devlog-entry-required/);
  mkdirSync(join(cwd, 'devlog'));
  const archive = `devlog/${new Date().toISOString().slice(0, 7)}.md`;
  writeFileSync(join(cwd, archive), 'Fixture entry'); git('add', archive);
  const message = commit('private-fixture-owner');
  assert.notEqual(message.status, 0);
  assert.match(message.stderr, /commit-message:1: local-private-pattern/);
  assert.equal(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd }).status, 128);
  assert.equal(commit('Safe fixture').status, 0);
  assert.equal(git('log', '-1', '--format=%an <%ae> | %cn <%ce>').toString().trim(), `${projectIdentity} | ${projectIdentity}`);
  const tip = git('rev-parse', 'HEAD').toString().trim();
  const hook = input => spawnSync('sh', ['.githooks/pre-push', 'fixture-remote', 'unused'], { cwd, encoding: 'utf8', input });
  assert.equal(hook(update(tip)).status, 0);
  assert.match(hook(update(tip, 'refs/heads/main', 'refs/arco/fixture/1')).stderr, /non-publication-ref/);
  writeFileSync(join(cwd, '.git/public-push-hold'), 'Fixture hold');
  assert.match(hook(update(tip)).stderr, /historical-review-unresolved/);
}));
test('independent scanner exemptions require both the exact value and file', { skip: process.env.ARCO_TEST_GITLEAKS !== '1' }, () => {
  const config = readFileSync('.gitleaks.toml', 'utf8');
  const value = config.match(/regexes = \["\^(.*?)\$"\]/)?.[1];
  assert.ok(value);
  const fixtures = [
    { file: 'server/src/providers/gemini-native/auth.ts', value, line: token => `const CLIENT_SECRET = '${token}';` },
    { file: 'scripts/antigravity-oauth.mjs', value, line: token => `const CLIENT_SECRET = '${token}';` },
    { file: 'scripts/smoke/backup-snapshot.ts', value: 'ghp_SECRET123', line: token => `const settings = { githubToken: '${token}' };` },
    { file: 'server/src/mcp/client.ts', value: 'mutation/destruction', line: token => `// Rationale per token: ${token} verbs (write/delete/remove/drop/` },
  ];
  const directory = mkdtempSync(join(tmpdir(), 'arco-secret-scan-'));
  const image = 'ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';
  try {
    for (const fixture of fixtures) {
      for (const [name, file, token, expected] of [
        ['known-public', fixture.file, fixture.value, 0],
        ['different-value', fixture.file, fixture.value.slice(0, -1) + 'A', 1],
        ['different-file', 'other.ts', fixture.value, 1],
      ]) {
        // The prose fixture has no meaningful altered value.
        if (fixture.file.endsWith('mcp/client.ts') && name === 'different-value') continue;
        const root = join(directory, `${basename(fixture.file)}-${name}`);
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, '.gitleaks.toml'), config);
        writeFileSync(join(root, file), `${fixture.line(token)}\n`);
        const result = spawnSync('docker', ['run', '--rm', '-v', `${root}:/repo:ro`, image, 'dir', '/repo', '--config', '/repo/.gitleaks.toml', '--redact', '--no-banner'], { encoding: 'utf8' });
        // Scanner output is captured and redacted; fixture values are never logged.
        assert.equal(result.status, expected, `Independent scanner scope: ${fixture.file} ${name}`);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// All history requires the same public identity.
const useLegacy = git => { git('config', 'user.name', legacyIdentity.name); git('config', 'user.email', legacyIdentity.email); };
const identityFinding = oid => new RegExp(`^${oid.slice(0, 12)}:1: project-history-identity-required$`, 'm');
test('commits and tags refuse the former placeholder without ancestry exceptions', () => fixture(({ cwd, git, check, push, commit }) => {
  const clean = commit();
  assert.equal(check('--history').status, 0);
  git('tag', '-a', 'current', clean, '-m', 'Safe tag');
  assert.equal(check('--release-history').status, 0);
  useLegacy(git);
  const identity = check('--identity');
  assert.equal(identity.status, 1);
  assert.match(identity.stderr, /project-author-required/);
  assert.match(identity.stderr, /project-committer-required/);
  git('tag', '-a', 'legacy-tag', clean, '-m', 'Safe tag');
  assert.match(check('--release-history').stderr, /project-tag-identity-required/);
  git('tag', '-d', 'legacy-tag');
  const legacy = commit('placeholder');
  assert.match(check('--history').stderr, identityFinding(legacy));
  assert.match(push(update(legacy)).stderr, identityFinding(legacy));
  // Either field alone is enough to fail.
  git('reset', '-q', '--hard', clean);
  git('config', 'user.name', projectName); git('config', 'user.email', projectEmail);
  writeFileSync(join(cwd, 'sample.txt'), 'author only'); git('add', 'sample.txt');
  git('commit', '-q', '-m', 'Fixture', `--author=${legacyIdentity.name} <${legacyIdentity.email}>`);
  const authorOnly = git('rev-parse', 'HEAD').toString().trim();
  assert.match(push(update(authorOnly)).stderr, identityFinding(authorOnly));
}));
test('only the complete public identity is exempt from a matching local private term', () => fixture(({ cwd, git, check, push, commit }) => {
  writeFileSync(join(cwd, '.git/private-patterns'), `${projectName}\n`);
  writeFileSync(join(cwd, 'sample.txt'), `Commits use ${projectIdentity}.`);
  assert.equal(check().status, 0);
  assert.equal(check('--identity').status, 0);
  const tip = commit(`Commits use ${projectIdentity}.`);
  assert.equal(check('--history').status, 0);
  assert.equal(push(update(tip)).status, 0);
  for (const text of [`Contact ${projectName}.`, `Mail ${projectEmail}.`, `/srv/${projectName}/work`, `${projectName}  <${projectEmail}>`]) {
    writeFileSync(join(cwd, 'sample.txt'), `First line\n${text}`);
    assert.match(check().stderr, /^sample\.txt:2: local-private-pattern$/m, 'Only the exact identity is exempt');
  }
  writeFileSync(join(cwd, 'message'), `Thanks ${projectName}`);
  assert.match(check('--message', join(cwd, 'message')).stderr, /commit-message:1: local-private-pattern/);
  git('config', 'user.name', `${projectName} fixture`);
  const variant = commit('clean variant');
  const result = push(update(variant));
  assert.match(result.stderr, identityFinding(variant));
  assert.match(result.stderr, new RegExp(`^${variant.slice(0, 12)}:metadata:\\d+: local-private-pattern$`, 'm'));
}));

test('explicit tree mode scans working files and cannot combine scopes', () => fixture(({ cwd, git, check }) => {
  writeFileSync(join(cwd, 'sample.txt'), 'clean'); git('add', 'sample.txt');
  writeFileSync(join(cwd, '.git/private-patterns'), 'private-fixture-owner');
  writeFileSync(join(cwd, 'sample.txt'), 'private-fixture-owner');
  assert.equal(check('--staged').status, 0);
  assert.match(check('--tree').stderr, /local-private-pattern/);
  assert.equal(check('--tree', '--staged').status, 1);
}));
test('attribution trailers are rejected even with the public identity', () => fixture(({ cwd, check }) => {
  const path = join(cwd, '.git/message');
  for (const trailer of ['Co-Authored-By', 'Signed-off-by', 'Generated-by', 'Assisted-by']) {
    writeFileSync(path, `Fixture\n\n${trailer}: ${projectIdentity}\n`);
    assert.match(check('--message', path).stderr, /attribution-trailer-forbidden/);
  }
  writeFileSync(path, 'Fixture change');
  assert.equal(check('--message', path).status, 0);
}));
test('source additions and deletions require an updated current UTC devlog archive', () => fixture(({ cwd, git, check, commit }) => {
  commit();
  const archive = `devlog/${new Date().toISOString().slice(0, 7)}.md`;
  git('rm', 'sample.txt');
  assert.match(check('--devlog').stderr, new RegExp(archive.replace('.', '\\.') + ':1: current-month-devlog-entry-required'));
  mkdirSync(join(cwd, 'devlog'));
  writeFileSync(join(cwd, 'devlog/2000-01.md'), 'Old entry'); git('add', 'devlog');
  assert.equal(check('--devlog').status, 1);
  writeFileSync(join(cwd, archive), 'Current entry'); git('add', archive);
  assert.equal(check('--devlog').status, 0);
  git('commit', '-m', 'Fixture deletion');
  git('rm', archive);
  assert.equal(check('--devlog').status, 0, 'Devlog-only corrections pass');
  writeFileSync(join(cwd, 'sample.txt'), 'new source'); git('add', 'sample.txt');
  assert.equal(check('--devlog').status, 1, 'Deleting the archive cannot satisfy a source change');
}));
test('devlog-only and index-only corrections pass without a monthly entry', () => fixture(({ cwd, git, check }) => {
  writeFileSync(join(cwd, 'DEVLOG.md'), 'Index correction'); git('add', 'DEVLOG.md');
  assert.equal(check('--devlog').status, 0);
  mkdirSync(join(cwd, 'devlog'));
  writeFileSync(join(cwd, 'devlog/2000-01.md'), 'Correction'); git('add', 'devlog');
  assert.equal(check('--devlog').status, 0);
}));

test('unapproved email, media and runtime files fail with synthetic exceptions scoped', () => fixture(({ cwd, git, check }) => {
  const privateAddress = 'private-owner' + '@' + 'private-mail.net';
  writeFileSync(join(cwd, 'sample.txt'), privateAddress);
  writeFileSync(join(cwd, 'capture.png'), 'fixture');
  mkdirSync(join(cwd, '.arco'));
  writeFileSync(join(cwd, '.arco/settings.json'), '{}');
  git('add', '--force', '.arco/settings.json');
  const result = check('--tree');
  for (const rule of ['unapproved-email-address', 'screenshot-or-recording-file', 'local-runtime-state']) assert.ok(result.stderr.includes(rule));
  assert.ok(!result.stderr.includes(privateAddress));
  rmSync(join(cwd, 'capture.png')); git('rm', '--cached', '-f', '.arco/settings.json'); rmSync(join(cwd, '.arco'), {recursive: true});
  writeFileSync(join(cwd, 'sample.txt'), [projectEmail, 'git@github.com', 'checkpoint@arco.local', 'fixture@example.test', 'fake@arco.invalid', 'strata@fixture.service'].join('\n'));
  assert.equal(check('--tree').status, 0);
  mkdirSync(join(cwd, 'server/src/voice'), {recursive: true});
  writeFileSync(join(cwd, 'server/src/voice/capture-ready.wav'), 'fixture');
  assert.equal(check('--tree').status, 0, 'Shipped UI sound is allowed');
}));

test('README screenshot exception accepts reviewed bytes only', () => fixture(({ cwd, git, check }) => {
  mkdirSync(join(cwd, 'docs/images'), { recursive: true });
  for (const name of ['home.webp', 'cluster.webp']) {
    const target = join(cwd, 'docs/images', name);
    cpSync(resolve('docs/images', name), target);
    assert.equal(check('--tree').status, 0, name);
    git('add', 'docs/images/' + name);
    assert.equal(check('--staged').status, 0, name);
    writeFileSync(target, 'unreviewed replacement');
    const result = check('--tree');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /screenshot-or-recording-file/);
    git('add', 'docs/images/' + name);
    assert.match(check('--staged').stderr, /screenshot-or-recording-file/);
    git('rm', '--cached', 'docs/images/' + name);
    rmSync(target);
  }
}));

// Assembled so this test file carries no occurrence of the upstream name.
const upstreamLetters = ['a', 'r', 'c', 'h', 'o', 'n'];
test('tree and staged scans reject the upstream name, plain or letter-separated; history scans do not', () => fixture(({ cwd, git, check }) => {
  const spellings = [upstreamLetters.join(''), upstreamLetters.join(' ').toUpperCase(), upstreamLetters.join('.'), upstreamLetters.join('-')];
  for (const spelling of spellings) {
    writeFileSync(join(cwd, 'banner.txt'), `|  ${spelling}  v1 |`);
    git('add', 'banner.txt');
    for (const scope of ['--tree', '--staged']) {
      const result = check(scope);
      assert.equal(result.status, 1, `${scope} must reject ${spelling.length}-char spelling`);
      assert.match(result.stderr, /banner\.txt:1: upstream-name/);
      assert.ok(!result.stderr.toLowerCase().includes(spelling.toLowerCase()));
    }
  }
  // Ordinary words that merely contain the letters in sequence stay allowed.
  writeFileSync(join(cwd, 'banner.txt'), 'march on, monarchs, patriarchs, ARCO_HOME');
  git('add', 'banner.txt');
  assert.equal(check('--tree').status, 0);
  assert.equal(check('--staged').status, 0);
  // Committed history keeps the plain name legitimately.
  writeFileSync(join(cwd, 'banner.txt'), upstreamLetters.join(''));
  git('add', 'banner.txt'); git('commit', '-m', 'Fixture');
  assert.equal(check('--history').status, 0);
  assert.equal(check('--history-head').status, 0);
}));

test('tracked agent instruction files and directories are rejected', () => fixture(({ cwd, git, check }) => {
  mkdirSync(join(cwd, '.cursor'));
  for (const name of ['AGENTS.md', 'sub/CLAUDE.md', '.cursor/rules.txt']) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true });
    writeFileSync(join(cwd, name), 'local notes');
  }
  git('add', '-f', 'AGENTS.md', 'sub/CLAUDE.md', '.cursor/rules.txt');
  const staged = check('--staged');
  assert.equal(staged.status, 1);
  assert.equal((staged.stderr.match(/agent-instruction-file/g) || []).length, 3);
  git('commit', '-m', 'Fixture');
  const history = check('--history');
  assert.equal(history.status, 1);
  assert.match(history.stderr, /agent-instruction-file/);
}));
test('untracked agent instruction files are not reported when ignored', () => fixture(({ cwd, git, check, commit }) => {
  writeFileSync(join(cwd, '.gitignore'), 'AGENTS.md\n');
  writeFileSync(join(cwd, 'AGENTS.md'), 'local notes');
  commit();
  assert.equal(check('--tree').status, 0);
}));
test('typographic punctuation is rejected in added Markdown lines and messages only', () => fixture(({ cwd, git, check }) => {
  const mark = String.fromCharCode(0x2014);
  writeFileSync(join(cwd, 'old.md'), `legacy ${mark} line\n`);
  writeFileSync(join(cwd, 'code.ts'), `// note ${mark} here\n`);
  git('add', 'old.md', 'code.ts'); git('commit', '-m', 'Fixture');
  writeFileSync(join(cwd, 'old.md'), `legacy ${mark} line\nplain ascii\n`);
  git('add', 'old.md');
  assert.equal(check('--staged').status, 0);
  writeFileSync(join(cwd, 'old.md'), `legacy ${mark} line\nplain ascii\nbad ${String.fromCharCode(0x201C)}quote${String.fromCharCode(0x201D)}\n`);
  git('add', 'old.md');
  const bad = check('--staged');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /old\.md:3: typographic-punctuation/);
  writeFileSync(join(cwd, 'code.ts'), `// changed ${mark} here\n`);
  git('add', 'code.ts'); git('reset', '-q', 'old.md');
  assert.equal(check('--staged').status, 0);
  writeFileSync(join(cwd, 'msg'), `Subject ${mark} text\n`);
  const message = check('--message', 'msg');
  assert.equal(message.status, 1);
  assert.match(message.stderr, /commit-message:1: typographic-punctuation/);
  writeFileSync(join(cwd, 'msg'), 'Subject text\n');
  assert.equal(check('--message', 'msg').status, 0);
}));

const stateDir = '.' + ['arc', 'hon'].join('');
test('a tracked upstream state directory is rejected in staged and history scopes', () => fixture(({ cwd, git, check }) => {
  mkdirSync(join(cwd, 'pkg', stateDir), { recursive: true });
  writeFileSync(join(cwd, 'pkg', stateDir, 'notes.txt'), 'local');
  git('add', '-f', 'pkg');
  const staged = check('--staged');
  assert.equal(staged.status, 1);
  assert.match(staged.stderr, /upstream-state-directory/);
  git('commit', '-m', 'Fixture');
  const history = check('--history');
  assert.equal(history.status, 1);
  assert.match(history.stderr, /upstream-state-directory/);
}));
test('an ignored untracked upstream state directory passes', () => fixture(({ cwd, git, check, commit }) => {
  mkdirSync(join(cwd, '.git', 'info'), { recursive: true });
  writeFileSync(join(cwd, '.git', 'info', 'exclude'), `${stateDir}/\n`);
  mkdirSync(join(cwd, stateDir));
  writeFileSync(join(cwd, stateDir, 'notes.txt'), 'local');
  commit();
  assert.equal(check('--tree').status, 0);
}));
