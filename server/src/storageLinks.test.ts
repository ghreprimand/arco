import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { archiveConversation, archivePath, restoreConversation } from './storageArchive.js';
import { compressOldLogs, deleteConversation, emptyScratch, StorageActionError } from './storageActions.js';
import { sealLiveLog } from './eventLog.js';
import { sealWorkflowLogNow } from './workflowStore.js';
import { purgeWorkflow } from './workflows/purgeWorkflow.js';
// @ts-expect-error plain ES module without types
import { unsealProjects } from '../../scripts/packaging/storage.mjs';

// Gate finding: no storage action follows a link. For each destructive or
// packing path, a link that points at .arco/plans leaves the plans folder
// byte-identical (names, sizes and contents).

const ID = 'conv-link-1';
const closed = { open: false, busy: false, by: 'operator' as const };
const unsafe = (error: unknown) => error instanceof StorageActionError && error.code === 'unsafe';

async function hashTree(root: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const name of (await readdir(rel ? path.join(root, rel) : root)).sort()) {
      const child = rel ? `${rel}/${name}` : name;
      const st = await lstat(path.join(root, child));
      if (st.isDirectory()) { lines.push(`${child}/`); await walk(child); continue; }
      lines.push(`${child} ${st.size} ${createHash('sha256').update(await readFile(path.join(root, child))).digest('hex')}`);
    }
  };
  await walk('');
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

async function withProject(fn: (p: { cwd: string; dir: string; plans: string; before: string }) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-links-'));
  const dir = path.join(cwd, '.arco', 'workflows', ID);
  const plans = path.join(cwd, '.arco', 'plans');
  try {
    await mkdir(path.join(dir, 'artifacts'), { recursive: true });
    await mkdir(path.join(dir, 'scratch'), { recursive: true });
    await mkdir(path.join(plans, '.history'), { recursive: true });
    await writeFile(path.join(plans, 'plan.md'), '# Permanent plan\n');
    await writeFile(path.join(plans, '.history', 'plan.1.md'), '# Plan v1\n');
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify({ workflowId: ID, cwd, cliSessions: [] }));
    await writeFile(path.join(dir, 'events.jsonl'), '{"seq":1,"type":"workflow_created"}\n');
    await writeFile(path.join(dir, 'artifacts', 'report.md'), 'report');
    await fn({ cwd, dir, plans, before: await hashTree(plans) });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

// Replace the conversation folder with a link to the plans folder.
async function linkConversationToPlans(dir: string, plans: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await symlink(plans, dir, 'dir');
}

test('EMPTY SCRATCH refuses a linked conversation folder', async () => {
  await withProject(async ({ cwd, dir, plans, before }) => {
    await linkConversationToPlans(dir, plans);
    await assert.rejects(emptyScratch(cwd, ID, { busy: false }), unsafe);
    assert.equal(await hashTree(plans), before);
  });
});

test('ARCHIVE refuses a linked conversation folder or archive folder, and skips a linked artifacts folder', async () => {
  await withProject(async ({ cwd, dir, plans, before }) => {
    const real = `${dir}-real`;
    await rename(dir, real);
    await symlink(plans, dir, 'dir');
    await assert.rejects(archiveConversation(cwd, ID, closed), unsafe);
    assert.equal(await hashTree(plans), before);
    await rm(dir); await rename(real, dir);

    await symlink(plans, path.join(cwd, '.arco', 'archive'), 'dir');
    await assert.rejects(archiveConversation(cwd, ID, closed), unsafe);
    assert.equal(await hashTree(plans), before);
    await rm(path.join(cwd, '.arco', 'archive'));

    await rm(path.join(dir, 'artifacts'), { recursive: true });
    await symlink(plans, path.join(dir, 'artifacts'), 'dir');
    const result = await archiveConversation(cwd, ID, closed);
    assert.ok(result.files >= 2);
    assert.ok((await lstat(path.join(dir, 'artifacts'))).isSymbolicLink(), 'the link stays and is not archived');
    assert.equal(await hashTree(plans), before);
  });
});

test('RESTORE refuses a link on the way into the conversation folder and a linked archive file', async () => {
  await withProject(async ({ cwd, dir, plans, before }) => {
    await archiveConversation(cwd, ID, closed);
    await mkdir(dir, { recursive: true });
    await rm(path.join(dir, 'artifacts'), { recursive: true, force: true });
    await symlink(plans, path.join(dir, 'artifacts'), 'dir');
    await assert.rejects(restoreConversation(cwd, ID), unsafe);
    assert.equal(await hashTree(plans), before);
    await rm(path.join(dir, 'artifacts'));

    const archive = archivePath(cwd, ID);
    await rename(archive, `${archive}.real`);
    await symlink(`${archive}.real`, archive);
    await assert.rejects(restoreConversation(cwd, ID), unsafe);
    await rm(archive); await rename(`${archive}.real`, archive);

    await linkConversationToPlans(dir, plans);
    await assert.rejects(restoreConversation(cwd, ID), unsafe);
    assert.equal(await hashTree(plans), before);
  });
});

test('DELETE refuses a linked conversation folder and a linked archive file; purge never follows a link', async () => {
  await withProject(async ({ cwd, dir, plans, before }) => {
    const purge = async (_c: string, _i: string, o: { removeDir?: (d: string) => Promise<void> }) => {
      if (o.removeDir) await o.removeDir(dir); else await rm(dir, { recursive: true, force: true });
      return { ok: true as const };
    };
    const real = `${dir}-real`;
    await rename(dir, real);
    await symlink(plans, dir, 'dir');
    await assert.rejects(deleteConversation(cwd, ID, { open: false, busy: false, purge }), unsafe);
    const purged = await purgeWorkflow(cwd, ID, { nuclear: false });
    assert.equal(purged.ok, false);
    assert.equal(await hashTree(plans), before);
    await rm(dir); await rename(real, dir);

    await mkdir(path.join(cwd, '.arco', 'archive'), { recursive: true });
    const archive = archivePath(cwd, ID);
    await symlink(path.join(plans, 'plan.md'), archive);
    await assert.rejects(deleteConversation(cwd, ID, { open: false, busy: false, purge, archiveFile: archive }), unsafe);
    assert.equal(await hashTree(plans), before);
    await rm(archive);

    // A link inside the folder is removed as a link when kept items stay.
    await writeFile(path.join(dir, 'keep.json'), JSON.stringify({ version: 1, items: [{ path: 'artifacts/report.md', reason: 'operator', at: 1 }] }));
    await symlink(plans, path.join(dir, 'plans-link'), 'dir');
    await deleteConversation(cwd, ID, { open: false, busy: false, purge });
    assert.equal(await readFile(path.join(dir, 'artifacts', 'report.md'), 'utf8'), 'report');
    assert.equal(await hashTree(plans), before);
  });
});

test('COMPRESS OLD LOGS and unseal skip a linked conversation folder', async () => {
  await withProject(async ({ cwd, dir, plans }) => {
    // A folder outside the state folder holding a large log and a sealed log.
    const outside = path.join(cwd, 'outside');
    await mkdir(outside);
    const lines = Array.from({ length: 6000 }, (_, i) => JSON.stringify({ seq: i + 1, type: 'primary_text', text: 'x'.repeat(200) }));
    await writeFile(path.join(outside, 'events.jsonl'), lines.join('\n') + '\n');
    await cp(outside, path.join(plans, 'conv'), { recursive: true });
    await sealLiveLog(path.join(plans, 'conv'), 64 * 1024);
    const before = await hashTree(plans);
    await symlink(path.join(plans, 'conv'), path.join(cwd, '.arco', 'workflows', 'linked-1'), 'dir');
    await symlink(outside, path.join(cwd, '.arco', 'workflows', 'linked-2'), 'dir');
    const out = await compressOldLogs(cwd, { isOpen: () => false, isBusy: () => false, seal: sealWorkflowLogNow });
    assert.equal(out.sealed, 0);
    assert.deepEqual((await readdir(outside)).sort(), ['events.jsonl']);
    const logs: string[] = [];
    await unsealProjects([cwd], (m: string) => logs.push(m));
    assert.ok(logs.some((m) => m.includes('linked-1')));
    assert.equal(await hashTree(plans), before);
    void dir;
  });
});
