import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Session, WorkflowState } from '../workflows/types.js';
import type WebSocket from 'ws';

// Running the built-in Architecture review from the SKILLS menu sends a pick
// with scope "builtin". The turn inlines the skill body, the conversation's
// artifacts folder and the facts Arco gathers, as for any operator pick.
const temp = mkdtempSync(join(tmpdir(), 'arco-builtin-pick-')); installIsolatedTestHome(temp);
const engine = await import('./turnEngine.js');
const { workflows, workflowCwds } = await import('../server/state.js');
const { initWorkflowStore } = await import('../workflowStore.js');
const { trackRecallFixture } = await import('../testSupport/recallFixture.test-support.js');
const closeRecall = trackRecallFixture();
const { settleProjectWrites } = await import('../testSupport/projectWrites.js');
engine.initTurnEngine({ previewAutoDetect: { noteAgentText: () => {}, notePotentialDevServerStart: () => {} } as never, handleCreateWorkflow: async () => {}, handleHandoffRequest: async () => {} });
after(async () => { await settleProjectWrites(); await closeRecall(); rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

test('a builtin pick inlines the Architecture review with its facts; an unknown builtin is skipped with a notice', async () => {
  const id = randomUUID(); const cwd = join(temp, id); mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'big.ts'), 'export const a = 1;\n'.repeat(50));
  const tasks: string[] = []; const notices: string[] = [];
  const ws = { readyState: 1, send: (data: string) => { const m = JSON.parse(data); if (m.type === 'system_notice') notices.push(m.content); } } as unknown as WebSocket;
  const manager = {
    spawn: (spec: { task: string }, emit: (event: unknown) => void) => new Promise((resolve) => {
      tasks.push(spec.task);
      setImmediate(() => { emit({ type: 'worker_text', text: 'ok' }); emit({ type: 'worker_complete', costUsd: 0, durationMs: 1 }); resolve({ text: 'ok', costUsd: 0, durationMs: 1 }); });
    }),
    getWorkerPid: () => undefined,
  };
  const wf = {
    config: { name: 'Fixture', workingDirectory: cwd, primaryProvider: 'claude', primaryModel: 'fixture', primaryEffort: 'medium', skipPermissions: false, claudeTransport: 'cli' },
    primary: { provider: 'claude', model: 'fixture', effort: 'medium', skipPermissions: false },
    manager, busy: false, observers: new Set([ws]), queue: { steering: [], followUp: [] },
  } as unknown as WorkflowState;
  workflows.set(id, wf); workflowCwds.set(id, cwd);
  const session = { id: 'fixture', workflowIds: new Set([id]), clusterIds: new Set(), clusterObserved: new Map() } as Session;
  try {
    await initWorkflowStore(cwd, id);
    await engine.handleUserMessage(ws, session, id, 'Run the Architecture review on this project.', randomUUID(), undefined, false, undefined, undefined, [{ scope: 'builtin', slug: 'architecture-review' }, { scope: 'builtin', slug: 'no-such-skill' }]);
    for (let i = 0; i < 200 && tasks.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const task = tasks[0] ?? '';
    assert.match(task, /<arco-skill name="Architecture review" scope="builtin">/);
    assert.match(task, /Deletion test/);
    assert.ok(task.includes(`Artifacts folder for this conversation: ${join(cwd, '.arco', 'workflows', id, 'artifacts')}`));
    assert.match(task, /<arco-architecture-facts>[\s\S]*- src\/big\.ts: 50[\s\S]*<\/arco-architecture-facts>/);
    assert.ok(notices.some((n) => /Inlined 1 operator-picked skill .*Architecture review.*Skipped \(not found\): builtin:no-such-skill/.test(n)), notices.join('\n'));
  } finally { workflows.delete(id); workflowCwds.delete(id); }
});
