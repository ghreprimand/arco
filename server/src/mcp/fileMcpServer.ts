import '../envAliases.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerFileTools } from './fileMcpTools.js';

// Read-only bridge for providers' read-only subprocesses. No plan, board,
// shell or write tools are registered here.
const cwd = process.argv[2];
if (!cwd) throw new Error('A workflow folder is required');
const server = new McpServer({name:'arco-files',version:'1.0.0'});
registerFileTools(server,cwd);
await server.connect(new StdioServerTransport());
