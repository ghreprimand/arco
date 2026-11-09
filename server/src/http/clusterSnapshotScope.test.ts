import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';

const root = mkdtempSync(join(tmpdir(), 'arco-snapshot-scope-'));
installIsolatedTestHome(root);

test('snapshot scope uses canonical folders, without trimming names or changing restore paths', async t => {
  const cwd = join(root, 'project'), alias = join(root, 'alias');
  await fs.mkdir(cwd);
  await fs.symlink(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const different = join(root, process.platform === 'win32' ? 'project-other' : 'project ');
  await fs.mkdir(different);
  const cases = [cwd, alias, different, join(root, 'missing')];
  const rows = await Promise.all(cases.map(async (sourceCwd, index) => {
    const id = randomUUID(), directory = join(process.env.ARCO_HOME!, 'cluster-snapshots', id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id, name: `Snapshot ${index}`, sourceCwd, createdAt: '2026-01-01', memberCount: 1 }));
    return { id, sourceCwd };
  }));
  const { listSnapshots } = await import('../clusterSnapshots.js');
  for (const scope of [cwd, alias, ...(process.platform === 'win32' ? [cwd.toUpperCase().replaceAll('\\', '/')] : [])]) {
    const listed = await (listSnapshots as any)(scope);
    for (const [index, row] of rows.entries()) {
      const actual = listed.find((snapshot: any) => snapshot.id === row.id);
      assert.equal(actual?.sameFolder, index < 2, row.sourceCwd);
      assert.equal(actual?.sourceCwd, row.sourceCwd, 'restore destination remains the saved spelling');
    }
  }
  assert.ok((await listSnapshots()).every(row => !('sameFolder' in row)), 'unscoped list retains its contract');

  const { workflowCwds } = await import('../server/state.js');
  const { tryHandleClusterSnapshotRoutes } = await import('./clusterSnapshotRoutes.js');
  const workflowId = randomUUID(); workflowCwds.set(workflowId, cwd);
  t.after(() => workflowCwds.delete(workflowId));
  const request = async (folder: string) => {
    let status = 0, body: any;
    const req = { method: 'GET', url: `/api/cluster-snapshots?${new URLSearchParams({ cwd: folder })}`, headers: {} };
    const res = { writeHead(value: number) { status = value; }, end(value: string) { body = JSON.parse(value); } };
    assert.equal(await tryHandleClusterSnapshotRoutes(req as never, res as never), true);
    return { status, body };
  };
  const response = await request(alias);
  assert.equal(response.status, 200);
  assert.equal(response.body.snapshots.filter((row: any) => row.sameFolder).length, 2);
  assert.equal((await request(different)).status, 403, 'unregistered scope does not gain filesystem authority');
});

test.after(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); });
