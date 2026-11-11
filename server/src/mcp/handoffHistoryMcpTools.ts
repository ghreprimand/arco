import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HANDOFF_HISTORY_TOOL, handoffHistorySchema } from '../handoffHistoryProtocol.js';

export async function callHandoffHistory(token: string, port: number, input: unknown): Promise<string> {
 const args = handoffHistorySchema.parse(input);
 const response = await fetch(`http://127.0.0.1:${port}/api/agent-handoff-history`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(args), signal: AbortSignal.timeout(30_000),
 });
 if (!response.ok) throw new Error('Earlier conversation history is unavailable for this caller.');
 const text = await response.text();
 if (Buffer.byteLength(text) > 24 * 1024) throw new Error('History response exceeded its limit.');
 return text;
}
export function registerHandoffHistoryTool(server: McpServer, token: string | undefined, port: number): void {
 if (!token) return;
 server.tool('handoff_history', HANDOFF_HISTORY_TOOL.description, handoffHistorySchema.shape, async args => {
  try { return { content: [{ type: 'text' as const, text: await callHandoffHistory(token, port, args) }] }; }
  catch { return { isError: true, content: [{ type: 'text' as const, text: 'Earlier conversation history is unavailable or the request is invalid.' }] }; }
 });
}
