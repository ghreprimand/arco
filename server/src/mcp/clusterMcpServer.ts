import '../envAliases.js'; // env fallback resolves before any module reads ARCO_* (see envAliases.ts)
// docs/PROTOCOL_CLUSTER.md - per-spawn stdio MCP server.
//
// Spawned as a child process by Claude CLI via `mcp-config.json` (written by
// `mcpConfigWriter.ts`) and by Codex via `-c mcp_servers.*` overrides. One
// child per `claude`/`codex` invocation. The child is stateless — its only
// state is the (clusterId, workflowId, port, taskBoard) tuple baked into argv
// at spawn time, plus the in-flight MCP request whose tool dispatch translates
// to a single `fetch` against Arco's local REST API.
//
// Why per-spawn instead of per-cluster: stdio MCP is point-to-point. Claude
// CLI expects to own the child's lifecycle via `command` + `args` in
// mcp-config.json. N CLI members of one cluster cannot share one stdio
// child. Decision rationale: docs/PROTOCOL_CLUSTER.md (2026-05-10).
//
// The tool set itself lives in `clusterMcpTools.ts` (registerClusterTools) so
// the SAME tools back both this stdio child AND the in-process loopback HTTP
// server Cursor members use (docs/PROVIDERS.md - Cursor ACP
// honors MCP only over http/sse, not stdio). Tool names exposed: peer_list,
// peer_send, peer_read, cluster_plan_read, cluster_plan_tick, cluster_plan_write,
// cluster_task_list/show/create/claim/update/heartbeat/link/unlink/comment/block/complete.
// Claude sees them wire-level as `mcp__arco-cluster__peer_list` etc.
//
// IMPORTANT: do NOT write to stdout — stdio is the MCP wire. All logging
// goes to stderr (claude's `[mcp:arco-cluster:stderr]` capture).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerClusterTools } from './clusterMcpTools.js';

const [, , CLUSTER_ID_RAW, WORKFLOW_ID_RAW, PORT_RAW, TASK_BOARD_RAW, ACCESS_MODE_RAW] = process.argv;

if (!CLUSTER_ID_RAW || !WORKFLOW_ID_RAW) {
  console.error('[arco-cluster-mcp] usage: clusterMcpServer.{ts|js} <clusterId> <workflowId> [<arcoPort>] [task-board-attached|task-board-detached]');
  process.exit(2);
}

const CLUSTER_ID = CLUSTER_ID_RAW;
const WORKFLOW_ID = WORKFLOW_ID_RAW;
const ARCO_PORT = parseInt(PORT_RAW ?? process.env.ARCO_PORT ?? '3001', 10);
const TASK_BOARD_ATTACHED = TASK_BOARD_RAW === 'task-board-attached';
const ACCESS_MODE = ACCESS_MODE_RAW === 'blind' || ACCESS_MODE_RAW === 'isolated'
  ? ACCESS_MODE_RAW
  : 'standard';

function logErr(...args: unknown[]): void {
  console.error('[arco-cluster-mcp]', ...args);
}

async function main(): Promise<void> {
  const server = new McpServer({ name: 'arco-cluster', version: '1.0.0' });
  registerClusterTools(server, {
    clusterId: CLUSTER_ID,
    workflowId: WORKFLOW_ID,
    arcoPort: ARCO_PORT,
    taskBoardAttached: TASK_BOARD_ATTACHED,
    accessMode: ACCESS_MODE,
    logErr,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logErr(`connected; cluster=${CLUSTER_ID.slice(0, 8)} workflow=${WORKFLOW_ID.slice(0, 8)} port=${ARCO_PORT} taskBoard=${TASK_BOARD_ATTACHED ? 'attached' : 'detached'}`);
}

main().catch((err) => {
  logErr('fatal:', err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
