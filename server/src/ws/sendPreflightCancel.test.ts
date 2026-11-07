import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, WorkflowState } from '../workflows/types.js';
import type WebSocket from 'ws';
const home = mkdtempSync(join(tmpdir(), 'arco-preflight-stop-'));
installIsolatedTestHome(home);
const engine = await import('./turnEngine.js');
const { workflows, workflowCwds } = await import('../server/state.js');
const { initWorkflowStore } = await import('../workflowStore.js');
const { settleProjectWrites } = await import('../testSupport/projectWrites.js');
const { trackRecallFixture } = await import('../testSupport/recallFixture.test-support.js');
const closeRecall = trackRecallFixture();
after(async () => { await settleProjectWrites(); await closeRecall(); await fs.rm(home, { recursive: true, force: true }); });

for (const cancelled of [true, false]) test(`B121: ordinary send preflight respects STOP (${cancelled})`, async (t) => {
  const cwd = join(home, String(cancelled)), id = `preflight-${cancelled}`;
  await fs.mkdir(cwd); await fs.writeFile(join(cwd, 'input.txt'), 'fixture context');
  const messages: Array<Record<string, unknown>> = [];
  const ws = { readyState: 1, send: (raw: string) => messages.push(JSON.parse(raw)) } as unknown as WebSocket;
  const session = { id, workflowIds: new Set([id]), clusterIds: new Set(), clusterObserved: new Map() } as Session;
  const tasks: string[] = [];
  const manager = { spawn: async (spec: { task: string }, emit: (event: unknown) => void) => { tasks.push(spec.task); emit({ type: 'worker_text', text: 'answer' }); emit({ type: 'worker_complete', costUsd: 0, durationMs: 1 }); return { text: 'answer', costUsd: 0, durationMs: 1 }; }, getWorkerPid: () => undefined };
  const wf = { config: { name: 'fixture', workingDirectory: cwd, primaryProvider: 'codex', primaryModel: 'fixture', primaryEffort: 'low' }, primary: { provider: 'codex', model: 'fixture', effort: 'low', skipPermissions: false }, manager, busy: false, observers: new Set([ws]), queue: { steering: [], followUp: [] }, bgTracker: { noteBgHint() {}, attachParent() {}, detachParent() {} } } as unknown as WorkflowState;
  workflows.set(id, wf); workflowCwds.set(id, cwd); await initWorkflowStore(cwd, id);
  engine.initTurnEngine({ previewAutoDetect: { noteAgentText() {}, notePotentialDevServerStart() {} } as never, handleCreateWorkflow: async () => {}, handleHandoffRequest: async () => {}, captureCheckpoint: async () => null });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  const read = fs.readFile;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => { if (String(args[0]) === await fs.realpath(join(cwd, 'input.txt'))) { entered(); await held; } return read(...args); });
  syncBuiltinESMExports();
  try {
    const pending = engine.handleUserMessage(ws, session, id, 'Read @file:input.txt', 'sent-fixture', undefined, false, undefined, undefined);
    await started;
    if (cancelled) engine.revokeBusy(wf);
    release(); await pending;
    assert.equal(tasks.length, cancelled ? 0 : 1);
    assert.equal(wf.queue.steering.length + wf.queue.followUp.length, 0);
    if (cancelled) assert.ok(messages.some(m => m.type === 'queued_message_cancelled' && m.clientMessageId === 'sent-fixture'));
  } finally { release(); workflows.delete(id); workflowCwds.delete(id); t.mock.restoreAll(); syncBuiltinESMExports(); }
});
