import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
