#!/usr/bin/env node
// THROWAWAY — companion to cursor-acp-probe.ts (spike item 8).
// A minimal MCP stdio server exposing one tool, `archon_probe_ping`. The probe
// passes this server to `session/new`'s `mcpServers` array and then asks the
// Cursor agent to call the tool. If the tool call arrives here (we log it to
// stderr and answer), Cursor's ACP honors per-session MCP config → cluster
// peer-tools are viable. If the agent can't see/call it, Cursor clusters are
// blocked (plan §Phase 6 fallback ladder).
//
// Speaks the MCP subset the client needs: initialize / tools/list / tools/call,
// newline-delimited JSON-RPC 2.0 over stdio. No SDK dependency on purpose —
// this is a probe, not shipped code.

let buf = '';
const log = (...a) => process.stderr.write('[probe-mcp] ' + a.join(' ') + '\n');

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        serverInfo: { name: 'archon-probe-mcp', version: '0.0.0' },
        capabilities: { tools: {} },
      },
    });
    return;
  }
  if (method === 'notifications/initialized') return; // notification, no reply
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'archon_probe_ping',
            description:
              'Arco spike probe. Call this tool with any word to confirm MCP wiring works.',
            inputSchema: {
              type: 'object',
              properties: { word: { type: 'string', description: 'any word' } },
              required: ['word'],
            },
          },
        ],
      },
    });
    return;
  }
  if (method === 'tools/call') {
    const word = params?.arguments?.word ?? '(none)';
    log(`>>> tools/call archon_probe_ping word=${JSON.stringify(word)} <<<`);
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `archon_probe_ping OK: received "${word}"` }],
      },
    });
    return;
  }
  // Unknown request → method-not-found so the agent doesn't hang.
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl = buf.indexOf('\n');
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch (e) {
        log('parse error:', e?.message ?? String(e));
      }
    }
    nl = buf.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
log('ready');
