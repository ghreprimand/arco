# LSP diagnostics

> WORKBENCH_EXPANSION_PLAN.md §C3. After a Write/Edit in a Claude **Native**
> turn, Arco lazy-spawns the project's language server, opens the changed
> file, and surfaces the server's semantic diagnostics (errors/warnings) inline
> on the Activity tab. The agent and operator see real compiler/type errors
> within a couple of seconds; fixing the error clears the badge.

This is its own subsystem under `server/src/lsp/`. It is deliberately small —
the **diagnostics slice of LSP only**. No completion, hover, formatting, or
code actions.

## Supported languages & server detection

| Extensions | languageId | LSP server (install yourself) |
|---|---|---|
| `.ts .tsx .mts .cts .js .jsx .mjs .cjs` | typescript / javascript (+react) | `typescript-language-server --stdio` |
| `.py .pyi` | python | `pyright-langserver --stdio` (fallback `pylsp`) |
| `.go` | go | `gopls` |
| `.rs` | rust | `rust-analyzer` |

Detection is a cross-platform **PATH lookup** (`server/src/lsp/servers.ts`
`findOnPath`): we walk the `PATH` dirs and check for the binary, honoring
`PATHEXT`/`.exe`/`.cmd` on win32. We do **not** shell out to `which`. The first
candidate that resolves wins; the result is cached per process.

**Bring your own upstream tool.** This is the same pattern as the caveman
output style: Arco does not bundle or install language servers. If the server
for a file's language is **not on PATH**, the subsystem is a **silent no-op** —
no message, no error, no crash, just no diagnostics.

> **TS note:** TS diagnostics require **`typescript-language-server`** (the LSP
> wrapper) on PATH. The bare `tsserver` binary speaks the TSServer protocol,
> **not** LSP, so it is deliberately not a candidate. Install with
> `npm i -g typescript-language-server typescript`.

## The diagnostics flow

```
Write/Edit (claude-native/tools.ts)
  └─ ctx.onFileWritten?.(abs)        ← fire-and-forget, wrapped in try/catch
       └─ worker.ts NativeToolContext.onFileWritten
            └─ lspManager.notifyWritten(absPath, cwd, workflowId, sink)
                 ├─ languageIdForPath → null? no-op
                 ├─ ensure(cwd, languageId) → spawn or reuse server (dedup)
                 ├─ initialize → initialized handshake
                 ├─ textDocument/didOpen (close+reopen on re-write)
                 └─ server → textDocument/publishDiagnostics notification
                      └─ mapPublishDiagnostics → DiagnosticsMessage
                           └─ sink → worker.workflowEventBroadcast
                                └─ WS `diagnostics {workflowId, file, items[]}`
                                     └─ client store.setDiagnostics
                                          └─ ActivityTab DIAGNOSTICS section
```

### The fire-and-forget write hook

`NativeToolContext.onFileWritten?: (absPath: string) => void` is called **after**
the successful `fs.writeFile` in **both** `Write` and `Edit`
(`claude-native/tools.ts`). It is:

- **never awaited** — the tool returns its normal string immediately;
- **wrapped in `try { … } catch { /* best-effort */ }`** at the call site so a
  hook throw can't fail the tool;
- the worker's wiring additionally `void`s the returned promise and attaches a
  `.catch()` so an async rejection can't become an unhandled rejection.

The write path is load-bearing (P0). A diagnostics failure must **never** break
a Write/Edit. The hook does not change write semantics, the plan-mode gate, the
read-set check, or the tool's return string.

### 0-based → 1-based conversion

LSP positions are **0-based** (`range.start.line` / `.character`). Arco's UI
is **1-based**. The conversion happens **once**, at the single boundary
`mapPublishDiagnostics` in `server/src/lsp/client.ts`:

```ts
line:   d.range.start.line      + 1
column: d.range.start.character + 1
```

Everything that crosses the protocol wire (`DiagnosticItem.line/column/
endLine/endColumn`) is already 1-based. The client never re-converts.

### Message shape

`shared/src/protocol/diagnostics.ts`:

```ts
DiagnosticsMessage = { type:'diagnostics', workflowId, file /* cwd-relative */, items: DiagnosticItem[] }
DiagnosticItem     = { severity:'error'|'warning'|'info'|'hint', message,
                       line /* 1-based */, column?, endLine?, endColumn?, source?, code? }
```

Each `diagnostics` message **replaces** the prior set for its `file`. An empty
`items[]` clears the file's diagnostics — that is how "fix the error, badge
drops" works. The client stores them per-file in
`JobState.diagnosticsByFile`; the store action drops the key on an empty array.

## Lifecycle (mirrors `llamacppManager`)

`server/src/lsp/client.ts` `LspManager` (module-level singleton `lspManager`):

- **one server process per `(cwd, languageId)`**, keyed `${cwd}\0${languageId}`;
- **lazy-spawned** on first write to a supported file; **reused** across turns;
- **concurrent-spawn dedup**: simultaneous `ensure()` callers for the same key
  share one in-flight spawn via a `pending` map;
- **idle-reap**: a shared sweeper (`armIdleTimer`) evicts any server unused for
  `ARCO_LSP_KEEPALIVE_MS` (default **5 min**) via a graceful LSP
  `shutdown`/`exit` then `SIGTERM` then a 3 s `SIGKILL` fuse. The sweeper
  clears itself when no servers remain;
- **init-timeout fuse**: `initialize` must complete within 20 s or the spawn is
  killed and treated as "no server" (graceful no-op);
- **shutdown-kill**: `lspManager.shutdown()` is wired from the server's
  `SIGTERM`/`SIGINT` handler (`server/src/index.ts`) and `SIGTERM`+`SIGKILL`s
  every live server child.

### Orphan handling (the noted gap)

LSP servers are spawned **without `detached`**, so they die with the Node server
on a clean exit, and `shutdown()` reaps them deterministically on a graceful
`SIGTERM`/`SIGINT`.

**Gap:** unlike the token-burning worker subprocesses (which have a durable pid
registry + boot-sweep in `server/src/workers/pidRegistry.ts`), the LSP subsystem
does **not** add a durable pid registry. On a hard `kill -9` of the Node server
(no signal handler runs), a language-server child can leak until the OS reaps
it. This is an accepted trade-off for a best-effort, cheap, idle-reaped
diagnostics subsystem — language servers don't consume API tokens and idle-reap
bounds their lifetime under normal operation. If this ever proves load-bearing,
mirror `pidRegistry` here.

## UI surface

`client/src/components/RightPanel/ActivityTab.tsx` `DiagnosticsSection`:

- a collapsible **count badge** (`N errors · M warnings`) at the top of the
  Activity tab;
- an **expandable per-file list**, errors sorted ahead of warnings, each row
  showing `line:col` + message (+ rule code when present);
- **clicking a row** opens the file in the `FileViewerModal` (absolutized
  against the workflow cwd).

> **Open-at-line gap:** the viewer does not yet scroll to the diagnostic's line
> — clicking opens the file at the top. The line/column is shown in the row and
> in the click tooltip. Wiring line-scroll into the shared viewer is left for a
> later pass.

## Config knobs

- `ARCO_LSP_KEEPALIVE_MS` — idle-evict window (ms). `0` ⇒ keep servers loaded
  forever. Default `300000` (5 min).

## Testing

`scripts/smoke/lsp-diagnostics.ts` (`npm run smoke:lsp-diagnostics`):

- **always-green unit core** (no server required): `FrameReader` reassembles
  Content-Length frames including split-across-chunks and byte-at-a-time drip,
  multiple frames in one chunk, and a malformed-frame skip; `mapPublishDiagnostics`
  proves the 0→1 conversion + severity table + empty-array clear;
- **gated real leg**: if `rust-analyzer` or `typescript-language-server` is on
  PATH, spawns it and asserts a real diagnostic surfaces; otherwise prints a
  clear `SKIP:` line and exits 0.
