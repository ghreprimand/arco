import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCodexMcpOverrides } from './mcpConfigWriter.js';
import { computeRegistryWiring } from './registryWiring.js';
import type { McpServerDef, McpWorkflowAllow, WorkerConfig } from '@arco/shared';

function overrides(version: string) {
  const defs = [{ id: 'fixture-server', name: 'Fixture', command: 'fixture', args: [], enabled: true }] as unknown as McpServerDef[];
  const allow = [{ serverId: 'fixture-server', enabled: true, allowedDangerousTools: ['write_record'], disabledTools: ['write_record', 'unprobed'], tools: [{ name: 'read_record' }, { name: 'write_record' }, { name: 'delete_record' }] }] as unknown as McpWorkflowAllow[];
  const wiring = computeRegistryWiring(defs, allow);
  return buildCodexMcpOverrides('workflow', { port: 3198, registryServers: wiring.registryServers, disallowedTools: wiring.disallowedTools, codexVersion: version });
}
test('Codex tool filters enforce disabled and unticked dangerous tools', () => {
  const args = overrides('0.167.0');
  const entry = args.find(arg => arg.startsWith('mcp_servers.reg-fixture-.disabled_tools='));
  assert.ok(entry, 'per-tool restrictions reach Codex');
  const tools = JSON.parse(entry.slice(entry.indexOf('=') + 1));
  assert.deepEqual(tools.sort(), ['delete_record', 'unprobed', 'write_record']);
  assert.ok(!tools.includes('read_record'));
});
test('older and unknown Codex versions do not receive unsupported tool-filter settings', () => {
  for (const version of ['0.128.0', 'unknown', 'broken']) assert.ok(!overrides(version).some(arg => /disabled_tools|enabled_tools/.test(arg)));
});

test('tool filters stay scoped to their own server and explicit disable wins', () => {
  const args = buildCodexMcpOverrides('workflow', {
    port: 3198, codexVersion: '0.167.0',
    registryServers: [{ key: 'one', command: 'fixture', args: [], disabledTools: ['write_record'], allowedDangerousTools: ['write_record'] }],
    disallowedTools: ['mcp__two__delete_record'],
  });
  assert.ok(args.includes('mcp_servers.one.disabled_tools=["write_record"]'));
});

test('app-server launch signature changes when its derived denylist changes', async () => {
  const { bootstrapSurfaceKey } = await import('../providers/codex-appserver/worker.js');
  const config: WorkerConfig = { provider: 'codex', model: 'fixture', effort: 'low', mcpRegistryServers: [{ key: 'one', command: 'fixture', args: [] }] };
  assert.notEqual(bootstrapSurfaceKey({ ...config, mcpDisallowedTools: [] }), bootstrapSurfaceKey({ ...config, mcpDisallowedTools: ['mcp__one__delete_record'] }));
});
