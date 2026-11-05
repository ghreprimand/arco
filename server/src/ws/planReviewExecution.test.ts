import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerConfig } from '@arco/shared';
import type { Session, WorkflowState } from '../workflows/types.js';
import type { WebSocket } from 'ws';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';

const root = mkdtempSync(join(tmpdir(), 'arco-plan-review-'));
installIsolatedTestHome(root);
after(async () => { await settleProjectWrites(); rmSync(root, { recursive: true, force: true }); });
const engine = await import('./turnEngine.js');
const { workflows, workflowCwds } = await import('../server/state.js');
const { initWorkflowStore, flushAll } = await import('../workflowStore.js');
const { settleProjectWrites } = await import('../testSupport/projectWrites.js');

test('plan review dispatches without project tools and is refused while busy', async () => {
  const cwd = join(root, 'project'); mkdirSync(cwd); const id = 'review-fixture';
  const sent: Array<Record<string, unknown>> = [];
  const ws = { readyState: 1, send: (body: string) => sent.push(JSON.parse(body)) } as unknown as WebSocket;
  const session = { id: 'fixture', workflowIds: new Set([id]), clusterIds: new Set(), clusterObserved: new Map() } as Session;
  let options: WorkerConfig | undefined;
  const manager = { spawn: (_spec: unknown, emit: (event: unknown) => void, config: WorkerConfig) => {
    options = config; emit({ type: 'worker_text', text: '# Plan\n- [ ] First' }); emit({ type: 'worker_complete', costUsd: 0, durationMs: 1 });
    return Promise.resolve({ text: 'fixture', costUsd: 0, durationMs: 1 });
  }, getWorkerPid: () => undefined };
  const wf = { config: { name: 'fixture', workingDirectory: cwd, primaryProvider: 'ollama', primaryModel: 'fixture', primaryEffort: 'medium', skipPermissions: false },
    primary: { provider: 'ollama', model: 'fixture', effort: 'medium' }, manager, busy: false, observers: new Set([ws]),
    queue: { steering: [], followUp: [] }, autoHandoff: { enabled: false, warnAt: 75, autoAt: 90, warnFired: false, autoFired: false },
    bgTracker: { noteBgHint: () => {}, attachParent: () => {}, detachParent: () => {} } } as unknown as WorkflowState;
  workflows.set(id, wf); workflowCwds.set(id, cwd); await initWorkflowStore(cwd, id);
  engine.initTurnEngine({ previewAutoDetect: { noteAgentText: () => {}, notePotentialDevServerStart: () => {} } as never, handleCreateWorkflow: async () => {}, handleHandoffRequest: async () => {} });
  try {
    await engine.handleUserMessage(ws, session, id, 'Draft a plan', 'one', undefined, false, undefined, 'plan-review');
    assert.equal(options?.interactionMode, 'chat');
    assert.equal(options?.sandbox, 'read-only');
    assert.equal(options?.disableProviderHooks, true);
    assert.equal(options?.chatWebAccess, false);
    wf.busy = true; options = undefined;
    await engine.handleUserMessage(ws, session, id, 'Draft a plan', 'two', undefined, false, undefined, 'plan-review');
    assert.equal(options, undefined);
    assert.ok(sent.some((message) => message.type === 'system_notice' && String(message.content).includes('PLAN DRAFT NOT STARTED')));
  } finally { workflows.delete(id); workflowCwds.delete(id); await flushAll(); }
});

test('a normal follow-up queued during plan review returns to agent mode', async () => {
  const cwd = join(root, 'queued-project'); mkdirSync(cwd); const id = 'review-queue-fixture';
  let checkpointDone!: () => void;
  const checkpoint = new Promise<void>((resolve) => { checkpointDone = resolve; });
  const ws = { readyState: 1, send: (body: string) => { if (JSON.parse(body).type === 'checkpoint_created') checkpointDone(); } } as unknown as WebSocket;
  const session = { id: 'fixture', workflowIds: new Set([id]), clusterIds: new Set(), clusterObserved: new Map() } as Session;
  const calls: Array<{ options: WorkerConfig; reply: () => void }> = [];
  const manager = { spawn: (_spec: unknown, emit: (event: unknown) => void, options: WorkerConfig) => new Promise((resolve) => {
    calls.push({ options, reply: () => { emit({ type: 'worker_text', text: 'fixture response' }); emit({ type: 'worker_complete', costUsd: 0, durationMs: 1 }); resolve({ text: 'fixture', costUsd: 0, durationMs: 1 }); } });
  }), getWorkerPid: () => undefined };
  const wf = { config: { name: 'fixture', workingDirectory: cwd, primaryProvider: 'ollama', primaryModel: 'fixture', primaryEffort: 'medium', skipPermissions: false },
    primary: { provider: 'ollama', model: 'fixture', effort: 'medium' }, manager, busy: false, observers: new Set([ws]),
    queue: { steering: [], followUp: [] }, autoHandoff: { enabled: false, warnAt: 75, autoAt: 90, warnFired: false, autoFired: false },
    bgTracker: { noteBgHint: () => {}, attachParent: () => {}, detachParent: () => {} } } as unknown as WorkflowState;
  workflows.set(id, wf); workflowCwds.set(id, cwd); await initWorkflowStore(cwd, id);
  engine.initTurnEngine({ previewAutoDetect: { noteAgentText: () => {}, notePotentialDevServerStart: () => {} } as never, handleCreateWorkflow: async () => {}, handleHandoffRequest: async () => {} });
  const waitFor = async (n: number) => { for (let i = 0; i < 200 && calls.length < n; i++) await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(calls.length, n); };
  try {
    const running = engine.handleUserMessage(ws, session, id, 'Draft', 'one', undefined, false, undefined, 'plan-review');
    await waitFor(1);
    await engine.handleUserMessage(ws, session, id, 'Continue work', 'two', undefined, true, 'follow-up', undefined);
    calls[0]!.reply(); await waitFor(2);
    assert.equal(calls[0]!.options.interactionMode, 'chat');
    assert.equal(calls[1]!.options.interactionMode, 'agent');
    assert.notEqual(calls[1]!.options.sandbox, 'read-only');
    calls[1]!.reply(); await running;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([checkpoint, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Checkpoint did not complete')), 15000); })]); }
    finally { if (timer) clearTimeout(timer); }
  } finally { workflows.delete(id); workflowCwds.delete(id); await flushAll(); }
});
