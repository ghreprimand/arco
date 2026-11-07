import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { WorkflowState, Session } from '../workflows/types.js';
const temp = mkdtempSync(join(tmpdir(), 'arco-cold-fold-'));
installIsolatedTestHome(temp);
const { handleFoldWorkflow } = await import('./compactHandlers.js');
const native = await import('../providers/claude-native/index.js');
const { workflows, workflowCwds } = await import('../server/state.js');
const { broadcastWorkflow } = await import('../server/broadcast.js');
const { initWorkflowStore, persistAndStampSeq, flushWorkflowBuffer } = await import('../workflowStore.js');
const { settleProjectWrites } = await import('../testSupport/projectWrites.js');
const { ClaudeNativeWorker } = await import('../providers/claude-native/worker.js');
after(async () => { await settleProjectWrites(); await fs.rm(temp, { recursive: true, force: true }); });

for (const engine of ['deterministic', 'server'] as const) test(`B88: ${engine} Fold restores a saved conversation before any new turn`, async (t) => {
  // Server Fold's request is unavailable in this fixture; its documented
  // deterministic fallback must still restore history without credentials.
  t.mock.method(ClaudeNativeWorker.prototype, 'ensureStarted', async () => { throw new Error('fixture API unavailable'); });
  const cwd = join(temp, engine), id = randomUUID();
  await initWorkflowStore(cwd, id);
  persistAndStampSeq(cwd, id, { type: 'user_message_echo', workflowId: id, content: 'Saved fixture question' } as never);
  persistAndStampSeq(cwd, id, { type: 'primary_text', workflowId: id, text: 'Saved fixture answer' } as never);
  await flushWorkflowBuffer(cwd, id);
  const messages: Array<Record<string, unknown>> = [];
  const ws = { readyState: 1, send: (raw: string) => messages.push(JSON.parse(raw)) } as unknown as WebSocket;
  const wf = { config: { name: 'Fixture', workingDirectory: cwd, claudeTransport: 'native' }, primary: { provider: 'claude', model: 'claude-opus-4-8', effort: 'low' }, busy: false, queue: { steering: [], followUp: [] }, observers: new Set([ws]) } as unknown as WorkflowState;
  workflows.set(id, wf); workflowCwds.set(id, cwd);
  native.setClaudeNativeWorkflowEventBroadcast((workflowId, event) => broadcastWorkflow(workflowId, event));
  try {
    await handleFoldWorkflow(ws, {} as Session, { type: 'fold_workflow', workflowId: id, ...(engine === 'server' ? { engine: 'server' as const } : {}) });
    assert.ok(messages.some((message) => message.type === 'context_folded'), JSON.stringify(messages));
    assert.equal(wf.busy, false);
  } finally { native.disposeClaudeNativeWorker(id); workflows.delete(id); workflowCwds.delete(id); }
});
