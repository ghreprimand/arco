// -- MCP registry (docs/ARCHITECTURE.md) --
//
// A first-class registry of external MCP servers the operator can register
// once (globally) and then enable per workflow tab. Replaces the ad-hoc
// per-provider MCP wiring (cluster arco-cluster child + codebase-memory)
// with an operator-curated surface that funnels through the SAME
// `mcpConfigWriter` backbone the providers already accept.
//
// Security model (two LOCKED operator decisions, see docs/MCP_REGISTRY.md):
//   1. Server-level enable + dangerous-tool DENYLIST. Enabling a server for a
//      tab exposes ALL its tools EXCEPT tools whose names match a curated
//      dangerous-pattern denylist (write/delete/exec/shell/…). Those stay OFF
//      until the operator explicitly ticks them per tab. The full tool list is
//      always shown for transparency.
//   2. NO hidden / model-selected tool expansion — only operator-enabled
//      servers + operator-ticked dangerous tools are ever exposed.
//
// Per-transport enforcement reality (see docs/MCP_REGISTRY.md "Enforcement"):
//   - Claude CLI: enabled servers land in `mcp-config.json`; dangerous-and-
//     unticked tools are passed as `--disallowedTools mcp__<server>__<tool>`,
//     which DOES compose with `--dangerously-skip-permissions` (verified —
//     the tool is removed from the model's available set entirely).
//   - Codex: server-level enable only (TOML `-c mcp_servers.*` overrides).
//     Codex has no per-tool allow/deny flag, so the denylist CANNOT be
//     enforced — enabling a server on a Codex tab exposes ALL its tools. This
//     is surfaced as a known gap in the UI/diagnostics. Do not fake it.
//   - Claude Native: the in-process worker (E1-Native) is a first-class MCP
//     host reusing the same dependency-free client. The denylist is enforced
//     BY OMISSION — a dangerous-and-unticked tool never appears in the worker's
//     tool defs, so the model can't call it (no runtime reject needed). This is
//     the only transport that enforces the per-tool denylist in-process.

// A registered MCP server definition. Stored globally at
// `~/.arco/mcp/registry.json`. `command` + `args` spawn a stdio child
// (NEVER shell:true, NEVER sudo). `env` is merged over the spawn environment;
// values are secret-bearing and are NEVER logged.
export interface McpServerDef {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  // Global enable flag. A disabled server is never wired into ANY workflow
  // regardless of per-workflow allowlist state — it's the master switch.
  enabled: boolean;
  createdAt: number;
}

// One tool as reported by a server's `tools/list`, plus Arco's dangerous
// classification (computed from the tool NAME via the denylist regex). The
// classification is advisory transparency on Codex and load-bearing on CLI
// Claude (drives the `--disallowedTools` set).
export interface McpToolInfo {
  name: string;
  description?: string;
  dangerous: boolean;
}

// Per-workflow allowlist entry. Persisted in the workflow's meta.json under
// `mcpAllow[]` (keyed by serverId). `enabled` is the per-tab server toggle;
// `allowedDangerousTools` is the explicit per-tab tick-list of dangerous tools
// the operator opted back in. `tools` caches the last-probed tool list so the
// `--disallowedTools` computation at turn time is deterministic without a
// (latency-adding) probe on every spawn — refreshed whenever the operator
// runs a probe or edits the allowlist.
export interface McpWorkflowAllow {
  serverId: string;
  enabled: boolean;
  allowedDangerousTools: string[];
  // DD11b — per-tab tool DISABLE-list. Bare tool names the operator hid for
  // this tab regardless of dangerous classification (e.g. a noisy or
  // irrelevant safe tool). Filtered out at schema-emit (Native) and added to
  // --disallowedTools (CLI) so the model never sees them. Distinct from the
  // dangerous denylist: a SAFE tool can be disabled, and a ticked-on dangerous
  // tool can still be disabled (disable wins).
  disabledTools?: string[];
  tools?: McpToolInfo[];
}

// A registry-sourced MCP server resolved for a workflow turn. `key` is the
// `mcpServers` object key (and the tool-namespace segment — tools surface as
// `mcp__<key>__<tool>`). Built server-side from the global registry + the
// workflow's allowlist, then threaded into the worker config so the Codex
// providers can build their `-c mcp_servers.*` overrides and the CLI Claude
// writer can merge it into mcp-config.json. Lives in shared because
// WorkerConfig (a shared type) carries it across the server's provider seam.
export interface ResolvedMcpServer {
  key: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  // E1-Native — the bare names of dangerous tools the operator ticked back ON
  // for this workflow. The CLI/Codex paths express the denylist as
  // `--disallowedTools` / advisory; the in-process Native host instead enforces
  // it BY OMISSION at buildToolDefs() — it includes a tool iff the tool is not
  // dangerous OR its name is in this set. Empty/absent ⇒ only safe tools.
  // Ignored by mcpConfigWriter (CLI/Codex don't read it).
  allowedDangerousTools?: string[];
  // DD11b — per-tab disabled tools (bare names). The Native host omits them at
  // buildToolDefs(); the CLI writer folds them into --disallowedTools. Disable
  // wins over a dangerous-tool tick.
  disabledTools?: string[];
}

// ── Client → Server ──

export interface McpRegistryCreateMessage {
  type: 'mcp_registry_create';
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  // H21 — set after the operator acknowledges an OSV malware warning, so the
  // re-sent create bypasses the pre-check (block-with-override).
  overrideMalwareWarning?: boolean;
}

export interface McpRegistryUpdateMessage {
  type: 'mcp_registry_update';
  id: string;
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

export interface McpRegistryDeleteMessage {
  type: 'mcp_registry_delete';
  id: string;
}

// Request the current global registry snapshot (sent on tab open / refresh).
// When `workflowId` is present, the server ALSO pushes that workflow's
// per-tab allowlist (mcp_allow_snapshot) so the UI can render enable/tick
// state without a separate round-trip.
export interface McpRegistryListMessage {
  type: 'mcp_registry_list';
  workflowId?: string;
}

// Set a workflow's allowlist for one server: per-tab enable + dangerous-tool
// ticks. The server resolves the workflow's cwd and persists into meta.json.
export interface McpWorkflowAllowMessage {
  type: 'mcp_workflow_allow';
  workflowId: string;
  serverId: string;
  enabled: boolean;
  allowedDangerousTools: string[];
  // DD11b — per-tab disabled tools. Omitted ⇒ the existing disable-list is
  // preserved server-side (so a dangerous-tick edit doesn't clobber it).
  disabledTools?: string[];
}

// Connection diagnostics — spawn the server's stdio child, do the initialize
// handshake, list tools, classify each, tear the child down. `workflowId` is
// optional context for the result broadcast routing; the probe itself is
// workflow-independent.
export interface McpProbeMessage {
  type: 'mcp_probe';
  serverId: string;
  workflowId?: string;
}

// ── Server → Client ──

// The full global registry. Broadcast after every CRUD mutation and on
// request. `defs` carries the server defs WITHOUT env values (env is
// secret-bearing — the client never needs the values, only the key names to
// show "3 env vars set"). `envKeys` per id lists the configured key names.
export interface McpRegistrySnapshotMessage {
  type: 'mcp_registry_snapshot';
  defs: Array<Omit<McpServerDef, 'env'> & { envKeys: string[] }>;
}

// Probe result for one server. `tools` present + `ok:true` on success;
// `ok:false` + `error` on connect/handshake/timeout failure.
export interface McpProbeResultMessage {
  type: 'mcp_probe_result';
  serverId: string;
  workflowId?: string;
  ok: boolean;
  tools: McpToolInfo[];
  error?: string;
}

// A workflow's per-tab allowlist. Pushed after `mcp_workflow_allow` and on
// `mcp_registry_list` with a workflowId. The client keys it by workflowId.
export interface McpAllowSnapshotMessage {
  type: 'mcp_allow_snapshot';
  workflowId: string;
  allow: McpWorkflowAllow[];
}

// H21 — OSV malware pre-check tripped at registry-add. The create was NOT
// applied; the client shows the flagged package(s) + advisory ids and offers an
// override (re-send create with overrideMalwareWarning:true). The original
// create payload is echoed back so the client can re-send it verbatim.
export interface McpMalwareWarningMessage {
  type: 'mcp_malware_warning';
  pending: McpRegistryCreateMessage;
  packages: Array<{ name: string; ecosystem: string; ids: string[] }>;
}
