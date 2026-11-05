import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { brotliCompressSync } from 'node:zlib';
import path from 'node:path';
import { archiveConversation, archivePath, restoreConversation } from './storageArchive.js';
import { compressOldLogs, deleteConversation, emptyScratch, StorageActionError } from './storageActions.js';
import { sealWorkflowLogNow } from './workflowStore.js';
import { linkFolder } from './testSupport/links.js';

// Links at the workflows folder, the archive folder, and paths packed inside
// an archive. Plans stay byte-identical and a refused action changes nothing.

const ID = 'conv-link-2';
const closed = { open: false, busy: false, by: 'operator' as const };
const unsafe = (error: unknown) => error instanceof StorageActionError && error.code === 'unsafe';

async function hashTree(root: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let names: string[] = [];
    try { names = (await readdir(rel ? path.join(root, rel) : root)).sort(); } catch { return; }
    for (const name of names) {
      const child = rel ? `${rel}/${name}` : name;
      const st = await lstat(path.join(root, child));
      if (st.isSymbolicLink()) { lines.push(`${child} ->`); continue; }
      if (st.isDirectory()) { lines.push(`${child}/`); await walk(child); continue; }
      lines.push(`${child} ${st.size} ${createHash('sha256').update(await readFile(path.join(root, child))).digest('hex')}`);
    }
  };
  await walk('');
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function archiveBytes(entries: Array<{ path: string; body: Buffer }>, workflowId: string): Buffer {
  const chunks: Buffer[] = [Buffer.from('ARCO-ARCHIVE 1\n')];
  for (const entry of entries) {
    const header = {
      path: entry.path,
      size: entry.body.length,
      mode: 0o600,
      mtimeMs: 1,
      sha256: createHash('sha256').update(entry.body).digest('hex'),
    };
    chunks.push(Buffer.from(JSON.stringify(header) + '\n'), entry.body, Buffer.from('\n'));
  }
  chunks.push(Buffer.from(JSON.stringify({ end: true, files: entries.length, workflowId, archivedAt: 1 }) + '\n'));
  return brotliCompressSync(Buffer.concat(chunks));
}

async function project(): Promise<{ cwd: string; dir: string; plans: string; before: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-link-further-'));
  const dir = path.join(cwd, '.arco', 'workflows', ID);
  const plans = path.join(cwd, '.arco', 'plans');
  await mkdir(path.join(dir, 'artifacts'), { recursive: true });
  await mkdir(path.join(plans, 'refs'), { recursive: true });
  await writeFile(path.join(plans, 'plan.md'), '# Permanent plan\n');
  await writeFile(path.join(plans, 'refs', 'storage.md'), 'Plans are never cleaned up.\n');
  await writeFile(path.join(dir, 'events.jsonl'), '{"seq":1,"type":"workflow_created"}\n');
  await writeFile(path.join(dir, 'artifacts', 'note.txt'), 'ordinary');
  return { cwd, dir, plans, before: await hashTree(plans) };
}

test('a linked workflows folder is refused by scratch, archive, delete, compress and restore', async () => {
  const { cwd, plans, before } = await project();
  const workflows = path.join(cwd, '.arco', 'workflows');
  const outside = await mkdtemp(path.join(tmpdir(), 'arco-workflows-real-'));
  try {
    const hidden = path.join(outside, ID);
    await mkdir(hidden, { recursive: true });
    const log = Array.from({ length: 4000 }, (_, i) => JSON.stringify({ seq: i + 1, type: 'primary_text', text: 'z'.repeat(300) })).join('\n') + '\n';
    await writeFile(path.join(hidden, 'events.jsonl'), log);
    await rm(workflows, { recursive: true });
    await linkFolder(outside, workflows);
    await assert.rejects(emptyScratch(cwd, ID, { busy: false }), unsafe);
    await assert.rejects(archiveConversation(cwd, ID, closed), unsafe);
    await assert.rejects(restoreConversation(cwd, ID), unsafe);
    const purge = async () => ({ ok: true as const });
    await assert.rejects(deleteConversation(cwd, ID, { open: false, busy: false, purge }), unsafe);
    const compressed = await compressOldLogs(cwd, { isOpen: () => false, isBusy: () => false, seal: sealWorkflowLogNow });
    assert.equal(compressed.sealed, 0);
    assert.deepEqual(await readdir(hidden), ['events.jsonl']);
    assert.equal((await readFile(path.join(hidden, 'events.jsonl'))).length, Buffer.byteLength(log));
    assert.equal(await hashTree(plans), before);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('a linked archive folder is not a place delete or restore will write or remove', async () => {
  const { cwd, plans } = await project();
  try {
    const archiveBody = Buffer.from('archive-kept');
    await writeFile(path.join(plans, `${ID}.arcoarchive`), archiveBody);
    // The plans folder now holds the file reached through the link.
    const before = await hashTree(plans);
    await linkFolder(plans, path.join(cwd, '.arco', 'archive'));
    const purge = async () => ({ ok: true as const });
    await assert.rejects(deleteConversation(cwd, ID, {
      open: false, busy: false, purge, archiveFile: archivePath(cwd, ID),
    }), unsafe);
    await assert.rejects(restoreConversation(cwd, ID), unsafe);
    await assert.rejects(archiveConversation(cwd, ID, closed), unsafe);
    assert.deepEqual(await readFile(path.join(plans, `${ID}.arcoarchive`)), archiveBody);
    assert.equal(await readFile(path.join(plans, 'plan.md'), 'utf8'), '# Permanent plan\n');
    assert.equal(await hashTree(plans), before);
    assert.equal(await readFile(path.join(cwd, '.arco', 'workflows', ID, 'events.jsonl'), 'utf8'), '{"seq":1,"type":"workflow_created"}\n');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a path inside an archive cannot restore through a link or outside the conversation', async () => {
  const { cwd, dir, plans, before } = await project();
  try {
    await rm(path.join(dir, 'artifacts'), { recursive: true });
    await linkFolder(plans, path.join(dir, 'artifacts'));
    await mkdir(path.join(cwd, '.arco', 'archive'), { recursive: true });
    const throughLink = archiveBytes([{ path: 'artifacts/planted.md', body: Buffer.from('planted') }], ID);
    await writeFile(archivePath(cwd, ID), throughLink);
    await assert.rejects(restoreConversation(cwd, ID), unsafe);
    assert.equal(await hashTree(plans), before);
    assert.equal(await lstat(path.join(dir, 'artifacts')).then((st) => st.isSymbolicLink()), true);
    await rm(archivePath(cwd, ID));

    const escaped = archiveBytes([{ path: '../plans/planted.md', body: Buffer.from('escaped') }], ID);
    await writeFile(archivePath(cwd, ID), escaped);
    await assert.rejects(restoreConversation(cwd, ID), /unsafe path/);
    assert.equal(await hashTree(plans), before);
    await assert.rejects(readFile(path.join(plans, 'planted.md')));
    assert.equal(await readFile(archivePath(cwd, ID)).then((buf) => buf.length), escaped.length);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
