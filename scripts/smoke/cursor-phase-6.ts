// docs/PROVIDERS.md - headless smoke for Cursor cluster
// membership plumbing. No metered LLM turns: the Phase-6 GATE probe
// (scripts/cursor-sse-mcp-probe.ts) already proved a loopback MCP's tools are
// callable over ACP live; this asserts the SHIPPED wiring around that —
//
//   1. Model→provider inference + override resolver treat Cursor correctly
//      (auto/grok → cursor; proxied claude-*/gpt-* ids are NOT a mismatch when
//      the operator explicitly picked cursor).
//   2. The shared tool factory (registerClusterTools) registers the same tool
//      set for the loopback server as the stdio child, board-gated.
//   3. The loopback HTTP MCP manager: ensure → a real StreamableHTTP MCP client
//      sees the peer tools; idempotent re-ensure returns the same URL and
//      refreshes ctx (board attach flips the tool count); close tears the
//      listener down (a later connect fails).
//
// The full 2-member metered exchange (a Cursor member peer_send/peer_read with a
// Claude lead over the loopback MCP) is the manual/metered acceptance step,
// verified once on a dev server and recorded in DEVLOG — same pattern as the
// real-LLM-turn skip in cluster-progress.ts.
//
//   npm run smoke:cursor-phase-6
//
// Exits 0 on all-pass, 1 on any failure. Needs no running Arco (module-level).

import { step, assert, assertEq, summary } from './lib.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { registerClusterTools } from '../../server/src/mcp/clusterMcpTools.js';
import { ensureClusterLoopbackMcp, closeClusterLoopbackMcp } from '../../server/src/mcp/clusterMcpLoopback.js';
import { inferClusterProviderFromModel, resolveClusterOverrideProvider } from '../../server/src/ws/clusterHandlers.js';

async function toolNames(taskBoardAttached: boolean): Promise<string[]> {
  const server = new McpServer({ name: 'arco-cluster', version: '1.0.0' });
  registerClusterTools(server, { clusterId: 'c1', workflowId: 'w1', arcoPort: 3001, taskBoardAttached });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(c);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name).sort();
}

async function listOverHttp(url: string): Promise<string[]> {
  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name).sort();
}

async function main(): Promise<void> {
  console.log('Cursor Phase-6 smoke — cluster membership plumbing\n');

  await step('1: model→provider inference treats Cursor ids', () => {
    assertEq(inferClusterProviderFromModel('auto'), 'cursor', 'auto → cursor');
    assertEq(inferClusterProviderFromModel('grok-4'), 'cursor', 'grok-4 → cursor');
    // Proxied families still infer to their native provider (ambiguous by id).
    assertEq(inferClusterProviderFromModel('claude-4-opus'), 'claude', 'claude-* → claude');
    assertEq(inferClusterProviderFromModel('gpt-5'), 'codex', 'gpt-* → codex');
  });

  await step('2: override resolver trusts an explicit Cursor pick', () => {
    // Cursor + a proxied claude id is NOT a mismatch (Cursor serves that family).
    const a = resolveClusterOverrideProvider('claude', 'cursor', 'claude-4-opus');
    assertEq(a.provider, 'cursor', 'cursor+claude-id → cursor');
    assert(!a.error, 'cursor+claude-id → no mismatch error');
    // Cursor + auto → cursor, no error.
    const b = resolveClusterOverrideProvider('claude', 'cursor', 'auto');
    assertEq(b.provider, 'cursor', 'cursor+auto → cursor');
    assert(!b.error, 'cursor+auto → no error');
    // The reverse is still a real mismatch: claude requested with a grok id.
    const c = resolveClusterOverrideProvider('claude', 'claude', 'grok-4');
    assert(!!c.error && c.error.startsWith('provider_model_mismatch'), 'claude+grok → mismatch');
  });

  await step('3: shared factory registers the board-gated tool set', async () => {
    const withBoard = await toolNames(true);
    const noBoard = await toolNames(false);
    assertEq(noBoard.length, 6, 'no board → 6 peer/plan tools');
    for (const t of ['peer_list', 'peer_send', 'peer_read', 'cluster_plan_read', 'cluster_plan_tick', 'cluster_plan_write']) {
      assert(noBoard.includes(t), `no board → has ${t}`);
    }
    assertEq(withBoard.length, 17, 'board → 6 peer/plan + 11 task tools');
    for (const t of ['cluster_task_list', 'cluster_task_claim', 'cluster_task_complete']) {
      assert(withBoard.includes(t), `board → has ${t}`);
    }
  });

  await step('4: loopback HTTP MCP — ensure, tools/list over StreamableHTTP', async () => {
    const wfid = 'wf-phase6-aaaaaaaa';
    const first = await ensureClusterLoopbackMcp({ clusterId: 'cl-1', workflowId: wfid, arcoPort: 3001, taskBoardAttached: false });
    assert(first.name === 'arco-cluster', 'descriptor name = arco-cluster');
    assert(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{32}$/.test(first.url), `loopback url shape: ${first.url}`);

    const names = await listOverHttp(first.url);
    assert(names.includes('peer_send') && names.includes('peer_read'), 'peer tools visible over HTTP');
    assertEq(names.length, 6, 'board detached → 6 tools over HTTP');

    // Idempotent re-ensure → SAME url, and board attach flips the tool count.
    const again = await ensureClusterLoopbackMcp({ clusterId: 'cl-1', workflowId: wfid, arcoPort: 3001, taskBoardAttached: true });
    assertEq(again.url, first.url, 're-ensure returns the same URL');
    const names2 = await listOverHttp(again.url);
    assertEq(names2.length, 17, 're-ensure with board attached → 17 tools (ctx refreshed)');

    closeClusterLoopbackMcp(wfid);
    // After close, a fresh connect must fail (listener gone).
    let failed = false;
    try { await listOverHttp(first.url); } catch { failed = true; }
    assert(failed, 'connect after close fails (listener torn down)');
  });

  summary('cursor-phase-6');
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
