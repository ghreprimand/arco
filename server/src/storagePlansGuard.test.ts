import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { archiveConversation, archivePath, restoreConversation } from './storageArchive.js';
import { compressOldLogs, deleteConversation, emptyScratch, StorageActionError } from './storageActions.js';
import { sealWorkflowLogNow } from './workflowStore.js';

// P7.4/P7.5: KEEP survives archive, scratch cleanup, compress, restore and
// delete. Plans stay byte-for-byte, including when scratch points at them.

const ID = 'conv-guard-1';
const closed = { open: false, busy: false, by: 'operator' as const };

async function hashTree(root: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const abs = rel ? path.join(root, rel) : root;
    for (const name of (await readdir(abs)).sort()) {
      const child = rel ? `${rel}/${name}` : name;
      const st = await lstat(path.join(abs, name));
      if (st.isDirectory()) { await walk(child); continue; }
      const buf = await readFile(path.join(abs, name));
      lines.push(`${child} ${createHash('sha256').update(buf).digest('hex')}`);
    }
  };
  await walk('');
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

async function fixture(): Promise<{ cwd: string; dir: string; plans: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-plans-guard-'));
  const dir = path.join(cwd, '.arco', 'workflows', ID);
  const plans = path.join(cwd, '.arco', 'plans');
  await mkdir(path.join(dir, 'artifacts'), { recursive: true });
  await mkdir(path.join(dir, 'scratch'), { recursive: true });
  await mkdir(path.join(plans, 'refs'), { recursive: true });
  await writeFile(path.join(plans, 'plan.md'), '# Permanent plan\n');
  await writeFile(path.join(plans, 'refs', 'storage.md'), 'Plans are never cleaned up.\n');
  const lines: string[] = [];
  for (let seq = 1; seq <= 6000; seq++) lines.push(JSON.stringify({ seq, type: 'primary_text', text: `body ${seq} ${'x'.repeat(200)}` }));
  await writeFile(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n');
  await writeFile(path.join(dir, 'artifacts', 'kept.md'), 'keep this artifact');
  await writeFile(path.join(dir, 'artifacts', 'drop.md'), 'archive me');
  await writeFile(path.join(dir, 'scratch', 'kept.iso'), 'keep this image');
  await writeFile(path.join(dir, 'scratch', 'temp.o'), 'delete me');
  await writeFile(path.join(dir, 'keep.json'), JSON.stringify({ version: 1, items: [
    { path: 'artifacts/kept.md', reason: 'operator', at: 1 },
    { path: 'scratch/kept.iso', reason: 'size-warning', at: 2 },
  ] }));
  return { cwd, dir, plans };
}

test('kept files survive archive, empty scratch, compress, restore and delete, and plans stay byte-identical', async () => {
  const { cwd, dir, plans } = await fixture();
  try {
    const before = await hashTree(plans);
    const purge = async (_cwd: string, _id: string, o: { removeDir?: (d: string) => Promise<void> }) => {
      if (o.removeDir) await o.removeDir(dir);
      else await rm(dir, { recursive: true, force: true });
      return { ok: true as const };
    };
    await assert.rejects(archiveConversation(cwd, ID, { ...closed, open: true }), (error: unknown) => error instanceof StorageActionError && error.code === 'open');
    await assert.rejects(emptyScratch(cwd, ID, { busy: true }), (error: unknown) => error instanceof StorageActionError && error.code === 'busy');
    await assert.rejects(deleteConversation(cwd, ID, { open: false, busy: true, purge }), (error: unknown) => error instanceof StorageActionError && error.code === 'open');
    assert.equal(await readFile(path.join(dir, 'scratch', 'temp.o'), 'utf8'), 'delete me');

    const compressed = await compressOldLogs(cwd, {
      isOpen: () => false,
      isBusy: () => false,
      seal: sealWorkflowLogNow,
    });
    assert.equal(compressed.sealed, 1);
    assert.equal(await readFile(path.join(dir, 'artifacts', 'kept.md'), 'utf8'), 'keep this artifact');

    await archiveConversation(cwd, ID, closed);
    assert.equal(await readFile(path.join(dir, 'artifacts', 'kept.md'), 'utf8'), 'keep this artifact');
    assert.equal(await readFile(path.join(dir, 'scratch', 'kept.iso'), 'utf8'), 'keep this image');
    await writeFile(path.join(dir, 'scratch', 'later.tmp'), 'later');
    const emptied = await emptyScratch(cwd, ID, { busy: false });
    assert.ok(emptied.removedFiles >= 1);
    assert.equal(await readFile(path.join(dir, 'scratch', 'kept.iso'), 'utf8'), 'keep this image');

    await restoreConversation(cwd, ID);
    assert.equal(await readFile(path.join(dir, 'artifacts', 'drop.md'), 'utf8'), 'archive me');
    assert.equal(await readFile(path.join(dir, 'artifacts', 'kept.md'), 'utf8'), 'keep this artifact');

    await deleteConversation(cwd, ID, { open: false, busy: false, purge, archiveFile: archivePath(cwd, ID) });
    assert.equal(await readFile(path.join(dir, 'artifacts', 'kept.md'), 'utf8'), 'keep this artifact');
    assert.equal(await readFile(path.join(dir, 'scratch', 'kept.iso'), 'utf8'), 'keep this image');
    assert.equal(await hashTree(plans), before);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('EMPTY SCRATCH does not follow a scratch symlink into the plans folder', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-plans-link-'));
  const dir = path.join(cwd, '.arco', 'workflows', ID);
  const plans = path.join(cwd, '.arco', 'plans');
  try {
    await mkdir(dir, { recursive: true });
    await mkdir(path.join(plans, 'refs'), { recursive: true });
    await writeFile(path.join(plans, 'plan.md'), '# Permanent plan\n');
    await writeFile(path.join(plans, 'refs', 'storage.md'), 'Plans are never cleaned up.\n');
    await symlink(path.relative(dir, plans), path.join(dir, 'scratch'));
    const before = await hashTree(plans);
    // Refused: a linked scratch folder is never followed.
    await assert.rejects(emptyScratch(cwd, ID, { busy: false }), (error: unknown) => error instanceof StorageActionError && error.code === 'unsafe');
    assert.equal(await hashTree(plans), before);
    assert.equal(await readFile(path.join(plans, 'plan.md'), 'utf8'), '# Permanent plan\n');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a symlink inside scratch is removed as a link and the plan it names stays', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-plans-inner-link-'));
  const dir = path.join(cwd, '.arco', 'workflows', ID);
  const plans = path.join(cwd, '.arco', 'plans');
  try {
    await mkdir(path.join(dir, 'scratch'), { recursive: true });
    await mkdir(plans, { recursive: true });
    await writeFile(path.join(plans, 'plan.md'), '# Permanent plan\n');
    await symlink(path.relative(path.join(dir, 'scratch'), path.join(plans, 'plan.md')), path.join(dir, 'scratch', 'plan-link'));
    await emptyScratch(cwd, ID, { busy: false });
    assert.equal(await readFile(path.join(plans, 'plan.md'), 'utf8'), '# Permanent plan\n');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
