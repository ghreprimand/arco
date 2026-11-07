import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowState, Session } from '../workflows/types.js';
import type WebSocket from 'ws';
const home = mkdtempSync(join(tmpdir(), 'arco-steer-skills-'));
installIsolatedTestHome(home);
const engine = await import('./turnEngine.js');
const { workflows, workflowCwds } = await import('../server/state.js');
const { initWorkflowStore } = await import('../workflowStore.js');
const { settleProjectWrites } = await import('../testSupport/projectWrites.js');
after(async () => { await settleProjectWrites(); await fs.rm(home, { recursive: true, force: true }); });

for (const scope of ['project', 'builtin'] as const) test(`B122: mid-turn steering delivers the selected ${scope} skill exactly once`, async () => {
  const cwd = join(home, scope), id = `steer-${scope}`;
  await fs.mkdir(join(cwd, '.arco', 'skills', 'fixture'), { recursive: true });
  await fs.writeFile(join(cwd, '.arco', 'skills', 'fixture', 'SKILL.md'), '---\nname: Fixture rule\ndescription: A synthetic rule\n---\nKeep the fixture rule in this message.\n');
  const ws = { readyState: 1, send: () => {} } as unknown as WebSocket;
  const wf = { config: { name: 'Fixture', workingDirectory: cwd, claudeTransport: 'native' }, primary: { provider: 'claude', model: 'claude-opus-4-8' }, busy: true, observers: new Set([ws]), queue: { steering: [], followUp: [] } } as unknown as WorkflowState;
  workflows.set(id, wf); workflowCwds.set(id, cwd); await initWorkflowStore(cwd, id);
  try {
    await engine.handleUserMessage(ws, {} as Session, id, 'Use this selected skill.', 'fixture-message', undefined, true, 'steer', undefined, [{ scope, slug: scope === 'project' ? 'fixture' : 'grill-me' }]);
    const delivered = engine.drainSteerForWorker(id, ws);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].content.match(/<arco-skill /g)?.length, 1);
    if (scope === 'project') assert.match(delivered[0].content, /Keep the fixture rule in this message/);
    assert.deepEqual(engine.drainSteerForWorker(id, ws), []);
  } finally { workflows.delete(id); workflowCwds.delete(id); }
});
