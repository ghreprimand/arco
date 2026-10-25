# Codex gpt-5.6 code mode and Arco cluster tools

## Known issue

Codex CLI 0.144.0 runs gpt-5.6 models in code mode. The model's tool surface is
an `exec` code cell with native Codex multi-agent tools. Arco's cluster MCP tools
remain available, but they are namespaced inside the cell's `tools` object. A
role prompt that names only top-level `peer_send` can therefore leave the model
unable to find the Arco cluster tools, even when the MCP server is connected.

The code-mode name for the cluster read tool is:

```js
await tools.mcp__arco_cluster__peer_read()
```

The corresponding send and member-list tools are:

```js
await tools.mcp__arco_cluster__peer_send({ to, content })
await tools.mcp__arco_cluster__peer_list()
```

Codex normalizes the server name `arco-cluster` to `arco_cluster` in this
namespace. Other transports expose different names for the same protocol tools:

| Transport | Tool name example |
| --- | --- |
| Claude CLI | `mcp__arco-cluster__peer_send` |
| Codex code mode | `tools.mcp__arco_cluster__peer_send({ to, content })` |
| Arco cluster API | `peer_send` |

The code-mode issue is a discoverability mismatch; the Arco MCP server does not
remove or disable cluster capabilities. A prompt that only names the API or a
top-level MCP name does not show the model how to call the namespaced tool.

## Arco integration

Arco adds a short, provider-specific instruction when Codex model metadata
indicates code mode. The instruction names the exact tools above and clarifies
that Codex's native collaboration tools do not reach the Arco cluster. It adds
no model authority and changes no cluster protocol or tool permissions.

`codexCodeModeClusterAddendum()` in `server/src/providers/codexCodeMode.ts`
provides the instruction. `codexModelUsesCodeMode(modelId, codexHome)` reads
Codex's model catalog and detects entries with a `tool_mode` value beginning
with `code_mode` or a non-null `multi_agent_version`. Detection follows catalog
metadata instead of hard-coded model-name matching. The catalog cache is
validated by modification time.

Unknown models and missing catalogs fail open: the conditional instruction
explains how to locate Arco tools if the surface is an `exec` code cell. Models
explicitly identified as direct function-calling skip the addendum. Only Codex
primary workflows receive it; a different provider using a Codex transport does
not. The addendum is context only. It does not add tools, change permission
checks, expand the cluster allowlist, or grant director authority.

## Verification

`npm run test:codex-code-mode` covers model-catalog detection, cache refresh,
fail-open behavior, direct-model exclusion, and the addendum's exact tool names
and send arguments. When upgrading Codex CLI, verify the tool names exposed in
an `exec` cell and confirm that the catalog still uses the fields above. If the
namespace changes, update the addendum and its test together.

The behavior was verified with codex-cli 0.144.0. In that release, gpt-5.6
models identify code mode through `tool_mode` or `multi_agent_version` catalog
fields. Some direct function-calling models do not need the addendum. Model
catalogs and tool surfaces can change between releases; the test protects Arco's
integration contract but does not certify every Codex model or account setup.

When updating Codex support, check three boundaries: the catalog fields that
select code mode, the MCP tool names exposed inside an `exec` cell, and the
cluster role text delivered to the model. Verify that `peer_read`, `peer_send`,
and `peer_list` can be called through the namespaced tools. Keep the send
arguments `{ to, content }`; changing the name or parameter shape can make a
reachable MCP server appear unusable to the model. Do not substitute Codex's
native `spawn_agent`, `send_message`, or `followup_task` tools: those coordinate
a separate Codex team and do not reach the Arco cluster.
