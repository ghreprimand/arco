import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyReviewedArtifact, ignoreCopyDestination, inspectArtifactCopy, scanCopyLine } from './artifactCopy.js';
import { outputDirectory } from './outputStore.js';
import { addKeep } from './keepStore.js';
import { linkFile, linkFolder } from './testSupport/links.js';

test('copy checks, review token, no clobber and original retention', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-copy-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    const dir = path.join(cwd, '.arco', 'workflows', 'conv-1', 'artifacts');
    await mkdir(dir, { recursive: true });
    await mkdir(path.join(cwd, 'out'));
    const source = path.join(dir, 'report.txt'); await writeFile(source, `Contact ${['synthetic', 'example.com'].join('@')}\n`);
    const review = await inspectArtifactCopy(cwd, 'conv-1', 'artifacts/report.txt', path.join(cwd, 'out'), false);
    assert.equal(review.ignored, false);
    assert.equal(review.files[0].findings[0].rule, 'email-address');
    await writeFile(source, 'changed');
    await assert.rejects(copyReviewedArtifact(cwd, 'conv-1', 'artifacts/report.txt', path.join(cwd, 'out'), false, review.token), /changed/);
    const revised = await inspectArtifactCopy(cwd, 'conv-1', 'artifacts/report.txt', path.join(cwd, 'out'), false);
    await ignoreCopyDestination(cwd, revised.target);
    const ignored = await inspectArtifactCopy(cwd, 'conv-1', 'artifacts/report.txt', path.join(cwd, 'out'), false);
    assert.equal(ignored.ignored, true);
    await copyReviewedArtifact(cwd, 'conv-1', 'artifacts/report.txt', path.join(cwd, 'out'), false, ignored.token);
    assert.equal(await readFile(path.join(cwd, 'out', 'report.txt'), 'utf8'), 'changed');
    assert.equal(await readFile(source, 'utf8'), 'changed');
    await assert.rejects(inspectArtifactCopy(cwd, 'conv-1', 'artifacts/report.txt', path.join(cwd, 'out'), false), /already exists/);
    if (await linkFile(source, path.join(dir, 'linked.txt'))) {
      await assert.rejects(inspectArtifactCopy(cwd, 'conv-1', 'artifacts/linked.txt', path.join(cwd, 'out'), false), /links/);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('scanner identifies credentials, home paths and IP addresses without returning values', () => {
  assert.ok(scanCopyLine('password="long-synthetic-value"').includes('password-or-secret'));
  assert.ok(scanCopyLine(['-----BEGIN ', 'RSA ', 'PRIVATE KEY-----'].join('')).includes('private-key'));
  assert.ok(scanCopyLine(['sk-', 'x'.repeat(32)].join('')).includes('provider-token'));
  assert.ok(scanCopyLine(['api_key=', '"', 'x'.repeat(32), '"'].join('')).includes('credential-assignment'));
  assert.ok(scanCopyLine(['', 'home', 'fixture-user', 'private', 'file'].join('/')).includes('personal-home-path'));
  assert.ok(scanCopyLine([203, 0, 113, 45].join('.')).includes('ip-address'));
  assert.ok(scanCopyLine(['alice', 'example.test'].join('@')).includes('email-address'));
});

test('oversized unignored artifact is refused', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-copy-big-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    const dir = path.join(cwd, '.arco', 'workflows', 'conv-1', 'artifacts'); await mkdir(dir, { recursive: true });
    const source = path.join(dir, 'image.png'); await writeFile(source, ''); await truncate(source, 100 * 1000 * 1000 + 1);
    const review = await inspectArtifactCopy(cwd, 'conv-1', 'artifacts/image.png', cwd, false);
    assert.equal(review.ignored, false);
    await assert.rejects(copyReviewedArtifact(cwd, 'conv-1', 'artifacts/image.png', cwd, false, review.token), /Over 100 MB/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('directory copy keeps empty folders, rejects links and reports declared public status', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-copy-dir-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    const dir = path.join(cwd, '.arco', 'workflows', 'conv-1', 'artifacts', 'bundle');
    await mkdir(path.join(dir, 'empty'), { recursive: true });
    await mkdir(path.join(dir, 'nested'), { recursive: true });
    await writeFile(path.join(dir, 'nested', 'file.svg'), '<svg><!-- password=abcdefgh --></svg>');
    const review = await inspectArtifactCopy(cwd, 'conv-1', 'artifacts/bundle', cwd, true);
    assert.equal(review.publicRepository, true);
    assert.ok(review.files[0].findings.some(f => f.rule === 'password-or-secret'));
    assert.ok(review.files[0].media);
    await copyReviewedArtifact(cwd, 'conv-1', 'artifacts/bundle', cwd, true, review.token);
    assert.equal(await readFile(path.join(cwd, 'bundle', 'nested', 'file.svg'), 'utf8'), '<svg><!-- password=abcdefgh --></svg>');
    assert.ok((await (await import('node:fs/promises')).stat(path.join(cwd, 'bundle', 'empty'))).isDirectory());
  } finally { await rm(cwd, { recursive: true, force: true }); }
});


test('NUL characters cannot hide a credential in text', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-copy-nul-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    const dir = path.join(cwd, '.arco', 'workflows', 'conv-1', 'artifacts'); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'note.txt'), 'pass\0word=abcdefgh');
    const review = await inspectArtifactCopy(cwd, 'conv-1', 'artifacts/note.txt', cwd, false);
    assert.ok(review.files[0].findings.some(f => f.rule === 'password-or-secret'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});


test('failed publication preserves the original and reports partial copies', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-copy-fail-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    const dir = path.join(cwd, '.arco', 'workflows', 'conv-1', 'artifacts', 'bundle');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'a.txt'), 'alpha'); await writeFile(path.join(dir, 'b.txt'), 'beta');
    const review = await inspectArtifactCopy(cwd, 'conv-1', 'artifacts/bundle', cwd, false);
    let calls = 0;
    const publish = async () => { if (++calls === 2) throw new Error('synthetic failure'); };
    await assert.rejects(copyReviewedArtifact(cwd, 'conv-1', 'artifacts/bundle', cwd, false, review.token, publish), /Some copied files may remain/);
    assert.equal(await readFile(path.join(cwd, 'bundle', 'a.txt'), 'utf8'), 'alpha');
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'alpha');
    assert.equal(await readFile(path.join(dir, 'b.txt'), 'utf8'), 'beta');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('publication uses the reviewed private snapshot if the source changes', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-copy-snapshot-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    const dir = path.join(cwd, '.arco', 'workflows', 'conv-1', 'artifacts');
    await mkdir(dir, { recursive: true });
    const source = path.join(dir, 'report.txt'); await writeFile(source, 'reviewed');
    const review = await inspectArtifactCopy(cwd, 'conv-1', 'artifacts/report.txt', cwd, false);
    const publish = async () => { await writeFile(source, 'changed after review'); };
    await copyReviewedArtifact(cwd, 'conv-1', 'artifacts/report.txt', cwd, false, review.token, publish);
    assert.equal(await readFile(path.join(cwd, 'report.txt'), 'utf8'), 'reviewed');
    assert.equal(await readFile(source, 'utf8'), 'changed after review');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('past the findings limit, files are listed as not fully scanned instead of refused', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-copy-findings-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    const dir = path.join(cwd, '.arco', 'workflows', 'conv-1', 'artifacts', 'bundle');
    await mkdir(dir, { recursive: true });
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) await writeFile(path.join(dir, name), 'password=fixture\n'.repeat(700));
    await writeFile(path.join(dir, 'e.txt'), 'password=fixture\n'.repeat(1200));
    const review = await inspectArtifactCopy(cwd, 'conv-1', 'artifacts/bundle', cwd, true);
    const byName = Object.fromEntries(review.files.map((f) => [f.rel, f]));
    // 700 + 700, then the 2,000 total leaves 600 for c.txt and nothing after.
    assert.deepEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map((n) => byName[n].findings.length), [700, 700, 600, 0, 0]);
    assert.deepEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map((n) => byName[n].unscanned), [false, false, true, true, true]);
    assert.deepEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map((n) => !!byName[n].findingsCapped), [false, false, true, true, true]);
    // A public copy outside Git ignore still needs the confirmation for them.
    await assert.rejects(copyReviewedArtifact(cwd, 'conv-1', 'artifacts/bundle', cwd, true, review.token), /Confirm the files that were not scanned/);
    await copyReviewedArtifact(cwd, 'conv-1', 'artifacts/bundle', cwd, true, review.token, undefined, true);
    assert.equal(await readFile(path.join(cwd, 'bundle', 'e.txt'), 'utf8'), 'password=fixture\n'.repeat(1200));
    // One file alone stops at 1,000 findings.
    await mkdir(path.join(cwd, 'single'));
    const one = await inspectArtifactCopy(cwd, 'conv-1', 'artifacts/bundle/e.txt', path.join(cwd, 'single'), false);
    assert.equal(one.files[0].findings.length, 1000);
    assert.equal(one.files[0].unscanned, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('private snapshot is refused when the temporary folder is inside the project', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-copy-tmp-'));
  const oldTmp = process.env.TMPDIR;
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    const dir = path.join(cwd, '.arco', 'workflows', 'conv-1', 'artifacts'); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'note.txt'), 'reviewed');
    const review = await inspectArtifactCopy(cwd, 'conv-1', 'artifacts/note.txt', cwd, false);
    process.env.TMPDIR = cwd;
    if (tmpdir() === cwd) await assert.rejects(copyReviewedArtifact(cwd, 'conv-1', 'artifacts/note.txt', cwd, false, review.token), /temporary folder must be outside/);
  } finally {
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    await rm(cwd, { recursive: true, force: true });
  }
});


test('destination folder swap cannot redirect reviewed bytes', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-copy-parent-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'arco-copy-outside-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    const dir = path.join(cwd, '.arco', 'workflows', 'conv-1', 'artifacts');
    await mkdir(dir, { recursive: true }); await mkdir(path.join(cwd, 'out'));
    await writeFile(path.join(dir, 'report.txt'), 'reviewed');
    const review = await inspectArtifactCopy(cwd, 'conv-1', 'artifacts/report.txt', path.join(cwd, 'out'), false);
    const swap = async () => { await rename(path.join(cwd, 'out'), path.join(cwd, 'old-out')); await linkFolder(outside, path.join(cwd, 'out')); };
    await assert.rejects(copyReviewedArtifact(cwd, 'conv-1', 'artifacts/report.txt', path.join(cwd, 'out'), false, review.token, swap), /Destination folder changed/);
    await assert.rejects(readFile(path.join(outside, 'report.txt')));
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});


test('private snapshot is refused inside a different Git repository', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-copy-project-'));
  const other = await mkdtemp(path.join(tmpdir(), 'arco-copy-temp-repo-'));
  const oldTmp = process.env.TMPDIR;
  try {
    execFileSync('git', ['init', '-q'], { cwd }); execFileSync('git', ['init', '-q'], { cwd: other });
    const dir = path.join(cwd, '.arco', 'workflows', 'conv-1', 'artifacts'); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'note.txt'), 'reviewed');
    const review = await inspectArtifactCopy(cwd, 'conv-1', 'artifacts/note.txt', cwd, false);
    process.env.TMPDIR = other;
    if (tmpdir() === other) await assert.rejects(copyReviewedArtifact(cwd, 'conv-1', 'artifacts/note.txt', cwd, false, review.token), /outside Git repositories/);
    {
      const alias = path.join(cwd, 'temp-alias'); await linkFolder(other, alias);
      process.env.TMPDIR = alias;
      if (tmpdir() === alias) await assert.rejects(copyReviewedArtifact(cwd, 'conv-1', 'artifacts/note.txt', cwd, false, review.token), /outside Git repositories/);
    }
  } finally {
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    await rm(cwd, { recursive: true, force: true }); await rm(other, { recursive: true, force: true });
  }
});

test('Git checks ignore inherited repository redirection', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-copy-git-env-'));
  const other = await mkdtemp(path.join(tmpdir(), 'arco-copy-other-git-'));
  const previous = process.env.GIT_DIR;
  try {
    execFileSync('git', ['init', '-q'], { cwd }); execFileSync('git', ['init', '-q'], { cwd: other });
    await writeFile(path.join(cwd, '.gitignore'), 'report.txt\n');
    const dir = path.join(cwd, '.arco', 'workflows', 'conv-1', 'artifacts'); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'report.txt'), 'fixture');
    process.env.GIT_DIR = path.join(other, '.git');
    const review = await inspectArtifactCopy(cwd, 'conv-1', 'artifacts/report.txt', cwd, false);
    assert.equal(review.ignored, true);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous;
    await rm(cwd, { recursive: true, force: true }); await rm(other, { recursive: true, force: true });
  }
});


test('copy and KEEP accept a project opened through a symlinked ancestor', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'arco-copy-alias-'));
  const actual = path.join(parent, 'actual');
  const alias = path.join(parent, 'alias');
  try {
    await mkdir(actual);
    await linkFolder(actual, alias);
    const cwd = path.join(alias, 'project');
    await mkdir(path.join(cwd, '.arco', 'workflows', 'conv-1', 'artifacts'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd });
    await writeFile(path.join(cwd, '.arco', 'workflows', 'conv-1', 'artifacts', 'note.txt'), 'ordinary note');
    const review = await inspectArtifactCopy(cwd, 'conv-1', 'artifacts/note.txt', cwd, false);
    await ignoreCopyDestination(cwd, review.target);
    const ignored = await inspectArtifactCopy(cwd, 'conv-1', 'artifacts/note.txt', cwd, false);
    assert.equal(ignored.ignored, true);
    await copyReviewedArtifact(cwd, 'conv-1', 'artifacts/note.txt', cwd, false, ignored.token);
    assert.equal(await readFile(path.join(cwd, 'note.txt'), 'utf8'), 'ordinary note');
    const dir = await outputDirectory(cwd, 'conv-1');
    assert.ok((await addKeep(dir, 'artifacts/note.txt', 'operator')).some(item => item.path === 'artifacts/note.txt'));
    if (await linkFile(path.join(cwd, 'note.txt'), path.join(cwd, '.arco', 'workflows', 'conv-1', 'artifacts', 'linked.txt'))) {
      await assert.rejects(inspectArtifactCopy(cwd, 'conv-1', 'artifacts/linked.txt', cwd, false), /links/);
    }
  } finally { await rm(parent, { recursive: true, force: true }); }
});
