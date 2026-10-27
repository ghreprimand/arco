import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { extractSection } from './helpers.mjs';

const source = dirname(fileURLToPath(import.meta.url));
function fixture() {
  const sandbox = mkdtempSync(join(tmpdir(), 'arco-release-test-'));
  const root = join(sandbox, 'checkout');
  mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'ghreprimand');
  git('config', 'user.email', '203024559+ghreprimand@users.noreply.github.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', join(sandbox, 'no-hooks'));
  mkdirSync(join(root, 'scripts'));
  cpSync(source, join(root, 'scripts/release'), { recursive: true });
  cpSync(join(source, '../release.mjs'), join(root, 'scripts/release.mjs'));
  for (const directory of ['', 'shared', 'server', 'client']) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, 'package.json'), JSON.stringify({ name: directory || 'arco', version: '0.1.0' }, null, 2) + '\n');
  }
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version: '0.1.0', packages: Object.fromEntries(['', 'shared', 'server', 'client'].map(key => [key, { version: '0.1.0' }])) }, null, 2) + '\n');
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n### Fixed\n\n- Preserve saved work.\n\n## v0.1.0 - 2026-10-27\n\n### Added\n\n- Initial workbench.\n');
  mkdirSync(join(root, 'devlog'));
  const archive = `devlog/${new Date().toISOString().slice(0, 7)}.md`;
  writeFileSync(join(root, archive), '# Earlier entries\n');
  writeFileSync(join(root, 'DEVLOG.md'), `# Development log\n\n- [Current archive](${archive})\n`);
  git('add', '.'); git('commit', '-m', 'Fixture base');
  const remote = join(sandbox, 'origin.git');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  git('remote', 'add', 'origin', remote); git('push', '-u', 'origin', 'main');
  const editor = join(sandbox, 'editor.mjs');
  writeFileSync(editor, "import { readFileSync, writeFileSync } from 'node:fs'; const path = process.argv[2]; writeFileSync(path, readFileSync(path, 'utf8').replace(/RELEASE_ENTRY_REQUIRED:.*\\n/, 'The release preserves saved work. Verified using fixture gates; no provider calls were made.\\n'));\n");
  const run = (...args) => spawnSync(process.execPath, ['scripts/release.mjs', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: `"${process.execPath}" "${editor}"` } });
  return { root, remote, git, run, archive, close: () => rmSync(sandbox, { recursive: true, force: true }) };
}

test('dry-run is read-only; a real release commits matching versions and an annotated tag without pushing', () => {
  const f = fixture();
  try {
    const before = f.git('rev-parse', 'HEAD');
    const preview = f.run('patch', '--dry-run');
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /Planned edit: package-lock.json/);
    assert.match(preview.stdout, /Release 0.1.0 -> 0.1.1/);
    assert.match(preview.stdout, /RELEASE_ENTRY_REQUIRED/);
    assert.equal(f.git('status', '--porcelain'), '');
    assert.equal(f.git('rev-parse', 'HEAD'), before);
    const result = f.run('patch');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.git('log', '-1', '--format=%s'), 'Release v0.1.1');
    assert.equal(f.git('log', '-1', '--format=%an <%ae>%n%cn <%ce>'), Array(2).fill('ghreprimand <203024559+ghreprimand@users.noreply.github.com>').join('\n'));
    assert.equal(f.git('cat-file', '-t', 'v0.1.1'), 'tag');
    assert.equal(f.git('rev-parse', 'v0.1.1^{}'), f.git('rev-parse', 'HEAD'));
    assert.equal(f.git('for-each-ref', 'refs/tags/v0.1.1', '--format=%(contents)').trim(), extractSection(readFileSync(join(f.root, 'CHANGELOG.md'), 'utf8'), 'v0.1.1').trim());
    for (const directory of ['', 'shared', 'server', 'client']) assert.equal(JSON.parse(readFileSync(join(f.root, directory, 'package.json'), 'utf8')).version, '0.1.1');
    assert.equal(f.git('status', '--porcelain'), '');
    assert.equal(execFileSync('git', ['--git-dir', f.remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), before);
    assert.equal(execFileSync('git', ['--git-dir', f.remote, 'tag', '--list'], { encoding: 'utf8' }).trim(), '');
  } finally { f.close(); }
});

test('release refuses dirty trees, other branches, divergence, empty notes and existing tags', () => {
  const f = fixture();
  try {
    const base = f.git('rev-parse', 'HEAD');
    writeFileSync(join(f.root, 'untracked.txt'), 'untracked');
    assert.match(f.run('patch', '--dry-run').stderr, /clean working tree/);
    rmSync(join(f.root, 'untracked.txt'));
    f.git('switch', '-c', 'feature');
    assert.match(f.run('patch', '--dry-run').stderr, /branch main/);
    f.git('switch', 'main');
    f.git('commit', '--allow-empty', '-m', 'Ahead');
    assert.match(f.run('patch', '--dry-run').stderr, /equal origin\/main/);
    f.git('push', 'origin', 'main');
    f.git('reset', '--hard', base);
    assert.match(f.run('patch', '--dry-run').stderr, /equal origin\/main/);
    f.git('fetch', 'origin');
    f.git('reset', '--hard', 'origin/main');
    f.git('tag', 'v0.1.1');
    assert.match(f.run('patch', '--dry-run').stderr, /already exists/);
    f.git('tag', '-d', 'v0.1.1');
    const path = join(f.root, 'CHANGELOG.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('- Preserve saved work.', ''));
    f.git('add', '.'); f.git('commit', '-m', 'Empty notes'); f.git('push', 'origin', 'main');
    assert.match(f.run('patch', '--dry-run').stderr, /Unreleased is empty/);
    assert.equal(f.git('status', '--porcelain'), '');
  } finally { f.close(); }
});

test('an unfinished devlog entry prevents the release commit and tag', () => {
  const f = fixture();
  try {
    f.git('config', 'core.editor', 'unused');
    // An editor that exits successfully without changing the entry.
    const result = spawnSync(process.execPath, ['scripts/release.mjs', 'patch'], { cwd: f.root, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: `"${process.execPath}" -e "process.exit(0)" --` } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Complete the release devlog/);
    assert.equal(f.git('log', '-1', '--format=%s'), 'Fixture base');
    assert.equal(f.git('tag', '--list'), '');
    assert.notEqual(f.git('status', '--porcelain'), '');
  } finally { f.close(); }
});


test('a release in a new month creates the archive and prepends its index entry', () => {
  const f = fixture();
  try {
    rmSync(join(f.root, f.archive));
    writeFileSync(join(f.root, 'DEVLOG.md'), '# Development log\n\n- [Earlier archive](devlog/2000-01.md)\n');
    writeFileSync(join(f.root, 'devlog/2000-01.md'), '# Earlier entries\n');
    f.git('add', '.'); f.git('commit', '-m', 'Earlier archive'); f.git('push', 'origin', 'main');
    const result = f.run('minor');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(readFileSync(join(f.root, 'DEVLOG.md'), 'utf8').indexOf(f.archive) < readFileSync(join(f.root, 'DEVLOG.md'), 'utf8').indexOf('devlog/2000-01.md'));
    assert.match(readFileSync(join(f.root, f.archive), 'utf8'), /Release v0.2.0/);
    assert.equal(f.git('status', '--porcelain'), '');
  } finally { f.close(); }
});


test('the untagged seeded 0.1.0 release can be cut without a version bump', () => {
  const f = fixture();
  try {
    const path = join(f.root, 'CHANGELOG.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('### Fixed\n\n- Preserve saved work.\n\n', ''));
    f.git('add', '.'); f.git('commit', '-m', 'Seed initial notes'); f.git('push', 'origin', 'main');
    const result = f.run('0.1.0');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.git('log', '-1', '--format=%s'), 'Release v0.1.0');
    assert.equal(f.git('cat-file', '-t', 'v0.1.0'), 'tag');
    assert.equal(JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8')).version, '0.1.0');
  } finally { f.close(); }
});
