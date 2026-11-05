import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type WebSocket from 'ws';
import type { ServerMessage } from '@arco/shared';

// A large artifact written during a turn warns while the turn is still
// running, not only when it ends; the check stops with the turn.
const root = mkdtempSync(path.join(tmpdir(), 'arco-turn-sizes-'));
installIsolatedTestHome(root);
process.env.ARCO_ARTIFACT_WARN_FILE_BYTES = '1000';
process.env.ARCO_ARTIFACT_WARN_INTERVAL_MS = '50';
const { send } = await import('./server/broadcast.js');
const { workflows, workflowCwds } = await import('./server/state.js');
const { watchingTurnSizes } = await import('./storageTurnWatch.js');
const { initWorkflowStore } = await import('./workflowStore.js');
const { settleProjectWrites } = await import('./testSupport/projectWrites.js');
after(async () => { await settleProjectWrites(); rmSync(root, { recursive: true, force: true }); });

test('size warnings arrive during a turn and the check stops when it ends', async () => {
  const id = 'turn-sizes-0001';
  const cwd = path.join(root, 'project');
  const artifacts = path.join(cwd, '.arco', 'workflows', id, 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  const received: ServerMessage[] = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: (data: string) => { received.push(JSON.parse(data)); } } as unknown as WebSocket;
  workflows.set(id, { config: { name: 'fixture', workingDirectory: cwd, primaryProvider: 'claude' }, primary: { provider: 'claude', model: 'fixture' }, observers: new Set([ws]), queue: { steering: [], followUp: [] } } as never);
  workflowCwds.set(id, cwd);
  await initWorkflowStore(cwd, id);
  try {
    send(ws, { type: 'primary_turn_started', workflowId: id, startedAt: Date.now() } as ServerMessage);
    assert.equal(watchingTurnSizes(id), true);
    writeFileSync(path.join(artifacts, 'render.bin'), Buffer.alloc(4000));
    const warned = () => received.find((m) => m.type === 'storage_warning') as (ServerMessage & { items: Array<{ path: string }> }) | undefined;
    for (let i = 0; i < 100 && !warned(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(warned()?.items.map((item) => item.path), ['artifacts/render.bin']);
    // Each item warns once, even though the check keeps running.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(received.filter((m) => m.type === 'storage_warning').length, 1);
    send(ws, { type: 'primary_turn_ended', workflowId: id, endedAt: Date.now() } as ServerMessage);
    assert.equal(watchingTurnSizes(id), false);
  } finally {
    workflows.delete(id); workflowCwds.delete(id);
  }
});

test('an incognito turn is not watched', () => {
  const id = 'turn-sizes-0002';
  const ws = { readyState: 1, bufferedAmount: 0, send: () => undefined } as unknown as WebSocket;
  workflows.set(id, { config: { name: 'fixture', workingDirectory: root, incognito: true }, primary: { provider: 'claude', model: 'fixture' }, observers: new Set([ws]), queue: { steering: [], followUp: [] } } as never);
  workflowCwds.set(id, root);
  try {
    send(ws, { type: 'primary_turn_started', workflowId: id, startedAt: Date.now() } as ServerMessage);
    assert.equal(watchingTurnSizes(id), false);
  } finally { workflows.delete(id); workflowCwds.delete(id); }
});
