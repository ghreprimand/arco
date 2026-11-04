import '../envAliases.js'; // env fallback resolves before any module reads ARCO_* (see envAliases.ts)
// Workflow-scoped `arco` stdio MCP server — per-spawn child.
//
// Sibling of `clusterMcpServer.ts` and deliberately separate from it: that one
// is cluster-scoped and only wired for cluster members, while these tools apply
// to EVERY workflow. Keeping them apart means cluster tool names
// (`mcp__arco-cluster__peer_send`, referenced in prompts and the gpt-5.6
// code-mode addendum) don't move, and a solo tab doesn't advertise peer tools
// it can't use.
//
// Spawned by Claude CLI via `mcp-config.json` and by Codex via
// `-c mcp_servers.arco.*` overrides — both written by `mcpConfigWriter.ts`.
// Stateless: the (workflowId, cwd, port) tuple baked into argv is all it holds,
// and each tool call is one `fetch` against Arco's local REST plan API.
// Cursor gets the same tools in-process via `clusterMcpLoopback.ts` (ACP honors
// MCP over http/sse only, not stdio).
//
// Claude sees these wire-level as `mcp__arco__plan_create` etc.
//
// IMPORTANT: do NOT write to stdout — stdio is the MCP wire. All logging goes
// to stderr.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerPlanTools } from './planMcpTools.js';

const [, , WORKFLOW_ID_RAW, CWD_RAW, PORT_RAW] = process.argv;

if (!WORKFLOW_ID_RAW || !CWD_RAW) {
  console.error('[arco-mcp] usage: arcoMcpServer.{ts|js} <workflowId> <cwd> [<arcoPort>]');
  process.exit(2);
}

const WORKFLOW_ID = WORKFLOW_ID_RAW;
const CWD = CWD_RAW;
const ARCO_PORT = parseInt(PORT_RAW ?? process.env.ARCO_PORT ?? '3001', 10);

function logErr(...args: unknown[]): void {
  console.error('[arco-mcp]', ...args);
}

async function main(): Promise<void> {
  const server = new McpServer({ name: 'arco', version: '1.0.0' });
  registerPlanTools(server, {
    workflowId: WORKFLOW_ID,
    cwd: CWD,
    arcoPort: ARCO_PORT,
    logErr,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logErr(`connected; workflow=${WORKFLOW_ID.slice(0, 8)} cwd=${CWD} port=${ARCO_PORT}`);
}

main().catch((err) => {
  logErr('fatal:', err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
