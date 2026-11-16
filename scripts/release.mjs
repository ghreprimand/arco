#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bumpVersion, initialChangelog, extractSection, rollChangelog, rewriteManifest, rewriteLockfile, relinkForDevlog } from './release/helpers.mjs';

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
const usage = 'Usage: node scripts/release.mjs <patch|minor|major|X.Y.Z> (--entry-file <file> | --edit-entry) [--dry-run]';
function entryCount(body) {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  console.log(`Release entry: ${words} words; expected 150-300.`);
  if (words < 150 || words > 300) console.warn('WARNING: Release entry is outside 150-300 words. Review its length; this warning does not prevent release.');
}
function configValue(key) {
  return spawnSync('git', ['config', '--get', key], { cwd: root, encoding: 'utf8' }).stdout?.trim() || '(unset)';
}
let completed = 'No tracked release files were changed.';

try {
  const args = process.argv.slice(2);
  let dryRun = false, editEntry = false, entryFile, requested;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run' && !dryRun) dryRun = true;
    else if (arg === '--edit-entry' && !editEntry) editEntry = true;
    else if (arg === '--entry-file' && entryFile === undefined && args[i + 1] && !args[i + 1].startsWith('--')) entryFile = args[++i];
    else if (!arg.startsWith('-') && requested === undefined) requested = arg;
    else throw new Error(usage);
  }
  if (!requested || (entryFile !== undefined) === editEntry) throw new Error(usage);
  let entryBody;
  if (entryFile !== undefined) {
    try { entryBody = readFileSync(resolve(process.cwd(), entryFile), 'utf8').trim(); }
    catch (error) { throw new Error(`Cannot read release entry file: ${error.message}\nPass a readable UTF-8 entry body with --entry-file <file>.`); }
    if (!entryBody || entryBody.includes('RELEASE_ENTRY_REQUIRED')) throw new Error('Complete the release devlog entry in the input file before retrying. No release files were changed.');
    entryCount(entryBody);
  }
  const configuredIdentity = `${configValue('user.name')} <${configValue('user.email')}>`;
  console.log(`Commit/tag identity: ${identity.name} <${identity.email}>; configured identity: ${configuredIdentity}.`);
  const hooks = configValue('core.hooksPath');
  console.log(`Hooks: ${hooks}.`);
  if (hooks !== '.githooks' || !existsSync(join(root, '.githooks/pre-commit'))) console.warn('WARNING: Project hooks are not active. Run npm run setup:hooks before releasing.');
  const status = git(['status', '--porcelain', '--untracked-files=all']);
  if (status) throw new Error(`Release requires a clean working tree, including untracked files.\n${status}\nCommit the reviewed work or remove the unwanted files, then retry.`);
  if (git(['branch', '--show-current']) !== 'main') throw new Error('Release requires branch main. After release approval, switch to clean main, fast-forward it to the green release branch and push main first.');
  let upstream;
  try { upstream = git(['rev-parse', '--verify', 'refs/remotes/origin/main']); }
  catch { throw new Error('Release requires origin/main. Run git fetch origin main, review the approved release commit, synchronize main and push main first.'); }
  if (git(['rev-parse', 'HEAD']) !== upstream) throw new Error('Release requires main to equal origin/main; fetch and synchronize first. Run git fetch origin main, review the difference, fast-forward main to the approved commit and push main before retrying.');
  console.log('main matches the locally fetched origin/main. Confirm the final hosted run and operator approval before release; this command does not fetch or query hosted checks.');

  const current = JSON.parse(read('package.json')).version;
  const manifests = ['package.json', 'shared/package.json', 'server/package.json', 'client/package.json'];
  if (manifests.some(path => JSON.parse(read(path)).version !== current)) throw new Error('All four package versions must match before release. Repair package.json, shared/package.json, server/package.json and client/package.json, commit the correction and synchronize main first.');
  const lock = JSON.parse(read('package-lock.json'));
  const lockConsistent = lock.version === current && ['', 'shared', 'server', 'client'].every(key => lock.packages?.[key]?.version === current);
  console.log(`Lockfile workspace versions: ${lockConsistent ? 'match manifests' : 'WARNING: differ from manifests; review package-lock.json before release'}.`);
  const initial = current === '0.1.0' && requested === current && git(['tag', '--list', 'v*']) === '';
  let version;
  try { version = initial ? current : bumpVersion(current, requested); }
  catch (error) { throw new Error(`${error.message}\nChoose patch, minor, major or an explicit newer X.Y.Z.`); }
  const tag = `v${version}`;
  if (spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], { cwd: root }).status === 0) throw new Error(`Tag ${tag} already exists. Inspect it with git show ${tag}; select a newer version rather than replacing a published tag.`);
  const date = new Date().toISOString().slice(0, 10);
  const edits = new Map(manifests.map(path => [path, rewriteManifest(read(path), version)]));
  edits.set('package-lock.json', rewriteLockfile(read('package-lock.json'), version));
  let changelog;
  try { changelog = initial ? initialChangelog(read('CHANGELOG.md'), current, requested) : rollChangelog(read('CHANGELOG.md'), version, date); }
  catch (error) { throw new Error(`${error.message}\nRepair the Unreleased section in CHANGELOG.md, commit the reviewed notes and synchronize main before retrying.`); }
  edits.set('CHANGELOG.md', changelog);
  const section = extractSection(changelog, tag);
  const archive = `devlog/${date.slice(0, 7)}.md`;
  const body = entryBody ?? `RELEASE_ENTRY_REQUIRED: Complete this entry before the release commit. Describe the user-visible changes, the release controls and files, the checks actually run and their results, failures and resolutions, and remaining limitations.\n\n${relinkForDevlog(section.replace(/^## .+\n/, ''))}`;
  const stub = `## ${date} -- Release ${tag}\n\n${body.trim()}\n\n---\n\n`;
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
    console.log(entryFile === undefined ? 'Interactive entry mode: complete the devlog in the editor before committing.' : 'File entry mode: the entry above is used; no editor is opened.');
    console.log(`After the local release commit and tag exist (run only with release approval):\n1. Read the full release commit: git show HEAD\n2. Read the tag: git show ${tag}\n3. Push explicitly after review: git push origin main ${tag}\n4. Inspect the release workflow; approve the staged npm package separately.\n5. Check the installed update, then delete release/${version} after confirming it is an ancestor of main.\n6. Replace NEXT_VERSION with the next agreed version, then create its branch: git switch -c release/NEXT_VERSION main\n7. Push that branch explicitly: git push --set-upstream origin release/NEXT_VERSION`);
    if (!dryRun) {
      completed = 'Release files may be partly written. Review the tree and index; no release commit or tag was created.';
      for (const [path, content] of edits) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
      }
      completed = 'Release files were written. Review the tree and index; no release commit or tag was created.';
      if (editEntry) {
        const editor = git(['var', 'GIT_EDITOR']);
        const edit = spawnSync(editor, [archive], { cwd: root, env, shell: true, stdio: 'inherit' });
        if (edit.error || edit.status !== 0) throw edit.error || new Error('Release entry editor failed; changes remain available for review.');
        const newest = read(archive).slice(stub.indexOf('\n\n') + 2).split(/^---\s*$/m)[0];
        entryCount(newest);
      }
      if (read(archive).includes('RELEASE_ENTRY_REQUIRED')) throw new Error('Complete the release devlog entry before committing; planned edits remain available for review.');
      git(['add', '--', ...edits.keys()]);
      git(['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, '-c', 'commit.gpgsign=false', 'commit', '-m', `Release ${tag}`], { stdio: 'inherit' });
      completed = 'The release commit was created locally. The annotated tag was not created; nothing was pushed.';
      const message = join(scratch, 'tag-message');
      writeFileSync(message, section);
      git(['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, '-c', 'tag.gpgsign=false', 'tag', '-a', tag, '--cleanup=verbatim', '-F', message]);
      console.log(`Created Release ${tag} and annotated tag ${tag}. Nothing was pushed.`);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
} catch (error) {
  console.error(error.message);
  console.error(completed);
  process.exitCode = 1;
}
