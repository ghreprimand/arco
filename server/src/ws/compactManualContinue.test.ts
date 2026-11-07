// The manual COMPACT button never sends a continue message; the auto-continue
// switch applies only to automatic compactions.
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkflowState, Session } from '../workflows/types.js';
import type { WebSocket } from 'ws';
const temp = mkdtempSync(join(tmpdir(), 'arco-manual-compact-'));
installIsolatedTestHome(temp); process.env.ARCO_TEST = '1';
const native = await import('../providers/claude-native/index.js');
const engine = await import('./turnEngine.js');
const compact = await import('./compactHandlers.js');
const { settleProjectWrites } = await import('../testSupport/projectWrites.js');
const { workflows, workflowCwds } = await import('../server/state.js');
const { broadcastWorkflow } = await import('../server/broadcast.js');
const { initWorkflowStore, replayEvents } = await import('../workflowStore.js');

test('manual COMPACT with auto-continue on sends no continue message', async () => {
  const cwd = join(temp, 'project'), id = randomUUID();
  const ws = { readyState: 1, send: () => {} } as unknown as WebSocket;
  const config = { name: 'fixture', workingDirectory: cwd, primaryProvider: 'claude' as const, primaryModel: 'claude-opus-4-8', primaryEffort: 'low' as const, claudeTransport: 'native' as const, nativeCompactAutoContinue: true };
  const wf = { busy: false, config, primary: { provider: 'claude', model: 'claude-opus-4-8', effort: 'low', skipPermissions: false }, observers: new Set([ws]), queue: { steering: [], followUp: [] }, autoHandoff: { enabled: false, afterCompactions: 5, compactions: 0, fired: false } } as unknown as WorkflowState;
  workflows.set(id, wf); workflowCwds.set(id, cwd); await initWorkflowStore(cwd, id);
  native.setClaudeNativeWorkflowEventBroadcast((workflowId, event) => broadcastWorkflow(workflowId, event));
  let continues = 0;
  engine.initTurnEngine({ previewAutoDetect: {} as never, handleCreateWorkflow: async () => {}, handleHandoffRequest: async () => {}, handleCompactWorkflow: compact.handleCompactWorkflow });
  try {
    assert.equal(native.debugSeedNativeCompactProbe(id, { provider: 'claude', model: 'claude-opus-4-8', effort: 'low', cwd, workflowId: id }, [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'reply' }]), true);
    await compact.handleCompactWorkflow(ws, { id: 's', workflowIds: new Set([id]), clusterIds: new Set(), clusterObserved: new Map() } as unknown as Session, { type: 'compact_workflow', workflowId: id });
    const events = await replayEvents(cwd, id, 0);
    assert.ok(events.some((e) => e.type === 'native_compacted'), 'the manual compaction ran');
    continues = events.filter((e) => e.type === 'system_notice' && String(e.content).startsWith('[AUTO-CONTINUE]')).length
      + events.filter((e) => e.type === 'user_message_echo').length;
    assert.equal(continues, 0, 'no continue message after a manual COMPACT');
  } finally { native.disposeClaudeNativeWorker(id); workflows.delete(id); workflowCwds.delete(id); await settleProjectWrites(); rmSync(temp, { recursive: true, force: true }); }
});
