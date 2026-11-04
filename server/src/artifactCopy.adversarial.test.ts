import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyReviewedArtifact, inspectArtifactCopy } from './artifactCopy.js';
import { addKeep } from './keepStore.js';
import { archiveConversation, archivePath } from './storageArchive.js';
import { deleteConversation } from './storageActions.js';

const ID = 'conv-1';

async function repo(): Promise<{ cwd: string; artifacts: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-copy-adv-'));
  execFileSync('git', ['init', '-q'], { cwd });
  const artifacts = path.join(cwd, '.arco', 'workflows', ID, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, 'note.txt'), 'ordinary note\n');
  return { cwd, artifacts };
}

test('copy refuses destinations inside .arco and .git, and item paths that leave artifacts', async () => {
  const { cwd } = await repo();
  try {
    await mkdir(path.join(cwd, '.arco', 'plans'), { recursive: true });
    await mkdir(path.join(cwd, '.git', 'hooks'), { recursive: true });
    const outside = await mkdtemp(path.join(tmpdir(), 'arco-copy-out-'));
    try {
      await assert.rejects(inspectArtifactCopy(cwd, ID, 'artifacts/note.txt', path.join(cwd, '.arco', 'plans'), false));
      await assert.rejects(inspectArtifactCopy(cwd, ID, 'artifacts/note.txt', path.join(cwd, '.git', 'hooks'), false));
      await assert.rejects(inspectArtifactCopy(cwd, ID, 'artifacts/../../note.txt', outside, false));
      await assert.rejects(inspectArtifactCopy(cwd, ID, '/etc/passwd', path.join(cwd), false));
      await assert.rejects(inspectArtifactCopy(cwd, ID, 'artifacts\\..\\..\\note.txt', path.join(cwd), false));
      await assert.rejects(inspectArtifactCopy(cwd, ID, 'artifacts/note.txt', outside, false));
    } finally { await rm(outside, { recursive: true, force: true }); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a symlink destination and a symlink inside artifacts are refused', async () => {
  if (process.platform === 'win32') return;
  const { cwd, artifacts } = await repo();
  const outside = await mkdtemp(path.join(tmpdir(), 'arco-copy-link-out-'));
  try {
    await symlink(outside, path.join(cwd, 'linked-out'));
    await assert.rejects(inspectArtifactCopy(cwd, ID, 'artifacts/note.txt', path.join(cwd, 'linked-out'), false));
    await symlink(path.join(cwd, '.git'), path.join(cwd, 'git-alias'));
    await assert.rejects(inspectArtifactCopy(cwd, ID, 'artifacts/note.txt', path.join(cwd, 'git-alias'), false));
    await symlink(outside, path.join(artifacts, 'escape'));
    await writeFile(path.join(outside, 'secret.txt'), 'api_key=abcdefghijklmnop');
    await assert.rejects(inspectArtifactCopy(cwd, ID, 'artifacts/escape', path.join(cwd), false), /links/);
    assert.equal(await readFile(path.join(cwd, 'note.txt')).catch(() => ''), '');
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('a NUL byte cannot hide a credential in an extensionless file', async () => {
  const { cwd, artifacts } = await repo();
  try {
    const secret = Buffer.concat([Buffer.from([0]), Buffer.from('api_key=abcdefghijklmnop\n')]);
    await writeFile(path.join(artifacts, 'notes'), secret);
    const review = await inspectArtifactCopy(cwd, ID, 'artifacts/notes', cwd, true);
    assert.ok(review.files[0].findings.length > 0, 'the review reported no findings');
    assert.equal(review.publicRepository, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('an edit between review and confirm is not what gets copied', async () => {
  const { cwd, artifacts } = await repo();
  try {
    const source = path.join(artifacts, 'note.txt');
    const review = await inspectArtifactCopy(cwd, ID, 'artifacts/note.txt', cwd, false);
    await writeFile(source, 'api_key=abcdefghijklmnop\n');
    await assert.rejects(copyReviewedArtifact(cwd, ID, 'artifacts/note.txt', cwd, false, review.token), /changed/);
    await assert.rejects(readFile(path.join(cwd, 'note.txt')));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('KEEP that lands during archive or delete still has its file', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-keep-race-'));
  const dir = path.join(cwd, '.arco', 'workflows', ID);
  try {
    await mkdir(path.join(dir, 'artifacts'), { recursive: true });
    await mkdir(path.join(cwd, '.arco', 'plans'), { recursive: true });
    await writeFile(path.join(cwd, '.arco', 'plans', 'p.md'), '# Plan\n');
    const note = path.join(dir, 'artifacts', 'note.txt');
    await writeFile(note, 'x'.repeat(2_000_000));
    await writeFile(path.join(dir, 'events.jsonl'), '{"seq":1,"type":"primary_text"}\n');
    const plansBefore = await readFile(path.join(cwd, '.arco', 'plans', 'p.md'), 'utf8');
    const archiving = archiveConversation(cwd, ID, { open: false, busy: false, by: 'operator' });
    const keeping = addKeep(dir, 'artifacts/note.txt', 'operator');
    const [archived, kept] = await Promise.allSettled([archiving, keeping]);
    if (kept.status === 'fulfilled' && kept.value.some((item) => item.path === 'artifacts/note.txt')) {
      assert.equal(await readFile(note, 'utf8'), 'x'.repeat(2_000_000));
    }
    if (archived.status === 'rejected') throw archived.reason;
    const purge = async (_c: string, _id: string, o: { removeDir?: (d: string) => Promise<void> }) => {
      if (o.removeDir) await o.removeDir(dir); else await rm(dir, { recursive: true, force: true });
      return { ok: true as const };
    };
    await writeFile(note, 'kept-body');
    const deleting = deleteConversation(cwd, ID, { open: false, busy: false, purge, archiveFile: archivePath(cwd, ID) });
    const keepingAgain = addKeep(dir, 'artifacts/note.txt', 'operator');
    const [removed, keptAgain] = await Promise.allSettled([deleting, keepingAgain]);
    if (keptAgain.status === 'fulfilled' && keptAgain.value.some((item) => item.path === 'artifacts/note.txt')) {
      assert.equal(await readFile(note, 'utf8'), 'kept-body');
    }
    if (removed.status === 'rejected') throw removed.reason;
    assert.equal(await readFile(path.join(cwd, '.arco', 'plans', 'p.md'), 'utf8'), plansBefore);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('media and undecodable files require acknowledgement for a public copy', async () => {
  const { cwd, artifacts } = await repo();
  try {
    await writeFile(path.join(artifacts, 'image.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('api_key=abcdefghijklmnop')]));
    await writeFile(path.join(artifacts, 'mixed'), Buffer.from([0xff, 0x61, 0x70, 0x69, 0x5f, 0x6b, 0x65, 0x79, 0x3d, 0x61, 0x62, 0x63, 0x64]));
    const review = await inspectArtifactCopy(cwd, ID, 'artifacts', cwd, true);
    assert.equal(review.files.find(f => f.rel === 'image.png')?.unscanned, true);
    assert.equal(review.files.find(f => f.rel === 'mixed')?.unscanned, true);
    assert.ok(review.files.find(f => f.rel === 'mixed')?.findings.length);
    await assert.rejects(copyReviewedArtifact(cwd, ID, 'artifacts', cwd, true, review.token), /Confirm the files/);
    await assert.rejects(readFile(path.join(cwd, 'artifacts', 'image.png')));
    await copyReviewedArtifact(cwd, ID, 'artifacts', cwd, true, review.token, undefined, true);
    assert.ok((await readFile(path.join(cwd, 'artifacts', 'image.png'))).length);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
