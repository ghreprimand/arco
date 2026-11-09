import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, WorkflowState } from '../workflows/types.js';
import type WebSocket from 'ws';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const root = mkdtempSync(join(tmpdir(), 'arco-checkpoint-notice-'));
installIsolatedTestHome(root);
const engine = await import('./turnEngine.js');
const { workflows, workflowCwds } = await import('../server/state.js');
const { initWorkflowStore } = await import('../workflowStore.js');
const { settleProjectWrites } = await import('../testSupport/projectWrites.js');

test('a refused turn checkpoint produces one visible notice even if the callback repeats', async () => {
  const cwd = join(root, 'project'), id = 'fixture-checkpoint-skip'; mkdirSync(cwd, { recursive: true });
  const sent: any[] = [];
  const ws = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) } as unknown as WebSocket;
  const session = { id: 'fixture', workflowIds: new Set([id]), clusterIds: new Set(), clusterObserved: new Map() } as Session;
  const manager = { spawn: async (_spec: unknown, emit: (event: unknown) => void) => {
    emit({ type: 'worker_text', text: 'fixture answer' }); emit({ type: 'worker_complete', costUsd: 0, durationMs: 1 });
    return { text: 'fixture answer', costUsd: 0, durationMs: 1 };
  }, getWorkerPid: () => undefined };
  const wf = { config: { name: 'fixture', workingDirectory: cwd, primaryProvider: 'codex', primaryModel: 'fixture', primaryEffort: 'low', skipPermissions: false }, primary: { provider: 'codex', model: 'fixture', effort: 'low', skipPermissions: false }, manager, busy: false, observers: new Set([ws]), queue: { steering: [], followUp: [] }, autoHandoff: { enabled: false, afterCompactions: 5, compactions: 0, fired: false }, bgTracker: { noteBgHint: () => {}, attachParent: () => {}, detachParent: () => {} } } as unknown as WorkflowState;
  workflows.set(id, wf); workflowCwds.set(id, cwd); await initWorkflowStore(cwd, id);
  const content = 'Checkpoint skipped because this folder is too large. Limits: ARCO_CHECKPOINT_TOTAL_CAP_BYTES, ARCO_CHECKPOINT_SCAN_ENTRIES and ARCO_CHECKPOINT_SCAN_MS.';
  engine.initTurnEngine({ previewAutoDetect: { noteAgentText() {}, notePotentialDevServerStart() {} } as never, handleCreateWorkflow: async () => {}, handleHandoffRequest: async () => {}, captureCheckpoint: async args => {
    const callback = (args as { onSkipped?: (message: string) => void }).onSkipped;
    callback?.(content); callback?.(content); return null;
  } });
  try {
    await engine.handleUserMessage(ws, session, id, 'fixture request', 'fixture-client', undefined, false, undefined, undefined);
    const notices = sent.filter(message => message.type === 'system_notice' && message.content === content);
    assert.equal(notices.length, 1);
  } finally {
    workflows.delete(id); workflowCwds.delete(id); await settleProjectWrites();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
