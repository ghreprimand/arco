# Codex gpt-5.6 (Sol / Terra / Luna) — native multi-agent "code mode" vs cluster membership

**Status:** RESOLVED 2026-07-09 · codex-cli **0.144.0** · fix shipped (code-mode cluster addendum) · not an Arco bug
**TL;DR:** The gpt-5.6 models run OpenAI's own multi-agent orchestration ("code mode": the model is
told *"You are `/root`, the primary agent in a team of agents"*, gets native `spawn_agent` /
`send_message` tools, and its tool surface becomes a JS `exec` code cell). Arco's cluster peer
tools are **not removed** in that mode — they move INSIDE the exec cell's `tools` namespace under
mangled names (`tools.mcp__archon_cluster__peer_send`). The incident member ignored the peer
substrate because Arco's role text said "peer_send" — a name that doesn't exist in its world —
while the harness gave its own `send_message` top billing. **Fix (shipped): a code-mode addendum
folded into the cluster role blocks that names the exec-cell tools verbatim and disclaims the
harness's native collaboration tools.** Verified live on both Codex transports: terra drains its
mailbox, peer_sends the director an ACK, and correctly disclaims directorship. gpt-5.6 cluster
members are now supported.

---

## 1. Symptoms (what the operator saw, 2026-07-09)

A cluster on a project (5 members) with one Codex member — a **Standard Builder** on
`gpt-5.6-terra` (HOME account, HIGH effort):

1. The terra member **"doesn't seem to be aware it is set to a builder"** — when asked *"Did you send
   mail back to the director?"* it replied: *"No. I am the director for this cluster. I reviewed and
   pushed the five commits to `origin/master`…"* (verbatim the actual Director's line).
2. It **never sends peer mail** — no `peer_send`, no cluster coordination.

## 2. Root cause (refined)

codex-cli 0.144 runs gpt-5.6 (sol/terra/luna) in OpenAI's native multi-agent "code mode" (the
`codex-code-mode-host` child process). Codex injects its own developer prompt: *"You are an agent in
a team of agents… use `spawn_agent`, `followup_task`, `send_message`… collaboration tools cannot be
called from inside `functions.exec`."* The model's tool surface becomes a JS `exec` code cell
(`custom_tool_call` items running `await tools.exec_command({...})` style code).

The original write-up concluded the MCP tools were demoted and unreachable. **That was wrong.**
Live enumeration of `Object.keys(tools)` inside a terra exec cell (with the archon-cluster MCP
server wired exactly as Arco wires it) shows the peer tools present and callable:

```
mcp__archon_cluster__peer_list
mcp__archon_cluster__peer_read
mcp__archon_cluster__peer_send
```

Note the mangling: server name `archon-cluster` → `archon_cluster` (dash → underscore), then
`mcp__<server>__<tool>`. This is a **third** wire shape for the same tool — Native sees bare
`peer_send`, Claude CLI sees `mcp__archon-cluster__peer_send` (dash preserved), Codex code mode
sees `tools.mcp__archon_cluster__peer_send` (dash → underscore, inside the exec namespace).

So the two symptoms decompose as:

| Symptom | Mechanism |
|---|---|
| "Thinks it's the director" | Codex's harness prompt tells it *it* is `/root`, the primary agent of its own team. Arco's folded "Standard Builder" role hint loses to it. |
| "Never sends peer mail" | The model is told to coordinate via native `spawn_agent`/`send_message`; Arco's role text names `peer_send`, which does not exist as a top-level tool in code mode. The model can't map "peer_send" to `tools.mcp__archon_cluster__peer_send`, so it never finds the substrate. It DID try to coordinate — the incident rollout shows 6 native `send_message` calls (to `/root`, i.e. its reply channel) — through the only surface it knew. |

**Not an Arco wiring bug** — the MCP child was alive, the role text reached the prompt, and the
tools were in the namespace the whole time. A discoverability collision, not a capability loss.

## 3. Evidence

Cluster `9be4b045-ec67-48da-b4b8-a8571cdd6ea8`, terra member `2ce7a314-…` (original incident):

- MCP override present in the live app-server args; `clusterMcpServer.js` child alive (two PIDs).
- Arco's role + peer text reached the prompt — the session rollout contains "Standard builder"
  (×8), "peer mailbox", "peer_list", the full shared cluster plan.
- Across 236 tool calls (98 exec `custom_tool_call`s in the surviving rollout): **zero**
  `tools.mcp__*` references. The exec cells used only `tools.exec_command` (×85) and
  `tools.apply_patch` (×13). Plus native `send_message` ×6 / `wait` ×4 — the harness's own tools.
- The three Claude members on the identical substrate made 94 peer/cluster calls between them.

Post-incident verification (2026-07-09, this investigation):

| Test | Transport | Result |
|---|---|---|
| `Object.keys(tools)` enumeration in exec cell | `codex exec`, default code mode | `mcp__archon_cluster__peer_*` present |
| "call peer_read" with exact exec-namespace name | `codex exec`, default code mode | tool call received by MCP server, first try |
| Amended role hint (see §5) + file task | `codex exec`, default code mode | peer_read → task → peer_send ACK → *"No, I am not the Director; I'm the Standard Builder."* |
| Same, via `thread/start` + `turn/start` with Arco's exact app-server param shapes and `-c mcp_servers.archon-cluster.*` overrides | **app-server** | peer_read → peer_list → task (verified) → peer_send ACK → *"No—I am the Standard Builder, not the Director."* 10.8 s turn. MCP calls surface as normal `mcpToolCall` items. |

## 4. The fix (shipped)

`server/src/providers/codexCodeMode.ts` + a fold in `turnEngine.ts`'s string-form cluster block
(right after the role hint):

- **`codexCodeModeClusterAddendum()`** — a ~700-byte block that (a) disclaims the harness's native
  collaboration tools ("spawn_agent / send_message do NOT reach this Arco cluster; being `/root`
  does not make you this cluster's director"), and (b) names the real tools verbatim:
  `await tools.mcp__archon_cluster__peer_read()`, `…peer_send({to, content})`, `…peer_list()`, plus
  the naming rule for `cluster_task_*` / `cluster_plan_*`. The whole fix is the verbatim names —
  the model executes them correctly the moment it knows them.
- **`codexModelUsesCodeMode(modelId, codexHome)`** — catalog-driven detection, no model-name regex.
  Reads codex's own `$CODEX_HOME/models_cache.json`; a model is code-mode iff its entry carries
  `tool_mode: "code_mode*"` or a non-null `multi_agent_version` — the exact ModelInfo fields that
  gate the harness client-side (§6 proves they're causal). mtime-validated in-memory cache. A
  future gpt-5.7 that ships the harness is caught automatically; a 5.6 build that drops it stops
  matching. **Fail-open**: unknown (no cache / model not listed) still folds the addendum — the
  text is conditionally phrased ("If your tool surface is an `exec` code cell…") so it reads as
  inapplicable on plain function-calling models. Definitively-direct models (5.5 / 5.4) skip it.
- Codex members only (`wf.primary.provider === 'codex'`) — Z.ai rides the app-server via a
  Responses proxy with non-Codex models; Claude/Cursor have their own transports.
- Tests: `npm run test:codex-code-mode` (detection contract + the load-bearing addendum strings —
  notably `{to, content}`: peer_send's param is `content`, not `message`).

Zero model authority added — pure context, same four-question posture as the plan/role folds.

## 5. Prompt shape that fixes the behavior (for reference / other integrations)

The live-verified amendment, in role-hint position:

> IMPORTANT — your Arco peer tools are MCP tools that live INSIDE your exec code environment's
> tools namespace: `tools.mcp__archon_cluster__peer_read()`,
> `tools.mcp__archon_cluster__peer_send({to, content})`, `tools.mcp__archon_cluster__peer_list()`.
> The native spawn_agent / send_message / followup_task tools belong to a DIFFERENT system and do
> not reach your Arco cluster; do not use them for cluster coordination. You are NOT the director.

With this, terra passed the full member protocol first-try on both transports (§3 table).

## 6. Circumvention attempts — corrected record

Original attempts (all failed, still true on 0.144.0):

| Attempt | Result |
|---|---|
| `-c include_collaboration_mode_instructions=false` | `/root` developer message still present |
| `--disable multi_agent` | still present |
| `--disable code_mode_host` | hung Codex |

The original conclusion — *"the `/root` framing comes from the server-provided ModelInfo
(`multi_agent_version`)… delivered regardless of the client-side flags"* — was **half right**. The
source is server ModelInfo, but it is NOT immune to the client: **`-c model_catalog_json=<file>`
replaces the catalog wholesale**, and stripping `tool_mode` + `multi_agent_version` from the 5.6
entries removes the harness completely (verified: zero `/root` text, zero spawn_agent/send_message,
normal function calling). Get the template with `codex debug models`.

That route is still a **dead end for clusters**, for a different reason: in stripped-direct mode
gpt-5.6 gets **no `tool_search` tool** (it is pinned to the responses-lite endpoint —
`use_responses_lite: true`), and codex 0.144 defers all MCP tools behind tool_search
(`tool_search_always_defer_mcp_tools` = hardcoded true), so MCP tools become unreachable entirely.
Forcing `use_responses_lite=false` or `tool_mode="direct"` or a foreign `comp_hash` hangs the
request server-side. gpt-5.5 by contrast gets `tool_search.tool_search_tool` and lazy-loads MCP
tools through it (also verified end-to-end).

So: **fight the harness → dead end; work inside it → trivial.** The addendum is the fix.

## 7. Is it a subscription-tier thing? (No)

Both configured accounts (HOME + WORK) report the same plan token (`chatgpt_plan_type: prolite`)
and near-identical catalogs; the WORK account's `gpt-5.6-terra` shows the same `/root` prompt.
The multi-agent harness is a feature 5.6 ships to Plus in full, not a limitation Pro would lift.
(Caveat: not tested on an actual Pro account; every signal says model-intrinsic, not tier-gated.)

## 8. Model compatibility (cluster membership)

| Model | `/root` harness | Cluster-safe? |
|---|---|---|
| gpt-5.6-sol / -terra / -luna | yes (`tool_mode: code_mode_only`, `multi_agent_version: v2/v2/v1`) | ✅ **with the code-mode addendum** (shipped, automatic) |
| gpt-5.5 | none | ✅ clean function-calling; MCP tools lazy-load via tool_search |
| gpt-5.4 / gpt-5.4-mini | none | ✅ clean |
| gpt-5.3-codex-spark (WORK only) | untested | likely ✅ (no code-mode fields in catalog) |
| gpt-5.3-codex / gpt-5.2-codex | — | ⛔ rejected: API-only on ChatGPT accounts |
| Claude / Cursor / Z.ai / local | n/a | ✅ |

## 9. Reproduce / re-verify

```bash
export CODEX_HOME=~/.archon/provider-accounts/codex-home   # or -work
cd /tmp/scratch

# Which models are code-mode, per the catalog codex actually uses:
python3 -c "import json,os; [print(m['slug'], m.get('tool_mode'), m.get('multi_agent_version')) \
  for m in json.load(open(os.environ['CODEX_HOME']+'/models_cache.json'))['models']]"

# Enumerate the exec-cell tools namespace with an MCP server wired (any stdio MCP server):
codex exec --dangerously-bypass-approvals-and-sandbox \
  -c 'mcp_servers.archon-cluster.command="node"' \
  -c 'mcp_servers.archon-cluster.args=["<path to any stdio MCP server>"]' \
  --model gpt-5.6-terra --skip-git-repo-check \
  "In your exec code environment, evaluate Object.keys(tools) and report the result verbatim."
# → expect mcp__archon_cluster__* entries. If a future codex changes the mangling, update
#   codexCodeModeClusterAddendum() and its test.

# Harness present/absent probe (original recipe still valid):
codex exec --model gpt-5.6-terra --skip-git-repo-check "Reply with exactly: OK."
# then grep the newest rollout under $CODEX_HOME/sessions/YYYY/MM/DD/ for
#   "team of agents"                       → present for 5.6, ABSENT for 5.5 / 5.4
```

Re-check when codex-cli bumps past 0.144.0: (a) the tool-name mangling in the exec namespace,
(b) whether `tool_search` starts attaching to 5.6 (would make direct MCP naming visible again),
(c) whether the catalog fields move. The detection + addendum are both cheap to retarget.

## 10. Live-rollout postscript (2026-07-09, same evening) — the cap ate the addendum

First real cluster test after the deploy failed anyway, and the addendum was NOT at fault — it
never reached the model. The director's shared plan block was 18.7 KB, and the string-form fold's
16 KB `APPEND_CLUSTER_MAX` cap sliced `finalAppend` from the **tail**. Fold order put the plan
first, so the cap silently evicted everything behind it: the peer-mailbox notice, the role hint,
the code-mode addendum, and the efficiency doctrine. Rollout forensics
(`rollout-2026-07-09T23-11-12-*.jsonl`, workflow `6e7c4bce`): the injected block contains the plan
+ truncation marker and zero occurrences of `peer_read` / `mcp__archon_cluster__` / "Your role in
this cluster". The member behaved exactly as §2 predicts for an unbriefed code-mode model — called
native `list_agents`, picked plan items (Bugs 3–5), started freelancing.

Fix (three parts, CLUSTER_MODE_PLAN.md §13 2026-07-09): **(1)** `server/src/clusterStringFold.ts`
(`composeClusterAppend`) — the plan is the only unbounded block in the fold, so it alone absorbs
the cap; small blocks (role, addendum, doctrines) plus already-folded content (the mailbox notice)
are reserved first. **(2)** An over-budget plan folds as a deterministic OUTLINE (headings + every
checkbox line verbatim, prose dropped — `clusterPlanOutline.ts`) instead of a head-slice, so the
actionable skeleton survives whole. **(3)** New read-only `cluster_plan_read` peer tool (all
member transports + REST `plan-read`) — the pull channel to the full body, which previously didn't
exist (injection was the plan's ONLY channel). Truncation now logs byte counts. Regression tests:
`npm run test:cluster-fold -w server` (includes an incident replica with the real addendum and an
18 KB plan). Note the bug was provider-agnostic — any string-form member (Claude CLI / Z.ai /
Cursor) with a >16 KB plan lost its role hint the same way; gpt-5.6 just made it maximally
visible.

## 11. Related

- `server/src/providers/codexCodeMode.ts` — detection + addendum (the shipped fix); test alongside.
- `server/src/ws/turnEngine.ts` — fold site, in the `needsStringFormCluster` block after the role hint.
- `server/src/clusterStringFold.ts` — plan-budgeting for the fold (§10); test alongside.
- `docs/PROVIDERS.md § Codex § Code-mode models` — transport-level summary.
- `docs/GOTCHAS.md § Phase 3 gotchas` — the three-wire-shapes naming invariant + don't-remove-the-addendum entry.
- `docs/CLUSTER_MODE_PLAN.md` — cluster peer-tool substrate (works correctly here).
