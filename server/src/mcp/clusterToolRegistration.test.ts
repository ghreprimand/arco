import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer, request } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerClusterTools } from './clusterMcpTools.js';
import { registerFileTools } from './fileMcpTools.js';
import { registerPlanTools } from './planMcpTools.js';

test('BLIND cluster filtering preserves subsequent workflow and registry registrations', () => {
  const names: string[] = [];
  const server = { registerTool(name: string) { names.push(name); } } as unknown as McpServer;
  const original = server.registerTool;
  registerClusterTools(server, { clusterId: 'cluster', workflowId: 'member', arcoPort: 3198, taskBoardAttached: true, accessMode: 'blind' });
  assert.deepEqual(names.sort(), ['peer_read', 'peer_send']);
  registerFileTools(server, '.');
  registerPlanTools(server, { workflowId: 'member', cwd: '.', arcoPort: 3198 });
  server.registerTool('registry_read', {}, async () => ({ content: [] }));
  for (const name of ['read_file', 'fetch_file', 'plan_create', 'plan_list', 'plan_ref_read', 'registry_read']) assert.ok(names.includes(name), name);
  assert.equal(server.registerTool, original);
});

test('standard cluster members retain shared coordination and board tools', () => {
  const names: string[] = [];
  const server = { registerTool(name: string) { names.push(name); } } as unknown as McpServer;
  registerClusterTools(server, { clusterId: 'cluster', workflowId: 'member', arcoPort: 3198, taskBoardAttached: true, accessMode: 'standard' });
  for (const name of ['peer_read', 'peer_send', 'peer_list', 'cluster_plan_read', 'cluster_task_list']) assert.ok(names.includes(name), name);
});

test('worker mail socket exposes only its authenticated member mailbox', async () => {
  const { startWorkerMailBridge } = await import('./workerMailBridge.js');
  const root = await mkdtemp(join(tmpdir(), 'arco-mail-bridge-'));
  const observed: unknown[] = [];
  let sawStalled: () => void = () => {};
  let stoppedStalled: () => void = () => {};
  const stalled = new Promise<void>(resolve => { sawStalled = resolve; });
  const stopped = new Promise<void>(resolve => { stoppedStalled = resolve; });
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      observed.push({ path: req.url, body });
      if (body.content === 'stall') { res.once('close', stoppedStalled); sawStalled(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ delivered: true }));
    });
  });
  let bridge: Awaited<ReturnType<typeof startWorkerMailBridge>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, [127, 0, 0, 1].join('.'), resolve); });
    const address = upstream.address(); assert.ok(address && typeof address !== 'string');
    const options = { parentDir: root, clusterId: 'cluster-a', workflowId: 'member-a', arcoPort: address.port, mode: 'researcher' as const, directorWorkflowId: 'director' };
    bridge = await startWorkerMailBridge(options);
    options.workflowId = 'other-member'; options.directorWorkflowId = 'other-researcher';
    assert.equal((await stat(bridge.socketPath)).mode & 0o777, 0o600);
    async function call(token: string, body: unknown): Promise<{ status: number; value: any }> {
      return await new Promise((resolve, reject) => {
        const req = request({ socketPath: bridge!.socketPath, path: `/mcp/${token}`, method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } }, (res) => {
          const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode ?? 0, value: text ? JSON.parse(text) : undefined }); });
        });
        req.once('error', reject); req.end(JSON.stringify(body));
      });
    }
    const wrong = (bridge.token[0] === '0' ? '1' : '0') + bridge.token.slice(1);
    assert.equal((await call(wrong, {})).status, 404);
    const init = await call(bridge.token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
    assert.equal(init.status, 200);
    const list = await call(bridge.token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.deepEqual(list.value.result.tools.map((tool: { name: string }) => tool.name).sort(), ['peer_read', 'peer_send']);
    assert.match(list.value.result.tools.find((tool: { name: string }) => tool.name === 'peer_send').description, /exact workflowId director/);
    const denied = await call(bridge.token, { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'peer_send', arguments: { to: 'other-researcher', content: 'fixture' } } });
    assert.equal(denied.value.result.isError, true);
    const taskDenied = await call(bridge.token, { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'peer_send', arguments: { to: 'director', content: 'fixture', task_id: 'task' } } });
    assert.equal(taskDenied.value.result.isError, true);
    assert.equal(observed.length, 0, 'researcher mail to a peer never reaches the upstream API');
    const sent = await call(bridge.token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'peer_send', arguments: { to: 'director', content: 'fixture', from: 'other-member', artifact_paths: ['/work/report.txt'] } } });
    assert.equal(sent.status, 200); assert.notEqual(sent.value.result.isError, true);
    const read = await call(bridge.token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'peer_read', arguments: { workflowId: 'other-member' } } });
    assert.equal(read.status, 200); assert.notEqual(read.value.result.isError, true);
    assert.deepEqual(observed, [
      { path: '/api/clusters/cluster-a/peer/send', body: { from: 'member-a', to: 'director', content: 'fixture', artifactPaths: ['report.txt'] } },
      { path: '/api/clusters/cluster-a/peer/read', body: { workflowId: 'member-a', onlyFrom: 'director' } },
    ]);
    const pending = call(bridge.token, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'peer_send', arguments: { to: 'director', content: 'stall' } } }).catch(() => undefined);
    await stalled;
    await bridge.close(); bridge = undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([stopped, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('upstream did not stop')), 3000); })]); }
    finally { if (timeout) clearTimeout(timeout); }
    await pending;
  } finally {
    if (bridge) await bridge.close();
    if (upstream.listening) await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
