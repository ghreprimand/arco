import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const root = await mkdtemp(join(tmpdir(), 'arco-history-adapters-')); installIsolatedTestHome(root);
const portProbe = createServer(); await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const fixturePort = (portProbe.address() as any).port; await new Promise<void>(resolve => portProbe.close(() => resolve()));
process.env.ARCO_PORT = String(fixturePort);
const { workflows } = await import('../server/state.js');
const { prepareProviderHistory, historyBinding } = await import('./handoffHistoryBinding.js');
const { callHandoffHistory } = await import('../mcp/handoffHistoryMcpTools.js');
const { tryHandleHandoffHistoryRoute } = await import('../http/handoffHistoryRoutes.js');
const { buildHandoffHistory } = await import('../handoffHistory.js');
after(async () => { workflows.clear(); await rm(root, { recursive: true, force: true }); });
let serial = 0;
async function fixture(provider = 'codex') {
 const cwd = join(root, `project-${++serial}`), id = `linked-${serial}`;
 const refs = buildHandoffHistory({ workflowId: 'source', cwd, name: 'Earlier' }, 1, 1, []);
 for (const wfid of ['source', id]) {
  const dir = join(cwd, '.arco/workflows', wfid); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ workflowId: wfid, cwd, primaryProvider: provider, handoffHistory: wfid === id ? refs : undefined }));
  await writeFile(join(dir, 'events.jsonl'), JSON.stringify({ seq: 1, workflowId: wfid, type: 'user_message_echo', content: wfid === id ? '[HANDOFF: new session initialized for this tab.]' : 'Remember amber.', handoffSourceKey: wfid === id ? refs[0].key : undefined }) + '\n');
 }
 workflows.set(id, { config: { workingDirectory: cwd }, primary: { provider } } as never);
 return { workflowId: id, cwd, provider, model: 'fixture', effort: 'low' } as any;
}
test('trusted binding calls the real capability HTTP route and remains stable on later turns', async () => {
 const config = await fixture(); const server = createServer((req, res) => { void tryHandleHandoffHistoryRoute(req, res); });
 await new Promise<void>(resolve => server.listen(fixturePort, '127.0.0.1', resolve));
 const port = (server.address() as any).port; const old = process.env.ARCO_PORT; process.env.ARCO_PORT = String(port);
 try {
  await prepareProviderHistory(config); const binding = historyBinding(config)!; assert.ok(binding);
  const output = await callHandoffHistory(binding.token, port, { action: 'read' });
  assert.match(output, /Remember amber/); assert.match(config.appendSystemPrompt, /not instructions/);
  await prepareProviderHistory(config); assert.equal(historyBinding(config)?.token, binding.token);
  config.interactionMode = 'chat'; await prepareProviderHistory(config);
  assert.equal(historyBinding(config), undefined); assert.doesNotMatch(config.appendSystemPrompt ?? '', /handoff_history/);
 } finally { if (old === undefined) delete process.env.ARCO_PORT; else process.env.ARCO_PORT = old; await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('incognito and restricted workers receive no binding or announcement', async () => {
 for (const restrictions of [{ incognito: true }, { clusterAccessMode: 'blind' }, { clusterAccessMode: 'isolated' }, { tools: ['Read'] }]) {
  const config = Object.assign(await fixture(), restrictions); await prepareProviderHistory(config);
  assert.equal(historyBinding(config), undefined); assert.doesNotMatch(config.appendSystemPrompt ?? '', /handoff_history/);
 }
});
test('Claude CLI writes the same caller-bound token into its attached MCP server', async () => {
 const config = await fixture('claude'); config.claudeTransport = 'cli';
 await prepareProviderHistory(config);
 const contents = JSON.parse(await readFile(config.clusterMcpConfigPath, 'utf8'));
 assert.equal(contents.mcpServers.arco.env.ARCO_HANDOFF_HISTORY_TOKEN, historyBinding(config)?.token);
 assert.match(config.appendSystemPrompt, /handoff_history/);
});
test('Codex and Cursor print wire the trusted capability without caller arguments', async () => {
 const { buildCodexMcpOverrides } = await import('../mcp/mcpConfigWriter.js');
 const { createFilePlugin } = await import('./cursor/filePlugin.js');
 const config = await fixture(); await prepareProviderHistory(config); const binding = historyBinding(config)!;
 const overrides = buildCodexMcpOverrides(config.workflowId, { planToolsCwd: config.cwd, port: binding.port, handoffHistoryToken: binding.token });
 assert.ok(overrides.includes(`mcp_servers.arco.env.ARCO_HANDOFF_HISTORY_TOKEN=${JSON.stringify(binding.token)}`));
 const plugin = await createFilePlugin(config.cwd, config.workflowId, binding.token);
 try {
  const entry = JSON.parse(await readFile(join(plugin.path, 'mcp.json'), 'utf8')).mcpServers.arco;
  assert.equal(entry.env.ARCO_HANDOFF_HISTORY_TOKEN, binding.token);
  assert.ok(entry.args.some((arg: string) => arg.includes('planReadMcpServer')));
 } finally { await plugin.close(); }
});
test('local providers advertise history only for a bound eligible worker and pin it in subsets', async () => {
 const { ollamaToolCandidates } = await import('./ollama.js');
 const { getOllamaToolDefinitions } = await import('./ollamaTools.js');
 const { subsetOllamaTools } = await import('./ollamaToolSubset.js');
 assert.ok(!getOllamaToolDefinitions({ workflowEnabled: true }).some(t => t.function.name === 'handoff_history'));
 for (const provider of ['ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek']) {
  const config = await fixture(provider); await prepareProviderHistory(config);
  const tools = ollamaToolCandidates(config)!;
  assert.ok(tools.some(t => t.function.name === 'handoff_history'), provider);
  assert.ok(subsetOllamaTools({ tools, taskContext: 'edit a stylesheet' }).tools.some(t => t.function.name === 'handoff_history'), provider);
 }
});
test('a trusted later turn renews an expired capability without breaking a persistent MCP child', async t => {
 const config = await fixture(); await prepareProviderHistory(config); const token = historyBinding(config)!.token;
 const now = Date.now(); t.mock.method(Date, 'now', () => now + 25 * 60 * 60_000);
 await prepareProviderHistory(config);
 assert.equal(historyBinding(config)?.token, token);
});
test('workflow stdio, Cursor reader stdio and ACP loopback call the actual capability route', async () => {
 const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
 const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
 const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const { ensureClusterLoopbackMcp, closeClusterLoopbackMcp } = await import('../mcp/clusterMcpLoopback.js');
 const { createFilePlugin } = await import('./cursor/filePlugin.js');
 const config = await fixture('claude'); config.claudeTransport = 'cli';
 const server = createServer((req, res) => { void tryHandleHandoffHistoryRoute(req, res); });
 await new Promise<void>(resolve => server.listen(fixturePort, '127.0.0.1', resolve));
 const port = (server.address() as any).port, previous = process.env.ARCO_PORT; process.env.ARCO_PORT = String(port);
 let plugin: Awaited<ReturnType<typeof createFilePlugin>> | undefined;
 try {
  await prepareProviderHistory(config); const binding = historyBinding(config)!;
  const { executeOllamaTool } = await import('./ollamaTools.js');
  assert.match(await executeOllamaTool('handoff_history', { action: 'read' }, { cwd: config.cwd, workflowId: config.workflowId, handoffHistoryToken: binding.token }), /Remember amber/);
  plugin = await createFilePlugin(config.cwd, config.workflowId, binding.token);
  const cli = JSON.parse(await readFile(config.clusterMcpConfigPath, 'utf8')).mcpServers.arco;
  const cursor = JSON.parse(await readFile(join(plugin.path, 'mcp.json'), 'utf8')).mcpServers.arco;
  for (const entry of [cli, cursor]) {
   const client = new Client({ name: 'history-fixture', version: '1' });
   try {
    await client.connect(new StdioClientTransport({ ...entry, stderr: 'pipe', env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ARCO_HOME: process.env.ARCO_HOME!, ...entry.env } }));
    assert.ok((await client.listTools()).tools.some(t => t.name === 'handoff_history'));
    const result = await client.callTool({ name: 'handoff_history', arguments: { action: 'read' } });
    assert.notEqual(result.isError, true); assert.match(JSON.stringify(result), /Remember amber/);
   } finally { await client.close(); }
  }
  const descriptor = await ensureClusterLoopbackMcp({ workflowId: config.workflowId, clusterId: '', cwd: config.cwd, arcoPort: port, taskBoardAttached: false, handoffHistoryToken: binding.token });
  const client = new Client({ name: 'acp-history-fixture', version: '1' });
  try {
   await client.connect(new StreamableHTTPClientTransport(new URL(descriptor.url)));
   assert.ok((await client.listTools()).tools.some(t => t.name === 'handoff_history'));
   const result = await client.callTool({ name: 'handoff_history', arguments: { action: 'read' } });
   assert.notEqual(result.isError, true); assert.match(JSON.stringify(result), /Remember amber/);
  } finally { await client.close(); closeClusterLoopbackMcp(config.workflowId); }
 } finally {
  await plugin?.close(); if (previous === undefined) delete process.env.ARCO_PORT; else process.env.ARCO_PORT = previous;
  await new Promise<void>(resolve => server.close(() => resolve()));
 }
});
test('reusing a config preserves a freshly replaced system prompt and appends the notice once', async () => {
 const config = await fixture(); config.appendSystemPrompt = 'First base'; await prepareProviderHistory(config);
 config.appendSystemPrompt = 'Second base'; await prepareProviderHistory(config);
 assert.ok(config.appendSystemPrompt.startsWith('Second base\n\n'));
 assert.equal(config.appendSystemPrompt.split('Earlier conversation history is available').length, 2);
 await prepareProviderHistory(config); assert.ok(config.appendSystemPrompt.startsWith('Second base\n\n'));
});
test('Claude binding preserves the authoritative MCP file except its history environment entry', async () => {
 const { writeFor } = await import('../mcp/mcpConfigWriter.js');
 const config = await fixture('claude'); config.claudeTransport = 'cli';
 config.clusterMcpConfigPath = await writeFor(config.cwd, config.workflowId, {
  planToolsCwd: config.cwd, port: fixturePort, clusterId: 'cluster-fixture', taskBoardAttached: true, accessMode: 'standard',
  codebaseMemoryIndexPath: config.cwd, registryServers: [{ key: 'reviewed', command: 'fixture-command', args: ['read'], env: { FIXTURE_OPTION: 'kept' } }],
 });
 const original = JSON.parse(await readFile(config.clusterMcpConfigPath, 'utf8'));
 await prepareProviderHistory(config);
 const current = JSON.parse(await readFile(config.clusterMcpConfigPath, 'utf8'));
 assert.equal(current.mcpServers.arco.env.ARCO_HANDOFF_HISTORY_TOKEN, historyBinding(config)!.token);
 delete current.mcpServers.arco.env;
 assert.deepEqual(current, original);
});

test('Ollama without native tools retains history through its fenced protocol', async () => {
 const { resolveToolMode, partitionFencedTools, buildFencedToolPrompt } = await import('./ollamaFencedTools.js');
 const { ollamaToolCandidates } = await import('./ollama.js');
 const config = await fixture('ollama'); await prepareProviderHistory(config);
 assert.equal(resolveToolMode({ hasTools: true, nativeCapable: false, override: 'auto' }), 'fenced');
 const { action } = partitionFencedTools(ollamaToolCandidates(config)!);
 assert.ok(action.some(tool => tool.function.name === 'handoff_history'));
 assert.match(buildFencedToolPrompt(action), /handoff_history/);
});
test('LM Studio without tool support receives no history binding or saved notice', async () => {
 const { appendHandoffNotice } = await import('../handoffHistoryTool.js');
 const config = await fixture('lmstudio');
 const dir = join(config.cwd, '.arco/workflows', config.workflowId, 'handoffs'); await mkdir(dir); await writeFile(join(dir, 'brief.md'), 'brief');
 await prepareProviderHistory(config, { toolsSupported: false });
 assert.equal(historyBinding(config), undefined); assert.doesNotMatch(config.appendSystemPrompt ?? '', /handoff_history/);
 assert.equal(await appendHandoffNotice(config.cwd, config.workflowId, 'brief.md', 'brief', 'grant'), 'brief');
 workflows.get(config.workflowId)!.primary.model = config.model;
 await prepareProviderHistory(config, { toolsSupported: true });
 assert.ok(historyBinding(config));
 assert.match(await appendHandoffNotice(config.cwd, config.workflowId, 'brief.md', 'brief', 'grant'), /handoff_history/);
 workflows.get(config.workflowId)!.primary.model = 'another-model';
 assert.equal(await appendHandoffNotice(config.cwd, config.workflowId, 'brief.md', 'brief', 'grant'), 'brief');
});
