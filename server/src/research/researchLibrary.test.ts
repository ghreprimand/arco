import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as clusterStore from '../clusterStore.js';
import { writeMeta, workflowMetaSeed } from '../workflowMeta.js';
import { closeResearch, closedResearchRecordPath } from './researchClose.js';
import { finishResearchReopen, prepareResearchReopen } from './researchCreate.js';
import { createResearchFolder, writeProjectFiles } from './researchFolder.js';
import { addToLibrary, forgetProject, libraryRows, liveResearchClusters, locateProject, readLibrary } from './researchLibrary.js';
import { configureResearch } from './researchRounds.js';
import { forgetResearch, initResearch, loadResearch, type ResearchState } from './researchState.js';

async function tempRoot(): Promise<string> { return fs.mkdtemp(join(tmpdir(), 'arco-research-library-')); }

function state(folder: string, over: Partial<ResearchState> = {}): ResearchState {
  return {
    schemaVersion: 1, projectId: randomUUID(), clusterId: randomUUID(), folder, membersCwd: join(folder, 'members'),
    name: 'Heat pump', brief: 'Which heat pump?\nBudget 9000.', blind: true, createdAt: new Date().toISOString(), directorWorkflowId: randomUUID(),
    researchers: [{ workflowId: randomUUID(), letter: 'A', provider: 'claude', model: 'sonnet' }, { workflowId: randomUUID(), letter: 'B', provider: 'ollama', model: 'qwen3:32b' }],
    rounds: [], targetedBeforeRounds: [], ...over,
  };
}

test('the library shows a closed project from its folder, and a folder holding another project as missing', async () => {
  const root = await tempRoot();
  const s = state(await createResearchFolder(root, 'Heat pump', new Date('2026-11-01T00:00:00Z')), { closedAt: '2026-11-02T00:00:00Z' });
  await writeProjectFiles(s);
  await addToLibrary({ projectId: s.projectId, folder: s.folder, name: s.name, createdAt: s.createdAt });
  const other = state(await createResearchFolder(root, 'Other', new Date('2026-11-01T00:00:00Z')));
  await writeProjectFiles(other);
  await addToLibrary({ projectId: randomUUID(), folder: other.folder, name: 'Gone', createdAt: other.createdAt });
  const rows = await libraryRows(new Map());
  const closed = rows.find((r) => r.projectId === s.projectId)!;
  assert.deepEqual({ status: closed.status, question: closed.question, researchers: closed.researchers, rounds: closed.rounds },
    { status: 'closed', question: 'Which heat pump?', researchers: 2, rounds: 0 });
  assert.equal(rows.find((r) => r.name === 'Gone')?.status, 'missing');
  assert.equal((await libraryRows(new Map([[s.projectId, 'cluster-1']]))).find((r) => r.projectId === s.projectId)?.status, 'open');
});

test('an older project in the research folder is added once, and a forgotten one is not added back', async () => {
  const root = await tempRoot();
  const { patchSettings } = await import('../settings.js');
  await patchSettings({ researchFolder: root });
  try {
    const folder = await createResearchFolder(root, 'Older', new Date('2026-10-01T00:00:00Z'));
    // A manifest written before the library: no projectId.
    await fs.writeFile(join(folder, 'research.json'), JSON.stringify({ schemaVersion: 1, name: 'Older', brief: 'Old question', status: 'closed', createdAt: '2026-10-01T00:00:00Z', researchers: [], rounds: [] }));
    const first = (await libraryRows(new Map())).filter((r) => r.folder === folder);
    assert.equal(first.length, 1);
    assert.equal(first[0].status, 'closed');
    await libraryRows(new Map());
    assert.equal((await readLibrary()).filter((e) => e.folder === folder).length, 1);
    assert.equal(await forgetProject(first[0].projectId), true);
    assert.equal((await libraryRows(new Map())).some((r) => r.folder === folder), false);
    assert.equal(await fs.stat(folder).then(() => true), true);
  } finally {
    await patchSettings({ researchFolder: '' });
  }
});

test('LOCATE accepts only the project\'s own folder and moves the kept record with it', async () => {
  const root = await tempRoot();
  const s = state(await createResearchFolder(root, 'Moved', new Date('2026-11-01T00:00:00Z')), { closedAt: '2026-11-02T00:00:00Z' });
  await writeProjectFiles(s);
  await addToLibrary({ projectId: s.projectId, folder: s.folder, name: s.name, createdAt: s.createdAt });
  await fs.mkdir(join(researchHome(), 'closed'), { recursive: true });
  await fs.writeFile(closedResearchRecordPath(s.projectId), JSON.stringify(s));
  const moved = join(root, 'elsewhere');
  await fs.rename(s.folder, moved);
  assert.equal((await libraryRows(new Map())).find((r) => r.projectId === s.projectId)?.status, 'missing');
  const stranger = state(await createResearchFolder(root, 'Stranger', new Date()));
  await writeProjectFiles(stranger);
  assert.deepEqual(await locateProject(s.projectId, stranger.folder), { ok: false, code: 'not_this_project' });
  assert.deepEqual(await locateProject(s.projectId, moved), { ok: true });
  assert.equal((await libraryRows(new Map())).find((r) => r.projectId === s.projectId)?.status, 'closed');
  assert.equal(JSON.parse(await fs.readFile(closedResearchRecordPath(s.projectId), 'utf8')).folder, moved);
});

function researchHome(): string { return join(closedResearchRecordPath('x'), '..', '..'); }

test('REOPEN continues the letters, keeps the earlier panel as removed and releases a round left open', async () => {
  const root = await tempRoot();
  const folder = await createResearchFolder(root, 'Reopen', new Date('2026-11-01T00:00:00Z'));
  const s = state(folder, { rounds: [{ n: 1, text: 'Compare.', startedAt: '2026-11-01T01:00:00Z', deadline: '2026-11-01T02:00:00Z', targeted: [],
    entries: { A: { state: 'replied', report: 'A says X.' }, B: { state: 'waiting' } } }] });
  const cluster = await clusterStore.createCluster({ cwd: folder, memberWorkflowIds: [s.directorWorkflowId, ...s.researchers.map((r) => r.workflowId)], research: { projectId: s.projectId }, taskBoardMode: 'none' });
  s.clusterId = cluster.clusterId;
  await initResearch(s);
  await writeProjectFiles(s);
  await addToLibrary({ projectId: s.projectId, folder, name: s.name, createdAt: s.createdAt });
  const woken: string[] = [];
  configureResearch({ enqueue: async () => undefined, mintMsgId: () => randomUUID(), wake: (id) => { woken.push(id); }, isBusy: () => false,
    pendingMail: async () => 0, clusterIdFor: () => undefined, notify: () => undefined, now: () => Date.now() });
  assert.equal((await closeResearch(cluster.clusterId, { moveUnsent: false, isBusy: () => false, waitMs: 0 })).ok, true);
  await clusterStore.deleteCluster(cluster.clusterId);
  forgetResearch(cluster.clusterId);

  const msg = { type: 'cluster_create_from_scratch' as const, cwd: '', research: { name: 'x', brief: 'x', reopen: { projectId: s.projectId, resumeDirector: true } },
    members: [{ provider: 'claude' as const, model: 'sonnet' }, { provider: 'ollama' as const, model: 'fixture' }, { provider: 'ollama' as const, model: 'fixture' }] };
  assert.deepEqual(await prepareResearchReopen(msg, await liveResearchClusters()), { refusal: 'director_conversation_missing' });
  await writeMeta(folder, workflowMetaSeed(folder, s.directorWorkflowId, { name: 'Research Director', primaryProvider: 'codex', primaryModel: 'gpt-fixture' } as never, { provider: 'codex', model: 'gpt-fixture' as never, effort: 'high' as never }));
  const prepared = await prepareResearchReopen(msg, await liveResearchClusters());
  assert.ok(!('refusal' in prepared));
  assert.equal(prepared.reopen?.resumeDirectorId, s.directorWorkflowId);
  assert.deepEqual(prepared.msg.members.map((m) => [m.provider, m.displayName]), [['codex', 'Research Director'], ['ollama', 'Researcher C'], ['ollama', 'Researcher D']]);

  const newCluster = randomUUID();
  const { state: reopened, released } = await finishResearchReopen(prepared, newCluster, [s.directorWorkflowId, randomUUID(), randomUUID()], new Date('2026-11-03T00:00:00Z'));
  assert.deepEqual(released, [1]);
  assert.equal(reopened.closedAt, undefined);
  assert.deepEqual(reopened.researchers.map((r) => [r.letter, !!r.removedAt, r.joinedFromRound ?? null]), [['A', true, null], ['B', true, null], ['C', false, 2], ['D', false, 2]]);
  assert.equal(reopened.rounds[0].entries.B.state, 'stopped');
  assert.equal(await fs.readFile(join(folder, 'rounds', 'round-1', 'report-a.md'), 'utf8').then((t) => t.includes('A says X.')), true);
  const manifest = JSON.parse(await fs.readFile(join(folder, 'research.json'), 'utf8'));
  assert.deepEqual([manifest.status, manifest.projectId], ['open', s.projectId]);
  assert.equal((await loadResearch(newCluster))?.directorWorkflowId, s.directorWorkflowId);
  assert.deepEqual(woken, []);
});
