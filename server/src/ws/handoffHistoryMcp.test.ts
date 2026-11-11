import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const root = await mkdtemp(join(tmpdir(), 'arco-history-turn-'));
installIsolatedTestHome(root);
const engine = await import('./turnEngine.js');
const { workflows, workflowCwds } = await import('../server/state.js');
const clusters = await import('../clusterStore.js');
const { initWorkflowStore } = await import('../workflowStore.js');
const { buildHandoffHistory } = await import('../handoffHistory.js');
const { mintHandoffHistoryCapability } = await import('../http/handoffHistoryRoutes.js');
const { configPathFor } = await import('../mcp/mcpConfigWriter.js');
const { settleProjectWrites } = await import('../testSupport/projectWrites.js');
const { trackRecallFixture } = await import('../testSupport/recallFixture.test-support.js');
const closeRecall = trackRecallFixture();
after(async () => { await settleProjectWrites(); await closeRecall(); await settleProjectWrites(); await rm(root, { recursive: true, force: true }); });
engine.initTurnEngine({ previewAutoDetect: { noteAgentText() {}, notePotentialDevServerStart() {} } as any, handleCreateWorkflow: async () => {}, handleHandoffRequest: async () => {}, captureCheckpoint: async () => null });
for (const restriction of ['eligible', 'chat', 'incognito', 'blind', 'isolated', 'no-ancestry']) test(`Claude CLI turn MCP history capability: ${restriction}`, async () => {
 const id = randomUUID(), cwd = join(root, id); await mkdir(cwd);
 const messages: any[] = []; let captured: any;
 const ws = { readyState: 1, bufferedAmount: 0, send: (raw: string) => messages.push(JSON.parse(raw)) } as any;
 const session = { id: 'fixture', workflowIds: new Set([id]), clusterIds: new Set(), clusterObserved: new Map() } as any;
 const manager = { spawn: async (spec: any, emit: any, options: any) => {
  captured = options; emit({ type: 'worker_text', text: 'fixture answer' }); emit({ type: 'worker_complete', costUsd: 0, durationMs: 1 }); return { id: spec.id, text: 'fixture answer', costUsd: 0, durationMs: 1 };
 }, getWorkerPid: () => undefined };
 const wf = { config: { name: 'Fixture', workingDirectory: cwd, primaryProvider: 'claude', primaryModel: 'fixture', claudeTransport: 'cli', primaryEffort: 'low', ...(restriction === 'chat' || restriction === 'incognito' ? { kind: 'chat' } : {}), ...(restriction === 'incognito' ? { incognito: true } : {}), autoCompaction: { enabled: false } }, primary: { provider: 'claude', model: 'fixture', effort: 'low', skipPermissions: false }, manager, busy: false, observers: new Set([ws]), queue: { steering: [], followUp: [] }, autoHandoff: { enabled: false, afterCompactions: 5, compactions: 0, fired: false } } as any;
 workflows.set(id, wf); workflowCwds.set(id, cwd);
 const refs = buildHandoffHistory({ workflowId: 'source', cwd, name: 'Earlier' }, 1, 1, []);
 const dir = join(cwd, '.arco/workflows', id); await mkdir(dir, { recursive: true });
 await writeFile(join(dir, 'meta.json'), JSON.stringify({ workflowId: id, cwd, primaryProvider: 'claude', sessions: [], handoffHistory: restriction === 'no-ancestry' ? [] : refs }));
 await writeFile(join(dir, 'events.jsonl'), JSON.stringify({ seq: 1, workflowId: id, type: 'user_message_echo', content: '[HANDOFF: new session initialized for this tab.]', handoffSourceKey: refs[0].key }) + '\n');
 await initWorkflowStore(cwd, id);
 let clusterId: string | undefined;
 if (restriction === 'blind' || restriction === 'isolated') { const cluster = await clusters.createCluster({ cwd, memberWorkflowIds: [id, randomUUID()], progressTracking: 'both' }); clusterId = cluster.clusterId; await clusters.setMemberAccessMode(clusterId, id, restriction); }
 try {
  const token = await mintHandoffHistoryCapability(id);
  assert.equal(!!token, restriction === 'eligible');
  await engine.handleUserMessage(ws, session, id, 'fixture task', 'fixture-input', undefined, false, undefined, undefined);
  const raw = await readFile(configPathFor(cwd, id), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (restriction === 'eligible' || restriction === 'blind' || restriction === 'no-ancestry') {
   assert.ok(captured, JSON.stringify(messages)); assert.ok(raw, 'turn engine writes the Claude MCP file');
   const config = JSON.parse(raw); assert.equal(config.mcpServers.arco.env?.ARCO_HANDOFF_HISTORY_TOKEN, restriction === 'eligible' ? token : undefined);
  } else {
   // Chat never attaches project MCP; ISOLATED rejects CLI before dispatch.
   assert.equal(raw, undefined); assert.equal(captured?.clusterMcpConfigPath, undefined);
   if (restriction === 'isolated') assert.ok(messages.some(m => m.message === 'isolated cluster members require the Claude Native transport'));
   else assert.ok(captured, JSON.stringify(messages));
  }
 } finally { if (clusterId) await clusters.deleteCluster(clusterId); workflows.delete(id); workflowCwds.delete(id); await settleProjectWrites(); }
});
