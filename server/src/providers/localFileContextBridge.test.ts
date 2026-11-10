import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const home = await mkdtemp(join(tmpdir(), 'arco-context-bridge-')); installIsolatedTestHome(home);
test.after(() => rm(home, { recursive: true, force: true }));
const { WorkerManager } = await import('../workers/WorkerManager.js');
const { OllamaProvider } = await import('./ollama.js');
const { workflows, workflowCwds } = await import('../server/state.js');
const { broadcastWorkflow } = await import('../server/broadcast.js');

test('WorkerManager forwards primary file context and its configuration', async t => {
  const priorFiles = [{ kind: 'source', path: join(home, 'file.txt'), name: 'file.txt' }];
  let config: any;
  const snapshot = { origin: 'tool', receipt: 'Saved file.txt', files: priorFiles };
  const fake = Object.assign(new EventEmitter(), { id: 'fixture', status: 'spawning', output: '', spawn() { queueMicrotask(() => { fake.emit('file_context', snapshot); fake.status = 'completed'; fake.emit('result', { text: 'done', costUsd: 0, durationMs: 1 }); }); }, kill() {} });
  t.mock.method(OllamaProvider, 'create', (_id: string, received: any) => { config = received; return fake as any; });
  const emitted: any[] = [];
  const manager = new WorkerManager();
  await manager.spawn({ id: 'bridge', task: 'fixture', provider: 'ollama', model: 'fixture', effort: 'medium' } as any, event => emitted.push(event), { cwd: home, workflowId: 'wf-bridge', priorFiles: priorFiles as any, fileContextCwd: home, fileContextInputIds: ['input'] });
  assert.deepEqual(config.priorFiles, priorFiles); assert.deepEqual(config.fileContextInputIds, ['input']);
  assert.equal(config.fileContextCwd, home);
  assert.ok(emitted.some(event => event.type === 'worker_file_context' && event.receipt === snapshot.receipt));
});

test('Incognito broadcast records file references without writing a workflow', () => {
  const id = 'wf-private-context-bridge';
  const wf = { config: { incognito: true }, incognitoEvents: [], observers: new Set() } as any;
  workflows.set(id, wf); workflowCwds.delete(id);
  try {
    broadcastWorkflow(id, { type: 'file_context', workflowId: id, origin: 'tool', receipt: 'Saved private media', files: [] });
    assert.equal(wf.incognitoEvents.length, 1); assert.equal(wf.incognitoEvents[0].type, 'file_context');
  } finally { workflows.delete(id); workflowCwds.delete(id); }
});
