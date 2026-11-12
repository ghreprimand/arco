import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { promises as fs, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-plan-revisions-')));
installIsolatedTestHome(root);
after(() => rmSync(root, { recursive: true, force: true }));
const store = await import('./planStore.js');
const architecture = await import('./architectureReview.js');
type ArchitectureReport = import('./architectureReview.js').ArchitectureReport;
const report = { report: 'facts.md', data: 'facts.json', candidates: [{ id: 'c1', title: 'Split storage', files: ['server/src/store.ts'], problem: 'Large file', proposal: 'Split it', strength: 'Worth exploring', benefits: { locality: 'One place', leverage: 'Fewer callers', tests: 'A seam' } }] } as ArchitectureReport;
let sequence = 0;
async function plan() {
  const cwd = join(root, `project-${++sequence}`); mkdirSync(cwd);
  return { cwd, plan: await store.createPlan(cwd, { title: 'Work', body: '# Work\n- [ ] Original task\n' }) };
}

test('B29: every concurrent architecture decision remains in its reference', async () => {
  const f = await plan();
  await Promise.all(Array.from({ length: 6 }, (_, i) => architecture.recordCandidateDecision(f.cwd, f.plan.id, report, 'c1', `Reason ${i}`)));
  const body = (await store.readPlanRef(f.cwd, f.plan.id, 'decisions'))!.body;
  for (let i = 0; i < 6; i++) assert.ok(body.includes(`Reason ${i}`));
});

test('B29: ADD TO PLAN preserves an intervening plan edit', async (t) => {
  const f = await plan(), original = fs.open;
  const file = join(f.cwd, '.arco', 'plans', `${f.plan.id}.md`);
  let inject = true;
  t.mock.method(fs, 'open', async (...args: any[]) => {
    const handle = await Reflect.apply(original, fs, args);
    const read = handle.readFile.bind(handle);
    handle.readFile = (async (...readArgs: any[]) => {
      const content = await Reflect.apply(read, handle, readArgs);
      if (args[0] === file && inject) {
        inject = false;
      await handle.close();
      await store.updatePlan(f.cwd, f.plan.id, { body: '# Work\n- [x] Original task\nOperator edit\n' });
      }
      return content;
    }) as typeof handle.readFile;
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await architecture.addCandidateToPlan(f.cwd, f.plan.id, report, 'c1');
  const body = (await store.readPlan(f.cwd, f.plan.id))!.body;
  assert.match(body, /\[x\] Original task/); assert.match(body, /Operator edit/); assert.match(body, /Split storage/);
});

test('B71: a stale plan body replacement is refused without losing accepted ticks', async () => {
  const f = await plan();
  const changed = f.plan.body.replace('[ ]', '[x]');
  await store.updatePlan(f.cwd, f.plan.id, { body: changed });
  await assert.rejects((store.updatePlan as Function)(f.cwd, f.plan.id, { body: f.plan.body + 'Stale text\n' }, { expectedBody: f.plan.body }), /changed|reload|conflict/i);
  assert.equal((await store.readPlan(f.cwd, f.plan.id))!.body, changed);
});

test('B186: creating a reference cannot overwrite one saved after the create dialog opened', async () => {
  const f = await plan();
  await store.writePlanRef(f.cwd, f.plan.id, 'details', '# Accepted details\n');
  const result = await (store.writePlanRef as Function)(f.cwd, f.plan.id, 'details', '# Blank create draft\n', { createOnly: true });
  assert.equal(result.ok, false);
  assert.equal((await store.readPlanRef(f.cwd, f.plan.id, 'details'))!.body, '# Accepted details\n');
});

test('B130: text-matched ticks resolve against the body actually being saved', async (t) => {
  const f = await plan();
  const clusters = await import('./clusterStore.js');
  const bridge = await import('./clusterPlanBridge.js');
  const { peerPlanTick } = await import('./clusterPeerOps.js');
  const member = randomUUID();
  const cluster = await clusters.createCluster({ cwd: f.cwd, memberWorkflowIds: [member, randomUUID()] });
  await bridge.attachExistingPlan(cluster.clusterId, f.plan.id);
  const file = join(f.cwd, '.arco', 'plans', `${f.plan.id}.md`), original = fs.open;
  let inject = true;
  t.mock.method(fs, 'open', async (...args: any[]) => {
    const handle = await Reflect.apply(original, fs, args);
    const read = handle.readFile.bind(handle);
    handle.readFile = (async (...readArgs: any[]) => {
      const content = await Reflect.apply(read, handle, readArgs);
      if (args[0] === file && inject) {
        inject = false;
      await handle.close();
      await store.updatePlan(f.cwd, f.plan.id, { body: '# Work\n- [ ] Inserted task\n- [ ] Original task\n' });
      }
      return content;
    }) as typeof handle.readFile;
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await peerPlanTick({ workflowId: member, clusterId: cluster.clusterId, broadcastSender() {}, broadcastRecipient() {} }, { taskText: 'Original task' }, () => {});
  assert.equal(result.ok, true);
  const body = (await store.readPlan(f.cwd, f.plan.id))!.body;
  assert.match(body, /\[ \] Inserted task/); assert.match(body, /\[x\] Original task/);
});

async function request(cwd: string, id: string, method: string, payload: unknown, refs = false) {
  const { tryHandleWorkflowDataRoutes } = await import('./http/workflowDataRoutes.js');
  const { workflowCwds } = await import('./server/state.js');
  workflowCwds.set('revision-fixture', cwd);
  const query = new URLSearchParams({ path: cwd, planId: id, ...(refs ? { slug: 'details' } : {}) });
  const req = Object.assign(Readable.from([JSON.stringify(payload)]), { method, url: `/api/plans${refs ? '/refs' : ''}?${query}`, headers: {} });
  let status = 0, body = '';
  const res = { writeHead(code: number) { status = code; }, end(text: string) { body = text; } };
  await tryHandleWorkflowDataRoutes(req as never, res as never, {} as never);
  return { status, body: JSON.parse(body) };
}

test('B71: the HTTP boundary returns a conflict and current plan for stale checkbox saves', async () => {
  const f = await plan(), accepted = f.plan.body.replace('[ ]', '[x]');
  await store.updatePlan(f.cwd, f.plan.id, { body: accepted });
  const result = await request(f.cwd, f.plan.id, 'PATCH', { body: f.plan.body, expectedBody: f.plan.body });
  assert.equal(result.status, 409); assert.equal(result.body.plan.body, accepted);
  assert.equal((await store.readPlan(f.cwd, f.plan.id))!.body, accepted);
});

test('B186: the HTTP create-only flag preserves an existing reference', async () => {
  const f = await plan();
  await store.writePlanRef(f.cwd, f.plan.id, 'details', '# Accepted details');
  const result = await request(f.cwd, f.plan.id, 'PUT', { body: '# Empty create draft', createOnly: true }, true);
  assert.equal(result.status, 409);
  assert.equal((await store.readPlanRef(f.cwd, f.plan.id, 'details'))!.body, '# Accepted details');
});
