// MCP adapter for the shared workflow plan schemas and operations.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createPlanTools, type PlanToolContext } from '../planTools.js';
export { lintPlanBody, leanPlanWarnings } from '../planTools.js';
export type PlanMcpToolCtx = PlanToolContext;

export function registerPlanTools(server: McpServer, ctx: PlanMcpToolCtx, opts: { readOnly?: boolean } = {}): void {
  for (const tool of createPlanTools(ctx)) {
    if (opts.readOnly && !['plan_list', 'plan_ref_list', 'plan_ref_read'].includes(tool.name)) continue;
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      async args => tool.execute(args));
  }
}
