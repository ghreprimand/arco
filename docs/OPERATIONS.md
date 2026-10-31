# Arco  - operations

**Status:** Task-oriented settings and menu organization, including the control-preservation map, remains in progress. See [Development status](DEVELOPMENT_STATUS.md).

Running, stopping, restarting, and recovering Arco. Where logs go, what env vars matter, and how to unstick the system when something goes sideways.

For the normal native install and run modes, see [`../README.md`](../README.md) and [`GETTING_STARTED.md`](GETTING_STARTED.md). For architecture see [`ARCHITECTURE.md`](ARCHITECTURE.md). For the persistence layout see [`PERSISTENCE.md`](PERSISTENCE.md). For the dev-side workflow see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

---

## Running locally

For the normal native install and run modes, follow [`../README.md`](../README.md) or [`GETTING_STARTED.md`](GETTING_STARTED.md). On Linux, the recommended persistent run is the systemd user service below; on macOS, use the hand-maintained launchd procedure in [`SERVICE_MODE.md`](SERVICE_MODE.md).

```bash
git clone <repository-url>
cd arco
npm ci --include=dev
npm run build
npm start
```

This foreground run serves the built client at <http://localhost:3001> and
stops with Ctrl+C. Use `npm run dev` only for development; its watchers restart
the server when `server/` or `shared/` changes and end in-flight agent turns.

**Requirements.** Node.js 24 or newer (`package.json` `engines`), npm, Git, and a C/C++ toolchain with Python 3 for the `better-sqlite3` and `node-pty` native modules when no prebuilt binary matches the platform (Xcode Command Line Tools on macOS, Visual Studio Build Tools on Windows). Provider CLIs (`claude`, `codex`, `cursor-agent`, ...) are installed separately from their vendors.

**`NODE_ENV=production` drops dev dependencies.** With `NODE_ENV=production` exported in the shell, `npm ci` and `npm install` skip `devDependencies` (TypeScript, Vite, tsx), so `npm run build` fails with missing type definitions. Install with `env -u NODE_ENV npm ci --include=dev` (POSIX) or `npm ci --include=dev` after clearing the variable (PowerShell: `Remove-Item Env:NODE_ENV`).

**Platform notes.**

| | Linux | macOS | Windows |
|---|---|---|---|
| Arco home | `~/.arco` | `~/.arco` | `%USERPROFILE%\.arco` |
| Terminal shell | `$SHELL`, else `/bin/bash` | `$SHELL`, else `/bin/zsh` | `powershell.exe` |
| `npm run dev`, `npm start` | yes | yes | yes |
| `scripts/arco` launcher, `npm run arco:service -- <command>` | yes (bash, systemd `--user`) | launcher yes; use the hand-maintained launchd procedure (see [`SERVICE_MODE.md`](SERVICE_MODE.md)) | no; use `npm start` |

`ARCO_HOME` relocates the whole Arco home, including global settings and provider data. Per-project state uses `.arco`. To migrate existing data, copy the previous home and per-project state folders into the corresponding Arco locations; Arco does not read other state roots automatically. On Windows, provider CLIs, `npx` and language servers installed through npm are `.cmd` shims, which Node cannot start without a shell; Arco finds them through `PATH` and `PATHEXT` and starts the JavaScript entry each shim wraps with its own Node (`server/src/windowsCommand.ts`). Native-run acceptance on Windows is pending.

**npm 12 and the native deps.** npm 12 blocks install scripts unless the root `package.json` `allowScripts` block covers them; it does, so `npm install` suffices on a fresh clone  - though on npm 12 prefer `npm ci`, which builds the same natives without renormalizing `package-lock.json` (see [`../CONTRIBUTING.md`](../CONTRIBUTING.md#setup) for why that churn must not be committed). The pins are version-keyed, so a dep bump can un-cover a package  - `npm install` warns (`N packages had install scripts blocked...`) and `npm install-scripts ls` shows the state. Approving after an install (`npm install-scripts approve <pkg>`) records the entry but does **not** build; follow it with `npm rebuild better-sqlite3 node-pty`.

The failure mode to recognize: an unbuilt `better-sqlite3` doesn't break the build or the boot  - it only kills transcript recall. Check the boot log.

| Boot log line | Meaning |
|---|---|
| `[arco] Recall index backfilled N workflows` | healthy |
| `[arco] RECALL DISABLED  - better-sqlite3 native binding is not built.` | run `npm rebuild better-sqlite3` |

`npm run dev` runs `concurrently --kill-others -n server,client` against:

- `npm run dev -w server` -> `tsx watch src/index.ts` on port 3001
- `npm run dev -w client` -> `vite` on port 5173 (proxies `/ws` and `/api/` to 3001)

If one process exits, the other is killed too. This is intentional  - half-running Arco is worse than off.

### Build (production)

```bash
npm run build       # full monorepo: shared -> server -> client
```

Builds:
- `shared/dist/`  - TS protocol types
- `server/dist/`  - compiled server, ready for `node dist/index.js`
- `client/dist/`  - Vite-bundled static frontend

To run the build in the foreground on any platform:

```bash
npm start           # server + built client on http://localhost:3001
```

`npm start` (`scripts/start.mjs`) sets `ARCO_SERVE_CLIENT=1` and `NODE_ENV=production` unless they are already set, then runs `server/dist/index.js` from the repository root. It refuses to start until `npm run build` has produced `server/dist` and `client/dist`.

For a durable, restartable production runtime use **service mode**: the compiled server serves `client/dist` itself (gated on `ARCO_SERVE_CLIENT=1`) under a systemd `--user` unit that restarts on crash.

```bash
npm run arco:service -- install --enable
npm run arco:service -- start
```

See [`SERVICE_MODE.md`](SERVICE_MODE.md) for the full CLI, the rendered unit, and the `ARCO_SERVE_CLIENT` gate. A reverse proxy fronting `node server/dist/index.js` (with the proxy serving the client bundle) remains a valid alternative  - also covered there.

---

## Updating Arco

Settings > Advanced > CLI and runtime versions shows the running Arco version,
the latest known release and its publication date. CHECK NOW refreshes release
metadata. The release toast's OPEN RELEASE link opens the release notes; DISMISS
remembers that version across browsers and restarts. A newer version can notify
again. These controls never download or install an update.

Finish or cancel active turns and save editor drafts before updating. Stopping
the server disconnects all browser tabs and interrupts in-flight provider work;
a restart does not continue an interrupted turn automatically. Stored workflows
remain available to reopen. Back up the Arco home and project state as described
in [Backup](BACKUP.md), then review the release notes before changing versions.

### Linux background service

From the checkout, update dependencies and rebuild the installed service. The
install action rewrites the unit from the current environment, so every
install-time variable (`ARCO_PORT`, `ARCO_HOST`, `ARCO_HUB_URL`, `ARCO_NTFY_URL`)
must be set again before each install. For a service on port 3002, replace the
bare install line below with `ARCO_PORT=3002 npm run arco:service -- install`;
reapply any other install-time variables used.

```sh
git pull --ff-only
npm ci --include=dev
npm run arco:service -- install
npm run arco:service -- stop
npm run arco:service -- start
npm run arco:service -- status
```

`install` builds the server and client, rewrites the user unit and reloads
systemd; it does not restart the running process. `stop` and `start` are separate
commands; there is no service `restart` subcommand. Reload the browser after the
new server starts. See [Service mode](SERVICE_MODE.md) for unit configuration
and manual macOS launchd management.

### Foreground native run

Stop the running foreground process with Ctrl+C, then run from the checkout:

```sh
git pull --ff-only
npm ci --include=dev
npm run build
npm start
```

Restore the same `ARCO_HOME`, `ARCO_PORT` and other runtime configuration used
before the update. On macOS, a hand-maintained launchd service must be stopped
and restarted with its own configured job; the Linux service commands do not
manage it. `npm run dev` is for development and restarts on source changes; it
is not required for normal updates.

### Docker

From the checkout, keeping the existing Compose project and persistent volume:

```sh
git pull --ff-only
docker compose up -d --build
```

Compose rebuilds the image and recreates the service. Keep the existing home
volume and project mounts; do not remove the volume as part of an update. See
[Docker](DOCKER.md) for configuration and backup details.

### Release-check privacy and opt-out

The server makes one request to GitHub 30 seconds after boot and every six
hours thereafter. CHECK NOW can request an additional check. The request has
no token, prompt, project path or workflow content. It sends the Arco version
in `User-Agent: arco/<version>`; GitHub also sees the server's public IP address
as it does for any HTTP request. Metadata is cached in memory. Unavailable,
missing or rate-limited releases are quiet after one debug message and retry
on the next cycle.

Turn off **Check for new releases** in Settings to prevent scheduled and manual
checks. Alternatively, set `ARCO_UPDATE_CHECK=0` in the server process's
environment (or service/container environment); it overrides the setting.
Changing a shell variable does not change an already-running service. A
release announcement is recorded in the server log, never in a workflow's
`events.jsonl`.

## Recovering a submitted turn

A composer draft that was not sent over an open WebSocket stays in the browser.
Once sent, an echo shows that the server emitted a response, not that the event
was flushed to disk, the provider accepted the request, or the requested work
completed. While the original server process is running, queued items are held
in its memory. A browser reconnect to that same process can reattach to the live
queue; a cold server restart cannot restore its executable queue. Event replay
can still show an older pending-looking queue snapshot after restart. Do not
treat that display as proof the item will run or that a missing item was never
submitted.

After a disconnect or restart, inspect the conversation and current project
state before retrying. A queued item may have been removed for a turn before the
connection failed, and absence of a completion event does not prove that a
provider or tool had no effect. Arco does not automatically replay uncertain
queued work. Confirm the intended action and its current state before manually
submitting it again. Duplicate submissions are not deduplicated by their client
message IDs.

Attachments and context references in replay are the submitted references, not
a saved copy of the expanded context. Expanded references, attachments and
one-turn skill selections are carried by the in-memory queue item and are not
reconstructed as executable work after a cold restart. A referenced file or
attachment may have changed or become unavailable; review it before resubmitting.

Pending approval gates can be shown again after restart, but their original
in-process callback no longer exists. Rejecting a pending gate clears it. An
explicit approval reissues the approved call as a new turn; it does not resume
the old call, and the new call may require review again. Review current state
before approving or retrying because a missing completion record cannot rule
out earlier provider-side effects. See [Persistence](PERSISTENCE.md) and the
[WebSocket protocol](PROTOCOL.md) for the event and queue details.

## Ports

| Port | Service | Notes |
|---|---|---|
| 3001 | HTTP + WebSocket | Server. Override with `ARCO_PORT` |
| 5173 | Vite dev server | Client. Override with `ARCO_CLIENT_PORT` |
| 8081 | Strata service | Standalone OpenAI-compatible `/v1`; `STRATA_URL_BASE` or Settings -> STRATA ENDPOINT |
| 8888 | SearXNG | Default search backend for local web tools; `ARCO_SEARXNG_URL` |
| 11434 | Ollama daemon | Default Ollama port; override the URL via `OLLAMA_URL_BASE` |

`/ws` and `/api/*` on the Vite dev server proxy to the server port. `/uploads/*` is served directly by the server.

---

## Exposure posture

The production server binds **loopback (`127.0.0.1`) by default**, reachable
only from this machine. `npm run dev` is different: Vite listens on all network
interfaces, so devices on a reachable network can load the development client.
API calls from that client remain subject to the browser session check. Use a
trusted network while developing. The production server's HTTP/WS surface
exposes a shell (the integrated PTY terminal), git/GitHub operations, filesystem
read and write under project roots, and provider credentials. Anything that can
reach its port must be trusted.

The **`/ws` control socket, `/terminal` PTY, `/upload` and the `/api/*` routes**
are the exception (bar the cluster-peer / plan tool routes agents call by
design): they need an HttpOnly session cookie that only a browser `fetch` from the
Arco page can mint (`server/src/http/wsAuth.ts`). This stops local processes -
including Arco's own agents  - from scripting the control plane, short of
deliberately forging browser headers. Refusals log as `refused upgrade` /
`refused session mint` / `refused <METHOD> <path>` in the journal. Emergency off-switch (also what test
servers for the smoke harness use): `ARCO_WS_AUTH=off`, e.g. an
`Environment=ARCO_WS_AUTH=off` line in the unit's `override.conf`, then
restart.

To use Arco remotely, **prefer an SSH or Vite tunnel** (forward `5173`/`3001`
over SSH, or `ssh -L`) so the bind stays loopback and only your authenticated
SSH session reaches it. Set `ARCO_HOST=0.0.0.0` **only** when you deliberately
want LAN/tailnet clients to reach the no-auth surface directly  - there is no
access control to fall back on.

The **Security & Exposure** group in the System modal's Diagnostics tab (and the
support bundle) reports this posture: bind address, terminal/git/filesystem/
credential exposure, preview proxy, local model endpoints, and risky env flags -
each `ok` on a loopback bind, `warn` when a non-loopback bind makes the
capability reachable by non-local clients. See `docs/DIAGNOSTICS.md section Security &
Exposure`.

MCP children spawned via `npx`/`uvx` run under an **env allowlist** (H20,
`server/src/mcp/client.ts::buildSafeEnv`)  - they do **not** inherit Arco's
Claude OAuth token or the `gh` GitHub PAT. An MCP server that needs a credential
must be given it explicitly in its per-server `env` config; relying on ambient
env will fail. See `docs/MCP_REGISTRY.md`.

---

## Environment variables

Use the `ARCO_` prefix for Arco-specific environment variables. `ARCO_HOME` relocates global state; per-project state stays under `.arco/`.

### Server-affecting

| Var | Default | Purpose |
|---|---|---|
| `ARCO_PORT` | `3001` | Server HTTP/WS port |
| `ARCO_UPDATE_CHECK` | enabled | Set `0` to prevent automatic and manual GitHub release checks; overrides Settings |
| `ARCO_HOST` | `127.0.0.1` | Server bind address. Loopback by default  - the HTTP/WS surface has **no auth** (see Exposure posture). Set `0.0.0.0` only to deliberately expose to the LAN |
| `ARCO_WS_AUTH` | on | `off` disables the session-cookie gate on `/ws`, `/terminal`, `/upload` and `/api/*` (`server/src/http/wsAuth.ts`). For throwaway smoke-test servers and as an emergency off-switch only  - never leave it on `arco.service` |
| `ARCO_HOME` | `~/.arco` (`%USERPROFILE%\.arco` on Windows) | Relocates the whole Arco home: settings, provider accounts and secrets, clusters, chats, checkpoints, the MCP registry, logs and the source for `scripts/arco-backup.ts`. `ARCO_HOME` takes precedence. Per-project state stays under `<project>/.arco/` |
| `ARCO_SERVE_CLIENT` | unset | Set `1` (service mode) to make the server serve the built `client/dist` as a static-file fallback (SPA fallback to `index.html`). Unset -> Vite owns the client in dev. See [`SERVICE_MODE.md`](SERVICE_MODE.md) |
| `NODE_ENV` | unset | The service unit sets `production`; this rejects test-only HTTP routes (e.g. the cluster `_test_insert` smoke hook) and switches identity to `systemd` service mode |
| `OLLAMA_URL_BASE` | `http://localhost:11434` | Ollama daemon endpoint |
| `STRATA_URL_BASE` | `http://127.0.0.1:8081/v1` | Standalone Strata endpoint; `settings.strata.baseUrl` takes precedence |
| `ARCO_STRATA_PROFILES` | `~/.arco/strata-profiles.json` | Optional prepared-profile registry; exact matching loopback endpoint only; see [STRATA.md](STRATA.md) |
| `LMSTUDIO_URL_BASE` | `http://localhost:1234/v1` | LM Studio OpenAI-compat endpoint |
| `ARCO_CURSOR_AUTH` | `~/.config/cursor/auth.json` | Path to the Cursor session-JWT file; read fresh each poll by the auth-status check and the `/api/cursor-usage` poller (test/override seam) |
| `ARCO_LLAMACPP_BIN` | `llama-server` on `PATH` | Path to the `llama-server` binary |
| `ARCO_LLAMACPP_HOST` | `127.0.0.1` | `llama-server` bind host; loopback by default |
| `ARCO_LLAMACPP_PORT` | `8923` | `llama-server` bind port (chosen to avoid common dev ports) |
| `ARCO_LLAMACPP_KEEPALIVE_MS` | `600000` (10 min) | Idle timeout before `llamacppManager` SIGTERMs the running `llama-server` (see section llama.cpp manager lifecycle) |
| `ARCO_RSS_KILL_BYTES` | `32 * 1024^3` (32 GB) | Tree-RSS auto-kill threshold (per worker tree); raised from 16 GB on 2026-04-28. Must be >= 1 GB or it's ignored |
| `ARCO_MAX_WORKER_OUTPUT_BYTES` | `52428800` (50 MB) | Per-worker text-output cap before force-settle + truncation notice. Must be >= 1 MB or it's ignored |
| `ARCO_TOOL_LOOP_GUARD` | `warn` | In-turn tool-loop guardrail mode (Claude Native, H9). `warn` = emit `tool_loop_warning` + `system_notice` only; `stop` (or `hard`/`1`/`on`) aborts the tool loop on the first trip; `off` (or `0`/`false`) disables detection |
| `ARCO_LOG_FILE` | unset | Set `1` to enable rotating file logging under `~/.arco/logs/` (the service unit sets this) |
| `ARCO_LOG_DIR` | `~/.arco/logs` | Override the file-log directory (also enables file logging when set) |
| `ARCO_OAUTH_CALLBACK_HOST` | `127.0.0.1` | Loopback host for the Claude Native OAuth callback |
| `ARCO_INSTANCE_NAME` | (hostname-derived) | Friendly instance name reported to the management hub |
| `ARCO_HUB_URL` | unset | Management-hub WS URL (`ws://<host>:<port>`). Inert unless set; baked into the service unit at install time if present in the shell |
| `ARCO_NTFY_URL` | unset | ntfy push endpoint (`http://<host>:<port>/<topic>`). Inert unless set; baked into the service unit at install time if present |
| `ARCO_NTFY_TOKEN` | unset | Optional bearer token for the ntfy topic |
| `ARCO_TEST_CHROME` | `~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome` | Chromium executable for the Python browser smokes (`scripts/smoke/*-browser.py`); set it to any local Chromium or Chrome |
| `ARCO_SEARXNG_URL` | `http://127.0.0.1:8888` | SearXNG endpoint behind the local `WebSearch` tool (Ollama / llama.cpp / LM Studio / Strata native, and Ollama/Strata Chat web toggles) |
| `ARCO_CHROME_BINARY` / `CHROME_PATH` | (auto-detect) | Chrome/Chromium binary for the headless preview screenshot path |
| `ARCO_CAMOUFOX_PYTHON` | `/opt/camoufox/bin/python` | Python used for the explicitly selected Camoufox Codex usage fallback and the local `WebFetch` stealth fallback |
| `TERMINAL` | (auto-detect) | Preferred terminal for Codex auth flows; falls back through `konsole`, `gnome-terminal`, `kgx`, `kitty`, `alacritty` |
| `OPENAI_API_KEY` | unset | Env-var auth fallback for Codex (subscription auth preferred); detected by the auth-status probe |
| `ARCO_CLUSTER_IDLE_FLOOR_SECONDS` | `10` | Minimum idle time before the nudger fires; set to `1` when running cluster smoke tests |
| `ARCO_CLUSTER_AUTO_TURN_COOLDOWN_MS` | `20000` | Per-recipient cooldown for AUTO-PICKUP turns |
| `ARCO_CLUSTER_AUTO_TURN_RATE_CAP_PER_MINUTE` | `10` | Cluster-wide rate cap for auto-turns |
| `ARCO_CLUSTER_AUTO_TURN_MAX_CHAIN_DEPTH` | `3` | Maximum peer-message chain depth before auto-turn refuses to fire |
| `ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL` | unset | Set `1` to lift the local runtime capacity limit set in Connections ("Cluster members that may use this runtime at once", default 1 per runtime) |
| `ARCO_PEER_SEND_DEDUPE_MS` | `60000` | Dedup window for `peer_send` (same from/to/content hash within window is rejected as `duplicate_send`) |

Additional local-provider and cluster controls:

- `ARCO_LOCAL_PROVIDER_SERIAL_QUEUE=0` disables the shared serial local-provider queue.
- `ARCO_{OLLAMA,LLAMACPP,LMSTUDIO}_MAX_TOOL_TURNS` tune local tool loops; `ARCO_LLAMACPP_THINKING_FLUSH_MS` tunes thinking flushes.
- `ARCO_CLUSTER_AUTO_TURN_SWEEP_INTERVAL_MS` tunes the operator-armed auto-turn sweep interval.

### Launcher-affecting

| Var | Default | Purpose |
|---|---|---|
| `ARCO_DIR` | the checkout containing `scripts/arco` | Project root the launcher manages |
| `ARCO_CLIENT_PORT` | `5173` | Vite port for browser open + port checks |
| `ARCO_SERVER_PORT` | `3001` | Mirror of `ARCO_PORT` for launcher checks |
| `XDG_CACHE_HOME` | `$HOME/.cache` | Where launcher logs/pids/locks live |

---

## The launcher script

`scripts/arco` is a bash 3.2-compatible launcher for desktop / CLI use.

### Commands

```bash
scripts/arco start     # boot Arco + open browser
scripts/arco stop      # graceful API shutdown + signal cleanup
scripts/arco restart   # stop then start
scripts/arco status    # report running/stopped + log path
scripts/arco logs [N]  # tail -f -n N of the log (default 100)
```

### Start

1. Acquire `mkdir`-based atomic lock at `$CACHE_DIR/start.lock.d` to prevent races.
2. Check existing Arco processes (PID file + ports + signature). If any exist, call `stop` first (launch starts a clean slate; resume prior work through the in-app picker rather than reattaching to a half-dead process).
3. `pkill -f` belt-and-suspenders for `tsx.*(server|src)/index\.ts` and `concurrently.*arco` signatures.
4. Brief 1-second settle so the kernel releases ports.
5. Refuse if a non-Arco process is squatting on either port.
6. `nohup setsid npm run dev >> $LOG_FILE 2>&1 &` and store the pid.
7. `wait_ready 60` polls both ports every 0.5s  - 60 tries, so up to ~30 seconds (the failure toast says "within 30s").
8. Open the browser to `http://localhost:5173` (rate-limited to one open per 5s window).

### Stop

1. POST `/api/shutdown` (graceful  - server broadcasts `shutdown` WS message to every connected tab).
2. Wait 2 seconds for the server's 1.5s client-notify window plus slack.
3. Fall back to signalling the PGID directly (kill `-- -<pgid>`).
4. `reap_orphans()` SIGKILLs any Arco-tied processes still holding the ports.
5. Last-resort `pkill -f` for known dev process signatures.
6. Remove the PID file.

### Logs

Live at `$XDG_CACHE_HOME/arco/arco.log`. The launcher trace (separate file, what command ran when) lives at `$XDG_CACHE_HOME/arco/launcher-trace.log`.

### Desktop entries (Linux freedesktop)

```bash
cp scripts/arco.desktop scripts/arco-quit.desktop ~/.local/share/applications/
update-desktop-database ~/.local/share/applications
```

Installs **Arco** (start + open browser) and **Quit Arco** (stop) as desktop entries. Both call into `scripts/arco`.

---

## Production service

`scripts/arco` runs the **dev** stack. For a durable runtime that survives a terminal close and restarts on crash, use **service mode**  - the compiled server serves `client/dist` itself under a systemd `--user` unit:

```bash
npm run arco:service -- install --enable
npm run arco:service -- start
npm run arco:service -- status
npm run arco:service -- logs
```

Full CLI, the rendered systemd unit, the `ARCO_SERVE_CLIENT` static-serve gate, and the macOS launchd procedure are in [`SERVICE_MODE.md`](SERVICE_MODE.md).

Before a backend service update, run `npm run deploy:preflight`. It reads the live
open workspace: standalone workflow snapshots use `busy`, while cluster
members use `status: 'busy' | 'idle'`. It exits 2 with active primary turns,
1 on an incomplete/unknown response, and 0 when those primaries are idle.
It sends no prompt. Incognito tabs are intentionally absent from workspace
sync; check those and any separate review/research workers in the UI as well.
The shape regression is pinned by
`node --conditions development --import tsx --test scripts/deploy-preflight.test.ts`.

### Reproducing the live unit on a clean install

Deployment caveat: `core.code-skew` compares startup Git HEAD with current HEAD,
not asset contents. Committing an already-deployed build or documentation alone
can warn without a pending runtime fix. For a verified **client-only** update,
the static server reads files per request: publish hashed assets first, preserve
old chunks, and replace `client/dist/index.html` last. Browser refresh picks up
the new client without interrupting server workers. Backend changes still require
rebuild/restart coordination. See the documentation index for maintained guides.

`install` bakes `ARCO_HUB_URL` / `ARCO_NTFY_URL` into the unit **only if they are set in the shell at install time** (remote-management is operator-supplied config, not baked into the repo). A clean checkout that runs `npm run arco:service -- install` produces a working but hub-unlinked unit. For a remote-management deployment, configure the hub endpoints explicitly:

```bash
ARCO_HUB_URL=ws://<hub-tailnet-ip>:3500 \
ARCO_NTFY_URL=http://<hub-tailnet-ip>:3501/arco-<topic> \
npm run arco:service -- install --enable
```

All *code* fixes (IPv6 hard-block, the usage-fetch guard, the global crash net) travel with the repo and need no env.

### Network compatibility

Arco uses the platform network stack and follows the configured proxy and DNS behavior. Keep network endpoints configurable for environments with restricted routing.

### Recovering from `start-limit-hit`

If `npm run arco:service -- status` shows `failed (Result: start-limit-hit)`, systemd has stopped retrying. Clear the counter and start again:

```bash
systemctl --user reset-failed arco && systemctl --user start arco
```

---

## In-app shutdown / restart

The UI's SystemHeader has a small power-button cluster:

- **Shutdown** -> `POST /api/shutdown` -> broadcasts `{type: 'shutdown', reason: 'server_stopping'}` -> server flushes `events.jsonl`, kills the dev tree, exits.
- **Restart** -> `POST /api/restart` -> broadcasts `{type: 'shutdown', reason: 'server_restarting'}` -> server flushes. In service mode it asks systemd to restart the compiled server. In dev mode it kills the dev tree (50ms delay so HTTP response flushes first), then spawns a detached respawn script that waits 1 second and runs `npm run dev`.

The client keeps the tab open during `server_restarting` and reconnects on the new process. On `server_stopping` it tries to close the tab (browsers usually block this; the `ShutdownOverlay` stays visible).

In dev mode, the respawn script is written to `$TMPDIR/arco-respawn-{pid}.sh`. If restart fails silently, look at `$TMPDIR/arco-respawn.log`.

On every stop the server logs one **shutdown forensics** line (H42, `server/src/diagnostics/shutdownForensics.ts`) recording the `signal`, `uptime`, `rss`, how many in-flight turns were truncated (broken down by provider), the worker-reap tally (`killed`/`reused`/`gone`), PTY session count, and the flush budget. Grep the server log after an unexpected stop to see exactly what the shutdown interrupted.

**GOTCHA**: The dev restart path is SIGKILL (50 ms after the HTTP response flushes, then `process.exit` 200 ms later), not graceful SIGTERM. The respawn script sleeps 1s before `exec npm run dev` so the parent is fully gone before the new tree binds. Earlier attempts with seconds-long grace + port polling raced concurrently/tsx teardown vs. rebind. SIGKILL is immediate; ports release on socket-close which kernel does in the same syscall. Service mode deliberately does not run that script; systemd owns the restart.

---

## Claude allowance

Hover the Claude status dot to read the allowance source, unknown or verified account state, freshness
and check time. The current meter reports account identity as unknown. Native OAuth credentials are
preferred; a CLI fallback is labeled explicitly and does not establish the Native account's allowance.
Use **CHECK ALLOWANCE NOW** to request a fresh check. An unavailable meter does not invalidate
execution credentials or change the selected workflow transport.

Cached snapshots are scoped to the current Native and CLI credential revisions. Reauthentication,
account replacement or a newly available Native grant invalidates the old selection context. A failed
check can retain an explicitly stale snapshot for unchanged credentials; an older binding's quota
cannot replace the current source. The popover keeps snapshot time separate from check time.

Claude CLI owns its credential refresh chain. Arco reads the current access grant from
`CLAUDE_CONFIG_DIR` or the default CLI directory and never refreshes or writes that chain for the meter.
If CLI allowance access expires or is rejected, recover through Claude CLI or its Connections sign-in
control, then check allowance again. CLI execution may still be available while metering is unavailable.
Native refresh continues through Arco's existing Native credential owner and lock.

## Codex usage

The Codex status dot reads ChatGPT subscription quota through the installed Codex CLI app-server. Its account selector uses the configured Codex profiles; the default is the first profile or the default CLI account. Update the CLI or connect a ChatGPT account in Connections when the read is unavailable. API-key accounts do not expose subscription quota. The usage page link opens the official dashboard. The displayed timestamp is the time the snapshot was fetched; a failed refresh can show an explicitly stale snapshot only when the account and credential file remain unchanged.

The legacy browser source is optional and must be selected in the usage popover. It uses a separate ChatGPT browser login, not the selected CLI account. Install Python and the optional [Camoufox package and browser](https://camoufox.com/python/installation/) as the user running Arco. On Linux and macOS, a dedicated environment can be prepared with:

```sh
python3 -m venv .venv-camoufox
.venv-camoufox/bin/python -m pip install camoufox
.venv-camoufox/bin/python -m camoufox fetch
```

Set `ARCO_CAMOUFOX_PYTHON` to the absolute path of that environment's Python in the server environment and restart Arco. Windows uses the environment's `Scripts/python.exe`; these commands and the headed login require a graphical session on the server host. The popover's LOGIN CAMOUFOX PROFILE action opens the independent profile for manual ChatGPT sign-in. Then select the browser source and CHECK NOW. Arco checks for the Python package and a browser executable before launching; a missing or incompatible browser requires the upstream installation steps. It never deletes the browser profile. The install sequence was checked on Linux; macOS and Windows remain unverified.

## Auth

Per-service. Status surfaced via the SystemHeader's `HeaderAuthChip` and the `AuthOverlay` (blocks UI when no primary-capable provider is authed).

| Provider | Login command / endpoint | Status check |
|---|---|---|
| Claude (CLI transport) | `claude auth login` | `claude auth status --json` |
| Claude (Native transport) | `POST /api/auth/claude-native/login` (browser OAuth, callback at `localhost:53692`; falls back to manual paste if the port can't bind) | `GET /api/auth/claude-native` |
| Codex | `codex login` | `codex login status` |
| Codex usage probe | `POST /api/codex-usage-login` (terminal-launched flow) | `GET /api/codex-usage` |
| GitHub | `gh auth login` | `gh auth status` |
| Ollama | (no login) | `${OLLAMA_URL_BASE}/api/tags` reachable |
| Cursor (ACP) | `cursor-agent login` (interactive  - launches a terminal for the browser OAuth flow) | `~/.config/cursor/auth.json` carries a session JWT; read fresh each poll (no `cursor-agent auth status` command exists) |
| Strata | (no login) | Live `/v1/models`, plus validated prepared local profiles while stopped/unloaded |
| LM Studio | (no login) | `${LMSTUDIO_URL_BASE}` OpenAI-compat server reachable |
| llama.cpp | (no login  - Arco spawns/manages `llama-server`) | `llama-server` reachable |

CLI flows are triggered via `POST /api/auth-login?provider=<name>`. Claude Native uses a separate set of `/api/auth/claude-native/*` endpoints (see [`HTTP_API.md`](HTTP_API.md) section Claude Native auth). The auth-status endpoint is `GET /api/auth-status`. Polled every 2 minutes by the client. Native tokens persist to `~/.arco/auth.json`; refresh races serialize via `proper-lockfile`.

### Recovering Native sign-in

An inline RE-LOGIN action uses that notice's originating workflow, transport and Native credential
revision, even when another tab is active. New notices retain the actual Native binding in saved
transcript events. Older notices without that metadata use their saved workflow configuration;
they do not establish the historical credential revision. CLI notices keep the CLI login path. Codex recovery retains the originating account profile without changing its app-server transport.

Settings and inline Native recovery share the same flow completion, error and manual-paste handling.
A flow id, rather than stored-token presence, tracks local callback completion even when rejected
credentials remain on disk. One Native store serves the home; a new flow supersedes an older one.
Pending flows expire after ten minutes and disappear on server restart. CANCEL SIGN-IN cancels
that flow. A stale, failed, cancelled or expired flow cannot clear another recovery notice or replace
a newer grant. Native refresh and inference retry limits are unchanged.

The callback at `localhost:53692` reaches Arco only from a browser on the server host with that port
reachable. Successful listener binding does not prove a remote browser can reach it. If approval
ends on an unreachable localhost page, paste its redirected URL into the provided field. Consent,
MFA and account selection remain provider-controlled; no remote OAuth return bridge is provided.
The management reauthentication actions use the same bootstrap and manual completion path.

After a matching completion, REVIEW ORIGINAL WORKFLOW opens that workflow and shows its current
execution state. Composer drafts, attachments, settings and transcripts are preserved. Review prior
actions and send explicitly from the composer; sign-in never replays a provider turn or tool mutation.
A different source or notice remains separate, and an already running workflow is not resumed again.

### Strata and large MoE operation

See [STRATA.md](STRATA.md) for profile selection, memory limits, profile
switching, CPU/GPU vision, service recovery, rollback, FREE VRAM and verification
limits. Arco application memory limits do not resize the separately managed
Strata service. Restart Strata only between its requests; restarting Arco
interrupts active workers across tabs.

### Ollama Over Tailscale

Arco can talk to an Ollama daemon on another Tailnet machine by setting `OLLAMA_URL_BASE` before starting Arco:

```sh
export OLLAMA_URL_BASE="http://<tailscale-ip-or-magicdns-name>:11434"
npm run dev
```

On the Ollama host, the daemon must listen on an address reachable from the Tailnet. Ollama binds `127.0.0.1:11434` by default; set `OLLAMA_HOST` on that machine, then restart Ollama. Prefer binding to the host's Tailscale IP when practical, or use firewall/Tailscale ACLs if binding `0.0.0.0:11434`, because Ollama's HTTP API has no built-in auth.

API-key fallbacks (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) work but Arco is designed around subscription auth. Claude Native does not honor `ANTHROPIC_API_KEY`  - it explicitly uses the OAuth `authToken` field on the SDK so the wire fingerprint matches Claude Code.

---

## External dependencies

### FFmpeg (required for Media studio audio/video ops)

The Media studio's audio ops (H6: clip / convert / normalize / mono / stereo / fade / resample / extract) and the upcoming video ops shell out to **`ffmpeg`** and **`ffprobe`** - system binaries on `PATH`, **not** npm deps. The waveform viewer + region select work without ffmpeg (browser-side decode); only the server-side ops + on-disk playback (the `/api/media/raw` serve route works without ffmpeg, but the ops don't) need it.

- **Detection:** `server/src/media/ffmpeg.ts::ffmpegAvailable()` caches a `ffmpeg -version` probe. If ffmpeg is absent, `POST /api/media/op` returns `200 { ok: false, code: 'ffmpeg-missing', error }` (with this pointer)  - never a crash. The op buttons surface the error inline.
- **Install (generic):** any recent ffmpeg (8.x verified)  - `apt install ffmpeg` / `brew install ffmpeg` / your distro's package. Confirm with `ffmpeg -version` and `ffprobe -version`.
- **Install (a source-built distribution):** follow `the distribution packaging guide` (manifest-tracked, 5 categories). **Never `curl | sh`.**
- **After install:** a running Arco server caches "ffmpeg missing"; **restart the server** to re-probe.

#### Media access fence + scratch

The studio is a **general** media tool: it can open a picker-imported file, a file on an SMB mount, or anything outside a workflow folder, and write output to a chosen destination.

- **Import scratch:** an imported (browser-blob) file is staged to **`~/.arco/media-scratch/<uuid>/`** so ffmpeg (which reads files, not object URLs) can act on it. Bounded  - per-upload byte cap (4 GiB), a **24h TTL**, and a 16 GiB total cap (oldest evicted)  - and reaped automatically. It's disposable: safe to `rm -rf ~/.arco/media-scratch/` at any time.
- **Access setting `mediaUnconfined`** (Settings -> **MEDIA ACCESS**; default **open**): when open, ops + the `/api/media/raw` serve may reach an **arbitrary absolute path** and write to an arbitrary (existing) output dir. When **CONFINED** (`false`), they're restricted to the workflow cwd **plus** the import scratch  - picker-imported files still convert/clip, but arbitrary disk paths are rejected. **Switch to CONFINED on a tunnel-exposed Arco.** Read per-op from the settings cascade, so a project `.arco/settings.json` can pin `"mediaUnconfined": false`. Output is always uniquified and never overwrites the source, regardless of the setting.

### Demucs (optional  - Media studio stem separation, N4)

The audio panel's **STEMS** control shells out to **`demucs`** (Python + torch) for AI source separation  - vocals / drums / bass / other, or a two-stems karaoke split. **Optional:** absent -> `POST /api/media/stems` returns `200 { code: 'demucs-missing' }` with this pointer (never a crash); every other media feature works without it.

- **Detection:** `server/src/media/demucs.ts::demucsAvailable()` is a cached **PATH scan** (it does *not* run `demucs --help`  - that imports torch and is slow). It also checks `~/.local/bin` (the common `pip --user` location). Restart the server to re-probe after installing.
- **Install (a source-built distribution):** follow `the distribution packaging guide` (manifest-tracked). **Never `curl | sh` / bare `pip`.** Demucs pulls torch + the `htdemucs` weights (cached under `~/.cache/torch` on first run).
- **GPU:** the runner passes **no `-d`**, so demucs auto-selects CUDA when available else CPU. On an RTX-class GPU a short track separates in seconds; on CPU it's minutes (the UI shows a running state + CANCEL the whole time). Cancel SIGKILLs the child and removes the partial output folder.
- **Output format caveat (`torchcodec`):** some torchaudio builds route **wav/flac** writes through `save_with_torchcodec`, which needs the separate **`torchcodec`** package. If it's absent, wav/flac fail and the runner returns a clear hint  - use **mp3** (lameenc, the default, always works) or add `torchcodec` with the system package manager.
- **Output layout:** a fresh `~/<chosen-or-source-dir>/<track>.stems[-N]/` folder per run (never clobbers a prior run or the source), with the stems flattened directly inside (demucs's forced `<model>/` subdir is removed). Reveal points at the folder.

---

## Logs

| Source | Path | Notes |
|---|---|---|
| Server (and client dev) | `$XDG_CACHE_HOME/arco/arco.log` | Combined stdout/stderr from `npm run dev` |
| Launcher trace | `$XDG_CACHE_HOME/arco/launcher-trace.log` | What launcher command ran when |
| Restart script | `$TMPDIR/arco-respawn-<pid>.sh` | Generated each restart |
| Restart output | `$TMPDIR/arco-respawn.log` | Stdout/stderr of the respawned `npm run dev` |
| Service mode (systemd) | journald + `~/.arco/logs/` | The unit sets `ARCO_LOG_FILE=1` (rotating file log) and journald captures stdout/stderr. View via `npm run arco:service -- logs`. See [`SERVICE_MODE.md`](SERVICE_MODE.md) |

To watch live: `scripts/arco logs` or `tail -f $XDG_CACHE_HOME/arco/arco.log` (dev); `npm run arco:service -- logs` (service mode).

**Memory trend.** When file logging is enabled (service mode sets `ARCO_LOG_FILE=1`), the server logs a periodic `[arco][mem:...] rss=... heapUsed=... heapTotal=... external=... rssdelta=... rssPeak=...` line every 5 minutes, plus a boot baseline and a shutdown final sample. Grep `\[arco\]\[mem` to tell whether RSS crept up over hours or spiked in a single turn before an RSS-guard kill. Inert in dev (no file log path).

---

## Browser memory

The browser is a hot working set, not the durable archive. Workflow history, cluster events, artifacts, and provider transcripts should remain recoverable from server-side files even when the client trims old rows from RAM. See [`PERSISTENCE.md`](PERSISTENCE.md) for the current caps.

### Quick triage

Check the largest processes:

```bash
ps -eo pid,ppid,comm,args,%mem,rss --sort=-rss | head -n 20
```

For a Chromium/Brave tab, the large process is usually a `--type=renderer` child. A multi-GB renderer with modest server/node RSS usually points to client-side retained state or render caches, not active worker memory.

### Client memory hooks

In the Arco tab DevTools console:

```js
window.__ARCO_MEMORY_STATS__()
window.__ARCO_TRIM_MEMORY__()
```

`__ARCO_MEMORY_STATS__()` reports workflow/cluster counts, hot row counts (`messages`, `sessionChat`, `activity`, `historyEvents`, worker tool calls), approximate persisted-store bytes, and Chromium heap size when available.

`__ARCO_TRIM_MEMORY__()` applies the same client working-set trim that runs automatically every 30 seconds, then returns fresh stats. It does not restart Arco, kill workers, drain mailboxes, or delete server-side history.

Current behavior to expect:

- Chat/session/activity/history rows stay bounded in the browser.
- Worker output/thinking/tool-call detail is capped in the UI.
- All live/running workers are retained; only old settled worker records can be pruned.
- Old detail trimmed from the browser should still be recovered from `events.jsonl`, provider transcripts, artifacts, or snapshots where that data is durably recorded.

If Brave/Chromium climbs steadily after `__ARCO_TRIM_MEMORY__()` and the hot row counts stay flat, investigate render-layer or browser-resource retention next: React derived data, markdown/highlight caches, Vite/HMR state, WebGL/theme resources, or browser graphics memory.

---

## Settings cascade

Settings are read in three layers, lowest precedence first:

1. **Defaults**  - hard-coded in `server/src/settings.ts` `defaults()` (all providers enabled).
2. **Global**  - `~/.arco/settings.json`. Hand-edited or written by `POST /api/settings` (the operator-facing patch path used by SystemHeader / SettingsPanel).
3. **Project**  - `<cwd>/.arco/settings.json`. Hand-edited only; lets a repo pin theme, default model, transport, etc., independent of the operator's machine-wide global.

A fourth conceptual layer exists in the protocol for transient runtime overrides ("in-memory"), but Arco has no consumer for it - `patchSettings` writes through to global, so the effective value matches what's on disk.

### Merge semantics

- **Nested objects**: deep-merged key-by-key. Project overrides only the keys it sets; unspecified keys fall through to global.
- **Arrays**: replace entirely. A project array overrides the global array as a single value  - there's no element-wise merge.
- **Scalars and `null`**: replace.

Example:

```jsonc
// ~/.arco/settings.json
{ "themeId": "sentinel",
  "workflowDefaults": { "primaryProvider": "claude", "primaryModel": "claude-opus-4-7" } }

// ~/Projects/sample-app/.arco/settings.json
{ "themeId": "amber-crt",
  "workflowDefaults": { "primaryProvider": "codex" } }

// effective for cwd=~/Projects/sample-app:
{ "themeId": "amber-crt",
  "workflowDefaults": { "primaryProvider": "codex", "primaryModel": "gpt-6-astra" } }
```

### Reading effective settings

- `GET /api/settings` -> global cascade (defaults -> global).
- `GET /api/settings?cwd=<path>` -> project cascade (defaults -> global -> `<path>/.arco/settings.json`).

The client is responsible for passing the active tab's cwd when it wants the project layer applied. There's no implicit "active cwd" on the server side.

### HMR

The server watches:

- `~/.arco/`  - installed once at boot. (Also holds `media-scratch/`  - the N2 import-staging area; not watched, reaped on its own TTL.)
- `<cwd>/.arco/`  - installed per workflow cwd, ref-counted (every workflow attached to that cwd holds one ref). Released when the last workflow for the cwd is removed.

Both watch the parent **directory** (not the file)  - atomic-rename writers replace the inode, breaking file-level watchers. Filename is filtered to `settings.json`; events are debounced 200 ms to coalesce the temp+rename pair from atomic writers and Linux's tendency to fire multiple events per save.

On any change, the server broadcasts `settings_updated` (with `scope: 'global' | 'project'` and the `cwd` for project events) to every connected client. Clients re-fetch via `GET /api/settings?cwd=<active-cwd>` and re-apply locally  - no server restart needed.

### Available keys

For Incognito Chat, global settings still configure appearance/providers but the
chat itself has no persisted workflow settings or recoverable session. See
[Chat and Incognito](CHAT.md) before treating a tab close or server restart as safe.

Theme family selection is encoded in `themeId`, not a separate persisted family
field. `provider-auto` remains Classic. Phosphor uses `phosphor:arco:<id>`;
existing IDs never migrate automatically. Crisp text overrides glow; effects-off
overrides decorative frost without deleting its saved setting. Reduced motion
keeps static treatment. See [PHOSPHOR_DEMO.md](PHOSPHOR_DEMO.md).

The full schema is `ArcoSettings` in `shared/src/protocol/settings.ts` (barrel-exported). Selected operator keys, not an exhaustive schema:

| Key | Purpose | Wired? |
|---|---|---|
| `enabledProviders` | Hide providers from the picker | Yes |
| `workflowDefaults.primary{Provider,Model,Effort}` | Pre-fill new tabs | Yes |
| `themeId` / `fontPackOverride` | Classic or namespaced Phosphor selection; independent font override | Yes |
| `phosphorEffects` / `phosphorSoftness` | Phosphor-only decorative effects (default on), glow softness 0-100 (default 50) | Yes |
| `textBrightness` / `bgBrightness` / `crispText` | Independent brightness and text-legibility controls | Yes |
| `operatorName` | Replace `> OPERATOR` chat label | Yes |
| `acknowledgedCliVersions` | Dismiss CONFIG-tab dot | Yes |
| `claude.transport` (`'cli' \| 'native'`) | Per-tab Claude transport - overridden by `WorkflowConfig.claudeTransport`. Reviewers and handoff seeds always run on `cli` regardless. | Yes |
| `codex.transport` (`'exec' \| 'appserver'`) | Per-tab Codex transport - overridden by `WorkflowConfig.codexTransport`. Reviewers and handoff seeds always run on `exec`. | Yes |
| `claudeNativeCompactDefault` | Seeds new Native tabs' SERVER-SIDE COMPACTION toggle (absent => off) | Yes |
| `autoHandoffDefaults` / `handoffSummarizer` | Seed new tabs' auto-handoff thresholds/mode; pin a fresh-summarizer provider/model for handoffs | Yes |
| `defaultProjectTrust` (`ask`/`always`/`never`) | DD7 default for unseen repos; read from global scope only | Yes |
| `mediaUnconfined` | Media studio path fence (see External dependencies) | Yes |
| `handoffPromptPath` | Override Handoff prompt file path (rare; the per-mode files at `<cwd>/.arco/handoff*.prompt.md` are the normal surface) | Yes |
| `queueMode` (`'visible' \| 'hidden'`) | Queue UX mode | Yes |
| `skillsExtraPaths` (`string[]`) | Extra skill scan dirs beyond `<cwd>/.arco/skills/` and `~/.arco/skills/` | Yes |

Per-workflow `meta.json` carries a few keys that are part of the same configuration story but not in `settings.json` (they're per-tab, not cascade-controlled): `autoHandoff: { enabled, warnAt, autoAt }` (trusted context-signal providers only; enabled by default for new tabs), `claudeNativeCompact` (server-side compaction toggle, **off** unless explicitly `true`, gated on the active model's catalog capability flags), `codexContextPolicy` (`max` when absent), `goalRun` (never persisted across a restart), and `appserverWarningSeen` (one-shot warning gate when an operator first flips Codex transport to `appserver`).

---

## Capabilities + CLI change detection

`server/src/capabilities.ts` probes each provider CLI's `--version` and help output. Snapshots persist to `~/.arco/cli-snapshots/<provider>-snapshot.json`. Re-probes:

- At server boot
- Every 4 hours via `PERIODIC_PROBE_INTERVAL_MS`
- On demand if the operator clicks the CONFIG tab's red dot

Differences become `capabilities_changed` WS events. The CONFIG tab shows a red dot when there are unacknowledged changes; click to clear.

If a CLI was upgraded between boots, the active tab gets a `[CLI] Updated X -> Y` system message. New flags appear in `cliChanges[]`; the operator can decide whether to accept the new behavior.

---

## Director / workers dispatcher and run recovery

Operational guidance for the task-dispatch layer built on top of cluster mode. Full protocol detail is in [`TASK_LEDGER.md`](TASK_LEDGER.md) and [`PROTOCOL_CLUSTER.md`](PROTOCOL_CLUSTER.md).

### Armed dispatcher

The per-cluster dispatcher is **OFF by default**. Two arming surfaces:

- **One-shot**  - `cluster_dispatch_once` immediately sweeps `ready` tasks not already claimed/running and assigns each to an idle member. No daemon; fires once per operator request.
- **Daemon**  - `cluster_dispatch_toggle` arms/disarms an interval sweep (default interval: configurable via `cluster_dispatch_settings_update`). Armed state persists in the cluster meta across server restarts.

On **server restart**, the daemon re-arms automatically from the persisted meta, but only dispatches tasks that are genuinely `ready` and unclaimed  - already-claimed or open runs are never double-dispatched. In-flight runs at the moment of restart finish normally once the member reconnects; the daemon does not cancel them.

To **pause** without losing the setting: `cluster_dispatch_toggle` with `armed: false`. To resume: toggle back on. Settings (interval, max concurrent, member eligibility) survive the toggle.

### Run recovery controls

`task_run_recover` (message type) accepts four actions on a run identified by `clusterId` + `taskId` + `runId`:

| Action | Effect |
|---|---|
| `reclaim` | Mark the run abandoned; task returns to `ready` for re-dispatch. |
| `terminate` | Mark the run terminated; task moves to `blocked`. Operator must unblock before re-dispatch. |
| `reassign` | Abandon the current run and immediately dispatch to a different member. |
| `fail` | Mark the run and task as `failed`; stops automatic retry. |

All actions run under a per-cwd lock. Accessible from the BOARD task drawer in the cluster UI.

**Stale-claim / heartbeat detection**  - a run whose heartbeat has not refreshed within the configured stale window is flagged `stale` by the dispatcher sweep. The dispatcher can reclaim stale runs automatically (configurable; default: reclaim and re-dispatch).

**Consecutive-failure breaker**  - a task that accumulates N consecutive failed runs (default: 3) is automatically moved to `blocked`. The operator must manually unblock (`cluster_task_update` with `blocked: false`) before the dispatcher will touch it again.

None of these controls are model-initiated  - all are operator actions or deterministic server-side rules. Every recovery action is logged to `events.jsonl`.

---

## Cluster startup and shutdown

Clusters don't have their own boot sequence  - they're recovered alongside regular workflows because the cluster record lives at `~/.arco/clusters/<clusterId>/meta.json` and the server reads it on reconnect.

**On server start:**
- `clusterStore` loads per-cluster state from disk lazily (first access per clusterId triggers a read).
- `clusterRehydrate` re-emits undelivered `peer_message_sent` events to any subscriber that was offline when the message arrived (rehydrate-on-subscribe). This fires when a client sends `cluster_subscribe` after reconnect.
- Mailbox files (`~/.arco/clusters/<clusterId>/mailbox/<recipientWfid>/<msgId>.json`) are left on disk as-is  - drain happens only when the model calls `peer_read`.

**On server stop / restart:**
- Pending mailbox files survive across restarts (they're on disk). Messages already delivered are in `events.jsonl`; undelivered ones remain in the mailbox directory.
- Active auto-turn state (the in-memory cooldown + rate counters in `clusterAutoTurn.ts`) is lost on restart and resets to zero. Operators with AUTO-PICKUP enabled should be aware that the chain-depth counter also resets, which is correct  - the orphan state that triggered it is also gone.
- No explicit mailbox cleanup happens on shutdown; operators can manually remove `~/.arco/clusters/<clusterId>/mailbox/` if they want a clean slate.

**Idle nudger (default OFF):**
The nudger (`server/src/clusterIdleNudger.ts`) fires a toast notification in the Arco UI when a cluster member has been idle longer than the configured floor (default 10s, test override via `ARCO_CLUSTER_IDLE_FLOOR_SECONDS`). It is **operator-armed per cluster** in the MAIL ALERTS toggle and is **toast-only**  - it never sends a prompt to any worker automatically. The toggle survives server restarts because the armed state is part of the cluster record.

**AUTO-PICKUP** (distinct from nudger) is also operator-armed per cluster (OFF by default). When ON, a `peer_message_sent` event that arrives while the recipient is idle fires a synthetic turn on the recipient. Guards: 20s cooldown per recipient, 10/min rate cap per cluster, max chain depth 3. Chain depth resets on `primary_turn_ended`. Env overrides: `ARCO_CLUSTER_AUTO_TURN_COOLDOWN_MS`, `ARCO_CLUSTER_AUTO_TURN_RATE_CAP_PER_MINUTE`, `ARCO_CLUSTER_AUTO_TURN_MAX_CHAIN_DEPTH`.

---

## Observable runtime states

Arco distinguishes six observable states so a failure tells you *which* failure it is. They split across two indicators: a global **connection** badge in the header, and a per-tab **runtime** pill above the composer.

**Connection (header badge  - what's wrong between your browser and Arco):**

| State | Header shows | What it means | What to do |
|---|---|---|---|
| `online` | ONLINE / SYNCING... | WebSocket open, talking to Arco. | Nothing. |
| `disconnected` | OFFLINE / RECONNECTING... | The WebSocket dropped but the **server process is still alive** (the `/healthz` probe succeeded)  - a browser sleep, network blip, or proxy hiccup. | Wait for the automatic reconnect, or click **RECONNECT**. |
| `server-down` | SERVER DOWN | The WebSocket is closed **and** `/healthz` is unreachable  - the **Arco server process itself is gone or unresponsive**. RECONNECT/RESTART can't help until it's back. | Check `npm run arco:service -- status` and `npm run arco:service -- logs`; start the service if it is stopped. (The header RESTART asks the running server to restart, so it only works once the process is back.) |

The split is driven by the B2 `/healthz` endpoint: a closed socket plus a failed probe is the only thing that promotes OFFLINE to SERVER DOWN. See the `npm run arco:service -- ...` commands above.

**Per-workflow runtime (pill above the composer  - what your tab's agent is doing):**

| State | Pill | What it means | What to do |
|---|---|---|---|
| `busy` | (existing spinner chrome) | Working and emitting output within the last 30s. | Wait. |
| `idle` | (no pill) | Not running, not freshly recovered. | It's your turn  - send a prompt. |
| `stuck` | WARNING no output for {N}s  - worker may be stuck + **CANCEL TURN** button | Still flagged busy but **no primary output for >=30s**  - the worker may be hung. | Click **CANCEL TURN** to kill the wedged turn, then re-send (see C2 below). |
| `replay-recovered` | recovered recovered from replay + **DISMISS** button | This tab was just **rehydrated from disk** (server restart / page reload of a resumed session)  - context came back from the event log. | Informational; **DISMISS** clears it now, else it auto-clears once you re-engage or after a few seconds. |

`busy`/`idle` reuse the existing composer chrome, so only the two new states (`stuck`, `replay-recovered`) get a dedicated pill.

### Targeted recovery actions

C1 made each failure observable; C2 maps each observable state to its **one correct recovery action** instead of one generic retry. The deriver (`recoveryActionFor` in `client/src/runtime/runtimeState.ts`) is pure, so the mapping is asserted headlessly by `npm run smoke:retry-paths`.

| State | Action | What it does | Why this is the right action |
|---|---|---|---|
| `disconnected` | **RECONNECT** (header) | Forces a WebSocket reconnect now. | The server process is alive (`/healthz` succeeded)  - only the socket dropped, so a reconnect is exactly what's missing. |
| `server-down` | **RE-PROBE** (header) | Re-fires the `/healthz` probe (same handler as RECONNECT, which re-probes each tick). | The server **process** is unreachable, so a WS reconnect can't land and `/api/restart` can't be delivered  - there's no process to receive it. The honest affordance is "re-check whether it's back," not a RESTART that implies a recovery that can't happen. RESTART is hidden in this state for the same reason. |
| `stuck` | **CANCEL TURN** (composer pill) | Sends a workflow-scoped `cancel`, which kills that workflow's in-flight worker. | There is **no safe way to poke a hung provider process awake**  - cancel-and-resend is the only honest recovery. CANCEL the dead turn, then re-send your prompt. |
| `replay-recovered` | **DISMISS** (composer pill) | Clears the recovery anchor (`recoveredAt`) for that tab. | Purely informational  - the tab already rehydrated correctly; DISMISS just acknowledges the notice early instead of waiting out its window. |
| `idle` / `busy` | (none) |  - | Normal chrome (the composer spinner / your turn) already covers these; a targeted recovery button would be redundant noise. |

A bound **preview** target whose port has gone unreachable gets its own targeted action: the PREVIEW tab's **RE-PROBE** button re-checks the bound port and, if it's gone, opens the dead-service picker to rebind to a currently-listening service.

---

## Robustness audit

C1 made each failure observable; C2 mapped each to its one correct retry; C3 is the audit that **proves** every enumerated failure case ends in a correct observable state with a working retry. `npm run smoke:robustness-audit` encodes each modelable case as a named timeline of input frames over the pure sectionC1/sectionC2 derivers (`client/src/runtime/runtimeState.ts`): at the failure point it asserts the expected connection state, workflow state, and recovery action; then applies the prescribed retry and asserts the timeline returns to health (`online` + `idle`/`busy`, no lingering action). It is pure / clock-injected / headless  - no live server, no provider spend, no real sockets  - exactly like `smoke:runtime-states` and `smoke:retry-paths`.

**Coverage matrix**  - how each of the nine enumerated cases is verified:

| # | Failure case | Expected observable end-state | Correct retry | Verified by |
|---|---|---|---|---|
| 1 | Browser disconnects mid-turn | `disconnected` -> reconnect -> `online` + `replay-recovered` -> `idle`/`busy` | **RECONNECT** | this harness (CASE 1) |
| 2 | Server restarts mid-turn | `server-down` -> server back -> `online` + `replay-recovered` -> `idle` | **RE-PROBE** (then auto-reconnect) | this harness (CASE 2) |
| 3 | Laptop sleep during a turn | no wedge: pending probe stays `disconnected`; a mid-sleep failed probe reads `server-down` but clears on wake; wakes -> `disconnected` -> `online` + `replay-recovered` | **RECONNECT** | this harness (CASE 3) |
| 4 | Provider CLI exits after partial output | (i) clean end -> `busy`->`idle`; (ii) silent crash -> stays `busy` -> `stuck` after 30s | (i) re-send; (ii) **CANCEL TURN** then re-send | this harness (CASE 4i / 4ii) |
| 5 | Codex app-server worker restart + resume | end-state `online` + `replay-recovered` -> `idle` | (automatic resume) | this harness asserts the **end-state** (CASE 5); resume **internal correctness** = `npm run smoke:cluster-4` / `smoke:compare` + manual recipe below |
| 6 | Claude Native large-history replay without UI block | `online` throughout the replay window + `replay-recovered` -> `idle` (never a spurious `disconnected`/`server-down`) | (none  - informational) | this harness asserts the **end-state** (CASE 6); "replay doesn't block the UI" is a **perf property** = manual recipe below |
| 7 | Terminal sessions interrupted / orphaned | workflow runtime unaffected: `online` + `idle`/`busy` (PTY liveness is orthogonal to the agent axis) | re-spawn / re-attach the terminal | this harness asserts the **runtime invariant** (CASE 7); orphan **reaping correctness** = `npm run smoke:terminal` (orphan registry round-trip) |
| 8 | Preview target dies then returns | preview probe `{ alive:false }` -> RE-PROBE -> `{ alive:true }` -> bound; agent runtime unaffected | **RE-PROBE** (PREVIEW tab) | this harness models the probe contract (CASE 8) |
| 9 | Client reload while events stream | `connecting` (no `server-down` flash) -> `online` + `replay-recovered` -> `idle` | (automatic) | this harness (CASE 9) |

### Manual / live recipes (the three cases whose internal mechanic is not a deriver property)

These verify the *internal correctness* the harness deliberately does not fake. The harness still asserts the observable end-state each would produce when the mechanic works.

- **Case 5  - Codex resume correctness.** Start a Codex app-server tab, send a turn, then kill the `codex app-server` child (`pkill -f 'codex app-server'`  - leaves the Arco server up). Observe: the tab shows `replay-recovered` briefly, then `idle`, with the prior conversation intact. Send a follow-up that references earlier context to confirm the session resumed (not a fresh session). Continuity is also covered headlessly by `smoke:cluster-4` / `smoke:compare`.
- **Case 6  - Native replay does not block the UI.** Open a Claude Native tab with a large `events.jsonl` (long session), stop and start the Arco server (`npm run arco:service -- stop` followed by `npm run arco:service -- start`), and reload the client. Observe: the tab rehydrates showing `replay-recovered` while the header stays `ONLINE` (no `SERVER DOWN`/`OFFLINE` flash), and the UI stays interactive (you can scroll / switch tabs) throughout the replay  - the in-process pre-warm replay must not jank the render loop.
- **Case 7  - Terminal orphan reaping.** Open a terminal session in a tab, note its child pid, then hard-kill the Arco server (not a clean shutdown) so the child is orphaned. Relaunch the server; the boot sweep (`reapOrphanTerminals`) SIGKILLs anything in the pid registry. Verify the orphaned pid is gone (`ps -p <pid>`). The registry round-trip is asserted headlessly by `smoke:terminal`.

---

## Workflow recovery

If you restart the server (or it crashes), workflows are recovered automatically on next boot. The recovery flow:

1. Read `~/.arco/known-cwds.json` for the list of cwds hosting workflows.
2. For each cwd, walk `<cwd>/.arco/workflows/` and validate each `<wfid>/meta.json`.
3. Drop cwds with no live workflows.
4. `reapOrphanWorkers()` reaps stale worker processes recorded in `~/.arco/worker-pids.json`. Each pid is stored with its process **start time** (H44, `server/src/workers/pidRegistry.ts`); at reap time the live start time is re-read so a **recycled pid** that now belongs to an unrelated process is left alone  - only genuinely-stale workers are SIGKILLed (outcomes logged as `killed`/`reused`/`gone`). A pid whose start time can't be read on either side fails toward kill. The on-disk format is `{ "procs": [{ "pid", "startTime" }] }`; a legacy `{ "pids": [...] }` file is still read (start time null => fail-toward-kill).
5. The client's persisted jobs in localStorage send `rehydrate_workflows` on reconnect; server replays from `events.jsonl`.

Result: all tabs survive a server restart with full chat history. Live in-flight turns are lost (the worker is dead), but the operator sees the partial chat and can resend.

**Rewinding a conversation (Claude Native).** The HISTORY tab's **REWIND CONVERSATION** action (REWINDS filter) moves the live head back to a chosen point and forks: the server appends a `leaf_move` event and sets `meta.leafSeq`, and the next turn forks a child of that point. The prior branch is kept and can be returned to ("undo the undo" is just another rewind). Native-first  - `revert_to_point_request` is rejected on the CLI / Codex transports. A rewind that can't be replayed byte-identically is surfaced as a reconstructed transcript rather than silently mangled. See [`PERSISTENCE.md`](PERSISTENCE.md).

---

## Recovering stuck states

### Composer stuck in queue mode but turn appears done

The diagnostic chip (`b / w / s` next to CANCEL) tells you which flag is stuck:

- `b1 / w0 / s0` -> server `busy` is stuck. Most likely cause: a turn-end frame was dropped or a worker silently exited. Click CANCEL  - the server's `handleCancel` unconditionally broadcasts `turn_cancelled` + `primary_turn_ended` as the escape hatch, and the client-side `recordTurnCancelled` defensively clears `busy`.
- `b0 / w>=1 / s0` -> a sub-worker (Review/Handoff summarizer) is stuck in `running`/`spawning`. Check the Review or Handoff tab  - there's probably an in-flight one. Cancel it via that tab's controls, or restart the server.
- `b0 / w0 / s1` -> a chat message has `isStreaming: true` and the closing event was never matched. CANCEL clears it; otherwise restart the server.

### Whole UI stuck on SYNCING overlay

The WS connected but a persisted job hasn't received its `workflow_state_snapshot`. Almost always because the server is taking too long to load the workflow's `events.jsonl` (large file). Wait 10-20 seconds. If it persists, check the server log for errors loading the workflow.

### "Concurrent writer detected" warning

A foreign `claude --resume <uuid>` terminal is writing to a session Arco has open. Arco refuses new turns for 60 seconds. Recover by Handoff  - rotate to a fresh session. Don't try to interleave writes; that's the corruption pattern the guard exists to prevent.

### Workflow is gone from the tab list but still on disk

Either the operator clicked Remove (the workflow directory was deleted), or `known-cwds.json` was hand-edited / removed. To re-add: open a fresh tab for the same cwd; if the workflow has any sessions on disk, the Resume picker will surface them.

### Cursor answers "Please sign in to continue"

A long-lived `cursor-agent acp` child keeps the credentials (and CLI binary) it started with, so a fresh `cursor-agent login` or CLI update doesn't reach an already-running tab. Arco recognizes that exact reply, shows the `[AUTH:cursor]` re-login card instead of the bubble, and retires the cached worker; after logging in, resend  - the next turn starts a current process and resumes the ACP session where Cursor allows.

### Worker output exceeds the output cap

Worker is force-settled and a truncation notice appears. The cap is per-turn  - next turn isn't affected. The default is **50 MB** of text output; raise it with `ARCO_MAX_WORKER_OUTPUT_BYTES` (values below 1 MB are ignored). This is distinct from the tree-RSS *memory* kill (`ARCO_RSS_KILL_BYTES`, default 32 GB), which a workflow doing known-huge work can opt out of with `disableRssGuard: true` in its `meta.json`  - that flag skips only the RSS kill, never the output cap.

### Server log shows ENOENT on `/proc/...`

Activity probe fired against a process that already exited. Harmless  - `processActivity.ts` handles ENOENT gracefully and reports the process as dead.

### Vite client hot-reload broke chat

The client's WS connection probably reconnected against a different server process (you ran a server restart while the client was open). Reload the page; the `rehydrate_workflows` flow will catch the client up.

### Stuck-worker breaker fires (`worker_stuck` / `system_notice`)

The stuck-worker breaker (`server/src/workers/stuckBreaker.ts`, section3.1) watches the tool stream for ERROR PERSISTENCE  - the same tool call returning the same *failing* result over and over with no success interleaved. It's deterministic (a counter keyed on the tool name + `outputHash`, not a model judging quality), so it's distinct from the C1 `stuck` runtime pill (which is just 30s of no primary output).

- At 3 identical failing calls in a row it emits a `worker_stuck` event (`escalation: 'detected'`, `recommendedAction: 'nudge'`) plus a `system_notice`: "Stuck-worker breaker: `<tool>` returned the identical failing result 3x in a row...".
- At 5 it escalates to `escalation: 'persist'` / `recommendedAction: 'pause'` and recommends a **reversible pause**  - it never kills or prompts the worker.
- Any success, a different tool signature, or your next operator turn clears the latch (`escalation: 'recovered'`).

What to do: read the `system_notice`  - the worker is repeating a failing command (bad path, missing dep, wedged service). Change the approach in your next prompt; that turn also clears the latch.

### Project CLAUDE.md / skills / settings aren't being applied

The project-trust gate (`server/src/projectTrust.ts`) suppresses a repo's project-local `CLAUDE.md`, project skills, and `<cwd>/.arco/settings.json` from the agent's system prompt until you explicitly trust the repo  - a cloned repo can otherwise inject instructions into your agent the moment you point a tab at it. When a cwd is untrusted, the composer shows an inline **WARNING UNTRUSTED PROJECT** banner listing the suppressed resources with **> TRUST** / **NEVER** buttons. The first turn runs with the resources suppressed; clicking TRUST records the decision in `~/.arco/trust.json` (keyed by canonical absolute path, deepest recorded ancestor wins) and folds them in on the **next** turn. Reversible  - edit or delete the entry in `trust.json` by hand. Default posture is `ask`; a global `defaultProjectTrust` (`ask`/`always`/`never`) in `~/.arco/settings.json` changes it, resolved from user/global scope only so a cloned repo can't self-grant trust.

### A tab is parked on a review gate

With `reviewSafeMode` armed (CONFIG, default OFF, Claude Native only), a sensitive tool call (any `Bash` command, a git-destructive command, a write outside the cwd) is not run  - it parks as a `gate_required` and surfaces an editable approval card. The worker waits until you approve / edit-then-approve / reject (`gate_reply`) or revoke a standing approval (`gate_revoke`). Parked gates are durable: a server restart re-surfaces any unresolved gate from `<cwd>/.arco/workflows/<wfid>/gate-approvals.json` (via `rehydrateGatesOnce`), and standing "approve all like this" approvals survive too. If a tab looks stuck with no output, check for a pending gate card before cancelling. See [`PRIMITIVES.md`](PRIMITIVES.md).

---

## Disk usage

`<cwd>/.arco/workflows/<wfid>/events.jsonl` grows append-only. There's no automatic rotation. At the 100 MB rotation cap (a soft target, not enforced), the on-disk file may be manually trimmed  - but Arco never does this automatically.

If a workflow's events.jsonl gets unwieldy:
- Use Handoff to rotate the session (the new session has a fresh events.jsonl).
- Or manually trim the file to keep only the latest N MB; the snapshot-only fallback handles the case where the client's `lastSeq` falls below the new `firstSeq`.

Saved Chat tabs live under `~/.arco/chats/<wfid>/`; closing a chat tab does not delete it (it stays in PAST CHATS). Removing a chat's directory while Arco is stopped deletes it for good. Incognito chats never write there.


---

## Remote access

Arco is designed for local-dev or single-forwarded-port remote access:

```bash
# On the Arco host:
npm run dev

# On the remote machine, via SSH:
ssh -L 5173:localhost:5173 <ssh-target>

# Then open http://localhost:5173 locally
```

Only port 5173 needs forwarding  - Vite proxies WS and API to the server. **Do not forward port 3001 directly** unless you're aware that the WS endpoint has no auth.

The server binds `127.0.0.1` by default (`ARCO_HOST`, see [environment variables](#environment-variables)). The HTTP surface exposes filesystem read/list endpoints, an `/upload` sink, and a `/api/github/*` proxy that piggybacks on the local `gh` token  - none of it is authed. Loopback binding makes accidental LAN exposure impossible. Override to `0.0.0.0` only if you're putting Arco behind your own auth-enforcing reverse proxy.

The auth model assumes single-operator local-only usage. Multi-user / public deployment isn't supported.

---

## llama.cpp manager lifecycle

`llamacppManager` (`server/src/providers/llamacppManager.ts`) is a **singleton** that owns at most one running `llama-server` process at a time. Key lifecycle points:

- **Lazy spawn**  - the server starts without loading any model. The first `ensureLoaded(alias)` call (from a workflow turn or the explicit `POST /api/llamacpp-load`) spawns `llama-server` with the alias's registered arguments and blocks until `/health` passes.
- **Alias switch**  - calling `ensureLoaded` with a different alias SIGTERMs the running process before spawning the new one. The previous model is evicted from VRAM first.
- **Idle unload**  - after a configurable idle period (default: 10 minutes without a turn, matching Ollama's KEEP_ALIVE; override via `ARCO_LLAMACPP_KEEPALIVE_MS`), the manager sends SIGTERM to `llama-server` and records state as `idle`. The next turn respawns it.
- **Orphan reaping**  - if the server restarts while a `llama-server` was running, the orphan's PID is in `~/.arco/worker-pids.json`. `reapOrphanWorkers()` at boot SIGKILLs it so ports aren't held.
- **Version + mtime cache**  - `llama-server --version` output is cached alongside the binary's mtime; if the binary changes on disk the cache is invalidated on next use.

The `POST /api/llamacpp-load?alias=<name>` endpoint provides the operator-facing preload path. `POST /api/llamacpp-unload` forces immediate eviction without waiting for the idle timer.

---

## Codex app-server lifecycle

The Codex `appserver` transport (`server/src/providers/codex-appserver/`) keeps a **long-lived `codex app-server` process per tab**. Each workflow tab on `appserver` transport gets its own child process that persists across turns (vs the `exec` transport which spawns a new `codex exec --json` per turn).

- **Spawn**  - on the first turn for the workflow (or after a transport switch), a `codex app-server` child is launched and a JSON-RPC connection is established.
- **Recycling**  - the long-lived child is replaced (old process killed, new one spawned) when its bootstrap signature changes: cluster membership or codebase-memory attachment (the MCP signature, `computeMcpSignature`), the Codex context policy / resolved catalog window, or  - for cluster members  - the role/model that feeds `developerInstructions`. The Codex thread survives via `thread/resume` on the next turn.
- **Crash recovery**  - a circuit breaker in the dispatcher tracks consecutive crashes. After a threshold of failures, the transport falls back to `exec` for that workflow and surfaces a toast. The operator can re-enable `appserver` from CONFIG.
- **Handoff / Review seeds**  - always run on the `exec` transport regardless of the workflow's configured transport.
- **Shutdown**  - `handleRemoveWorkflow` and server shutdown both call the child's kill path. The `appserver` transport's long-lived process is **not** a subprocess of tsx-watch's parent, so it doesn't die automatically on `tsx watch` restart  - `reapOrphanWorkers()` is the fallback.

---

## Preview tab port discovery

The PREVIEW tab binds a workflow's `set_preview_port` to the per-workflow `/api/preview/<wfid>/` proxy. Port discovery has two paths:

- **`GET /api/preview/listening`**  - Linux-only. Walks `/proc/net/tcp{,6}` for LISTEN sockets, then reverse-resolves PIDs by scanning `/proc/<pid>/fd/`. Returns `{ entries: Array<{ port, pid, command }> }`. Excludes Arco's own PID. On macOS or non-Linux kernels returns `[]`  - the operator must set the port manually (via the PREVIEW tab's manual BIND input).
- **`GET /api/preview/probe?port=<n>`**  - platform-independent liveness check. Used when the operator clicks a RECENT history pill: if the upstream is dead the UI shows a "service no longer running" modal with the listening-processes list so the operator can rebind.

If your workflow's dev server is on a non-standard port and `/api/preview/listening` returns empty (macOS), paste the port directly into the PREVIEW tab's BIND input.

---

## Tool-output filtering with rtk

`rtk` (`rtk-ai/rtk`) is an optional Rust binary that hooks into Claude Code's `PreToolUse` event and rewrites noisy tool inputs (`git status`, `cargo test` on green, `npm install`, etc.) into compact, model-friendly forms. It works on every Claude Code surface that honors `~/.claude/settings.json`  - including Arco's Claude CLI tabs and (after Phase B0) Arco's Claude Native tabs.

**Install:**

```bash
cargo install rtk         # or download a release binary, ensure it's on PATH
rtk --version             # verify
```

**Wire it into `~/.claude/settings.json`:**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Read|Grep",
        "hooks": [
          { "type": "command", "command": "rtk hook" }
        ]
      }
    ]
  }
}
```

**Verify it's firing in Arco:**

1. Open the ACTIVITY tab -> "TOKEN USAGE" section.
2. Run a tab through a few turns that exercise `git status` or `cargo test`.
3. Check `events.jsonl` (under `<cwd>/.arco/workflows/<wfid>/events.jsonl`) for `hook_rewrote_input` entries  - each one names the hook command (`rtk hook`), the original input, and the rewritten input.
4. Compare `toolResultBytes` on the `primary_turn_token_usage` entries before vs. after enabling rtk; rtk-rewritten Bash calls produce smaller tool_results so `toolResultBytes` should drop on green-path runs.

Arco does **not** auto-install rtk into per-workflow config. Operator opts in once at the user level. Arco does not bundle rtk.

---

## Installing `codebase-memory-mcp`

External MCP servers are installed independently and can be attached per tab; Arco does not download or bootstrap them. See `docs/MCP_REGISTRY.md` for configuration.

**Install:**

```bash
# 1. Download the latest release for your platform from upstream and place
#    it on $PATH (rename / move to wherever you keep operator binaries).
# 2. CRITICAL  - install with --skip-config so the binary does NOT auto-edit
#    your ~/.claude/settings.json (or other agent config files). Arco
#    drives the per-workflow MCP wiring itself; the binary's auto-edit
#    behavior would conflict with that.
codebase-memory-mcp install --skip-config

# 3. Verify it's on PATH:
which codebase-memory-mcp
codebase-memory-mcp --version
```

**Hard invariant  - `--skip-config`.** The binary's default install behavior auto-edits agent config files (`~/.claude/settings.json` and similar). Arco ALWAYS invokes it with `--skip-config` (the server's one-shot reindex spawn and the deferred F9 spawn-site wiring both hard-code the flag). If you run any `codebase-memory-mcp <subcommand>` manually for diagnostics, append `--skip-config` to keep the invariant. See `docs/GOTCHAS.md section Efficiency`.

**Verifying inside Arco:**

1. Open a Native Claude tab in any cwd. CONFIG tab -> scroll to `INDEXES & MEMORY`.
2. Type an absolute index path (defaults to the workflow's cwd) and check "Attach codebase memory to this tab." A `codebase_memory_state{attached: true}` lands on the WS; the box stays checked across reload.
3. Click **Re-index now.** If the binary is on PATH, the spawn returns 200 + a fresh status line ("Indexed: N files  /  last sync just now"). If it's missing, a top-right toast reads "codebase-memory-mcp not installed  - see docs/OPERATIONS.md."
4. The FILES tab includes a `FILES | BLAST RADIUS` sub-tab nav when memory is attached. The Blast Radius panel renders `detect_changes` output against the current `git diff`.

**Diagnostics.** The reindex endpoint logs to the server console (`[arco] [<wfid>] codebase-memory attached -> <path>`). Failures land in `events.jsonl` via the `codebase_memory_state` broadcast. If the binary fails after a successful install, run `codebase-memory-mcp reindex --path <p> --skip-config` directly to confirm the binary works outside Arco's spawn.

---

## Cross-references

- Build / dev workflow + how to add a provider: [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
- Persistence layout: [`PERSISTENCE.md`](PERSISTENCE.md)
- Server lifecycle internals: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- "Don't regress" invariants: [`GOTCHAS.md`](GOTCHAS.md)
