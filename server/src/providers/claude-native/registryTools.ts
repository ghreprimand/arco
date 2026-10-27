// docs/ARCHITECTURE.md (E1-Native) - registry MCP tools for the in-process
// Claude Native host.
//
// Two responsibilities, kept OUT of worker.ts so the smoke can test them
// without booting a worker or the Anthropic SDK:
//
//   - registryToolDefs(servers, sessions): the AUTHORITATIVE denylist gate for
//     Native. Builds Anthropic tool defs for every allowed registry server's
//     tools, EXCEPT dangerous-and-unticked ones — those are OMITTED entirely,
//     so the model never sees them (no runtime reject, no hidden expansion).
//     This mirrors the buildToolDefs() peer-tool registration gate.
//   - registryNamespace / parseRegistryToolName: the `mcp__<key>__<tool>`
//     wire-name encode/decode. Underscores only (Anthropic tool-name regex
//     `^[a-zA-Z0-9_-]{1,64}$` — the same rule peerTools.ts documents).
//
// `ResolvedMcpServer.allowedDangerousTools` carries the operator's per-tab
// ticks (threaded by registryWiring.computeRegistryWiring). A dangerous tool
// is included iff its bare name is in that set; everything safe is always in.

import type { ClaudeToolDef } from './tools.js';
import type { ResolvedMcpServer } from '@arco/shared';
import { classifyDangerous, isMcpToolReadOnly, type McpSession } from '../../mcp/client.js';

// Wire-name prefix for a registry server's tools. The `key` is already the
// namespace-safe `reg-<id8>` from registryWiring.registryKey.
export function registryNamespace(key: string): string {
  return `mcp__${key}__`;
}

// Decode an `mcp__<key>__<tool>` wire name back into its parts. Returns null
// for any non-registry name (so the dispatcher can fall through). The bare
// tool name may itself contain `__`, so we split on the FIRST two `__` only.
export function parseRegistryToolName(wireName: string): { key: string; tool: string } | null {
  if (!wireName.startsWith('mcp__')) return null;
  const rest = wireName.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep < 0) return null;
  const key = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (!key.startsWith('reg-') || tool.length === 0) return null;
  return { key, tool };
}

// Anthropic 400s when input_schema carries a top-level oneOf/allOf/anyOf
// (peerTools.ts documents the same restriction). Some MCP servers emit those.
// Defensively drop the offending keys; if dropping leaves no usable object
// schema we still pass through `{type:'object', properties:{}}` so the tool
// stays callable with no declared params rather than being silently lost.
const FORBIDDEN_TOP_LEVEL = ['oneOf', 'allOf', 'anyOf'] as const;

function sanitizeInputSchema(
  raw: Record<string, unknown> | undefined,
): { schema: ClaudeToolDef['input_schema']; droppedKeys: string[] } {
  const droppedKeys: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { schema: { type: 'object', properties: {} }, droppedKeys };
  }
  const next: Record<string, unknown> = { ...raw };
  for (const k of FORBIDDEN_TOP_LEVEL) {
    if (k in next) { delete next[k]; droppedKeys.push(k); }
  }
  // Anthropic requires `type:'object'` + a properties object. Coerce both so a
  // server emitting a loose schema still yields a valid def.
  const properties = (next.properties && typeof next.properties === 'object')
    ? (next.properties as Record<string, unknown>)
    : {};
  const required = Array.isArray(next.required)
    ? (next.required as unknown[]).filter((r): r is string => typeof r === 'string')
    : undefined;
  return {
    schema: {
      type: 'object',
      properties,
      ...(required && required.length > 0 ? { required } : {}),
    },
    droppedKeys,
  };
}

// Dispatch-time denylist guard — defense in depth. registryToolDefs() omits
// dangerous-unticked tools so the model never SEES them, but a model can emit
// a tool_use for a name it was never advertised (guessing the namespace off an
// advertised safe sibling, or replaying one from earlier context). Without this
// the open session would happily execute it, defeating the operator gate. The
// CLI path is already enforced at dispatch by Claude Code's --disallowedTools;
// this gives Native the same guarantee. Allowed iff the server is in the
// per-tab set AND the tool is safe OR operator-ticked — the exact rule
// registryToolDefs uses for omission.
export function isRegistryToolAllowed(
  servers: ResolvedMcpServer[],
  key: string,
  toolName: string,
): boolean {
  const server = servers.find((s) => s.key === key);
  if (!server) return false;
  // DD11b — an operator-disabled tool is never allowed (disable wins, even over
  // a dangerous-tool tick).
  if ((server.disabledTools ?? []).includes(toolName)) return false;
  if (!classifyDangerous(toolName)) return true;
  return (server.allowedDangerousTools ?? []).includes(toolName);
}

// DD11a — plan-mode dispatch guard for registry MCP tools. With plan mode on,
// only read-only MCP tools may execute (mirrors how Write/Edit short-circuit).
// Looks the tool up in the open session so it can consult the server-declared
// annotations; an unknown tool fails closed (not read-only). registryToolDefs
// already OMITS non-readonly tools under plan mode, but a model can emit a
// tool_use for a name it was never advertised — this gives Native the same
// dispatch-time guarantee the CLI gets from --disallowedTools.
export function isRegistryToolReadOnly(session: McpSession, toolName: string): boolean {
  const tool = session.listTools().find((t) => t.name === toolName);
  if (!tool) return false;
  return isMcpToolReadOnly(tool);
}

// Build the Anthropic tool defs for the allowed registry servers, enforcing the
// denylist BY OMISSION. `sessions` maps each server `key` to its open
// McpSession (the cached tool list lives there). A server with no open session
// contributes nothing. `onNote` is an optional logging sink for dropped schema
// keys — the smoke passes none; the worker passes a console-backed logger.
export function registryToolDefs(
  servers: ResolvedMcpServer[],
  sessions: Map<string, McpSession>,
  onNote?: (note: string) => void,
  // DD11a — when the worker is in plan mode, OMIT every non-readonly MCP tool
  // (same posture as Write/Edit short-circuiting) so the model never sees a way
  // to mutate state while planning. Off by default (normal turns).
  planMode = false,
): ClaudeToolDef[] {
  const defs: ClaudeToolDef[] = [];
  for (const server of servers) {
    const session = sessions.get(server.key);
    if (!session) continue;
    const ticked = new Set(server.allowedDangerousTools ?? []);
    const disabled = new Set(server.disabledTools ?? []);
    for (const tool of session.listTools()) {
      // DD11b — operator-disabled tools are OMITTED outright (disable wins).
      if (disabled.has(tool.name)) continue;
      // Re-classify from the bare name (don't trust a cached flag) so the
      // denylist stays authoritative. Include iff safe OR operator-ticked.
      if (classifyDangerous(tool.name) && !ticked.has(tool.name)) continue;
      // Plan mode: hide anything not provably read-only (annotation-first,
      // verb fallback, fail-closed).
      if (planMode && !isMcpToolReadOnly(tool)) continue;
      const { schema, droppedKeys } = sanitizeInputSchema(tool.inputSchema);
      if (droppedKeys.length > 0 && onNote) {
        onNote(`registry tool ${server.key}/${tool.name}: dropped unsupported schema keys [${droppedKeys.join(', ')}]`);
      }
      defs.push({
        name: `${registryNamespace(server.key)}${tool.name}`,
        description: tool.description ?? `MCP tool ${tool.name} from ${server.key}`,
        input_schema: schema,
      });
    }
  }
  return defs;
}
