#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { publicSafetyRules as rules } from '../shared/src/publicSafetyRules.ts';

const args = new Set(process.argv.slice(2));
const packageAt = process.argv.indexOf('--package');
const packageRoot = packageAt >= 0 && process.argv[packageAt + 1] ? resolve(process.argv[packageAt + 1]) : null;
// Replacement objects must never conceal the objects Git will publish.
const runGit = (argv, input) => {
  const result = spawnSync('git', argv, {
    input, maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  });
  // for-each-ref can warn and skip a malformed ref while exiting successfully.
  // An incomplete inventory must never count as an audit pass.
  if (result.status !== 0 || result.error || result.stderr.length) throw new Error('Git audit read failed');
  return result.stdout;
};
const git = (...argv) => runGit(argv);
const findings = new Set();
// Reports deliberately contain locations and rule names only, never values.
const report = (file, line, rule) => findings.add(`${file}:${line}: ${rule}`);
try {
const root = git('rev-parse', '--show-toplevel').toString().trim();
process.chdir(root);
const commonGitDir = resolve(root, git('rev-parse', '--git-common-dir').toString().trim());
const patternsFile = process.env.ARCO_PRIVATE_PATTERNS_FILE || join(commonGitDir, 'private-patterns');
const readPatterns = file => existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(s => s && !s.startsWith('#')) : [];
const privatePatterns = readPatterns(patternsFile);
// Optional current-content patterns are excluded from history and push audits.
const treeScope = ['--tree', '--staged', '--package'].some(flag => args.has(flag)) || process.argv.length === 2;
const treePatterns = treeScope ? readPatterns(join(commonGitDir, 'private-patterns-tree')) : [];
// Optional local word list is shared by linked worktrees. It is never tracked,
// echoed, or applied to historical objects. Empty or absent files are a no-op.
const privateWords = readPatterns(join(commonGitDir, 'private-words'));
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const privateWordPattern = privateWords.length
  ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${privateWords.map(escapeRegex).join('|')})(?![\\p{L}\\p{N}_])`, 'iu')
  : null;
const privateWordTree = args.has('--tree') || (process.argv.length === 2);
function inspectPrivateWords(label, value, line = 1) {
  if (!privateWordPattern) return;
  const decoded = value.toString().replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .toLowerCase().replaceAll(expected.toLowerCase(), ' '.repeat(expected.length));
  const compact = decoded.replaceAll('\0', '');
  const match = privateWordPattern.exec(decoded) ?? privateWordPattern.exec(compact);
  if (match) report(label, line + decoded.slice(0, match.index).split('\n').length - 1, 'local-private-word');
}
const split = buffer => buffer.toString().split('\0').filter(Boolean);
// Required author, committer and tagger for new history: the maintainer's
// public GitHub no-reply identity. There is no environment or configuration
// override.
const expected = 'ghreprimand <203024559+ghreprimand@users.noreply.github.com>';
const safeUsers = new Set(['operator', 'example', 'user', 'username', 'u', 'op', 'root', 'nobody', 'glob', 'real', 'test', 'runner', 'node']);
// Public protocol endpoints and synthetic addresses used by retained Arco
// parsing and checkpoint behavior. Reserved test domains never deliver mail.
const publicAddresses = new Set([
  '203024559+ghreprimand@users.noreply.github.com',
  'git@github.com', // Git SSH endpoint, not a personal mailbox.
  'a@b.com', // Literal reference-parser example, not an operator identity.
  'checkpoint@arco.local', 'test@arco.local', // Internal fixture identities.
  // The same identities under the upstream name, present in commits before
  // the rename; the push audit scans full ancestry. Assembled from parts so
  // the tree carries no occurrence of the upstream name.
  ...['checkpoint', 'test'].map((user) => `${user}@${['arc', 'hon'].join('')}.local`),
]);
// Two reviewed minifier identifiers resemble email addresses. Their exact
// token hashes apply only to packaged client entry bundles; unrelated changes
// to a bundle must not require an exception for the whole artifact.
const reviewedClientEmails = new Set([
  '9a0c7d2a96e74ab5dd391f3ca70560cfb9493075f869c4b6aa63c2dcee3ee339',
  'ec4203bbae12e1f2c3f60055ab37164bf3f0fae672a32a69403a866a321690f6',
]);
// SQLite 12.9.0 Windows x64 has an email-like byte sequence in .text. Both
// the binary and the token remain pinned to their individually reviewed hashes.
const reviewedSqliteArtifact = '9253f70cab8a046f1bc9fa58650fd03089f7ef67bdf44b55a39692e4decc917d';
// SQLite 13.0.3's scrubbed Windows x64 prebuild contains the same reviewed
// email-like instruction bytes in .text; the new artifact is separately pinned.
const reviewedSqliteNapiArtifact = 'c4f93917c9791af6bf6dbd30a7eae0877840f1a776b2ab140691afd5f52f16b4';
const reviewedSqliteEmails = new Set(['2657a6941a3c36e66b21e528b3f2b5c167159c481d98b65e81a9ef8f0b9808e9']);
// Director-reviewed package-only false matches. Exact paths and exact tokens
// are masked individually; source/history scans and neighboring bytes stay intact.
function reviewedPackageText(label, value) {
  if (!args.has('--package')) return value;
  if (label === 'node_modules/xlsx/xlsx.js' || label === 'node_modules/xlsx/xlsx.mjs') {
    // ODF specification section number, not a network address.
    const comment = '// ' + [10, 4, 6, 2].join('.') + ' <draw:object>';
    value = value.replaceAll(comment, ' '.repeat(comment.length));
  }
  if (/^client\/dist\/assets\/ThemedBackgroundShaderImpl-[A-Za-z0-9_-]+\.js$/.test(label)) {
    // Reviewed shader integer. Hashing avoids retaining a local-pattern fragment.
    value = value.replace(/(?<![\w.])\d+(?![\w.])/g, token =>
      createHash('sha256').update(token).digest('hex') === '4ad6a246a2834e522d110e17b99d09b28492a48dc628b138d94e381d18c89890'
        ? ' '.repeat(token.length) : token);
  }
  return value;
}
function inspect(label, buffer, currentContent = false) {
  let reviewedEmailHashes;
  if (args.has('--package') && /^client\/dist\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(label)) reviewedEmailHashes = reviewedClientEmails;
  else if (args.has('--package') && /^(?:native\/)?win32-x64-abi137\/better_sqlite3\.node$/.test(label) && createHash('sha256').update(buffer).digest('hex') === reviewedSqliteArtifact) reviewedEmailHashes = reviewedSqliteEmails;
  else if (args.has('--package') && /^(?:native\/)?win32-x64\/better_sqlite3\.node$/.test(label) && createHash('sha256').update(buffer).digest('hex') === reviewedSqliteNapiArtifact) reviewedEmailHashes = reviewedSqliteEmails;
  // NULs may occur in source literals or UTF-16 metadata. They must not hide
  // a credential or turn a text source file into an unscanned binary.
  const value = reviewedPackageText(label, buffer.toString('utf8').replaceAll('\0', ''));
  // Known private terms are also checked inside binary metadata.
  // The complete public project identity is the only exempt form; a local term
  // contained in it is still reported anywhere else, including on its own.
  const decoded = value.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).toLowerCase()
    .replaceAll(expected.toLowerCase(), ' '.repeat(expected.length));
  if (currentContent && privateWordTree && !args.has('--staged') && !args.has('--package')) {
    // A matching path must not be repeated in the finding text.
    const safeLabel = privateWordPattern?.test(label) ? 'tracked-file' : label;
    inspectPrivateWords(safeLabel, buffer);
  }
  for (const pattern of currentContent ? [...privatePatterns, ...treePatterns] : privatePatterns) {
    let offset = decoded.indexOf(pattern);
    if (/^\d+$/.test(pattern)) {
      while (offset >= 0 && (/\d/.test(decoded[offset - 1] ?? '') || /\d/.test(decoded[offset + pattern.length] ?? ''))) {
        offset = decoded.indexOf(pattern, offset + 1);
      }
    }
    if (offset >= 0) report(label, decoded.slice(0, offset).split('\n').length, 'local-private-pattern');
  }
  value.split('\n').forEach((line, index) => {
    for (const [name, rule] of rules) if (rule.test(line)) report(label, index + 1, name);
    for (const match of line.matchAll(/[A-Za-z0-9_.+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      const address = match[0].toLowerCase();
      // systemd template unit names use @ but do not denote mailboxes.
      if (!publicAddresses.has(address) && !/\.(?:test|invalid|example|service)$/.test(address) && !reviewedEmailHashes?.has(createHash('sha256').update(address).digest('hex'))) report(label, index + 1, 'unapproved-email-address');
    }
    const pathLine = line.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    for (const match of pathLine.matchAll(/(?:(?<![A-Za-z0-9_/])\/(?:home|Users)\/|[A-Za-z]:[\\/]Users[\\/])([A-Za-z0-9_.-]+)(?=[\\/])/g)) {
      if (!safeUsers.has(match[1])) report(label, index + 1, 'personal-home-path');
    }
    // Test files may deliberately exercise LAN address validation.
    if (!/(?:\.test\.|^scripts\/smoke\/)/.test(label) && /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/.test(line)) report(label, index + 1, 'private-network-example');
  });
}
// The upstream name, written plain or with its letters separated by single
// spaces, dots or dashes (a banner can spell it out). Checked in the tree and
// staged scopes only: older commits legitimately carry the plain name.
// Assembled from parts so this file carries no occurrence of it.
const upstreamName = ['a', 'r', 'c', 'h', 'o', 'n'];
const upstreamSpelling = new RegExp(`(?<![A-Za-z])${upstreamName.join('[ ._-]?')}(?![A-Za-z])`, 'i');
// The upstream state directory (dot plus the name) is local runtime state and
// is refused at any depth in every scope, history included.
const upstreamStateDir = new RegExp(`(?:^|/)\\.${upstreamName.join('')}(?:/|$)`, 'i');
const nameScope = !['--history', '--history-head', '--release-history', '--push'].some(flag => args.has(flag));
// Exact upstream application assets reviewed as UI content, not captured media.
const publicMedia = new Set([
  'server/src/voice/capture-ready.wav', // Short microphone-ready UI cue.
  'client/public/backgrounds/odytty-dark-waves.webp', // Shipped theme background.
]);
// Synthetic README captures, generated in an isolated temporary environment.
// The exact bytes require visual privacy review; replacements must add the new
// digest after a fresh review rather than inheriting a path-only exception.
// Prior digests stay listed so push/history scans still accept earlier commits.
const reviewedCaptures = new Map([
  // Raster icons rendered from client/public/favicon.svg; not screenshots.
  ...['client/public', 'client/dist'].flatMap((dir) => [
    [`${dir}/arco-192.png`, 'cc77d317130d36fe99bb51acc8d85258160b05203fb192060fefcf2da4a81ef9'],
    [`${dir}/arco-512.png`, '654d841e08588aad0e968e40b40db1c8aa88323bcec04ca91b24aa73905c359b'],
  ]),
  // These exact files are compiled copies of the reviewed bundled media.
  ['client/dist/backgrounds/odytty-dark-waves.webp', '4660bbd363cd1b11027c8b51e7168340ab81f4b06af55e0dc2e054510a91b1cc'],
  ['server/dist/voice/capture-ready.wav', 'f063e9edc2ddd2789a69a8ddc16caf930734df73fcfaddf4a66714fdb6c3423a'],
  ['docs/images/home.webp', [
    '865584466ee8aec0652b8aad8b6062faeeb6d83f3cbf9517e478f11cb57e39f7', // Synthetic home fixture, folder list.
    '8684cf6873e24b260b37b9a530560fac62ac7ac868ce3d9d924783a6a1a8b74e', // Synthetic home fixture, refreshed theme controls.
    '1ff4fc44552b17531aa760082c23b0a8286b4f86bf98722f5fb3af9504380568', // Synthetic home fixture, refreshed layout switch.
    'f8a6647ee643b6aebe73a2218af3b8b818fa33d92b6e86ff4e2d6dabf6411512',
    'ecccf08fe0a6aba59c868ce0ef624022e347d4f221bbdfedc9b77bebbf498aca',
    'a55a86fbe001a5907026f838e28f42dfa460a4a9dc4b8b95e54574a68589e90d',
    'e3c5bf21d9a68f1bb06f3268204d85795c2e7fecb8e52916018f364a9333b28b',
    '52da96e20a790aa0c2894dc2d3beed8e68ea22a88909e0ebb130b209acf9e97f',
    '5ee70c0953ecd23503019e635002e1940ae7157209a0be9767cf81522ddf86b8',
    'a759b99454b994f95ba52afbf41ed35ff17471e950ae5c3adc67360a7ad5b102',
  ]],
  ['docs/images/cluster.webp', [
    'e368c87433b299379b708d4d344b039db0c9ca328c56de0488901849767c466a', // Synthetic cluster fixture, conversation header.
    'cda8020db9cd8fe86727ec634a0d287c7877fcdf6ad6dc45dc62716c95041094', // Synthetic cluster fixture, refreshed theme controls.
    'eeb9ecc5a2d8aff787676f62a0f6917cca0e4b22d18c5fcede347e8776a358ed', // Synthetic cluster fixture, refreshed layout switch.
    '5611fd938130c3e3a884f32650e38d4a89e77d2b25a87f861e80500397e589af', // Synthetic cluster fixture, refreshed composer status.
    '3f52d4451f7dab350a55070f43cbd900666ef2c49be8186648cb24c302b1ee5b',
    'bcf48ec2227a0e496fc2cfb9c365d301cfddaa804abb7b985996ad90b3482e76',
    '63b6c20e45028c8df123a70658e259d6b378ffd07bca813401a355eab610f937',
    'cd6dc994fe33d4dc8c276243b8984b2935a2aae61a48134cccf4d141e8e925c6',
    'b6576252389fcfdc776dff8621dbb8926631d57c9f2b613b98a93924d2ddac8f',
    '303f237f0b28bc99521018a0f14b04e706012ff042835454f984f18940780bfb',
    'ea7f3ce53d36a8593402dbb57c28ec537402175c51943b0733b9c0c3b84d7b1b',
    'd2ec4b30b011334d53120ed057d07e389040f0135d074a60bfe670a1caf2444e',
    '0d6bf20ba59e92c37c5cdc577ae3302fc821421a5ccf2e00ffb4beb61b7aa9c3',
  ]],
]);
function reviewedCaptureAllows(file, digest) {
  const allowed = reviewedCaptures.get(file);
  if (allowed == null) return false;
  return typeof allowed === 'string' ? allowed === digest : allowed.includes(digest);
}
// Local agent instruction files and directories are machine-local and never
// tracked. Matched by name at any depth.
const agentFile = /(?:^|\/)(?:AGENTS\.md|AGENT\.md|CLAUDE\.md|CLAUDE\.local\.md|GEMINI\.md|codex\.md|\.cursorrules|\.windsurfrules|\.clinerules|\.cursor\/.*|\.claude\/.*|\.codex\/.*)$/i;
// ASCII-punctuation check: curly quotes, dashes beyond the hyphen, ellipsis
// and similar typographic characters.
const typographic = /[\u2010-\u2015\u2018-\u201F\u2026\u2212]/;
const cachePath = /(?:^|\/)(?:__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)(?:\/|$)|\.(?:pyc|pyo|tsbuildinfo)$/;
function inspectFile(file, buffer) {
  if (args.has('--package') && /(?:^|\/)(?:DEVLOG\.md|devlog|test|tests|testSupport|__tests__|fixtures)(?:\/|$)|\.(?:test|spec|test-support)\./i.test(file)) report(file, 1, 'package-test-or-devlog');
  if (/(?:^|\/)(?:\.arco|\.codex|\.claude)(?:\/|$)/.test(file)) report(file, 1, 'local-runtime-state');
  if (/\.(?:png|jpe?g|gif|webp|avif|bmp|tiff?|wav|mp3|mp4|webm|m4a|mov|ogg|flac)$/i.test(file) && !publicMedia.has(file) && !reviewedCaptureAllows(file, createHash('sha256').update(buffer).digest('hex'))) report(file, 1, 'screenshot-or-recording-file');
  // Help and manual copy ships in the client bundle; keep it ASCII like docs.
  // Tree and staged only: older commits still contain U+2014 until this tip lands.
  if (nameScope && /^client\/src\/help\//.test(file) && /\u2014/.test(buffer.toString('utf8'))) report(file, 1, 'typographic-punctuation');
  if (/(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|events\.jsonl|meta\.json|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx)|.*\.sqlite(?:3)?|.*\.db)$/.test(file) && !file.endsWith('/.env.example') && file !== '.env.example') report(file, 1, 'runtime-or-secret-file');
  if (upstreamStateDir.test(file)) report(file, 1, 'upstream-state-directory');
  if (agentFile.test(file)) report(file, 1, 'agent-instruction-file');
  if (cachePath.test(file)) report(file, 1, 'generated-cache-file');
  if (nameScope) {
    const lines = buffer.toString('utf8').replaceAll('\0', '').split('\n');
    const at = lines.findIndex(line => upstreamSpelling.test(line));
    if (at >= 0) report(file, at + 1, 'upstream-name');
    if (upstreamSpelling.test(file)) report('file-name', 1, 'upstream-name');
  }
  inspect(file, buffer, true);
  inspect('file-name', Buffer.from(file), true);
}
const identityOf = line => line?.replace(/ -?\d+ [+-]\d{4}$/, '');
const commonDir = git('rev-parse', '--git-common-dir').toString().trim();
// A local, shared-worktree hold is intentionally not an environment-variable
// bypass. Only explicit resolution of the historical findings can remove it.
const pushHold = join(commonDir, 'public-push-hold');
function refTips(scope) {
  const publicationRefs = scope === 'release';
  const headOnlyRefs = scope === 'head';
  const refs = git('for-each-ref', '--format=%(objectname) %(refname)',
    ...(publicationRefs ? ['refs/heads/', 'refs/tags/', 'refs/remotes/']
      : headOnlyRefs ? ['refs/tags/'] : [])).toString().trim();
  const tips = refs ? refs.split('\n').map(line => {
    const [oid, ref] = line.split(' ');
    if (!oid || !ref) throw new Error('Invalid ref');
    inspect('git-ref-name', Buffer.from(ref));
    return oid;
  }) : [];
  if (headOnlyRefs) {
    const resolved = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], {
      maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    });
    if (resolved.status === 0 && !resolved.error && resolved.stderr.length === 0) {
      const headTip = resolved.stdout.toString().trim();
      if (!headTip) throw new Error('Git audit read failed');
      tips.push(headTip);
    } else {
      if (resolved.status !== 1 || resolved.error || resolved.stderr.length) throw new Error('Git audit read failed');
      const head = git('rev-parse', '--git-path', 'HEAD').toString().trim();
      const raw = readFileSync(head, 'utf8').trim();
      const unbornBranch = /^ref: (refs\/heads\/[^\s]+)$/.exec(raw);
      if (!unbornBranch) throw new Error('Git audit read failed');
      // A real unborn branch has no branch ref. Inspect it through Git so a
      // packed ref and malformed ref data cannot be mistaken for an empty repo.
      const branchTip = git('for-each-ref', '--format=%(objectname)', unbornBranch[1]).toString().trim();
      if (branchTip) throw new Error('Git audit read failed');
    }
  } else {
    // Detached CI checkouts and unborn repositories are both valid. Resolve HEAD
    // only when it exists; a broken HEAD/ref must not masquerade as unborn.
    const head = git('rev-parse', '--git-path', 'HEAD').toString().trim();
    const raw = readFileSync(head, 'utf8').trim();
    if (!raw.startsWith('ref: ') || refs || existsSync(git('rev-parse', '--git-path', raw.slice(5)).toString().trim())) {
      tips.push(git('rev-parse', '--verify', 'HEAD').toString().trim());
    }
  }
  return tips;
}
function proposedTips() {
  if (existsSync(pushHold)) report('push-hold', 1, 'historical-review-unresolved');
  const hashSize = git('rev-parse', '--show-object-format').toString().trim() === 'sha256' ? 64 : 40;
  const oidPattern = new RegExp(`^[0-9a-f]{${hashSize}}$`);
  const zero = '0'.repeat(hashSize);
  const input = readFileSync(0, 'utf8');
  if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Push input too large');
  const lines = input.trim() ? input.trim().split('\n') : [];
  const tips = [];
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) throw new Error('Invalid push record');
    const [localRef, oid, remoteRef, remoteOid] = fields;
    if (!oidPattern.test(oid) || !oidPattern.test(remoteOid)) throw new Error('Invalid push object');
    git('check-ref-format', remoteRef);
    // Only distributable branch/tag destinations are supported. Even renaming
    // a runtime checkpoint into a branch must not publish it accidentally.
    if (!/^refs\/(?:heads|tags)\//.test(remoteRef) || localRef.startsWith('refs/arco/')) {
      report('push-ref', 1, 'non-publication-ref');
    }
    inspect('git-ref-name', Buffer.from(remoteRef));
    if (oid === zero) {
      if (localRef !== '(delete)') throw new Error('Invalid deletion');
      continue;
    }
    if (localRef === '(delete)') throw new Error('Invalid update');
    // Scan the supplied immutable object, not the current local ref (which
    // could move during the hook). Scan its full ancestry, not remoteOid..oid:
    // a clean tip cannot hide private content already in its parents.
    tips.push(oid);
  }
  return tips;
}
function inspectHistory(tips) {
  if (git('rev-parse', '--is-shallow-repository').toString().trim() !== 'false') {
    report('history', 1, 'incomplete-shallow-history');
    return;
  }
  const grafts = join(commonDir, 'info', 'grafts');
  if (existsSync(grafts) && readFileSync(grafts, 'utf8').trim()) {
    report('history', 1, 'incomplete-grafted-history');
    return;
  }
  const blobs = new Set(), objects = new Set(), commitTips = new Set();
  function inspectTree(tree) {
    for (const entry of split(git('ls-tree', '-r', '-z', tree))) {
      const tab = entry.indexOf('\t');
      if (tab < 0) throw new Error('Invalid tree entry');
      const file = entry.slice(tab + 1);
      const [, type, object] = entry.slice(0, tab).split(' ');
      if (type !== 'blob') { report(file, 1, 'unsupported-git-object'); continue; }
      const key = `${object}:${file}`;
      if (!blobs.has(key)) { inspectFile(file, git('cat-file', 'blob', object)); blobs.add(key); }
    }
  }
  function inspectTip(oid) {
    if (objects.has(oid)) return;
    objects.add(oid);
    const type = git('cat-file', '-t', oid).toString().trim();
    if (type === 'commit') { commitTips.add(oid); return; }
    if (type === 'tag') {
      const tag = git('cat-file', 'tag', oid);
      const header = tag.toString().split('\n\n')[0];
      const target = /^object ([0-9a-f]+)$/m.exec(header)?.[1];
      const tagger = /^tagger (.+)$/m.exec(header)?.[1];
      if (!target || !tagger) throw new Error('Invalid annotated tag');
      if (identityOf(tagger) !== expected) report(oid.slice(0, 12), 1, 'project-tag-identity-required');
      inspect(`${oid.slice(0, 12)}:tag`, tag);
      inspectTip(target);
      return;
    }
    // Git permits tags of trees and blobs. Scan those too instead of silently
    // discarding a ref that rev-list would not visit as a commit.
    if (type === 'tree') { inspectTree(oid); return; }
    if (type === 'blob') { inspect(`tagged-blob:${oid.slice(0, 12)}`, git('cat-file', 'blob', oid)); return; }
    throw new Error('Unsupported object');
  }
  for (const tip of new Set(tips)) inspectTip(tip);
  if (!commitTips.size) return;
  const commits = runGit(['rev-list', '--stdin'], [...commitTips].join('\n') + '\n').toString().trim().split('\n').filter(Boolean);
  for (const commit of commits) {
    const raw = git('cat-file', 'commit', commit);
    const header = raw.toString().split('\n\n')[0];
    const author = /^author (.+)$/m.exec(header)?.[1];
    const committer = /^committer (.+)$/m.exec(header)?.[1];
    if (!author || !committer) throw new Error('Invalid commit');
    if (identityOf(author) !== expected || identityOf(committer) !== expected) report(commit.slice(0, 12), 1, 'project-history-identity-required');
    inspect(`${commit.slice(0, 12)}:metadata`, raw);
    inspectTree(commit);
  }
}
const valid = new Set(['--identity', '--message', '--history', '--history-head', '--release-history', '--push', '--staged', '--tree', '--devlog', '--package']);
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!valid.has(argv[i])) throw new Error('Unknown option');
  if ((argv[i] === '--message' || argv[i] === '--package') && !argv[++i]) throw new Error('Missing input path');
}
if (['--history', '--history-head', '--release-history', '--push', '--staged', '--tree', '--package'].filter(flag => args.has(flag)).length > 1) throw new Error('Conflicting scopes');
if (args.has('--identity')) {
  for (const kind of ['AUTHOR', 'COMMITTER']) {
    const identity = git('var', `GIT_${kind}_IDENT`).toString().trim().replace(/ \d+ [+-]\d{4}$/, '');
    if (identity !== expected) report('commit-metadata', 1, `project-${kind.toLowerCase()}-required`);
  }
}
const messageAt = process.argv.indexOf('--message');
if (messageAt >= 0) {
  const message = readFileSync(resolve(process.argv[messageAt + 1]));
  inspect('commit-message', message);
  message.toString().split('\n').forEach((line, index) => {
    if (typographic.test(line)) report('commit-message', index + 1, 'typographic-punctuation');
    if (/^\s*(?:co-authored-by|signed-off-by|generated-by|authored-by|committed-by|assisted-by)\s*:/i.test(line)) report('commit-message', index + 1, 'attribution-trailer-forbidden');
  });
}
if (args.has('--devlog')) {
  const changed = split(git('diff', '--cached', '--name-only', '-z'));
  const expectedArchive = `devlog/${new Date().toISOString().slice(0, 7)}.md`;
  if (changed.some(file => file !== 'DEVLOG.md' && !file.startsWith('devlog/'))) {
    const updated = split(git('diff', '--cached', '--name-only', '--diff-filter=AM', '-z'));
    if (!updated.includes(expectedArchive)) report(expectedArchive, 1, 'current-month-devlog-entry-required');
  }
}
if (args.has('--history') || args.has('--history-head') || args.has('--release-history') || args.has('--push')) {
  const scope = args.has('--release-history') ? 'release' : args.has('--history-head') ? 'head' : 'all';
  inspectHistory(args.has('--push') ? proposedTips() : refTips(scope));
} else if (args.has('--staged')) {
  for (const file of split(git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'))) {
    inspectPrivateWords('file-name', file);
    const staged = git('show', `:${file}`);
    // Git does not render binary additions as text in the patch.
    if (staged.includes(0)) inspectPrivateWords('staged-binary', staged);
    inspectFile(file, staged);
  }
  // Scan only added text for local private words, including non-Markdown files.
  let addedLine = 0;
  for (const line of git('diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=ACMR').toString().split('\n')) {
    if (line.startsWith('diff --git ')) { addedLine = 0; continue; }
    const hunk = /^@@ -\S+ \+(\d+)/.exec(line);
    if (hunk) { addedLine = Number(hunk[1]); continue; }
    if (addedLine > 0 && line.startsWith('+')) {
      inspectPrivateWords('staged-diff', line.slice(1), addedLine++);
    }
  }
  // Added Markdown lines only; existing content is not rescanned.
  let current = '', newLine = 0;
  for (const line of git('diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=ACMR', '--', '*.md').toString().split('\n')) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) { current = header[1]; continue; }
    const hunk = /^@@ -\S+ \+(\d+)/.exec(line);
    if (hunk) { newLine = Number(hunk[1]); continue; }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (typographic.test(line)) report(current, newLine, 'typographic-punctuation');
      newLine++;
    }
  }
} else if (args.has('--package')) {
  if (!packageRoot || !lstatSync(packageRoot).isDirectory()) throw new Error('Package input is not a directory');
  const walk = (directory, relative = '') => {
    for (const name of readdirSync(directory)) {
      const file = join(directory, name), label = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || stat.size > 100 * 1024 * 1024) throw new Error('Unsafe package input');
      if (stat.isDirectory()) walk(file, label);
      else inspectFile(label, readFileSync(file));
    }
  };
  walk(packageRoot);
} else if (args.has('--tree') || (messageAt < 0 && !args.has('--identity') && !args.has('--devlog'))) {
  for (const file of new Set(split(git('ls-files', '--cached', '--others', '--exclude-standard', '-z')))) {
    if (existsSync(file)) inspectFile(file, readFileSync(file));
  }
}
} catch {
  // Git/IO exceptions can contain private paths, ref names or object contents.
  // Missing/corrupt objects and malformed hook input fail closed, without echo.
  report('audit-input', 1, 'unreadable-or-invalid-audit-input');
}
if (findings.size) {
  for (const finding of findings) process.stderr.write(`${finding}\n`);
  process.stderr.write(`Public-history audit failed: ${findings.size} finding(s). Values withheld.\n`);
  process.exitCode = 1;
} else process.stdout.write('Public-history audit passed for the requested scope. Manual release review remains required.\n');
