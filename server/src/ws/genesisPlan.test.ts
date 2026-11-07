import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { WorkflowState } from '../workflows/types.js';
const temp = mkdtempSync(join(tmpdir(), 'arco-genesis-ending-'));
installIsolatedTestHome(temp);
const { handleGenesisScaffold } = await import('./genesisHandlers.js');
const { workflows, workflowCwds } = await import('../server/state.js');
const { initWorkflowStore } = await import('../workflowStore.js');
const { settleProjectWrites } = await import('../testSupport/projectWrites.js');
const { getPublicProjectChoice } = await import('../publicProjectChoice.js');

test('Genesis plan reply preserves cwd and existing attachment, with public choice persisted', async () => {
  const cwd = join(temp, 'project'), id = randomUUID();
  await fs.mkdir(cwd);
  const messages: Array<Record<string, unknown>> = [];
  const ws = { readyState: 1, send: (raw: string) => messages.push(JSON.parse(raw)) } as unknown as WebSocket;
  const wf = { busy: false, config: { name: 'Fixture', workingDirectory: cwd, genesisSeed: { title: 'Fixture plan', spark: 'Fixture', concept: 'Fixture concept', theCase: 'Fixture case', buildDirection: 'Fixture direction', planOnly: true } }, planId: 'prior-plan', observers: new Set([ws]), primary: { provider: 'claude' } } as unknown as WorkflowState;
  workflows.set(id, wf); workflowCwds.set(id, cwd);
  await initWorkflowStore(cwd, id);
  try {
    wf.busy = true;
    await handleGenesisScaffold(ws, { type: 'genesis_scaffold', workflowId: id });
    assert.equal(messages.at(-1)?.type, 'error');
    assert.equal(await fs.stat(join(cwd, 'SPEC.md')).catch(() => null), null);
    wf.busy = false;
    await handleGenesisScaffold(ws, { type: 'genesis_scaffold', workflowId: id, publicProject: true });
    const saved = messages.find((message) => message.type === 'genesis_plan_saved');
    assert.ok(saved);
    assert.equal(saved.cwd, cwd);
    assert.equal(typeof saved.planId, 'string');
    assert.deepEqual(saved.written, ['SPEC.md', 'TODO.md']);
    assert.equal(workflowCwds.get(id), cwd);
    assert.equal(wf.planId, 'prior-plan');
    assert.equal(await getPublicProjectChoice(cwd), true);
    assert.equal(messages.some((message) => message.type === 'workflow_cwd_bound'), false);
  } finally {
    workflows.delete(id); workflowCwds.delete(id);
    await settleProjectWrites();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
