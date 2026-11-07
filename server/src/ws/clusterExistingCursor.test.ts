import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const home = mkdtempSync(join(tmpdir(), 'arco-existing-cursor-'));
installIsolatedTestHome(home);
after(() => rmSync(home, { recursive: true, force: true }));
const { workflows } = await import('../server/state.js');
const store = await import('../clusterStore.js');
const handlers = await import('./clusterHandlers.js');

for (const action of ['create', 'add', 'http']) {
  test(`${action} refuses an existing Cursor session before cluster admission`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'arco-cursor-project-'));
    const ids: string[] = [];
    const add = (provider: string) => {
      const id = randomUUID(); ids.push(id);
      workflows.set(id, { config: { workingDirectory: cwd, primaryProvider: provider }, primary: { provider }, observers: new Set() } as never);
      return id;
    };
    const cursor = add('cursor');
    const claude = add('claude');
    const other = add('claude');
    let clusterId: string | undefined;
    const errors: string[] = [];
    const ws = { readyState: 1, OPEN: 1, send: (raw: string) => { const msg = JSON.parse(raw); if (msg.type === 'error') errors.push(msg.message); } } as never;
    handlers.initClusterHandlers({ handleUserMessage: async () => {}, handleRemoveWorkflow: () => {}, createBlankNativeWorkflow: async () => '', assertAllMembersClaudeOrCodex: async () => 'fixture_general_fence' });
    try {
      if (action === 'create') await handlers.handleClusterCreate(ws, {} as never, cwd, [claude, cursor]);
      else if (action === 'add') {
        clusterId = (await store.createCluster({ cwd, memberWorkflowIds: [claude, other] })).clusterId;
        await handlers.handleClusterMemberAdd(ws, clusterId, cursor);
        assert.deepEqual((await store.readCluster(clusterId))?.members, [claude, other]);
      }
      else {
        const { tryHandleClusterRoutes } = await import('../http/clusterRoutes.js');
        const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ cwd, memberWorkflowIds: [claude, cursor] }))]), { url: '/api/clusters', method: 'POST' });
        let status = 0;
        const res = { writeHead: (code: number) => { status = code; }, end: (body: string) => { errors.push(JSON.parse(body).error); } };
        await tryHandleClusterRoutes(req as never, res as never, { assertAllMembersClaudeOrCodex: async () => 'fixture_general_fence' } as never);
        assert.equal(status, 400);
      }
      assert.equal(errors.length, 1);
      assert.match(errors[0], /Cursor.*peer tools.*ADD FRESH/i);
    } finally {
      if (clusterId) await store.deleteCluster(clusterId);
      for (const id of ids) workflows.delete(id);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
