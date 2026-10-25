// CLUSTER_MODE_PLAN.md Phase 3 + EFFICIENCY_PLAN.md Phase F9 — per-workflow
// `mcp-config.json` writer.
//
// One file per workflow at `.archon/<wfid>/mcp-config.json` under the
// workflow's cwd. Originally written for cluster membership (Phase 3); F9
// extended it to ALSO carry the operator-attached `codebase-memory-mcp`
// entry. The two entries are independent — a workflow can have one, both,
// or neither — and the writer rewrites the file deterministically from the
// current intent on every call.
//
// Layout:
//   {
//     "mcpServers": {
//       "archon-cluster": { "command": "...", "args": [...] },     // when in a cluster
//       "codebase-memory": { "command": "codebase-memory-mcp", ... } // when attached
//     }
//   }
//
// When NEITHER entry applies the writer unlinks the file (best-effort) so a
// stale config can't poison the next CLI spawn. cleanupFor() remains the
// explicit "tear down regardless of state" entry point used by workflow
// removal.

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Resolve the absolute path to the cluster MCP server entry point. In dev
// (tsx watch) `import.meta.url` resolves to `.../server/src/mcp/mcpConfigWriter.ts`,
// so `clusterMcpServer.ts` is a sibling. In prod (`node dist/index.js`) the
// runtime sees `.../server/dist/mcp/mcpConfigWriter.js` and `clusterMcpServer.js`
// is the sibling. Either way the sibling-lookup works.
//
// Exported (Phase 4) so the Codex providers can reuse the same resolver when
// they construct `-c mcp_servers.archon-cluster.*` TOML overrides instead of
// a JSON config file. Codex's CLI accepts `-c key=value` overrides on top of
// `~/.codex/config.toml` and has no `--mcp-config <path>` equivalent, so the
// argv shape diverges from Claude's even though both spawn the same MCP
// child via the same command line.
export function resolveMcpServerEntry(): { command: string; args: string[] } {
  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev) {
    // Dev path: prefer the .ts source and run via npx tsx so the child
    // inherits the same transpile-on-import behavior the parent tsx-watch
    // process uses. The MCP child is short-lived (~per-claude-spawn) so the
    // tsx startup cost isn't load-bearing.
    const entry = resolve(HERE, 'clusterMcpServer.ts');
    return { command: 'npx', args: ['tsx', entry] };
  }
  const entry = resolve(HERE, 'clusterMcpServer.js');
  return { command: 'node', args: [entry] };
}

// Sibling resolver for the workflow-scoped `archon` server (plan tools). Same
// dev/prod split as resolveMcpServerEntry above.
export function resolveArchonMcpServerEntry(): { command: string; args: string[] } {
  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev) {
    return { command: 'npx', args: ['tsx', resolve(HERE, 'archonMcpServer.ts')] };
  }
  return { command: 'node', args: [resolve(HERE, 'archonMcpServer.js')] };
}

// VOICE_AGENT_PLAN.md — the archon-voice child for a `voiceOperator` Chat.
export function resolveVoiceMcpServerEntry(): { command: string; args: string[] } {
  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev) return { command: 'npx', args: ['tsx', resolve(HERE, 'voiceMcpServer.ts')] };
  return { command: 'node', args: [resolve(HERE, 'voiceMcpServer.js')] };
}
export function buildVoiceMcpOverrides(workflowId: string, port: number): string[] {
  const entry = resolveVoiceMcpServerEntry();
  return [
    '-c', `mcp_servers.archon-voice.command=${JSON.stringify(entry.command)}`,
    '-c', `mcp_servers.archon-voice.args=${JSON.stringify([...entry.args, workflowId, String(port)])}`,
    // 2026-10-17: Codex 0.163 fails every MCP call in a chat-mode thread with
    // "MCP tool call requires approval, but approval policy is never" (chats
    // run approvalPolicy 'never' under a read-only profile). The voice tools
    // are already bounded by VoiceExecutor and only the owning window executes
    // them, so pre-approve them at the server entry. Verified by
    // `npm run smoke:voice-luna`.
    '-c', 'mcp_servers.archon-voice.default_tools_approval_mode="approve"',
  ];
}

function configPath(workflowCwd: string, workflowId: string): string {
  return join(workflowCwd, '.archon', workflowId, 'mcp-config.json');
}

// EFFICIENCY_PLAN.md Phase F9 — codebase-memory MCP entry. The binary is
// operator-installed per `docs/OPERATIONS.md`; we invoke it as
// `codebase-memory-mcp serve --path <indexPath> --skip-config`. The
// `--skip-config` flag is LOAD-BEARING: without it the binary auto-edits
// other agent configs (documented in `docs/GOTCHAS.md § Efficiency`).
function buildCodebaseMemoryEntry(indexPath: string): { command: string; args: string[] } {
  return {
    command: 'codebase-memory-mcp',
    args: ['serve', '--path', indexPath, '--skip-config'],
  };
}

// ARCHON_OPS_PLAN.md §E1 — a registry-sourced MCP server resolved for a
// workflow. Defined in shared (`ResolvedMcpServer`) because it rides on the
// shared WorkerConfig across the provider seam; re-exported here under the
// writer-local name the call sites already reference.
import type { ClusterMemberAccessMode, ResolvedMcpServer } from '@archon/shared';
import { atomicWriteFile } from '../atomicFile.js';
export type RegistryMcpEntry = ResolvedMcpServer;

export interface McpConfigOptions {
  // When set, includes the archon-cluster MCP entry pointing at this cluster.
  clusterId?: string;
  // Cluster peer/plan tools follow clusterId; cluster_task_* tools are exposed
  // only when the operator explicitly attached this cluster to the cwd board.
  taskBoardAttached?: boolean;
  accessMode?: ClusterMemberAccessMode;
  // Archon HTTP port for the cluster MCP child to call back into.
  port: number;
  // EFFICIENCY_PLAN.md Phase F9 — when set, includes the codebase-memory
  // MCP entry pointing at the indexed tree. Caller resolves
  // `wf.config.codebaseMemory.indexPath || wf.config.workingDirectory`.
  codebaseMemoryIndexPath?: string;
  // ARCHON_OPS_PLAN.md §E1 — operator-enabled-and-allowed registry servers
  // for this workflow. Merged into `mcpServers` alongside the cluster /
  // codebase-memory entries. Empty / absent ⇒ no registry servers. These are
  // the ONLY model-exposed MCP servers besides the two built-in ones — no
  // hidden / model-selected expansion.
  registryServers?: RegistryMcpEntry[];
  // Workflow-scoped `archon` entry — plan create/attach/list tools. Unlike the
  // cluster entry this applies to EVERY workflow, so it carries the cwd (the
  // plan REST routes are keyed by `?path=<cwd>`). Absent ⇒ omitted, which is
  // what keeps the existing "no entries ⇒ unlink the file" branch reachable.
  planToolsCwd?: string;
}

// Shared argv for the workflow-scoped `archon` MCP child, so the JSON-config
// and Codex-TOML paths can never drift.
function archonEntryArgs(workflowId: string, cwd: string, port: number): { command: string; args: string[] } {
  const { command, args } = resolveArchonMcpServerEntry();
  return { command, args: [...args, workflowId, cwd, String(port)] };
}

// Merge desired entries and write `.archon/<wfid>/mcp-config.json`. Returns
// the absolute path when at least one entry applies, or `undefined` when
// neither does (in which case the file is unlinked best-effort so a stale
// config can't carry over). Callers pass the path to
// `claude --mcp-config <path>` only when the return value is defined.
export async function writeFor(
  workflowCwd: string,
  workflowId: string,
  opts: McpConfigOptions,
): Promise<string | undefined> {
  const path = configPath(workflowCwd, workflowId);
  const entries: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  if (opts.clusterId) {
    const { command, args: cmdArgs } = resolveMcpServerEntry();
    entries['archon-cluster'] = {
      command,
      args: [
        ...cmdArgs,
        opts.clusterId,
        workflowId,
        String(opts.port),
        opts.taskBoardAttached === true ? 'task-board-attached' : 'task-board-detached',
        opts.accessMode ?? 'standard',
      ],
    };
  }
  if (opts.planToolsCwd) {
    entries['archon'] = archonEntryArgs(workflowId, opts.planToolsCwd, opts.port);
  }
  if (opts.codebaseMemoryIndexPath) {
    entries['codebase-memory'] = buildCodebaseMemoryEntry(opts.codebaseMemoryIndexPath);
  }
  // §E1 — operator-enabled registry servers. Keyed by `key`; the CLI surfaces
  // each tool as `mcp__<key>__<tool>`. `env` carried through when present
  // (Anthropic's mcp-config accepts an `env` object for stdio servers).
  for (const r of opts.registryServers ?? []) {
    entries[r.key] = {
      command: r.command,
      args: r.args,
      ...(r.env && Object.keys(r.env).length > 0 ? { env: r.env } : {}),
    };
  }
  if (Object.keys(entries).length === 0) {
    await fs.rm(path, { force: true });
    return undefined;
  }
  await fs.mkdir(dirname(path), { recursive: true });
  // Anthropic's CLI accepts `command` (string) + `args` (string[]) for stdio
  // MCP servers. Tool-name namespacing comes from the top-level mcpServers
  // key (`archon-cluster` / `codebase-memory`) — the CLI surfaces tools as
  // `mcp__archon-cluster__peer_list`, `mcp__codebase-memory__*`, etc.
  // Atomic because a SPAWNED CLI CHILD reads this file, and the write happens
  // moments before the spawn. `rename` guarantees the child sees either the
  // whole previous config or the whole new one — never a partial object, which
  // would fail its JSON parse and silently strip the workflow's peer tools.
  await atomicWriteFile(path, JSON.stringify({ mcpServers: entries }, null, 2));
  return path;
}

// Best-effort full unlink. Called from workflow tear-down (handleRemoveWorkflow,
// member-remove follow-up) where the workflow itself is gone. For "leave the
// cluster but keep the workflow alive" call writeFor with the new opts
// instead so the codebase-memory entry survives if it was attached.
export async function cleanupFor(workflowCwd: string, workflowId: string): Promise<void> {
  await fs.rm(configPath(workflowCwd, workflowId), { force: true });
}

// Test surface — exposed so smokes can assert the file landed.
export function configPathFor(workflowCwd: string, workflowId: string): string {
  return configPath(workflowCwd, workflowId);
}

// CLUSTER_MODE_PLAN.md Phase 4 + EFFICIENCY_PLAN.md Phase F9 — build the
// Codex CLI `-c` argv overrides that register per-spawn MCP stdio children
// without touching `~/.codex/config.toml`.
//
// Codex CLI accepts `-c key=value` (TOML dotted-path) overrides that layer on
// top of the user's config — keys we don't set keep their operator values. So
// instead of merging a temp config.toml (TOML merge is non-trivial) we just
// emit the specific dotted keys for each MCP server we want, leaving every
// other operator-configured MCP server intact.
//
// The TOML value side is parsed by Codex's `-c` handler — strings are
// quoted, arrays use TOML array syntax. JSON.stringify happens to produce
// TOML-compatible output for both cases (TOML strings and arrays are a
// strict superset of JSON's quoting rules for these shapes), so we lean on
// the standard library rather than hand-rolling escaping.
//
// Used by both Codex transports (`exec` per-turn and `app-server` per-process).
// Symmetric with `writeFor()`'s JSON shape so the underlying MCP children see
// identical argv either way.
export function buildCodexMcpOverrides(
  workflowId: string,
  opts: McpConfigOptions,
): string[] {
  const out: string[] = [];
  if (opts.clusterId) {
    const { command, args: cmdArgs } = resolveMcpServerEntry();
    const fullArgs = [
      ...cmdArgs,
      opts.clusterId,
      workflowId,
      String(opts.port),
      opts.taskBoardAttached === true ? 'task-board-attached' : 'task-board-detached',
      opts.accessMode ?? 'standard',
    ];
    out.push(
      '-c', `mcp_servers.archon-cluster.command=${JSON.stringify(command)}`,
      '-c', `mcp_servers.archon-cluster.args=${JSON.stringify(fullArgs)}`,
    );
  }
  if (opts.planToolsCwd) {
    const entry = archonEntryArgs(workflowId, opts.planToolsCwd, opts.port);
    out.push(
      '-c', `mcp_servers.archon.command=${JSON.stringify(entry.command)}`,
      '-c', `mcp_servers.archon.args=${JSON.stringify(entry.args)}`,
    );
  }
  if (opts.codebaseMemoryIndexPath) {
    const entry = buildCodebaseMemoryEntry(opts.codebaseMemoryIndexPath);
    out.push(
      '-c', `mcp_servers.codebase-memory.command=${JSON.stringify(entry.command)}`,
      '-c', `mcp_servers.codebase-memory.args=${JSON.stringify(entry.args)}`,
    );
  }
  // §E1 — registry servers, same TOML dotted-key shape. Codex has NO per-tool
  // allow/deny flag, so EVERY tool of an enabled server is exposed — the
  // dangerous-tool denylist is NOT enforceable here (documented gap; surfaced
  // in the UI). `env` rides through as a TOML inline table when present.
  for (const r of opts.registryServers ?? []) {
    out.push(
      '-c', `mcp_servers.${r.key}.command=${JSON.stringify(r.command)}`,
      '-c', `mcp_servers.${r.key}.args=${JSON.stringify(r.args)}`,
    );
    if (r.env && Object.keys(r.env).length > 0) {
      // TOML inline-table: { "KEY" = "val", … }. JSON.stringify on each value
      // yields TOML-compatible quoted strings (same superset rationale as the
      // args array above).
      const pairs = Object.entries(r.env)
        .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
        .join(', ');
      out.push('-c', `mcp_servers.${r.key}.env={ ${pairs} }`);
    }
  }
  return out;
}
