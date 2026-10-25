#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = new Set(process.argv.slice(2));
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
const patternsFile = process.env.ARCO_PRIVATE_PATTERNS_FILE || git('rev-parse', '--git-path', 'private-patterns').toString().trim();
const privatePatterns = existsSync(patternsFile) ? readFileSync(patternsFile, 'utf8').split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(s => s && !s.startsWith('#')) : [];
const split = buffer => buffer.toString().split('\0').filter(Boolean);
// Required author, committer and tagger for new history: the maintainer's
// public GitHub no-reply identity. There is no environment or configuration
// override.
const expected = 'ghreprimand <203024559+ghreprimand@users.noreply.github.com>';
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/],
  ['provider-token', /\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16})\b/],
  ['credential-assignment', /\b(?:api_key|apiKey|access_token|refresh_token|client_secret)\s*[=:]\s*["'][A-Za-z0-9_./+\-=]{32,}["']/],
];
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
function inspect(label, buffer) {
  // NULs may occur in source literals or UTF-16 metadata. They must not hide
  // a credential or turn a text source file into an unscanned binary.
  const value = buffer.toString('utf8').replaceAll('\0', '');
  // Known private terms are also checked inside binary metadata.
  // The complete public project identity is the only exempt form; a local term
  // contained in it is still reported anywhere else, including on its own.
  const decoded = value.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).toLowerCase()
    .replaceAll(expected.toLowerCase(), ' '.repeat(expected.length));
  for (const pattern of privatePatterns) {
    const offset = decoded.indexOf(pattern);
    if (offset >= 0) report(label, decoded.slice(0, offset).split('\n').length, 'local-private-pattern');
  }
  value.split('\n').forEach((line, index) => {
    for (const [name, rule] of rules) if (rule.test(line)) report(label, index + 1, name);
    for (const match of line.matchAll(/[A-Za-z0-9_.+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      const address = match[0].toLowerCase();
      // systemd template unit names use @ but do not denote mailboxes.
      if (!publicAddresses.has(address) && !/\.(?:test|invalid|example|service)$/.test(address)) report(label, index + 1, 'unapproved-email-address');
    }
    const pathLine = line.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    for (const match of pathLine.matchAll(/(?:(?<![A-Za-z0-9_/])\/(?:home|Users)\/|[A-Za-z]:[\\/]Users[\\/])([A-Za-z0-9_.-]+)(?=[\\/])/g)) {
      if (!safeUsers.has(match[1])) report(label, index + 1, 'personal-home-path');
    }
    // Test files may deliberately exercise LAN address validation.
    if (!/(?:\.test\.|^scripts\/smoke\/)/.test(label) && /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/.test(line)) report(label, index + 1, 'private-network-example');
  });
}
// Exact upstream application assets reviewed as UI content, not captured media.
const publicMedia = new Set([
  'server/src/voice/capture-ready.wav', // Short microphone-ready UI cue.
  'client/public/backgrounds/odytty-dark-waves.webp', // Shipped theme background.
]);
const cachePath = /(?:^|\/)(?:__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)(?:\/|$)|\.(?:pyc|pyo|tsbuildinfo)$/;
function inspectFile(file, buffer) {
  if (/(?:^|\/)(?:\.arco|\.codex|\.claude)(?:\/|$)/.test(file)) report(file, 1, 'local-runtime-state');
  if (/\.(?:png|jpe?g|gif|webp|avif|bmp|tiff?|wav|mp3|mp4|webm|m4a|mov|ogg|flac)$/i.test(file) && !publicMedia.has(file)) report(file, 1, 'screenshot-or-recording-file');
  if (/(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|events\.jsonl|meta\.json|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx)|.*\.sqlite(?:3)?|.*\.db)$/.test(file) && !file.endsWith('/.env.example') && file !== '.env.example') report(file, 1, 'runtime-or-secret-file');
  if (cachePath.test(file)) report(file, 1, 'generated-cache-file');
  inspect(file, buffer);
  inspect('file-name', Buffer.from(file));
}
const identityOf = line => line?.replace(/ -?\d+ [+-]\d{4}$/, '');
const commonDir = git('rev-parse', '--git-common-dir').toString().trim();
// A local, shared-worktree hold is intentionally not an environment-variable
// bypass. Only explicit resolution of the historical findings can remove it.
const pushHold = join(commonDir, 'public-push-hold');
function refTips(releaseOnly) {
  const refs = git('for-each-ref', '--format=%(objectname) %(refname)',
    ...(releaseOnly ? ['refs/heads/', 'refs/tags/', 'refs/remotes/'] : [])).toString().trim();
  const tips = refs ? refs.split('\n').map(line => {
    const [oid, ref] = line.split(' ');
    if (!oid || !ref) throw new Error('Invalid ref');
    inspect('git-ref-name', Buffer.from(ref));
    return oid;
  }) : [];
  // Detached CI checkouts and unborn repositories are both valid. Resolve HEAD
  // only when it exists; a broken HEAD/ref must not masquerade as unborn.
  const head = git('rev-parse', '--git-path', 'HEAD').toString().trim();
  const raw = readFileSync(head, 'utf8').trim();
  if (!raw.startsWith('ref: ') || refs || existsSync(git('rev-parse', '--git-path', raw.slice(5)).toString().trim())) {
    tips.push(git('rev-parse', '--verify', 'HEAD').toString().trim());
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
const valid = new Set(['--identity', '--message', '--history', '--release-history', '--push', '--staged', '--tree', '--devlog']);
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!valid.has(argv[i])) throw new Error('Unknown option');
  if (argv[i] === '--message' && !argv[++i]) throw new Error('Missing message path');
}
if (['--history', '--release-history', '--push', '--staged', '--tree'].filter(flag => args.has(flag)).length > 1) throw new Error('Conflicting scopes');
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
if (args.has('--history') || args.has('--release-history') || args.has('--push')) {
  inspectHistory(args.has('--push') ? proposedTips() : refTips(args.has('--release-history')));
} else if (args.has('--staged')) {
  for (const file of split(git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'))) inspectFile(file, git('show', `:${file}`));
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
