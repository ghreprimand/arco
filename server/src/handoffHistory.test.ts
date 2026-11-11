import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = await mkdtemp(join(tmpdir(), 'arco-handoff-'));
installIsolatedTestHome(root);
after(async () => {
  await (await import('./workflowMeta.js')).settleMetaSideEffects();
  await rm(root, { recursive: true, force: true });
});
const { buildHandoffHistory, historyEligible, captureHandoffHistory, saveHandoffHistory, safeHistoryMeta } = await import('./handoffHistory.js');

const source = { workflowId: 'source', cwd: '/project', name: 'Source' };
test('handoff records a frozen immediate source without Task parentage', () => {
  const result = buildHandoffHistory(source, 12, 3, []);
  assert.equal(result[0].workflowId, 'source');
  assert.equal(result[0].throughSeq, 12);
  assert.equal(result[0].grantedAtSeq, 3);
  assert.ok(result[0].key);
  assert.equal('parentWorkflowId' in result[0], false);
});
test('flattened ancestors survive an intermediate source deletion', () => {
  const a = buildHandoffHistory(source, 12, 3, []);
  const b = buildHandoffHistory({ ...source, workflowId: 'middle' }, 25, 1, a);
  assert.deepEqual(b.map(r => r.workflowId), ['middle', 'source']);
  assert.equal(b[1].throughSeq, 12);
  assert.equal(b[1].grantedAtSeq, 1);
  assert.equal(a[0].grantedAtSeq, 3);
});
test('historical Spawn cannot inherit a later handoff grant', () => {
  const later = buildHandoffHistory(source, 12, 30, []);
  const result = buildHandoffHistory({ ...source, workflowId: 'middle' }, 25, 1, later);
  assert.deepEqual(result.map(r => r.workflowId), ['middle']);
});
test('in-place handoffs replace the same source with the latest frozen boundary', () => {
  const first = buildHandoffHistory(source, 12, 13, []);
  const second = buildHandoffHistory(source, 40, 41, first);
  assert.equal(second.length, 1);
  assert.equal(second[0].throughSeq, 40);
});
test('Chat, incognito, BLIND and ISOLATED never receive history', () => {
  assert.equal(historyEligible({ kind: 'workflow' }, 'standard'), true);
  for (const config of [{ kind: 'chat' }, { kind: 'workflow', incognito: true }]) {
    assert.equal(historyEligible(config, 'standard'), false);
  }
  for (const mode of ['blind', 'isolated']) assert.equal(historyEligible({}, mode), false);
});

async function fixture(id: string, extra = {}) {
  const cwd = join(root, 'project');
  const dir = join(cwd, '.arco', 'workflows', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ workflowId: id, cwd, name: id,
    primaryProvider: 'claude', primaryModel: 'opus', primaryEffort: 'high',
    cliSessions: [], operator: 'operator', createdAt: 1, lastActiveAt: 1, ...extra }));
  await writeFile(join(dir, 'events.jsonl'), JSON.stringify({ seq: 12, ts: 1, message: { type: 'user_message_echo', workflowId: id, content: 'earlier fact' } }) + '\n');
  return cwd;
}
test('saved ancestry survives reload, closure and intermediate deletion without copying text', async () => {
  const cwd = await fixture('ancestor');
  await fixture('child');
  const refs = await captureHandoffHistory(cwd, 'ancestor');
  await saveHandoffHistory(cwd, 'child', refs);
  const reloaded = await safeHistoryMeta(cwd, 'child');
  assert.equal(reloaded?.handoffHistory?.[0].throughSeq, 12);
  assert.equal(JSON.stringify(reloaded?.handoffHistory).includes('earlier fact'), false);
  await rm(join(cwd, '.arco', 'workflows', 'ancestor'), { recursive: true });
  assert.equal(await safeHistoryMeta(cwd, 'ancestor'), null);
  assert.equal((await safeHistoryMeta(cwd, 'child'))?.handoffHistory?.length, 1);
});
test('a source cutoff is clamped and missing, Chat or symlinked sources are unavailable', async () => {
  const cwd = await fixture('bounded');
  assert.equal((await captureHandoffHistory(cwd, 'bounded', 999))[0].throughSeq, 12);
  assert.equal((await captureHandoffHistory(cwd, 'bounded', 5))[0].throughSeq, 5);
  assert.deepEqual(await captureHandoffHistory(cwd, 'missing'), []);
  await fixture('chat-source', { kind: 'chat' });
  assert.deepEqual(await captureHandoffHistory(cwd, 'chat-source'), []);
  await symlink(join(cwd, '.arco', 'workflows', 'bounded'), join(cwd, '.arco', 'workflows', 'linked'));
  assert.equal(await safeHistoryMeta(cwd, 'linked'), null);
});
test('failed link persistence leaves no grant and lets the operation complete', async () => {
  const cwd = await fixture('save-source');
  let completed = false;
  const linked = await saveHandoffHistory(cwd, 'missing', await captureHandoffHistory(cwd, 'save-source'));
  completed = true;
  assert.equal(linked, false);
  assert.equal(completed, true);
  assert.equal(await safeHistoryMeta(cwd, 'missing'), null);
});
test('cancelled export does not replace an existing grant', async () => {
  const cwd = await fixture('cancel-target');
  const refs = await captureHandoffHistory(cwd, 'cancel-target');
  await saveHandoffHistory(cwd, 'cancel-target', refs, () => false);
  assert.equal((await safeHistoryMeta(cwd, 'cancel-target'))?.handoffHistory, undefined);
});
test('source UI resolves only saved opaque keys and refuses restricted callers', async () => {
  const { workflows } = await import('./server/state.js');
  const { tryHandleWorkflowDataRoutes } = await import('./http/workflowDataRoutes.js');
  const cwd = await fixture('ui-source');
  await fixture('ui-child');
  const refs = await captureHandoffHistory(cwd, 'ui-source');
  await saveHandoffHistory(cwd, 'ui-child', refs);
  await writeFile(join(cwd, '.arco', 'workflows', 'ui-child', 'events.jsonl'), JSON.stringify({ seq: 13, type: 'user_message_echo', content: '[HANDOFF: new session initialized for this tab.]', handoffSourceKey: refs[0].key }) + '\n');
  workflows.set('ui-child', { config: { workingDirectory: cwd } } as never);
  async function request(query: string) {
    let code = 0, body = '';
    const res = { writeHead(n: number) { code = n; }, end(s: string) { body = s; } };
    await tryHandleWorkflowDataRoutes({ url: `/api/handoff-sources?workflowId=ui-child${query}`, method: 'GET' } as never, res as never, {} as never);
    return { code, data: JSON.parse(body) };
  }
  try {
    assert.equal((await request('&source=ui-source')).code, 404, 'raw workflow ids are not keys');
    const listed = await request('');
    assert.equal(listed.data.sources[0].available, true);
    assert.equal('cwd' in listed.data.sources[0], false);
    const opened = await request(`&source=${refs[0].key}`);
    assert.equal(opened.data.config.resumeWorkflowId, 'ui-source');
    assert.equal(opened.data.throughSeq, 12);
    await rm(join(cwd, '.arco', 'workflows', 'ui-source'), { recursive: true });
    assert.equal((await request(`&source=${refs[0].key}`)).code, 404);
    workflows.get('ui-child')!.config.kind = 'chat';
    assert.equal((await request('')).code, 403);
  } finally { workflows.delete('ui-child'); }
});
