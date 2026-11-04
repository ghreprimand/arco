// server/src/ws/mcpHandlers.ts — MCP registry WS handlers
// (docs/ARCHITECTURE.md).
//
// The registry is a GLOBAL machine-wide list (~/.arco/mcp/registry.json),
// so CRUD mutations broadcast a fresh snapshot to every connected client. The
// per-workflow allowlist is cwd-scoped, persisted in the workflow's meta.json
// (mcpAllow[]); `mcp_workflow_allow` resolves the cwd from the workflow and
// re-syncs the on-disk mcp-config so the change takes effect on the next turn
// without a restart.
//
// Probes spawn a short-lived stdio child via the dependency-free client
// (probeServer) — bounded timeout, force-killed on completion. The probe
// result drives diagnostics AND refreshes the cached tool list used to compute
// `--disallowedTools` deterministically at turn time.
//
// SECURITY: snapshots NEVER carry env values (only the key names, so the UI can
// show "N env vars set"). env is secret-bearing and is never sent over the wire
// nor logged.

import { WebSocket } from 'ws';
import type {
  McpRegistryCreateMessage,
  McpRegistryUpdateMessage,
  McpRegistryDeleteMessage,
  McpWorkflowAllowMessage,
  McpProbeMessage,
  McpRegistryListMessage,
  McpRegistrySnapshotMessage,
  McpServerDef,
} from '@arco/shared';
import * as registry from '../mcp/registry.js';
import { probeServer } from '../mcp/client.js';
import { checkCommandForMalware } from '../mcp/osvCheck.js';
import { reclassify } from '../mcp/registryWiring.js';
import { setMcpAllow, setMcpProbedTools, readMeta } from '../workflowMeta.js';
import { syncMcpConfigForWorkflow } from './clusterHandlers.js';
import { workflows, workflowCwds, sessions } from '../server/state.js';
import { send } from '../server/broadcast.js';

function cwdForWorkflow(workflowId: string): string | null {
  const wf = workflows.get(workflowId);
  const cwd = wf?.config.workingDirectory ?? workflowCwds.get(workflowId);
  return cwd && cwd.length > 0 ? cwd : null;
}

// env-stripped snapshot row: the client needs key NAMES (to show count /
// presence) but never the secret values.
function toSnapshot(defs: McpServerDef[]): McpRegistrySnapshotMessage {
  return {
    type: 'mcp_registry_snapshot',
    defs: defs.map((d) => {
      const { env, ...rest } = d;
      return { ...rest, envKeys: Object.keys(env ?? {}) };
    }),
  };
}

// Broadcast the current global registry to every connected client (registry is
// machine-global; all tabs see the same list).
async function broadcastRegistry(): Promise<void> {
  const snap = toSnapshot(await registry.list());
  for (const ws of sessions.keys()) {
    if (ws.readyState === WebSocket.OPEN) send(ws, snap);
  }
}

// Push a workflow's per-tab allowlist to the requesting client.
async function sendAllowSnapshot(ws: WebSocket, workflowId: string): Promise<void> {
  const cwd = cwdForWorkflow(workflowId);
  if (!cwd) return;
  const meta = await readMeta(cwd, workflowId);
  send(ws, { type: 'mcp_allow_snapshot', workflowId, allow: meta?.mcpAllow ?? [] });
}

export async function handleMcpRegistryList(ws: WebSocket, msg: McpRegistryListMessage): Promise<void> {
  send(ws, toSnapshot(await registry.list()));
  if (msg.workflowId) await sendAllowSnapshot(ws, msg.workflowId);
}

export async function handleMcpRegistryCreate(
  ws: WebSocket,
  msg: McpRegistryCreateMessage,
): Promise<void> {
  const command = (msg.command ?? '').trim();
  if (!command) {
    send(ws, { type: 'error', message: 'MCP registry: command is required.' });
    return;
  }
  // H21 — OSV malware pre-check (block-with-override, fail-open). Skipped when
  // the operator already acknowledged the warning (re-send with the override).
  if (!msg.overrideMalwareWarning) {
    const osv = await checkCommandForMalware(command, msg.args ?? []);
    if (osv.malicious.length > 0) {
      send(ws, {
        type: 'mcp_malware_warning',
        pending: { ...msg, overrideMalwareWarning: true },
        packages: osv.malicious,
      });
      console.warn(`[arco] MCP registry-add blocked pending override: OSV malware advisory for ${osv.malicious.map((m) => m.name).join(', ')}`);
      return;
    }
    if (osv.error) {
      // Fail-open: OSV unreachable must not block the add. Log only.
      console.warn(`[arco] MCP OSV pre-check failed open (${osv.error}); proceeding with add`);
    }
  }
  await registry.create({
    name: (msg.name ?? '').trim() || command,
    command,
    args: msg.args ?? [],
    env: msg.env ?? {},
    enabled: msg.enabled ?? false,
  });
  await broadcastRegistry();
}

export async function handleMcpRegistryUpdate(
  _ws: WebSocket,
  msg: McpRegistryUpdateMessage,
): Promise<void> {
  await registry.upsert(msg.id, {
    name: msg.name,
    command: msg.command,
    args: msg.args,
    env: msg.env,
    enabled: msg.enabled,
  });
  await broadcastRegistry();
}

export async function handleMcpRegistryDelete(
  _ws: WebSocket,
  msg: McpRegistryDeleteMessage,
): Promise<void> {
  await registry.remove(msg.id);
  await broadcastRegistry();
}

export async function handleMcpWorkflowAllow(
  ws: WebSocket,
  msg: McpWorkflowAllowMessage,
): Promise<void> {
  const cwd = cwdForWorkflow(msg.workflowId);
  if (!cwd) {
    send(ws, { type: 'error', message: 'MCP allow: workflow has no working directory.' });
    return;
  }
  // setMcpAllow preserves any existing cached probe `tools` (we don't supply a
  // fresh list here — the operator probes separately). The cache is what the
  // turn-time --disallowedTools computation reads.
  await setMcpAllow(cwd, msg.workflowId, {
    serverId: msg.serverId,
    enabled: msg.enabled,
    allowedDangerousTools: msg.allowedDangerousTools ?? [],
    // DD11b — undefined ⇒ preserve the existing disable-list (setMcpAllow).
    disabledTools: msg.disabledTools,
  });
  await sendAllowSnapshot(ws, msg.workflowId);
  // Re-sync the on-disk mcp-config so the enable/disable takes effect on the
  // next CLI Claude turn without a server restart (Codex reads its overrides
  // at spawn time from in-memory config, which the next turn rebuilds).
  await syncMcpConfigForWorkflow(msg.workflowId).catch((err) => {
    console.error(`[arco] [${msg.workflowId.slice(0, 8)}] mcp config re-sync failed:`, err);
  });
}

export async function handleMcpProbe(
  ws: WebSocket,
  msg: McpProbeMessage,
): Promise<void> {
  const def = await registry.get(msg.serverId);
  if (!def) {
    send(ws, {
      type: 'mcp_probe_result',
      serverId: msg.serverId,
      ...(msg.workflowId ? { workflowId: msg.workflowId } : {}),
      ok: false,
      tools: [],
      error: 'server not found in registry',
    });
    return;
  }
  const result = await probeServer(def);
  const tools = reclassify(result.tools);
  // Cache the probed tool list onto the workflow's allowlist entry (if one
  // exists) so turn-time --disallowedTools is deterministic. No-op when the
  // server isn't yet enabled for the workflow.
  if (msg.workflowId && result.ok) {
    const cwd = cwdForWorkflow(msg.workflowId);
    if (cwd) {
      await setMcpProbedTools(cwd, msg.workflowId, msg.serverId, tools).catch(() => undefined);
    }
  }
  send(ws, {
    type: 'mcp_probe_result',
    serverId: msg.serverId,
    ...(msg.workflowId ? { workflowId: msg.workflowId } : {}),
    ok: result.ok,
    tools,
    ...(result.error ? { error: result.error } : {}),
  });
}
