// docs/ARCHITECTURE.md - bridge the global registry + a workflow's per-tab
// allowlist into the MCP intent the providers consume.
//
// Single source of truth for "which registry servers + which dangerous-tool
// denials apply to this workflow's turn". The three callers that assemble MCP
// intent (turnEngine, clusterHandlers.syncMcpConfigForWorkflow,
// workflowHandlers) call resolveRegistryWiring() rather than re-deriving the
// merge, so the security model lives in exactly one place.
//
// Returns BOTH:
//   - registryServers: McpConfigWriter entries for enabled-and-allowed servers
//     (merged into mcp-config.json for CLI Claude and `-c` overrides for Codex)
//   - disallowedTools: `mcp__<key>__<tool>` names for dangerous-and-UNticked
//     tools of those servers — passed to CLI Claude as `--disallowedTools`,
//     which (verified) composes with `--dangerously-skip-permissions` and
//     removes the tool from the model's set entirely. Codex has no equivalent;
//     these are advisory-only there (documented gap).

import type { McpServerDef, McpWorkflowAllow, McpToolInfo } from '@arco/shared';
import type { RegistryMcpEntry } from './mcpConfigWriter.js';
import { classifyDangerous } from './client.js';
import * as registry from './registry.js';

export interface RegistryWiring {
  registryServers: RegistryMcpEntry[];
  disallowedTools: string[];
}

// Stable, namespace-safe mcpServers key for a registry server. Distinct prefix
// avoids any collision with the built-in `arco-cluster` / `codebase-memory`
// keys, and the short id suffix keeps the wire-level `mcp__<key>__<tool>`
// readable. Hyphens are valid in the namespace (cf. arco-cluster).
export function registryKey(serverId: string): string {
  return `reg-${serverId.slice(0, 8)}`;
}

// Pure core — given the global server defs + the workflow's allowlist, compute
// the wiring. Exported so the smoke drives it without disk/meta access.
//
// Rules (LOCKED decisions §1 + §2 / four-question test):
//   - A server contributes ONLY if it is globally `enabled` AND the workflow's
//     allowlist marks it `enabled` (per-tab opt-in). No allowlist entry ⇒ off.
//   - Every NON-dangerous tool is exposed implicitly (server-level enable).
//   - A dangerous tool is denied UNLESS its bare name is in
//     `allowedDangerousTools` (operator ticked it for this tab).
//   - `tools` is the last-probed list cached in the allowlist entry. If a
//     server was enabled but never probed (no cached tools), it is still wired
//     (server-level enable) but NO disallowed entries are computed — we can't
//     deny tools we've never seen. The UI nudges the operator to probe; until
//     then a never-probed server on CLI Claude behaves like Codex (all tools
//     exposed). This is surfaced as a diagnostic, not hidden.
export function computeRegistryWiring(
  defs: McpServerDef[],
  allow: McpWorkflowAllow[],
): RegistryWiring {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const registryServers: RegistryMcpEntry[] = [];
  const disallowedTools: string[] = [];

  for (const a of allow) {
    if (!a.enabled) continue;
    const def = byId.get(a.serverId);
    if (!def || !def.enabled) continue; // global master switch off ⇒ never wire

    const key = registryKey(def.id);
    const disabled = a.disabledTools ?? [];
    registryServers.push({
      key,
      command: def.command,
      args: def.args,
      ...(def.env && Object.keys(def.env).length > 0 ? { env: def.env } : {}),
      // E1-Native — carry the operator's per-tab dangerous-tool ticks so the
      // in-process Native host can enforce the denylist by omission. CLI/Codex
      // ignore this; they enforce via --disallowedTools / advisory instead.
      ...(a.allowedDangerousTools.length > 0 ? { allowedDangerousTools: [...a.allowedDangerousTools] } : {}),
      // DD11b — carry the per-tab disable-list so the Native host omits those
      // tools too (disable wins over a dangerous tick).
      ...(disabled.length > 0 ? { disabledTools: [...disabled] } : {}),
    });

    const ticked = new Set(a.allowedDangerousTools);
    const disabledSet = new Set(disabled);
    for (const t of a.tools ?? []) {
      // Re-classify from the bare name rather than trusting the cached flag —
      // keeps the denylist authoritative even if the cache is stale. A tool is
      // disallowed (CLI) if it's dangerous-and-unticked OR operator-disabled.
      if (disabledSet.has(t.name) || (classifyDangerous(t.name) && !ticked.has(t.name))) {
        disallowedTools.push(`mcp__${key}__${t.name}`);
      }
    }
    // DD11b — a disabled tool the operator never probed (not in the cached
    // `tools`) still must be denied on CLI. Add any disable-list entry not
    // already covered by the loop above.
    for (const name of disabled) {
      const wire = `mcp__${key}__${name}`;
      if (!disallowedTools.includes(wire)) disallowedTools.push(wire);
    }
  }
  return { registryServers, disallowedTools };
}

// Disk-backed resolution: load the global registry and the workflow's allowlist
// from meta.json, then compute. Used by the live call sites. `allow` comes from
// the caller (it already has the workflow's meta loaded) to avoid a redundant
// meta read; pass [] when the workflow has no allowlist yet.
export async function resolveRegistryWiring(allow: McpWorkflowAllow[]): Promise<RegistryWiring> {
  const defs = await registry.list();
  return computeRegistryWiring(defs, allow);
}

// Convenience for tests / probes: re-classify a fresh tool list against the
// denylist (the probe already does this, but the allowlist may carry a stale
// cache the operator hasn't refreshed).
export function reclassify(tools: McpToolInfo[]): McpToolInfo[] {
  return tools.map((t) => ({ ...t, dangerous: classifyDangerous(t.name) }));
}
