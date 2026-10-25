# MCP Registry (ARCHON_OPS_PLAN.md §E1)

A first-class registry for registering external MCP servers once, then enabling
them per workflow tab — replacing the ad-hoc per-provider MCP wiring (the
cluster `archon-cluster` child and `codebase-memory`) with an operator-curated
surface that funnels through the same `mcpConfigWriter` backbone the providers
already accept.

This doc covers both passes. **E1-core**: registry + per-workflow allowlist +
reusable MCP client + diagnostics + CLI-Claude/Codex wiring + management UI.
**E1-Native**: the Claude **Native** in-process worker is a first-class MCP host
— it opens a long-lived `McpSession` per allowed registry server (reusing the
same dependency-free client) and enforces the dangerous-tool denylist
**in-process, by omission** (a dangerous-unticked tool never appears in the
worker's tool defs). This is the only transport that enforces the per-tool
denylist in-process. See "Claude Native — denylist by omission" below.

## The two locked operator decisions

1. **Server-level enable + dangerous-tool denylist.** The operator enables a
   whole server for a tab (all its tools exposed) **except** tools whose names
   match a curated dangerous-pattern denylist (write / delete / remove / exec /
   shell / spawn / kill / put / post / patch / sudo / …). Those stay **OFF**
   until the operator explicitly ticks them per tab. The full tool list is
   always shown for transparency.
2. **No hidden, model-selected tool expansion.** Only operator-enabled servers
   and operator-ticked dangerous tools are ever exposed. There is no path by
   which the model can pull in additional MCP servers or tools.

Both satisfy the four-question test (CLAUDE.md): operator-initiated; bounded by
deterministic rules (the denylist regex + the per-tab allowlist); visible in
`events.jsonl` where the WS messages cross; reversible (disable / untick / delete).

## Storage model

- **Registry (global):** `~/.archon/mcp/registry.json` (override base with
  `$ARCHON_HOME`). One machine-wide list of `McpServerDef {id, name, command,
  args, env, enabled, createdAt}`. Atomic temp+rename writes (matches
  `taskLedger` / `planStore` / `workflowMeta`). `enabled` here is the **global
  master switch** — a globally-disabled server is never wired into any tab.
- **Allowlist (per workflow):** persisted in each workflow's `meta.json` under
  `mcpAllow[]` — `McpWorkflowAllow {serverId, enabled, allowedDangerousTools[],
  tools?}`. `enabled` is the **per-tab** server toggle; `allowedDangerousTools`
  is the explicit tick-list of dangerous tools opted back in; `tools` caches the
  last-probed tool list so the `--disallowedTools` computation at turn time is
  deterministic without a per-spawn probe.

Env values are **secret-bearing**: they are persisted to `registry.json` but
**never logged** and **never sent over the WebSocket** — the
`mcp_registry_snapshot` carries only env key *names* (`envKeys[]`) so the UI can
show "N env vars set".

## The dangerous-tool denylist

`classifyDangerous(toolName)` in `server/src/mcp/client.ts` is a pure helper
(exported, smoke-tested directly). It **tokenizes** the tool name across
snake_case, kebab-case, dotted, whitespace, and camelCase boundaries, then flags
the tool if any token is in the dangerous set (write, delete, del, remove, rm,
drop, truncate, destroy, exec, execute, eval, shell, spawn, run, kill,
terminate, sudo, command, cmd, put, post, patch, create, update, modify, move,
mv, rename, set, send, push, upload, overwrite, replace, insert).

Tokenization (not substring matching) is load-bearing: `readme` tokenizes to
`readme` (not `rm`) and `description` does not match — substring matching would
mis-flag both. Read-side verbs (read / list / get / search / query / describe)
are not in the set and stay enabled by default.

## Per-transport enforcement reality

The registry exposes the **same servers** to every wired transport, but the
**dangerous-tool denylist enforcement differs by transport**:

| Transport | Server enable | Dangerous-tool denylist |
|---|---|---|
| **CLI Claude** | `mcp-config.json` merge | **ENFORCED** via `--disallowedTools` |
| **Codex** (`exec` + `app-server`) | `-c mcp_servers.*` TOML overrides | **NOT ENFORCEABLE** — see gap below |
| **Claude Native** | open `McpSession` per allowed server | **ENFORCED** in-process by omission from tool defs |

### CLI Claude — `--disallowedTools` (verified)

After `--mcp-config <path>`, the CLI provider appends
`--disallowedTools "mcp__<key>__<tool>,…"` for every dangerous-and-unticked tool
of the workflow's enabled registry servers.

**Verified behavior** (Claude CLI 2.1.160): `--disallowedTools` **composes with
`--dangerously-skip-permissions`** — the named tool is removed from the model's
available set entirely (the model reports `No such tool available`), while
non-listed tools of the same server still work. So the denylist is a **real
mechanical enforcement** on CLI Claude even in AUTO mode, not a prompt-advisory
no-op. The verification used a fake stdio MCP server exposing `read_thing` +
`delete_thing`: with `--disallowedTools mcp__fake__delete_thing`, calling
`delete_thing` was blocked and `read_thing` succeeded.

### Codex — known gap (not faked)

Codex's CLI has **no per-tool allow/deny flag** (`server/src/providers/codex.ts`:
"No equivalent to Claude's `--tools` allow-list"). It can only register a server
wholesale via `-c mcp_servers.<key>.*` TOML overrides — which exposes **all** of
that server's tools. The dangerous-tool denylist therefore **cannot be enforced
on Codex tabs**. Arco does not fake enforcement: it surfaces this honestly in
the MCP CONFIG section with a banner ("Codex exposes all tools of an enabled
server — it has no per-tool deny flag, so the dangerous-tool denylist is not
enforced here") and per-tool "(not gated on Codex)" labels. Server-level
enable/disable **is** honored on Codex.

### Claude Native — denylist by omission (in-process)

The Native worker runs the agent loop in Arco's own process, so it doesn't
shell out to a CLI — there is no `--disallowedTools` flag to lean on. Instead the
denylist is enforced **by omission** at `buildToolDefs()`: a dangerous-and-
unticked tool is **never added to the worker's tool defs**, so the model never
sees it and cannot call it. This is stronger than a runtime reject — there is no
tool to reject. `server/src/providers/claude-native/registryTools.ts`
(`registryToolDefs`) is the authoritative gate; it includes a tool iff the tool
is safe (`!classifyDangerous`) OR its bare name is in that server's operator-
ticked set (`ResolvedMcpServer.allowedDangerousTools`, threaded by
`computeRegistryWiring`). Tool names are namespaced `mcp__<key>__<tool>`
(underscores only — Anthropic's tool-name regex), matching the CLI/Codex wire
form. A top-level `oneOf`/`allOf`/`anyOf` in a server's `inputSchema` (which
Anthropic 400s on) is defensively dropped from the emitted def, with a logged
note.

**Session lifecycle.** The worker keeps a map of open `McpSession` keyed by
server `key`, reconciled at the top of every `runTurn` (`reconcileMcpSessions`):
newly-allowed servers are connected lazily, servers the operator removed since
the last turn are closed and dropped. Sessions persist across turns (caching is
fine). On `dispose()` (tab close + after `handoff_complete`) **every session is
force-closed** — a leaked stdio child would otherwise outlive the worker
(load-bearing; see `docs/GOTCHAS.md § Claude Native transport`). `cancel()` does
not touch sessions — they survive an operator CANCEL by design and are torn down
only on full disposal. `dispatchTool` routes `mcp__reg-<id8>__<tool>` to the
matching open session's `callTool`; a missing/closed session returns a clean
`[error] …`, never throws.

## Wiring (where registry servers enter a turn)

A single helper, `server/src/mcp/registryWiring.ts`, owns the merge so the
security model lives in one place:

- `computeRegistryWiring(defs, allow)` — pure core. Given the global server defs
  + the workflow's allowlist, returns `{ registryServers, disallowedTools }`. A
  server contributes only if it is **globally enabled** AND the tab's allowlist
  marks it enabled. Each non-dangerous tool is exposed implicitly; each
  dangerous tool is denied unless its bare name is in `allowedDangerousTools`.
  Re-classifies from the bare name (keeps the denylist authoritative even if the
  cached flag is stale).
- `resolveRegistryWiring(allow)` — disk-backed convenience that loads the global
  registry and computes against the caller-supplied allowlist.

The two live call sites that assemble MCP intent call the helper rather than
re-deriving the merge:

- `server/src/ws/turnEngine.ts` (`handleUserMessage`) — the primary operator
  turn. Reads `meta.mcpAllow`, resolves the wiring, passes `registryServers`
  into `mcpConfigWriter.writeFor` (CLI Claude) and threads `mcpRegistryServers` +
  `mcpDisallowedTools` into the worker config (Codex reads `mcpRegistryServers`
  to build `-c` overrides; CLI Claude reads `mcpDisallowedTools` for
  `--disallowedTools`).
- `server/src/ws/clusterHandlers.ts` (`syncMcpConfigForWorkflow`) — keeps the
  on-disk `mcp-config.json` coherent when cluster/codebase-memory toggle, so the
  registry entries survive an off-path rewrite.

`mcpConfigWriter` (`McpConfigOptions.registryServers`, `writeFor`,
`buildCodexMcpOverrides`) merges the registry entries alongside the existing
`archon-cluster` / `codebase-memory` entries — the cluster + codebase-memory
behaviour is unchanged. Registry keys are namespaced `reg-<id8>` so they can't
collide with the two built-in keys; tools surface as `mcp__reg-<id8>__<tool>`.

## Protocol

Defined in `shared/src/protocol/mcp.ts`:

- **Client → Server:** `mcp_registry_create` / `mcp_registry_update` /
  `mcp_registry_delete` / `mcp_registry_list` (optionally with `workflowId` to
  also pull the tab's allowlist), `mcp_workflow_allow` (set a tab's server
  enable + dangerous-tool ticks), `mcp_probe` (diagnostics).
- **Server → Client:** `mcp_registry_snapshot` (env-stripped; broadcast to all
  clients after every CRUD mutation since the registry is global),
  `mcp_probe_result` (tools + ok/error), `mcp_allow_snapshot` (a tab's
  allowlist, pushed after `mcp_workflow_allow` and on list-with-workflowId).

Handlers: `server/src/ws/mcpHandlers.ts`, routed in `server/src/index.ts`.

## The reusable MCP client

`server/src/mcp/client.ts` — a **dependency-free** stdio JSON-RPC client (no
`@modelcontextprotocol` SDK on the client side; newline-delimited JSON-RPC 2.0,
the same framing `clusterMcpServer.ts` speaks). Both the one-shot probe and the
long-lived session share one framing helper so the wire contract lives in one
place. E1-Native imports it so the Native worker is an MCP host without dragging
in the SDK transport machinery.

- `probeServer(def, opts)` — spawn the stdio child (argv array, never
  `shell:true`, never sudo), run `initialize` → `notifications/initialized` →
  `tools/list`, classify each tool, force-kill the child. Bounded by
  `timeoutMs` (default 10 s) so a hung child can't wedge the server. Always
  resolves (failure as `{ ok:false, error }`). One-shot — powers diagnostics AND
  the visible tool list, and refreshes the cached `tools` on the workflow
  allowlist.
- `connectServer(def, opts): Promise<McpSession>` — **E1-Native**: a long-lived
  session. Spawn → `initialize` → ready for repeated `tools/call`. The session
  exposes `listTools()` (cached from the handshake, carrying each tool's raw
  `inputSchema`), `callTool(name, args)` (per-call timeout, default 60 s), and
  `close()` (force-kill, idempotent). **Never throws into the turn loop**: a
  spawn/initialize failure resolves to a *closed session* whose `callTool`
  returns `{ isError:true, text:'[error] …' }` and whose `listTools` is empty; a
  timed-out call is reported the same way. An unexpected child exit fails every
  awaiting call rather than hanging.
- `classifyDangerous(toolName)` — the pure denylist helper described above.

## Management UI

`client/src/components/RightPanel/McpRegistrySection.tsx`, mounted in the CONFIG
tab for Claude (CLI + Native) and Codex tabs. It can:

- CRUD registry servers (add by command + args; toggle the global enable;
  remove).
- Per-tab enable a globally-enabled server, with its tool list shown — dangerous
  tools flagged `DANGEROUS` and individually tickable; safe tools listed
  read-only.
- Run a `probe` (diagnostics: connected? N tools? error?).
- On a Codex tab, the gap banner + per-tool "(not gated on Codex)" labels.

Help entry: `rightpanel.config.mcp` (run `npm run docs:check`).

## Smoke

`scripts/smoke/mcp-registry.ts` (`npm run smoke:mcp-registry`) — headless, temp
`$ARCHON_HOME` under `os.tmpdir()`, cleaned up. Covers: registry CRUD round-trip
+ persistence; `classifyDangerous` on dangerous + safe names; per-workflow
allowlist enable/disable changing the merged `mcpServers` object; a
globally-disabled and a per-tab-disabled server absent; dangerous-and-unticked
tools in the CLI `--disallowedTools` set while ticked ones are not; the Codex
`-c` override form; `probeServer` end-to-end against a fake MCP stdio child
(plus a bounded-timeout failure case).
