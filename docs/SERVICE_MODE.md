# Production service mode

How packaged and source installations run Arco as a per-user background service
on Linux, macOS, and Windows.

## Packaged service

The npm package provides the normal service path on all three platforms:

```sh
npm install -g arco-workbench
arco setup
```

`arco setup` asks before installing the service and creating a per-user
application shortcut, starts the service, and opens the local URL. Run
`arco open` to start a stopped service and open a Chromium app window with an
Arco-owned browser profile. The profile retains its own microphone permission.
`arco open --tab` opens the default browser instead. If no supported Chromium
browser is found, `arco open` reports the fallback and opens a normal tab.

Automatic search order for the app window:

| System | Browsers, first found wins |
| --- | --- |
| Windows | Edge, Chrome, Brave, Vivaldi, Chromium (App Paths registrations, then Program Files, Program Files (x86) and the per-user `%LOCALAPPDATA%` installs) |
| macOS | Chrome, Edge, Brave, Chromium, Vivaldi (`/Applications`, then `~/Applications`) |
| Linux | `google-chrome`, `microsoft-edge`, `brave-browser` or `brave`, `chromium`, `vivaldi` on `PATH` (with their `-stable` and `-browser` names), then Flatpak installs of Chrome, Edge, Brave, Chromium and Vivaldi |

A Flatpak browser is found through its exported launcher in
`/var/lib/flatpak/exports/bin` or `~/.local/share/flatpak/exports/bin` and runs
with `flatpak run`, which gives it access to the Arco browser profile folder.

To choose the browser, use **Settings > Advanced > App window browser**
(Automatic, a detected browser, or another program name or path), or
`arco open --browser <name-or-path>` for one launch. Names are `chrome`,
`edge`, `brave`, `vivaldi` and `chromium`, a Flatpak id such as
`com.brave.Browser`, or a program on `PATH`. The setting is stored in
`settings.json` in the Arco home and also applies to the shortcut and the
explorer window. A chosen browser that is not found falls back to Automatic
with a message. In a non-Chromium browser, the page shows a one-time notice
with CHOOSE BROWSER and DISMISS.
The shortcut appears in the Windows Start menu, macOS Applications, or the
Linux application menu. Run `arco shortcuts add` or `arco shortcuts remove`
to manage it. A modified shortcut is left in place for manual review. The
window and taskbar or Dock can still show the browser icon, depending on the
browser and desktop environment.

Direct service commands are:

| Command | Effect |
| --- | --- |
| `arco service install` | Install the per-user service |
| `arco service uninstall` | Stop and remove the service and its shortcut |
| `arco service start` | Start the service |
| `arco service stop` | Stop the service |
| `arco service restart` | Stop and start the service |
| `arco service status` | Show supervisor status |
| `arco service logs` | Print recent logs (on Windows also the raw output files) |
| `arco service refresh` | Linux and Windows: update an unmodified Arco-owned service definition |

| Platform | Installed definition |
| --- | --- |
| Linux | systemd user unit `arco.service` |
| macOS | LaunchAgent `arco-workbench.plist`, label `arco-workbench` |
| Windows | Task Scheduler logon task `arco-workbench` |

`ARCO_HOME`, `ARCO_PORT`, `ARCO_HOST`, and the other supported service
environment values are saved at first install. Reinstalling an owned definition
keeps that configuration. Arco refuses an existing definition it does not own
and refuses to operate on an owned definition that was modified afterward.

On Linux, the Arco home used as the service working directory must be an absolute path without whitespace, control characters, or quotes. `arco service refresh` updates an unmodified Arco-owned unit and reloads systemd. Future package updates refresh the unit before restarting it. An edited unit is left untouched.

For an affected 0.1.3 Linux installation, its updater cannot refresh the older unit and may roll back when restarting fails. Install the newer package with `npm install -g arco-workbench`, then run `arco service refresh` and `arco service start`.

The package uses port 3001 when available, then the next available port through
3099, and finally an operating-system-assigned port. A selected port is saved
and reused. If it becomes unavailable, the next start selects a free port,
records the change in the service log, and shows a notice in the workbench.
`arco open` and shortcuts follow the saved port. `arco doctor` reports its
status. An explicit `ARCO_PORT` is also allowed to move if occupied.

On Windows the task starts Node through `wscript.exe` running a small JScript
launcher (`service/launch.js` in the Arco home, written at install), which
starts Node with a hidden window and waits for it, so no console window
appears. JScript is used because VBScript is being retired from Windows 11.
`conhost.exe --headless` and a logon type that hides windows (S4U, which would
change which profile and desktop the providers see) were rejected: the first
does not start a child process on hosted runners and the second changes the
user context. Ending the task terminates only the launcher, so `arco service stop`,
`restart` and `uninstall` also end matching `wscript.exe` and `node.exe`
processes only when the command line identifies `arco.mjs service-run` and
this home's `service/config.json`, with their child processes. If the stop
cannot be verified, the update refuses to replace the package. Another home's Arco and a source-checkout service are not touched. Raw output goes to `service.stdout.log` and
`service.stderr.log` in the Arco log directory (5 MiB each, one rotated copy),
beside the structured `arco.log`; `arco service logs` prints all three.
`arco update` and UPDATE AND RESTART rewrite an unmodified Arco-owned task
definition from older installs; the service also does it at start, which takes
effect at the next start.

Packaged services offer **UPDATE AND RESTART** on Linux, macOS, and Windows.
The terminal equivalent is `arco update`. See
[Updating Arco](OPERATIONS.md#updating-arco).

## Source-checkout service

Linux contributors can run the compiled server under the source
`npm run arco:service` systemd user unit. The dev launcher `scripts/arco`
remains separate and runs `npm run dev`.

Install and first-run: [README](../README.md) and [Getting started](GETTING_STARTED.md).
Run/stop/recover: [Operations](OPERATIONS.md). HTTP endpoints: [HTTP API](HTTP_API.md).

## Source service files

| Piece | Path |
| --- | --- |
| CLI entry | `scripts/arco-service.ts` (`npm run arco:service -- <command>`) |
| Pure unit-render and arg-parse | `scripts/service/unit.ts` (`parseServiceArgs`, `renderSystemdUnit`) |
| Static-serve fallback | `server/src/http/router.ts` (gated on `ARCO_SERVE_CLIENT=1`) |
| Liveness / readiness endpoints | `server/src/http/router.ts` (`/healthz`, `/health` alias, `/readyz`) |
| Readiness state singleton | `server/src/server/readiness.ts` (`markReady` / `isReady` / `readinessSnapshot`) |
| systemd unit (written by `install`) | `~/.config/systemd/user/arco.service` (respects `XDG_CONFIG_HOME`) |
| Smoke (arg-parse + unit-gen, no live install) | `scripts/smoke/service-cli.ts` via `npm run smoke:service-cli` |

## Source Linux service CLI

| Command | Effect |
| --- | --- |
| `npm run arco:service -- install [--enable]` | Build, write the unit, `daemon-reload`; `--enable` also enables on login |
| `npm run arco:service -- start` | `systemctl --user start arco` |
| `npm run arco:service -- stop` | `systemctl --user stop arco` |
| `npm run arco:service -- status` | `systemctl --user status arco` |
| `npm run arco:service -- logs [-n N]` | Tail `~/.arco/logs/arco.log` (last N lines optional) |
| `npm run arco:service -- logs --journal [-n N]` | `journalctl --user -u arco -f` |
| `npm run arco:service -- uninstall` | Stop, disable, remove unit, `daemon-reload` |

These source-checkout actions are Linux-only through the root `arco:service`
package script. This source CLI has no `restart` action.

- `install` runs `npm run build` first so `server/dist/index.js` and
  `client/dist` exist, writes the unit, and runs `systemctl --user daemon-reload`.
  Pass `--enable` to also `systemctl --user enable` so Arco starts on next login.
  It does not auto-start; run `npm run arco:service -- start`.
- `ARCO_PORT` and `ARCO_HOST`, when set in the install-time shell, are written
  into the generated unit. Example:

```sh
ARCO_PORT=3002 npm run arco:service -- install --enable
```

- All actions shell out with `execFile`/`spawn` argv arrays: never `shell:true`,
  never `sudo`. A `--user` unit needs neither.
- Unit-rendering and arg-parsing live in pure importable functions
  (`scripts/service/unit.ts`) so the smoke can assert without touching
  `systemctl`.

## The systemd `--user` unit

`install` renders this to `~/.config/systemd/user/arco.service`, with `<repo>`
replaced by the absolute path of the checkout:

```ini
[Unit]
Description=Arco - multi-provider coding workbench
Documentation=<repository-url>
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=<repo>
ExecStart=node <repo>/server/dist/index.js
Environment=ARCO_SERVE_CLIENT=1
Environment=NODE_ENV=production
Environment=ARCO_LOG_FILE=1
Environment=NODE_OPTIONS=--dns-result-order=ipv4first
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

Load-bearing details:

- **`ExecStart` runs the compiled server** (`node server/dist/index.js`): never
  `tsx`, never `npm run dev`.
- **`Environment=ARCO_SERVE_CLIENT=1`** enables the in-process static-serve
  fallback (see below).
- **`Environment=ARCO_LOG_FILE=1`** turns on structured file logging (see
  [Logs](#logs)). Off in dev, so `npm run dev` is unchanged.
- **`Environment=NODE_OPTIONS=--dns-result-order=ipv4first`** makes spawned
  provider CLIs (claude/codex are separate Node processes that inherit it)
  prefer IPv4. The server's own process already hard-blocks IPv6 in code
  (`server/src/net/forceIpv4.ts` forces `dns.lookup` to family 4; a v6 usage
  fetch once crash-looped the service into a permanent "SERVER DOWN"). This
  line is the belt for the children.
- **`Restart=on-failure` + `RestartSec=3`** brings the service back a few
  seconds after a crash.
- **`StartLimitIntervalSec=60` + `StartLimitBurst=5`** (in `[Unit]`, where
  systemd requires them) bound a crash-loop: more than 5 failures in 60s and
  systemd stops respawning (`failed`) instead of hammering forever.
- **`WantedBy=default.target`** because a `--user` unit has no
  `multi-user.target`.
- `ARCO_PORT` / `ARCO_HOST` are added as `Environment=` lines only if set in
  the shell at install time; otherwise the server defaults apply (`3001` /
  `127.0.0.1`).
- **`ARCO_HUB_URL` and `ARCO_NTFY_URL`** are baked into the unit only when set
  at install time. Configure them to link the service to a management hub and
  optional notification transport. If omitted, hub and ntfy integrations remain
  inactive. Use private-network URLs and keep topic values out of tracked files.
  See [Remote management](REMOTE_MANAGEMENT.md) and
  [Notifications](NOTIFICATIONS.md).

```bash
ARCO_HUB_URL=ws://<management-hub>:<port> \
ARCO_NTFY_URL=https://<notification-server>/<topic> \
  npm run arco:service -- install --enable
```

### Restart-on-crash

`Restart=on-failure` restarts the process when it exits non-zero (crash), not
on a clean stop. The unit also sets explicit crash-loop bounds:
**`StartLimitIntervalSec=60` + `StartLimitBurst=5`** in `[Unit]`, so a process
that dies immediately on boot is respawned at most 5 times in 60s before
systemd gives up (the unit enters `failed`) instead of hammering the provider
APIs forever. `npm run arco:service -- status` shows the current state and
restart count.

### Logs

Service mode writes structured JSONL to an Arco-owned, size-rotated file in
addition to stdout:

| Knob | Env var | Default |
| --- | --- | --- |
| Enable file logging | `ARCO_LOG_FILE=1` | off (set by the unit; off in dev) |
| Log directory | `ARCO_LOG_DIR` | `~/.arco/logs` |
| Rotate at | `ARCO_LOG_MAX_BYTES` | `5242880` (5 MB) |
| Files to keep | `ARCO_LOG_KEEP` | `5` |

The file lives at `<ARCO_LOG_DIR>/arco.log`. Each line is
`{"ts":"<ISO>","level":"info|warn|error","msg":"...", ...fields}`. When the
live file would exceed `ARCO_LOG_MAX_BYTES` it rotates
(`arco.log` -> `arco.log.1` -> ... -> `arco.log.<keep>`, oldest dropped),
bounding disk use.

**Console tee, not call-site migration.** The server has hundreds of
`console.*` call sites; rather than rewrite them,
`server/src/server/logger.ts` monkeypatches `console.log`/`warn`/`error` at
boot so each call still writes to stdout (journald keeps capturing it) and
appends one structured line to the file. Gated entirely on `ARCO_LOG_FILE=1`
(or an explicit `ARCO_LOG_DIR`): when neither is set (the default, including
`npm run dev`), the logger installs nothing and console is untouched. Logging
is best-effort: a write failure is swallowed so it can never crash the server.

Tailing:

```bash
npm run arco:service -- logs [-n N]            # tail -n N -f ~/.arco/logs/arco.log
npm run arco:service -- logs --journal [-n N]  # journalctl --user -u arco -f (Linux/systemd)
```

The default file tail is cross-platform (`tail -f`), unlike `journalctl`. If
the log file does not exist yet, `logs` prints a note
(`no log file at <path> - is the service running with ARCO_LOG_FILE=1?`) and
exits 0. `--journal` follows the systemd journal instead (on macOS it prints
the manual-run notice). The dev launcher's separate flat-file log at
`$XDG_CACHE_HOME/arco/arco.log` is unrelated.

The structured-log status also surfaces in the A1 diagnostics report as the
`core.logs` check: `ok` with the active path and current size when file logging
is on, `skipped` when it is off (dev / `ARCO_LOG_FILE` unset).

## The `ARCO_SERVE_CLIENT` env gate

In development, Vite on 5173 owns the client and proxies `/ws` and `/api/*` to
the server on 3001. In production there is no Vite; the server must serve the
built bundle itself.

`server/src/http/router.ts` serves `client/dist` as a static-file fallback only
when `process.env.ARCO_SERVE_CLIENT === '1'`. The gate is an explicit opt-in
(not keyed on `NODE_ENV`) set by the systemd unit:

- **Unset (the default, including `npm run dev`):** behavior is unchanged. The
  server returns its normal 404 for unmatched non-API routes and Vite owns the
  client.
- **`=1`:** for unmatched `GET` requests the server resolves the path against
  `client/dist`, serves the file with the right `Content-Type`, and falls back
  to `index.html` (with `Cache-Control: no-store`) for unmatched non-asset
  paths so the SPA router works on deep links. Path traversal is blocked (the
  resolved path must stay within `client/dist`). If `client/dist` does not
  exist, it falls through to the existing 404 rather than crashing.

The fallback runs after every API/preview route and before the final 404, so it
can never shadow an Arco endpoint.

## Build and `@arco/shared` resolution (load-bearing)

The compiled server can only boot if `@arco/shared` resolves to compiled JS,
not its `.ts` source. Otherwise `node server/dist/index.js` dies on the first
`import` with `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"`. The
monorepo serves both development (live `.ts`) and production (compiled `dist`)
from one package via conditional `exports` in `shared/package.json`:

```jsonc
"exports": {
  ".": {
    "development": "./src/index.ts",  // Vite serve + `tsx --conditions development`
    "types":       "./src/index.ts",  // tsc (moduleResolution: bundler) -> live source types
    "import":      "./dist/index.js",  // bare `node` ESM (production / arco service)
    "default":     "./dist/index.js"
  }
}
```

Load-bearing rules (do not regress these or the service crash-loops on boot):

- **`shared/package.json` must keep this `exports` map** (and `main`/`types`
  pointing at `dist`). The `default`/`import` branch is what lets bare `node`
  load compiled JS.
- **The server development script passes `--conditions development`**
  (`tsx watch --conditions development src/index.ts`) so `npm run dev` keeps
  resolving the live `.ts` source. The `test:*` scripts pass it too
  (`node --conditions development --import tsx ...`). Vite 6 selects the
  `development` condition automatically in serve mode; `vite build` gets
  `dist`.
- **`install` runs `npm run build` first**, which builds `shared/dist` before
  the server boots. A service started against a stale or absent `shared/dist`
  will fail to import.

This is verified by booting `node server/dist/index.js` in
`scripts/smoke/service-cli.ts`'s sibling check and by `npm run build` plus a
manual boot. If you change shared's packaging, re-run
`ARCO_SERVE_CLIENT=1 node server/dist/index.js` and confirm it serves `/`
before relying on service mode.

## Health and readiness

Service mode is supervised, so it ships the two probes a supervisor (systemd, a
load balancer, k8s) wants: liveness and readiness, as separate signals. Both are
unauthenticated `GET`s, route ahead of the static-client fallback, and are never
gated on `ARCO_SERVE_CLIENT` (they work in plain `node server/dist/index.js` and
in development too). Full request/response shapes:
[HTTP API: Liveness and readiness](HTTP_API.md).

- **`GET /healthz` - liveness.** Always `200` once the server is listening
  (the route only runs when it is up):
  `{ status: 'live', version, pid, uptimeSec }`. The `/health` route is a
  back-compat alias returning the same body. Wire it to a systemd
  `ExecStartPost` curl, an uptime monitor, or a load-balancer liveness check.
- **`GET /readyz` - readiness.**
  `200 { status: 'ready', components, pending: [], uptimeSec }` only after boot
  completes; `503 { status: 'not-ready', pending, components }` during the boot
  window (`pending` is emitted on both so the shape is symmetric). Use it for
  "add to pool when ready" or a k8s readiness probe.

**Readiness is exactly two components: `capabilities` + `stores`.** That
mirrors the spec: the provider-capabilities probe (a pre-`listen()` top-level
await, so always done by the time the server is listening) plus workflow-store
recovery from disk (the post-`listen()` async). Best-effort boot prefetches
(settings cascade, model catalogs, recall backfill) are deliberately excluded:
they degrade gracefully and must not hold readiness false. For the same reason,
store recovery marks `stores` ready in a `.finally`, not just `.then`: a
recovery error is failure-isolated and must still flip the gate, or `/readyz`
would never return 200 and systemd/k8s would kill a process that is in fact
serving.

`npm run arco:service -- status` probes the live `/readyz` and prints a
`readiness:` line under the systemd status (for example
`readiness: ready (capabilities, stores)`,
`readiness: NOT READY - pending: stores`, or
`readiness: unreachable (...)` when nothing is serving on the port). The
readiness line is additive and best-effort; it never changes the systemd exit
code (a stopped unit still exits non-zero). It also prints when no unit is
installed (the server may be running via `npm run dev` or a manual
`node dist/index.js`), since readiness is independent of systemd. Readiness also
surfaces in the diagnostics report as the `core.readiness` check (ok when ready,
warn while still booting).

## Reverse-proxy alternative

If you would rather front Arco with nginx/Caddy and let it serve `client/dist`,
you can: run `node server/dist/index.js` (no `ARCO_SERVE_CLIENT`) and point the
proxy's static root at `client/dist`, proxying `/ws` and `/api/*` to the server.
Service mode just bundles the common case (server serves its own client) into
one durable unit.

> **Warning:** The HTTP/WS surface has no user login. It exposes a shell,
> git/GitHub ops, filesystem read+write, and provider credentials, guarded only
> by the browser session cookie and the Host and Origin check. Service mode does
> not change that. Keep the bind loopback (`ARCO_HOST=127.0.0.1`, the default)
> and reach it via SSH/Vite tunnel, or put it behind your own auth-enforcing
> reverse proxy (add its host name to `ARCO_ALLOWED_HOSTS`). See
> [Operations: Exposure posture](OPERATIONS.md#exposure-posture).

## Source checkout on macOS

The source `npm run arco:service` implementation uses systemd and is Linux-only.
On macOS its action subcommands
(`install`/`start`/`stop`/`status`/`logs`/`uninstall`) print a manual-run
pointer and exit 0:

```bash
cd <repo>
npm run build
ARCO_SERVE_CLIENT=1 NODE_ENV=production node server/dist/index.js
```

The source `arco:service` CLI does not install or manage launchd agents. The
hand-maintained procedure below remains a source or legacy contributor option.
Normal package installs use the generated `arco-workbench` LaunchAgent described
above. The source unit-rendering and arg-parsing pure functions still work on
macOS, so the smoke runs cross-platform.

### Hand-maintained launchd service for source checkouts

> **macOS source or legacy path only.** This launchd agent is not generated by
> the source `arco:service` CLI and is not checked into Git. Packaged macOS
> installs use `arco service` and `arco-workbench.plist`.

On a Mac you can run Arco as a production background service via a launchd
agent:

- **Plist:** `~/Library/LaunchAgents/com.arco.app.plist` (label `com.arco.app`).
  Runs the compiled server (`node <repo>/server/dist/index.js`) with
  `ARCO_SERVE_CLIENT=1 NODE_ENV=production ARCO_LOG_FILE=1`, serving the built
  `client/dist` on **http://localhost:3001**. `RunAtLoad` +
  `KeepAlive{SuccessfulExit=false}` starts on boot and restarts on crash.
- **Manage:**

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.arco.app.plist  # load + start
launchctl bootout    gui/$(id -u)/com.arco.app                              # stop + unload
launchctl kickstart -k gui/$(id -u)/com.arco.app                            # restart
curl -s localhost:3001/healthz                                                 # health check
```

- **Logs:** structured `~/.arco/logs/arco.log`; stdout/err
  `~/Library/Logs/Arco/service.{out,err}.log`.

**Update procedure (macOS-specific):** from the checkout, update and then
restart the hand-maintained job:

```bash
npm run arco:update
launchctl kickstart -k gui/$(id -u)/com.arco.app
```

Use the actual job label if the local launchd configuration differs. Updating
rebuilds the compiled server and client; restarting interrupts running turns.

> The launchd service and the development launcher (`scripts/arco`, which runs
> `npm run dev`) both bind `:3001`. They are mutually exclusive. Stop the
> service before using the development launcher.

## Related links

- Run/stop/recover and exposure posture: [Operations](OPERATIONS.md)
- Install and first-run: [README](../README.md), [Getting started](GETTING_STARTED.md)
- HTTP endpoints: [HTTP API](HTTP_API.md)
- The development launcher (`scripts/arco`):
  [Operations: The launcher script](OPERATIONS.md)
- Documentation style: [STYLE](STYLE.md)
