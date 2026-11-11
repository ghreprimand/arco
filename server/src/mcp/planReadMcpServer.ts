import { registerHandoffHistoryTool } from './handoffHistoryMcpTools.js';
// Read-only workflow plan server for Cursor print's temporary plugin.
import '../envAliases.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerPlanTools } from './planMcpTools.js';

const [, , workflowId, cwd, port] = process.argv;
if (!workflowId || !cwd) {
  console.error('Usage: planReadMcpServer <workflowId> <cwd> [port]');
  process.exit(2);
}
const server = new McpServer({ name: 'arco', version: '1.0.0' });
registerPlanTools(server, { workflowId, cwd, arcoPort: parseInt(port ?? process.env.ARCO_PORT ?? '3001', 10) }, { readOnly: true });
registerHandoffHistoryTool(server, process.env.ARCO_HANDOFF_HISTORY_TOKEN, parseInt(port ?? process.env.ARCO_PORT ?? '3001', 10));
server.connect(new StdioServerTransport()).catch(error => {
  console.error('[arco-plans]', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
