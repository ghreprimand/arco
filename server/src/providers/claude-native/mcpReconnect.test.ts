import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeNativeWorker } from './worker.js';
import type { McpSession } from '../../mcp/client.js';

test('B87: repaired, closed and changed MCP definitions reconnect on the next turn', async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'arco-mcp-reconnect-'));
  const script = join(cwd, 'fixture.cjs');
  await fs.writeFile(script, `require('node:readline').createInterface({input:process.stdin}).on('line', line => { const m=JSON.parse(line); if(m.id === undefined) return; const result=m.method === 'tools/list' ? {tools:[{name:process.argv[2]}]} : {}; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'); });`);
  const definition = { key: 'fixture', command: process.execPath, args: [join(cwd, 'missing.cjs')], env: {} };
  const worker = new ClaudeNativeWorker({ workflowId: 'mcp-reconnect', config: { cwd, model: 'claude-opus-4-8', mcpRegistryServers: [definition] } as never });
  const internal = worker as unknown as { reconcileMcpSessions(): Promise<void>; mcpSessions: Map<string, McpSession> };
  try {
    await internal.reconcileMcpSessions();
    definition.args = [script, 'first'];
    await internal.reconcileMcpSessions();
    const first = internal.mcpSessions.get('fixture')!;
    assert.equal(first.listTools()[0]?.name, 'first', 'a failed startup must not be cached forever');
    await internal.reconcileMcpSessions();
    assert.equal(internal.mcpSessions.get('fixture'), first, 'healthy unchanged sessions are reused');
    first.close();
    await internal.reconcileMcpSessions();
    assert.notEqual(internal.mcpSessions.get('fixture'), first, 'closed sessions reconnect');
    definition.args = [script, 'second'];
    await internal.reconcileMcpSessions();
    assert.equal(internal.mcpSessions.get('fixture')!.listTools()[0]?.name, 'second', 'changed launch arguments take effect');
  } finally { await worker.dispose(); await fs.rm(cwd, { recursive: true, force: true }); }
});
