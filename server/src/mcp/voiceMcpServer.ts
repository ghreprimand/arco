import '../envAliases.js'; // env fallback resolves before any module reads ARCO_* (see envAliases.ts)
// docs/VOICE.md - per-spawn stdio MCP child for the "Computer" voice
// operator chat. Stateless: (workflowId, port) from argv; every tool call is
// one loopback POST to /api/voice/tool, which the server relays to the
// browser that owns the hands-free session. The browser executes it through
// the same bounded VoiceExecutor actions as direct voice commands and the
// result comes back as the tool output. No shell, files, git or config here.
//
// IMPORTANT: never write to stdout — stdio is the MCP wire. Log to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { COMPUTER_TOOL_SPECS, computerToolWireArgs } from '../voice/toolDefinitions.js';
// Mirrors VOICE_TOOL_TIMEOUT_MS in shared/src/protocol/voiceOperator.ts. The
// child is spawned without the dev `--conditions development` flag, so a
// shared import would resolve to a possibly stale dist; keep it literal.
const VOICE_TOOL_TIMEOUT_MS = 20_000;

const [, , WORKFLOW_ID, PORT_RAW] = process.argv;
if (!WORKFLOW_ID) { console.error('[arco-voice-mcp] usage: voiceMcpServer <workflowId> [<arcoPort>]'); process.exit(2); }
const PORT = parseInt(PORT_RAW ?? process.env.ARCO_PORT ?? '3001', 10);

async function call(tool: string, args: Record<string, string>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/voice/tool`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: WORKFLOW_ID, tool, args }),
      signal: AbortSignal.timeout(VOICE_TOOL_TIMEOUT_MS + 2000),
    });
    const body = await r.json().catch(() => ({})) as { ok?: boolean; result?: string; error?: string };
    if (!r.ok || body.ok !== true) return { content: [{ type: 'text', text: body.error || `Arco refused ${tool} (http ${r.status}).` }], isError: true };
    return { content: [{ type: 'text', text: body.result ?? '' }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Arco is not reachable: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

async function main(): Promise<void> {
  const server = new McpServer({ name: 'arco-voice', version: '1.0.0' });
  for (const spec of COMPUTER_TOOL_SPECS) {
    server.registerTool(spec.name, { description: spec.description, inputSchema: spec.shape },
      async (args: Record<string, unknown>) => call(spec.name, computerToolWireArgs(args)));
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[arco-voice-mcp] ready for workflow ${WORKFLOW_ID} on port ${PORT}`);
}
main().catch((e) => { console.error('[arco-voice-mcp] fatal', e); process.exit(1); });
