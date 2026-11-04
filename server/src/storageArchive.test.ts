import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, utimes, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { archiveConversation, archivePath, listArchives, restoreConversation } from './storageArchive.js';
import { deleteConversation, StorageActionError } from './storageActions.js';
import { sanitizePolicy, staleConversations } from './storageOverview.js';
import { scanStorage } from './storageReport.js';

// P7.5 (docs/STORAGE_PLAN.md): ARCHIVE, restore and DELETE for closed
// conversations, and the opt-in auto-archive rule. Nothing is removed before
// its archive is written and checked; kept items stay; plans are untouched.

const ID = 'conv-arch-1';
async function project(fn: (cwd: string, dir: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-archive-'));
  const dir = path.join(cwd, '.arco', 'workflows', ID);
  await mkdir(path.join(dir, 'artifacts', 'nested'), { recursive: true });
  await mkdir(path.join(cwd, '.arco', 'plans'), { recursive: true });
  await writeFile(path.join(cwd, '.arco', 'plans', 'p.md'), '# Plan\n');
  await writeFile(path.join(dir, 'meta.json'), '{"workflowId":"conv-arch-1"}');
  await writeFile(path.join(dir, 'events.jsonl'), '{"seq":1,"type":"workflow_created"}\n');
  await writeFile(path.join(dir, 'artifacts', 'nested', 'blob.bin'), randomBytes(300_000));
  await writeFile(path.join(dir, 'artifacts', 'empty.txt'), '');
  await writeFile(path.join(dir, 'artifacts', 'kept.md'), 'kept');
  await writeFile(path.join(dir, 'keep.json'), JSON.stringify({ version: 1, items: [{ path: 'artifacts/kept.md', reason: 'operator', at: 1 }] }));
  try { await fn(cwd, dir); } finally { await rm(cwd, { recursive: true, force: true }); }
}
const closed = { open: false, busy: false, by: 'operator' as const };
const isCode = (code: string) => (e: unknown) => e instanceof StorageActionError && e.code === code;

test('archive keeps kept items in place, restores byte for byte, and never touches plans', async () => {
  await project(async (cwd, dir) => {
    const blob = await readFile(path.join(dir, 'artifacts', 'nested', 'blob.bin'));
    const when = new Date('2026-01-02T03:04:05Z');
    await utimes(path.join(dir, 'events.jsonl'), when, when);
    if (process.platform !== 'win32') await symlink(path.join(cwd, '.arco', 'plans', 'p.md'), path.join(dir, 'artifacts', 'plan-link'));
    await assert.rejects(archiveConversation(cwd, ID, { ...closed, open: true }), isCode('open'));
    const result = await archiveConversation(cwd, ID, closed);
    assert.equal(result.files, 5); // meta, events, blob, empty, keep.json
    assert.ok(existsSync(archivePath(cwd, ID)));
    assert.deepEqual((await listArchives(cwd)).map((a) => a.workflowId), [ID]);
    // Only kept items (and the link, never followed) remain.
    const left = (await readdir(path.join(dir, 'artifacts'))).sort();
    assert.deepEqual(left, process.platform !== 'win32' ? ['kept.md', 'plan-link'] : ['kept.md']);
    assert.equal(existsSync(path.join(dir, 'meta.json')), false);
    assert.equal(await readFile(path.join(cwd, '.arco', 'plans', 'p.md'), 'utf8'), '# Plan\n');
    await assert.rejects(archiveConversation(cwd, ID, closed), isCode('exists'));
    const report = await scanStorage(path.join(cwd, '.arco'), null);
    assert.ok(report.buckets.archives.bytes > 0);
    const restored = await restoreConversation(cwd, ID);
    assert.equal(restored.files, 5);
    assert.deepEqual(await readFile(path.join(dir, 'artifacts', 'nested', 'blob.bin')), blob);
    assert.equal(await readFile(path.join(dir, 'artifacts', 'empty.txt'), 'utf8'), '');
    assert.equal((await stat(path.join(dir, 'events.jsonl'))).mtimeMs, when.getTime());
    assert.equal(existsSync(archivePath(cwd, ID)), false);
    const log = (await readFile(path.join(cwd, '.arco', 'storage-actions.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l).action);
    assert.deepEqual(log, ['archive', 'restore']);
  });
});

test('restore refuses to overwrite, and a damaged archive restores nothing and is kept', async () => {
  await project(async (cwd, dir) => {
    await archiveConversation(cwd, ID, closed);
    await writeFile(path.join(dir, 'meta.json'), '{"other":true}');
    await assert.rejects(restoreConversation(cwd, ID), isCode('exists'));
    assert.equal(await readFile(path.join(dir, 'meta.json'), 'utf8'), '{"other":true}');
    await rm(path.join(dir, 'meta.json'));
    const file = archivePath(cwd, ID);
    const bytes = await readFile(file);
    await writeFile(file, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await assert.rejects(restoreConversation(cwd, ID));
    assert.ok(existsSync(file));
  });
});

test('archive and delete stop on an unreadable or whole-conversation KEEP', async () => {
  await project(async (cwd, dir) => {
    await writeFile(path.join(dir, 'keep.json'), '{');
    await assert.rejects(archiveConversation(cwd, ID, closed), isCode('keep_unreadable'));
    const purge = async () => ({ ok: true });
    await assert.rejects(deleteConversation(cwd, ID, { open: false, busy: false, purge }), isCode('keep_unreadable'));
    await writeFile(path.join(dir, 'keep.json'), JSON.stringify({ version: 1, items: [{ path: '.', reason: 'operator', at: 1 }] }));
    await assert.rejects(archiveConversation(cwd, ID, closed), isCode('kept'));
    await assert.rejects(deleteConversation(cwd, ID, { open: false, busy: false, purge }), isCode('kept'));
    assert.ok(existsSync(path.join(dir, 'meta.json')));
  });
});

test('delete leaves kept items, removes an archive, and refuses an open conversation', async () => {
  await project(async (cwd, dir) => {
    const purged: string[] = [];
    const purge = async (_cwd: string, id: string, o: { removeDir?: (d: string) => Promise<void> }) => {
      purged.push(id);
      if (o.removeDir) await o.removeDir(dir); else await rm(dir, { recursive: true, force: true });
      return { ok: true };
    };
    await assert.rejects(deleteConversation(cwd, ID, { open: true, busy: false, purge }), isCode('open'));
    const result = await deleteConversation(cwd, ID, { open: false, busy: false, purge, archiveFile: archivePath(cwd, ID) });
    assert.deepEqual(purged, [ID]);
    assert.equal(result.keptItems, 1);
    assert.deepEqual((await readdir(dir)).sort(), ['artifacts', 'keep.json']);
    assert.deepEqual(await readdir(path.join(dir, 'artifacts')), ['kept.md']);
    assert.equal(await readFile(path.join(cwd, '.arco', 'plans', 'p.md'), 'utf8'), '# Plan\n');
    // An archived conversation: delete removes the archive too.
    await rm(path.join(dir, 'keep.json'));
    await writeFile(path.join(dir, 'meta.json'), '{}');
    await archiveConversation(cwd, ID, closed);
    await deleteConversation(cwd, ID, { open: false, busy: false, purge, archiveFile: archivePath(cwd, ID) });
    assert.equal(existsSync(archivePath(cwd, ID)), false);
  });
});

test('the auto-archive rule is off by default and picks only long-closed, unkept conversations', async () => {
  assert.equal(sanitizePolicy({}).autoArchiveClosedDays, null);
  assert.equal(sanitizePolicy({ autoArchiveClosedDays: 0 }).autoArchiveClosedDays, null);
  assert.equal(sanitizePolicy({ autoArchiveClosedDays: 30 }).autoArchiveClosedDays, 30);
  assert.equal(sanitizePolicy({ budgetGiB: -5 }).budgetGiB, 100);
  assert.equal(sanitizePolicy({}).budgetNotice, true);
  await project(async (cwd, dir) => {
    const old = new Date(Date.now() - 40 * 86_400_000);
    for (const name of ['meta.json', 'events.jsonl']) await utimes(path.join(dir, name), old, old);
    assert.deepEqual(await staleConversations(cwd, 30), [ID]);
    assert.deepEqual(await staleConversations(cwd, 60), []);
    await writeFile(path.join(dir, 'keep.json'), JSON.stringify({ version: 1, items: [{ path: '.', reason: 'operator', at: 1 }] }));
    assert.deepEqual(await staleConversations(cwd, 30), []);
  });
});
