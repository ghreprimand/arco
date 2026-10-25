# Integrated operator terminal

A real PTY-backed terminal inside Arco — run system commands as you would in
Ghostty, built to leverage Arco's flow rather than embed a generic shell.
Shipped in **Workbench Expansion Part K** (§K1 core, §K2 multi-session +
lifecycle safety, §K3 "Run in terminal", §K4 pop-out into a separate browser
window, §K5 operator→agent output bridge). This doc is the load-bearing
reference; the plan lives in
`docs/WORKBENCH_EXPANSION_PLAN.md` Part K.

## The one invariant: session ≠ connection

A **session** is a long-lived `node-pty` child owned by the **workflow**, not by
the window or the WS connection. The floating terminal window is a **view**:

- Opening it **attaches** to a session (spawning one first if none exists).
- Closing the window (or dropping the `/terminal` socket) **detaches** — the
  shell, and any `npm run dev` / `sleep 30` running in it, **keeps running**.
- Reopening **re-attaches** and **repaints the scrollback** from a bounded
  server-side ring buffer.
- Only an explicit **Kill** (or workflow-close / server-shutdown teardown) ends
  a session.

This is THE acceptance criterion: a `sleep 30` survives a window close+reopen.

## The session pool — `server/src/terminal/ptyManager.ts`

A process-wide singleton `ptyManager` owns all sessions, keyed by id and tagged
with their owning `workflowId`:

- `spawn(workflowId, workflowRoot, requestedCwd?)` → spawns the operator's
  `$SHELL` (fallback `/bin/zsh` on macOS, `/bin/bash` elsewhere; `powershell.exe` on Windows) in a cwd
  resolved through **`resolveWithinCwd`** against the workflow root. A cwd that
  escapes the root **throws — no shell is spawned**. Returns the new `PtySession`.
- `attach(sessionId, onData, onExit?)` → adds a viewer's listeners and returns
  `{ scrollback, cols, rows, dispose }` so the window repaints history; `dispose`
  removes **exactly that** listener. **§K2 multi-listener:** a session holds a
  **Set** of listeners, not a single callback — **two windows can view the same
  session and both receive live output** (the `onData`/`onExit` fan out to all).
  K1's single-window case is preserved (one listener in, one out); §K2 only
  widened the count. The channel calls the returned `dispose` on socket close so
  closing one of two co-viewing windows leaves the other attached.
- `detach(sessionId)` → clears **all** listeners (belt-and-suspenders); the
  per-attach `dispose` is the precise path. Neither kills the shell.
- `write` / `resize` / `kill` → standard PTY ops; `kill` reaps the child, drops
  the session, and **unregisters its pid from the durable registry** (below).
- `killForWorkflow(workflowId)` / `killAll()` → teardown (workflow-close,
  server-shutdown). `allSessions()` lists every live session (shutdown events).
- `infoForWorkflow(workflowId)` → wire-facing `PtySessionInfo[]`
  (`{ sessionId, label, cwd, createdAt }`, oldest-first) for the switcher /
  `terminal_sessions` reply.

Each session carries a **`label`** for the switcher: `shell N` (a per-workflow
monotonic counter that never reuses a number), or the **cwd basename** when a
non-root cwd was requested (so "open terminal here" on `server/` reads `server`).

Each session keeps a **bounded scrollback ring buffer** (~256 KB; older bytes
dropped from the front) so re-attaching repaints recent history without
streaming the whole shell life.

### Teardown wiring (leak-safety)

- **Workflow close** — `handleRemoveWorkflow` (`server/src/ws/workflowHandlers.ts`)
  calls `ptyManager.killForWorkflow` and emits a `terminal_killed`
  (`reason: 'workflow-close'`) per session.
- **Server shutdown** — `onSignal` (`server/src/index.ts`) emits a
  `terminal_killed` (`reason: 'shutdown'`) per live session, then calls
  `ptyManager.killAll()`. `kill` unregisters each pid from the durable registry,
  so the next boot sweep is a no-op (it won't SIGKILL a recycled pid).
- **Shell exit** — the `onExit` listener drops the session, unregisters its pid,
  and broadcasts `terminal_killed` (`reason: 'shell-exit'`).

### §K2 — durable PTY pid registry + boot orphan sweep

node-pty children are **not** spawned `detached`, so a **clean** server exit
reaps them. But on a **hard** kill (SIGKILL, OOM, crash, force-quit) they
**reparent to init and keep running** — a long-lived `npm run dev` started inside
a terminal would leak across the restart with no record to reap it. This mirrors
the worker-safety pattern (`server/src/workers/pidRegistry.ts`):

- **`server/src/terminal/ptyPidRegistry.ts`** — a **separate** durable JSON
  (`~/.arco/terminal-pids.json`, distinct from `worker-pids.json` so the two
  reap paths can't clobber each other). `registerTerminalPid` on spawn,
  `unregisterTerminalPid` on clean kill/exit.
- **Boot orphan sweep** — `reapOrphanTerminals()` (exported from `ptyManager.ts`)
  runs in `index.ts` **right after `reapOrphanWorkers()`, before `listen()`**. It
  SIGKILLs any pid still in the registry from a prior unclean run, then clears the
  file. It **reuses `forceKillPid`** from the worker registry (process-group
  SIGKILL with a bare-pid fallback — POSIX-portable; node-pty pids are real OS
  pids).
- **Shutdown** — clears the registry (via per-session `kill`), so a clean restart
  finds nothing to reap.

### §K2 — RSS guard decision (deliberately NOT an auto-kill)

The plan mentions "an RSS/orphan guard like the worker-safety paths." The
**orphan/shutdown reaping above IS the load-bearing safety.** We **do not**
RSS-auto-kill operator shells. Unlike an autonomous worker, a terminal runs
processes the **operator started intentionally** (a dev server, a long build, a
REPL); SIGKILLing their shell on an RSS threshold would be destructive and
violate the operator-in-control fence. Orphan reaping (a crashed *prior* run's
leak) is safe and bounded; killing a *live* operator session on a memory heuristic
is not. If a guard is ever added it must default to **observation-only (no kill)**.
See also `docs/GOTCHAS.md § worker safety`.

## Two channels

### 1. The seq'd `/ws` control plane

Session **open / kill** and **command-line** events flow over the normal seq'd,
persisted `/ws` protocol so they land in `events.jsonl` for four-question
visibility. Messages (see `docs/PROTOCOL.md` + `shared/src/protocol/terminal.ts`):

- client → `terminal_open { workflowId, cwd? }`, `terminal_kill { sessionId }`,
  `terminal_command { sessionId, command }`,
  **`terminal_list { workflowId }`** (§K2 — request the live session list)
- server → `terminal_opened { sessionId, cwd, shell, label, ts }` (§K2 adds
  `label`), `terminal_killed { sessionId, reason, ts }`
  (`reason` now includes `'shutdown'`),
  `terminal_command_logged { sessionId, command, ts }`,
  **`terminal_sessions { workflowId, sessions: PtySessionInfo[] }`** (§K2 — reply
  to `terminal_list`, also re-emitted on rehydrate)

**Session-list mechanism (§K2):** a dedicated `terminal_list`→`terminal_sessions`
round-trip, **not** a fold into the workflow snapshot. Rationale: PTYs don't
survive a server restart, so replaying the events.jsonl `terminal_opened` history
would list **dead** sessions; the live `ptyManager` pool is the source of truth.
The server **re-emits `terminal_sessions` on rehydrate** (`rehydrateOneWorkflow`
in `handoffHandlers.ts`, per-socket) so a reconnecting client recovers its
switcher and drops sessions that died with a restart — mirroring how
`plan_attached` / `preview_set` re-emit live server state.

### 2. The dedicated `/terminal` WS path — the raw byte stream

`server/src/terminal/terminalChannel.ts`. A **separate WS path**, wired into
`index.ts`'s upgrade fan-out alongside `/ws`. Carries the **raw PTY byte
stream** and is **deliberately NOT** seq'd or persisted — far too chatty for
`events.jsonl`. Envelope:

- client → `attach { sessionId }`, `input { data }`,
  `prefill { data }` (§K3 — see below), `resize { cols, rows }`, `kill {}`
- server → `data { bytes }`, `exit { code }`, `error { message }`

The session is created over `/ws` (`terminal_open`); this channel only ever
**attaches** to an existing id. Connection close = window close = **detach**.

## What is and isn't logged

| | events.jsonl? |
|---|---|
| Session open (cwd + shell) | **yes** (`terminal_opened`) |
| Session kill (with reason) | **yes** (`terminal_killed`) |
| Operator command lines | **yes** (`terminal_command_logged`) |
| Raw byte stream (output + keystrokes) | **no** — `/terminal` channel only |

**Command-line capture** is best-effort and **client-side**: `XtermView`
accumulates printable input and flushes the buffered line on Enter, sending
`terminal_command`. It's a visibility log, not a precise shell parser (it doesn't
expand history, account for multi-line heredocs, or strip pipelines). Robust
lifecycle logging is the guarantee; exact command capture is best-effort.

## Hard fences (load-bearing)

- **Operator-only, NEVER an agent tool.** The PTY is never registered as a tool
  the model can call. Agents have their own per-turn Bash within tool-use.
  Wiring a model into this PTY is the autonomous-shell fence — don't.
- **cwd never escapes the workflow root** — `resolveWithinCwd` on every spawn.
- **Raw stream off the `/ws` seq protocol and out of `events.jsonl`.**
- **`/terminal` upgrade respects the same access gate as `/ws`.** Both ride the
  same loopback-bound HTTP server (`HOST=127.0.0.1` by default). That loopback
  bind **is** the gate — there is no per-connection token/origin check on `/ws`
  (see `server/src/server/constants.ts`), and `/terminal` inherits exactly that
  posture.

## Remote-shell caveat

Arco is sometimes tunneled over Tailscale (operator works remote). An exposed
terminal endpoint = a **remote shell on the workstation**. `/terminal` honors
the same access posture as `/ws` — exposing Arco remotely exposes the terminal
too. The operator's own destructive commands are their responsibility; Arco
does not sandbox the operator, same as any terminal.

## Entry points

Both converge on the same floating window via `useTerminalStore.openTerminal`;
they differ only in cwd:

1. **Header launcher** (`SystemHeader.tsx`, `>_ TERMINAL`) → session in the
   **active workflow root**. Disabled when no workflow is active.
2. **Files-tab "open terminal here"** (`FileExplorer.tsx`) — a `>_` icon in the
   Files header (root cwd) and a **right-click on any directory** (that dir's
   cwd).

3. **"Run in terminal" chat chip** (§K3, below) → opens the window for the
   workflow and **pre-fills** an agent-suggested command (root cwd if no
   session exists yet).
4. **`+ NEW` in a window header** (§K2) → always spawns a **fresh** session in a
   new floating window. This is the only entry that forces a new session; the
   other three reuse the workflow's existing session/window when one exists.

## §K3 — "Run in terminal" (conversation-aware command spawn)

When an agent's reply contains a shell code block (```` ```bash ````/`sh`/`shell`/
`console`/`zsh`), the chat renderer shows a **`▶ RUN IN TERMINAL`** chip on that
block. Clicking it opens/raises the floating terminal for the workflow and
**pre-fills the command on the PTY input line — it does NOT execute it.** The
operator reviews, edits, and presses Enter themselves.

### THE load-bearing fence — pre-fill, NEVER auto-run

**The prefill path never submits a line, ever.** The command sits on the prompt
until the operator's own Enter runs it. This is the operator-in-the-loop
guarantee that makes K3 distinct from "the agent runs a command" — the model
only *suggested* the text; nothing executes without an operator keystroke.

- The guarantee point is `wrapPrefillForPty()` in `terminalChannel.ts`: the
  `prefill { data }` handler does `ptyManager.write(sessionId, wrapPrefillForPty(data))`.
  It strips **any** trailing `\r`/`\n` (via `stripLineTerminator`) and then wraps
  the body in **bracketed-paste markers** (`\x1b[200~` … `\x1b[201~`, DECSET 2004).
- **Why bracketed paste (the multi-line fence):** `stripLineTerminator` only
  removes the *trailing* terminator. A multi-line ```` ```bash ```` block (e.g.
  `npm install\nnpm test`) carries **interior** newlines; written bare, the PTY's
  line discipline would execute `npm install` the instant it saw the interior
  `\n`, leaving `npm test` on the prompt — auto-running the first line. Bracketed
  paste makes a paste-aware shell treat embedded newlines as **literal input**, so
  the whole block lands on the edit line and nothing submits until Enter — exactly
  how a real terminal handles a multi-line paste. Even a client that appended a
  trailing newline cannot make a prefill submit.
- **Caveat (degradation, not a bug):** if a shell has bracketed paste *disabled*,
  the `\x1b[200~`/`\x1b[201~` markers degrade to **literal text** on the prompt
  rather than executing. That is strictly safer than the old bare-newline path
  (which auto-ran), just cosmetically odd — and it matches what a real paste into
  such a shell does. Modern interactive shells (bash ≥4.4 with readline, zsh/zle,
  fish) enable bracketed paste by default, so this is rare.
- There is **no server path that runs a command without an operator action.**
  The PTY is still operator-only (it is never an agent tool); the chip is a
  surface the *human* clicks; `prefill` only types text. The only thing that
  submits a line to the shell is operator `input` carrying Enter (or the
  operator's own Enter after a prefill).
- The plan's optional step-4 "run immediately" toggle was **deliberately not
  built.** Pre-fill-only is the sole shipped behavior.

### Detector — `client/src/components/Terminal/detectCommand.ts`

A small **pure function** (unit-tested directly by
`scripts/smoke/terminal-prefill.ts`) that classifies a fenced block:

- Qualifies on info-string `bash`/`sh`/`shell`/`console`/`zsh` (case-insensitive),
  accepting either a bare info-string or ReactMarkdown's `language-xxx` className.
- Drops a single trailing newline; **keeps interior newlines** (a multi-line
  block is pre-filled whole — the operator edits it). The interior newlines are
  what make bracketed-paste wrapping (above) load-bearing on the prefill write.
- For a **single-line `console`** block, strips a leading `$ ` / `# ` prompt
  (markdown transcript convention). Multi-line `console` blocks are kept
  verbatim (they mix commands + output).
- Empty / whitespace-only blocks do not qualify.

### Flow

`CopyablePre` (in `ChatMessage.tsx`) runs the detector on each fenced block and,
when it qualifies + a `workflowId` is in scope, renders the chip. The chip calls
`terminalStore.prefillInTerminal(workflowId, command)`, which raises/opens the
window and stages the command. `FloatingTerminalWindow` drains the staged
command once a session exists (spawning a root-cwd session first if none) and
hands it to `XtermView`, which sends the `prefill` frame after its socket
attaches. A nonce makes back-to-back chip clicks of the same command re-fire.

## §K4 — Pop-out into a separate OS-level browser window

A floating terminal window can be **popped out** into its own real browser
window (put a shell on a second monitor; tile it). The **POP OUT** button sits
in each window's header (next to KILL, shown only when the window has a session).
It calls:

```js
window.open(`/?popoutTerminal=${sessionId}`, '_blank', 'width=720,height=480,resizable=yes');
```

### Route shape — `/?popoutTerminal=<sessionId>` (query param on root), and why

There is **no router** in the client — `main.tsx` mounts a single `<App/>`.
The pop-out is a **`window.location.search` branch in `main.tsx`**: if
`?popoutTerminal=<id>` is present, it renders a standalone
`<TerminalPopout sessionId={id}/>` **instead of** `<App/>` (after the usual
`bootstrapCachedTheme()`, so the pop-out inherits the operator's theme for free —
same origin, same localStorage).

**Why query-param-on-root rather than a `/terminal/<id>` path segment:** the
HTML document for the pop-out is a plain GET. The root path `/` is *always*
served `index.html`:

- **Dev (Vite, :5173):** the catch-all `^/.*` proxy's `bypass` returns `req.url`
  (→ Vite serves it) for any request **without** a preview-iframe Referer, so
  `/?popoutTerminal=…` falls straight through to Vite's SPA `index.html`. There
  is **no collision** with the `/terminal` **WS upgrade** path (an upgrade is not
  a GET; the upgrade fan-out in `index.ts` matches the exact path `/terminal`
  after stripping the query string), nor with `/ws` / `/api/*`. A
  `/terminal/<id>` **path segment** would risk visually colliding with the
  `/terminal` WS path and the `/terminal` WS proxy rule (see below); the
  query-param shape sidesteps all of it.

**The `/terminal` WS itself must be proxied in dev (K4 fixed this).** XtermView
(in both the in-app window and the pop-out) opens `ws(s)://${location.host}/terminal`
— at :5173 that's Vite, which must forward the upgrade to the Arco server like
it does `/ws`. The K1 vite config only proxied `/ws`, so the in-app terminal AND
the pop-out were dead in any *browser* / 5173-tunneled session (the terminal
smokes miss this — they connect to :3001 directly). K4 added `/terminal` to the
`configureServer` upgrade handler in `client/vite.config.ts` (alongside `/ws`).
Safe because Vite's own HMR upgrade keys off the `vite-hmr` subprotocol, which a
bare `new WebSocket('/terminal')` never sends. See `docs/GOTCHAS.md § Integrated
terminal`.
- **Prod:** the Node server **does** serve the built client when the systemd unit
  sets `ARCO_SERVE_CLIENT=1` — `tryServeClientDist` (`server/src/http/router.ts`)
  serves `client/dist` with an **SPA fallback** (extension-less unmatched paths →
  `index.html`). Root-serves-index.html is exactly the shape that fallback
  satisfies, so `/?popoutTerminal=…` falls through to `index.html` in prod too.
  The static serve runs after every API/preview route and only for GET, so it
  can never shadow an Arco endpoint, and asset paths (with an extension) 404
  rather than getting the SPA fallback.

### What the pop-out is (and isn't)

`client/src/components/Terminal/TerminalPopout.tsx` — full-window, mounting just
`<XtermView sessionId={id}/>` (reused **as-is**; it already does fit-addon
resize-to-window) under a thin header. It:

- **boots NO app stores and NO `/ws` control plane.** The only socket it opens is
  XtermView's own `/terminal` WS, which `attach`es by **sessionId alone** (the
  session knows its own workflowId server-side). The pop-out therefore can't
  resolve the session's *label* — it shows the 8-char id + a generic "TERMINAL"
  title. That's fine; the operator popped it out knowingly.
- **NEVER spawns a session.** It only attaches to one the in-app window already
  created over `/ws` (`terminal_open`). A stale/killed id surfaces as the
  XtermView `error` frame → the pop-out shows a "session not found — may have
  been killed / server restarted" message + a Close button. A shell that exits
  (operator typed `exit`, process died) shows a "session ended" message + Close.
- **coexists with the in-app floating window** viewing the same session — popping
  out does **NOT** close the floating window. This is exactly §K2's multi-listener:
  two sockets attach to one session, output fans to both, and **typing in either
  window drives the same shell.** (Demonstrating that coexistence is the point;
  it's the K4 acceptance criterion.)

### Closing the pop-out detaches only its socket (no server change)

Closing the pop-out window closes its `/terminal` WS, which fires
`ws.on('close', detach)` in `terminalChannel.ts`. `detach()` calls the per-socket
`disposeListener` returned by `ptyManager.attach` — which removes **exactly that
socket's** listener from the session's multi-listener `Set`, leaving the in-app
floating window attached and **the shell alive**. This is the §K1 session ≠
connection invariant + the §K2 multi-listener doing their job; **K4 needed no
server change** (it reuses the existing `/terminal` WS + per-socket dispose).

### Parent-window close

If the **main app window** closes, nothing happens to the pop-out or the session:
the session lives in the server's `ptyManager` pool, owned by the **workflow**,
not by any window. The pop-out keeps streaming until its own socket closes
(detach) or the operator Kills the session (from a window that still has KILL —
the pop-out itself offers no Kill, only attach + input).

## §K5 — Operator→agent output bridge

The closing half of the K3 loop: K3 is *agent suggests → operator runs*; K5 is
*operator feeds the result back*. A **→ COMPOSER** button on the floating
terminal window takes the operator's current xterm **selection** and inserts it
into the active workflow's composer as a quoted block — the clean way to show
the agent "here's the stack trace I just got" without giving the agent terminal
control.

### THE load-bearing fence — operator-action-only, INSERT not SEND

This is the same operator-only fence as the rest of Part K, stated for the
bridge:

- **Nothing crosses to the agent without the explicit button click.** There is
  no auto-feed, no streaming of terminal output to the model, no background
  capture. The agent never sees the selection stream.
- The output is **inserted into the composer draft** — text the operator can
  still edit or delete — and is **not auto-submitted as a turn.** The operator
  presses send themselves, exactly as with anything they typed. (Contrast K3,
  whose fence is "pre-fill, never auto-run"; K5's is "insert, never auto-send".)
- It **appends** to the existing draft — it never clobbers what the operator was
  mid-typing.

### How it works (client-only; no protocol surface)

- **Selection** — `XtermView` subscribes to xterm's `onSelectionChange` and
  reports `term.getSelection()` (or `''` when `!term.hasSelection()`) up via an
  `onSelectionChange(selectedText)` prop. No state crosses the `/terminal` WS;
  selection is a pure browser-side concern.
- **Which composer** — the bridge targets the **`workflowId` the floating window
  is already bound to** (every `TerminalWindowInstance` carries one, same
  association K3's prefill uses). So the result lands in the composer of the tab
  that owns the shell. The pop-out (`TerminalPopout`) deliberately has **no**
  bridge button: it boots no stores and no `/ws`, so it can't reach a composer —
  the operator sends from the in-app window.
- **Insert** — on click the button reads the current draft fresh from
  `appStore` (`drafts[workflowId]`) and writes `appendToDraft(current,
  selection)` back via `setDraft`. Because the composer (`TerminalInput`) renders
  straight from `drafts[workflowId]`, the block shows up in the visible input,
  appended to in-progress typing.
- **Format** — `buildQuotedTerminalBlock` (pure, in `composerBridge.ts`) emits a
  `Terminal output:` header over a fenced code block holding the selection
  verbatim. The fence grows to one backtick longer than the longest backtick run
  inside the selection, so embedded ```` ``` ```` can't break out of the block.

Pure core: `client/src/components/Terminal/composerBridge.ts`
(`buildQuotedTerminalBlock` + `appendToDraft`). Smoke:
`scripts/smoke/terminal-bridge.ts` (`npm run smoke:terminal-bridge`) asserts the
quoting format, the fence-growth, and that it **appends** rather than clobbers.

## Client components — `client/src/components/Terminal/`

- `FloatingWindow.tsx` — reusable draggable / resizable overlay (z-order on
  focus, non-blocking; `position: fixed`, no backdrop).
- `XtermView.tsx` — the `xterm.js` view bound to one session over `/terminal`,
  with the fit addon driving resize→PTY resize. **§K5:** reports the live
  selection (`onSelectionChange` → `term.getSelection()`) up to the parent.
- `FloatingTerminalWindow.tsx` — orchestrator mounted once at App level. **§K2:**
  renders **N windows** (`terminalStore.windows.map(...)` → one
  `TerminalWindowInstance` each). Each instance reads `terminalStore`, spawns a
  session on demand (`terminal_open`), renders the window + xterm, and offers a
  **session switcher** (`<select>` over the workflow's sessions), a **`+ NEW`**
  button (always spawns a fresh session in a new window), and per-session
  **Kill**, plus a §K4 **POP OUT** button and a §K5 **→ COMPOSER** button
  (enabled only when there's a selection) per session window.
  It asks `terminal_list` on mount and drains a §K3 staged prefill.
- `detectCommand.ts` — pure §K3 shell-block detector (no React; importable from
  the smoke).
- `composerBridge.ts` — pure §K5 formatter (`buildQuotedTerminalBlock` +
  `appendToDraft`; no React; importable from the smoke). See § K5 above.
- `TerminalPopout.tsx` — §K4 standalone full-window pop-out (rendered by
  `main.tsx` on `?popoutTerminal=<id>` instead of `<App/>`); reuses `XtermView`,
  boots no stores / no `/ws`. See § Pop-out above.

State lives in `client/src/stores/terminalStore.ts` (kept out of `appStore`
because the byte stream is off the seq'd protocol and the windows are
non-persisted overlays). **§K2 store shape:** `windows: TerminalWindow[]` (each
`{ windowId, workflowId, sessionId|null, pendingCwd?, pendingPrefill? }`) +
`sessionsByWorkflow: Record<string, TerminalSession[]>`. Actions: `openTerminal`
(reuse-or-open a window for the workflow; the K1 entry-point behavior),
`newSession` (always spawn in a new window), `closeWindow`,
`switchWindowSession`, `bindSpawnedSession` (binds a spawn's `terminal_opened` id
to the waiting window), `addSession`/`removeSession`/`setSessions` (driven by the
WS dispatch), `prefillInTerminal`/`consumePrefill` (§K3, now per-window).
