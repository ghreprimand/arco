#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bumpVersion, initialChangelog, extractSection, rollChangelog, rewriteManifest, rewriteLockfile } from './release/helpers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const identity = { name: 'ghreprimand', email: '203024559+ghreprimand@users.noreply.github.com' };
const env = { ...process.env, GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email };
function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `git ${args[0]} failed.`);
  return result.stdout?.trim() ?? '';
}
const read = path => readFileSync(join(root, path), 'utf8');

try {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter(arg => arg !== '--dry-run');
  if (positional.length !== 1 || args.filter(arg => arg === '--dry-run').length > 1) throw new Error('Usage: node scripts/release.mjs <patch|minor|major|X.Y.Z> [--dry-run]');
  if (git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('Release requires a clean working tree, including untracked files.');
  if (git(['branch', '--show-current']) !== 'main') throw new Error('Release requires branch main.');
  if (git(['rev-parse', 'HEAD']) !== git(['rev-parse', 'refs/remotes/origin/main'])) throw new Error('Release requires main to equal origin/main; fetch and synchronize first.');

  const current = JSON.parse(read('package.json')).version;
  const manifests = ['package.json', 'shared/package.json', 'server/package.json', 'client/package.json'];
  if (manifests.some(path => JSON.parse(read(path)).version !== current)) throw new Error('All four package versions must match before release.');
  const initial = current === '0.1.0' && positional[0] === current && git(['tag', '--list', 'v*']) === '';
  const version = initial ? current : bumpVersion(current, positional[0]);
  const tag = `v${version}`;
  if (spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], { cwd: root }).status === 0) throw new Error(`Tag ${tag} already exists.`);
  const date = new Date().toISOString().slice(0, 10);
  const edits = new Map(manifests.map(path => [path, rewriteManifest(read(path), version)]));
  edits.set('package-lock.json', rewriteLockfile(read('package-lock.json'), version));
  const changelog = initial ? initialChangelog(read('CHANGELOG.md'), current, positional[0]) : rollChangelog(read('CHANGELOG.md'), version, date);
  edits.set('CHANGELOG.md', changelog);
  const section = extractSection(changelog, tag);
  const archive = `devlog/${date.slice(0, 7)}.md`;
  const stub = `## ${date} -- Release ${tag}\n\nRELEASE_ENTRY_REQUIRED: Complete this entry before the release commit. Describe the user-visible changes, the release controls and files, the checks actually run and their results, failures and resolutions, and remaining limitations.\n\n${section.replace(/^## .+\n/, '')}\n---\n\n`;
  edits.set(archive, stub + (existsSync(join(root, archive)) ? read(archive) : ''));
  const index = read('DEVLOG.md');
  if (!index.includes(`devlog/${date.slice(0, 7)}.md`)) {
    const line = `- [${date.slice(0, 7)}](${archive})\n`;
    const firstArchive = index.search(/^- .*devlog\//m);
    if (firstArchive < 0) throw new Error('DEVLOG.md has no archive index to extend.');
    edits.set('DEVLOG.md', index.slice(0, firstArchive) + line + index.slice(firstArchive));
  }

  const scratch = mkdtempSync(join(tmpdir(), 'arco-release-'));
  try {
    console.log(`Release ${current} -> ${version}; annotated tag ${tag}.`);
    for (const [path, content] of edits) {
      const before = join(scratch, 'before'), after = join(scratch, 'after');
      writeFileSync(before, existsSync(join(root, path)) ? read(path) : '');
      writeFileSync(after, content);
      const diff = spawnSync('git', ['diff', '--no-index', '--no-color', '--', before, after], { encoding: 'utf8' });
      if (diff.error || ![0, 1].includes(diff.status)) throw diff.error || new Error('Could not render release diff.');
      console.log(`\nPlanned edit: ${path}\n${diff.stdout.split('\n').slice(4).join('\n')}`);
    }
    console.log(`\nTag message and GitHub release body:\n${section}`);
    console.log('The release devlog entry must be completed in the editor before committing.');
    console.log(`After review, push explicitly: git push origin main ${tag}`);
    if (!dryRun) {
      for (const [path, content] of edits) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
      }
      const editor = git(['var', 'GIT_EDITOR']);
      const edit = spawnSync(editor, [archive], { cwd: root, env, shell: true, stdio: 'inherit' });
      if (edit.error || edit.status !== 0) throw edit.error || new Error('Release entry editor failed; changes remain available for review.');
      if (read(archive).includes('RELEASE_ENTRY_REQUIRED')) throw new Error('Complete the release devlog entry before committing; planned edits remain available for review.');
      git(['add', '--', ...edits.keys()]);
      git(['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, '-c', 'commit.gpgsign=false', 'commit', '-m', `Release ${tag}`], { stdio: 'inherit' });
      const message = join(scratch, 'tag-message');
      writeFileSync(message, section);
      git(['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, '-c', 'tag.gpgsign=false', 'tag', '-a', tag, '--cleanup=verbatim', '-F', message]);
      console.log(`Created Release ${tag} and annotated tag ${tag}. Nothing was pushed.`);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
