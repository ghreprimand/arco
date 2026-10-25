# Arco — production service mode

Arco normally runs as a dev product (`tsx watch` + Vite via `npm run dev` or the `scripts/arco` launcher). **Service mode** is the boring, restartable, inspectable production runtime: the **compiled** server (`server/dist/index.js`) serves the built client (`client/dist`) itself, supervised by a systemd `--user` unit that restarts it on crash and survives a terminal close.

This is the prerequisite for remote continuation (Tier 4). It is a **separate path** from the dev launcher — `scripts/arco` (start/stop/restart/status/logs against `npm run dev`) is unchanged and still owns local dev.

For the broader run/stop/recover story see [`OPERATIONS.md`](OPERATIONS.md). For HTTP endpoints see [`HTTP_API.md`](HTTP_API.md).

---

## Where it lives

| Piece | Path |
|---|---|
| CLI entry | `scripts/arco-service.ts` (`arco service <command>`) |
| Pure unit-render + arg-parse | `scripts/service/unit.ts` (`parseServiceArgs`, `renderSystemdUnit`) |
| Static-serve fallback | `server/src/http/router.ts` (gated on `ARCO_SERVE_CLIENT=1`) |
| Liveness / readiness endpoints | `server/src/http/router.ts` (`/healthz`, `/health` alias, `/readyz`) |
| Readiness state singleton | `server/src/server/readiness.ts` (`markReady` / `isReady` / `readinessSnapshot`) |
| systemd unit (written by `install`) | `~/.config/systemd/user/arco.service` (respects `XDG_CONFIG_HOME`) |
| Smoke (arg-parse + unit-gen, no live install) | `scripts/smoke/service-cli.ts` → `npm run smoke:service-cli` |

---

## The `arco service` CLI

```bash
arco service install [--enable]   # build + write the unit + daemon-reload (+ enable on login)
arco service start                # systemctl --user start arco
arco service stop                 # systemctl --user stop arco
arco service status               # systemctl --user status arco
arco service logs [-n N]          # tail -f ~/.arco/logs/arco.log [last N lines]
arco service logs --journal [-n N] # journalctl --user -u arco -f  (Linux/systemd)
arco service uninstall            # stop + disable + remove unit + daemon-reload
```

Invoke via `npx tsx scripts/arco-service.ts <command>` (or wire your own `arco service` shim that calls it).

- `install` runs `npm run build` first (so `server/dist/index.js` + `client/dist` exist), writes the unit, and `systemctl --user daemon-reload`s. Pass `--enable` to also `systemctl --user enable` so Arco comes back on next login. It does **not** auto-start — run `arco service start`.
- All actions shell out with `execFile`/`spawn` argv arrays — never `shell:true`, never `sudo`. A `--user` unit needs neither.
- The unit-rendering + arg-parsing logic is in pure, importable functions (`scripts/service/unit.ts`) so the smoke can assert on them without touching `systemctl`.

---

## The systemd `--user` unit

`install` renders this to `~/.config/systemd/user/arco.service`:

```ini
[Unit]
Description=Arco — multi-provider coding workbench
Documentation=https://github.com/ghreprimand/arco
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=%h/Projects/Arco
ExecStart=node %h/Projects/Arco/server/dist/index.js
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

- **`ExecStart` runs the compiled server** (`node server/dist/index.js`) — never `tsx`, never `npm run dev`. Production runs compiled.
- **`Environment=ARCO_SERVE_CLIENT=1`** flips on the in-process static-serve fallback (see below).
- **`Environment=ARCO_LOG_FILE=1`** turns on structured file logging (see [Logs](#logs)). Off in dev, so `npm run dev` is unchanged.
- **`Environment=NODE_OPTIONS=--dns-result-order=ipv4first`** makes the spawned provider CLIs (claude/codex/gemini are separate Node processes that inherit it) prefer IPv4. The server's own process already hard-blocks IPv6 in code (`server/src/net/forceIpv4.ts` forces `dns.lookup` to family 4 — a v6 usage fetch once crash-looped the service into a permanent "SERVER DOWN"); this line is the belt for the children.
- **`Restart=on-failure` + `RestartSec=3`** is the restart-on-crash acceptance: the service comes back a few seconds after a crash.
- **`StartLimitIntervalSec=60` + `StartLimitBurst=5`** (in `[Unit]`, where systemd requires them) bound a crash-loop: more than 5 failures in 60s and systemd stops respawning (`failed` state) instead of hammering forever.
- **`WantedBy=default.target`** because a `--user` unit has no `multi-user.target`.
- `ARCO_PORT` / `ARCO_HOST` are added as `Environment=` lines **only if set** in the shell at install time; otherwise the server's own defaults apply (`3001` / `127.0.0.1`).
- **`ARCO_HUB_URL` / `ARCO_NTFY_URL`** are likewise baked in **only if set** at install time. This is the Tier-5 promotion path: when you promote a hub-linked box, run `install` with both in the env so the durable unit links the management hub and pushes ntfy exactly like the dev launcher's inline env did. Omit them and the compiled server's `initHubLink` / `initNtfyTransport` stay **inert** — a fine single-box install, but offline to the hub and silent on ntfy. Tailnet-only URLs; see [`REMOTE_MANAGEMENT.md`](REMOTE_MANAGEMENT.md) §9/§J2.

  ```bash
  # Promote a hub-linked workstation (both URLs land as Environment= lines):
  ARCO_HUB_URL=ws://<hub-tailnet>:3500 \
  ARCO_NTFY_URL=http://<ntfy-tailnet>:3501/<topic> \
    npm run arco:service -- install --enable
  ```

### Restart-on-crash

`Restart=on-failure` restarts the process when it exits non-zero (crash), not on a clean stop. The unit also sets explicit crash-loop bounds — **`StartLimitIntervalSec=60` + `StartLimitBurst=5`** in `[Unit]` — so a process that dies immediately on boot is respawned at most 5 times in 60s before systemd gives up (the unit enters `failed`) instead of hammering the provider APIs forever. `arco service status` shows the current state and restart count.

### Logs

Service mode writes **structured JSONL** to an Arco-owned, size-rotated file in addition to stdout:

| Knob | Env var | Default |
|---|---|---|
| Enable file logging | `ARCO_LOG_FILE=1` | off (set by the unit; **off in dev**) |
| Log directory | `ARCO_LOG_DIR` | `~/.arco/logs` |
| Rotate at | `ARCO_LOG_MAX_BYTES` | `5242880` (5 MB) |
| Files to keep | `ARCO_LOG_KEEP` | `5` |

The file lives at `<ARCO_LOG_DIR>/arco.log`; each line is `{"ts":"<ISO>","level":"info|warn|error","msg":"…", ...fields}`. When the live file would exceed `ARCO_LOG_MAX_BYTES` it rotates (`arco.log` → `arco.log.1` → … → `arco.log.<keep>`, oldest dropped), bounding disk use.

**Console tee, not call-site migration.** The server has hundreds of `console.*` call sites; rather than rewrite them, `server/src/server/logger.ts` monkeypatches `console.log`/`warn`/`error` at boot so each call still writes to stdout (journald keeps capturing it) **and** appends one structured line to the file. Gated entirely on `ARCO_LOG_FILE=1` (or an explicit `ARCO_LOG_DIR`) — when neither is set (the default, including `npm run dev`), the logger installs nothing and console is untouched. Logging is best-effort: a write failure is swallowed so it can never crash the server.

Tailing:

```bash
arco service logs [-n N]            # tail -n N -f ~/.arco/logs/arco.log  (POSIX; works on macOS)
arco service logs --journal [-n N]  # journalctl --user -u arco -f  (Linux/systemd)
```

The default file tail is cross-platform (`tail -f`), unlike `journalctl`. If the log file doesn't exist yet, `logs` prints a note (`no log file at <path> — is the service running with ARCO_LOG_FILE=1?`) and exits 0. `--journal` follows the systemd journal instead (on macOS it prints the manual-run notice). The dev launcher's separate flat-file log at `$XDG_CACHE_HOME/arco/arco.log` is unrelated.

The structured-log status also surfaces in the A1 diagnostics report as the `core.logs` check — `ok` with the active path + current size when file logging is on, `skipped` when it's off (dev / `ARCO_LOG_FILE` unset).

---

## The `ARCO_SERVE_CLIENT` env gate

In dev, **Vite on 5173 owns the client** and proxies `/ws` + `/api/*` to the server on 3001. In production there is no Vite — the server must serve the built bundle itself.

`server/src/http/router.ts` serves `client/dist` as a static-file fallback **only when `process.env.ARCO_SERVE_CLIENT === '1'`**. The gate is an explicit opt-in (NOT keyed on `NODE_ENV`) set by the systemd unit:

- **Unset (the default, including `npm run dev`):** behavior is 100% unchanged — the server returns its normal 404 for unmatched non-API routes and Vite owns the client.
- **`=1`:** for unmatched `GET` requests the server resolves the path against `client/dist`, serves the file with the right `Content-Type`, and falls back to `index.html` (with `Cache-Control: no-store`) for unmatched non-asset paths so the SPA router works on deep links. Path traversal is blocked (the resolved path must stay within `client/dist`). If `client/dist` doesn't exist, it falls through to the existing 404 rather than crashing.

The fallback runs **after** every API/preview route and before the final 404, so it can never shadow an Arco endpoint.

---

## Build & `@arco/shared` resolution (load-bearing)

The compiled server can only boot if `@arco/shared` resolves to **compiled JS**, not its `.ts` source — otherwise `node server/dist/index.js` dies on the first `import` with `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"`. The monorepo serves both dev (live `.ts`) and prod (compiled `dist`) from one package via conditional `exports` in `shared/package.json`:

```jsonc
"exports": {
  ".": {
    "development": "./src/index.ts",  // Vite serve + `tsx --conditions development`
    "types":       "./src/index.ts",  // tsc (moduleResolution: bundler) → live source types
    "import":      "./dist/index.js",  // bare `node` ESM (production / arco service)
    "default":     "./dist/index.js"
  }
}
```

So the load-bearing rules — **do not regress these or the service crash-loops on boot**:

- **`shared/package.json` must keep this `exports` map** (and `main`/`types` pointing at `dist`). The `default`/`import` branch is what lets bare `node` load compiled JS.
- **The server dev script passes `--conditions development`** (`tsx watch --conditions development src/index.ts`) so `npm run dev` keeps resolving the live `.ts` source. The `test:*` scripts pass it too (`node --conditions development --import tsx …`). Vite 6 selects the `development` condition automatically in serve mode; `vite build` gets `dist`.
- **`install` runs `npm run build` first**, which builds `shared/dist` before the server boots. A service started against a stale/absent `shared/dist` will fail to import.

This is verified by booting `node server/dist/index.js` in `scripts/smoke/service-cli.ts`'s sibling check and by `npm run build` + a manual boot; if you change shared's packaging, re-run `ARCO_SERVE_CLIENT=1 node server/dist/index.js` and confirm it serves `/` before trusting `arco service`.

---

## Health & readiness

Service mode is supervised, so it ships the two probes a supervisor (systemd, a load balancer, k8s) wants — liveness and readiness, as separate signals. Both are unauthenticated `GET`s, route ahead of the static-client fallback, and are **never** gated on `ARCO_SERVE_CLIENT` (they work in plain `node server/dist/index.js` and in dev too). Full request/response shapes: [`HTTP_API.md` § Liveness & readiness](HTTP_API.md).

- **`GET /healthz` — liveness.** Always `200` once the server is listening (the route only runs when it's up): `{ status: 'live', version, pid, uptimeSec }`. The `/health` route is a back-compat alias returning the same body. Wire it to a systemd `ExecStartPost` curl, an uptime monitor, or a load-balancer liveness check.
- **`GET /readyz` — readiness.** `200 { status: 'ready', components, pending: [], uptimeSec }` only after boot completes; `503 { status: 'not-ready', pending, components }` during the boot window (`pending` is emitted on both so the shape is symmetric). Use it for "add to pool when ready" or a k8s readiness probe.

**Readiness is exactly two components: `capabilities` + `stores`.** That mirrors the spec — the provider-capabilities probe (a pre-`listen()` top-level await, so always done by the time the server is listening) plus workflow-store recovery from disk (the post-`listen()` async). Best-effort boot prefetches (settings cascade, model catalogs, recall backfill) are **deliberately excluded**: they degrade gracefully and must not hold readiness false. For the same reason, store recovery marks `stores` ready in a **`.finally`**, not just `.then` — a recovery *error* is failure-isolated and must still flip the gate, or `/readyz` would never return 200 and systemd/k8s would kill a process that is in fact serving.

`arco service status` probes the live `/readyz` and prints a `readiness:` line under the systemd status (e.g. `readiness: ready (capabilities, stores)`, `readiness: NOT READY — pending: stores`, or `readiness: unreachable (...)` when nothing is serving on the port). The readiness line is additive and best-effort — it never changes the systemd exit code (a stopped unit still exits non-zero). It also prints when **no unit is installed** (the server may be running via `npm run dev` or a manual `node dist/index.js`), since readiness is independent of systemd. Readiness also surfaces in the A1 diagnostics report as the `core.readiness` check (ok when ready, warn while still booting).

---

## Reverse-proxy alternative

If you'd rather front Arco with nginx/Caddy and let it serve `client/dist`, you can: run `node server/dist/index.js` (no `ARCO_SERVE_CLIENT`) and point the proxy's static root at `client/dist`, proxying `/ws` + `/api/*` to the server. Service mode just bundles the common case (server serves its own client) into one durable unit.

> The HTTP/WS surface has **no auth** and exposes a shell, git/GitHub ops, filesystem read+write, and provider credentials. Service mode does not change that — keep the bind loopback (`ARCO_HOST=127.0.0.1`, the default) and reach it via SSH/Vite tunnel, or put it behind your own auth-enforcing reverse proxy. See [`OPERATIONS.md` § Exposure posture](OPERATIONS.md).

---

## macOS

systemd is Linux-only. On macOS the action subcommands (`install`/`start`/`stop`/`status`/`logs`/`uninstall`) print a manual-run pointer and exit 0:

```bash
cd <repo>
npm run build
ARCO_SERVE_CLIENT=1 NODE_ENV=production node server/dist/index.js
```

launchd support is a later K-tier add. The unit-rendering + arg-parsing pure functions still work on macOS, so the smoke runs cross-platform.

### Hand-maintained launchd service (macOS-specific)

> **macOS only.** This section describes a launchd agent that is *not* generated by the `arco service` CLI (which no-ops on macOS) and is *not* checked into git. It is hand-maintained per-machine. On Linux use the systemd unit above instead.

On a Mac you can run Arco as a production background service via a launchd agent:

- **Plist:** `~/Library/LaunchAgents/com.example.arco.plist` (label `com.example.arco`). Runs the **compiled** server (`node <repo>/server/dist/index.js`) with `ARCO_SERVE_CLIENT=1 NODE_ENV=production ARCO_LOG_FILE=1`, serving the built `client/dist` on **http://localhost:3001**. `RunAtLoad` + `KeepAlive{SuccessfulExit=false}` → starts on boot, restarts on crash.
- **Manage:**
  ```bash
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.arco.plist  # load + start
  launchctl bootout    gui/$(id -u)/com.example.arco                              # stop + unload
  launchctl kickstart -k gui/$(id -u)/com.example.arco                            # restart
  curl -s localhost:3001/healthz                                                 # health check
  ```
- **Logs:** structured `~/.arco/logs/arco.log`; stdout/err `~/Library/Logs/Arco/service.{out,err}.log`.

**Update procedure (macOS-specific — run after every `git pull`):** the service runs compiled `dist/`, so source changes are invisible until you rebuild.

```bash
cd <repo>
npm install                                          # only if manifests changed
npm run build                                         # shared + server + client → dist/
launchctl kickstart -k gui/$(id -u)/com.example.arco   # restart on the new dist
curl -s localhost:3001/healthz                        # confirm: {"status":"live",...}
```

> The launchd service and the `Arco - Dev.app` launcher (which runs `npm run dev`) both bind `:3001` — they are **mutually exclusive**. Stop the service before using the dev launcher.

---

## Cross-references

- Run/stop/recover + exposure posture: [`OPERATIONS.md`](OPERATIONS.md)
- HTTP endpoints: [`HTTP_API.md`](HTTP_API.md)
- The dev launcher (`scripts/arco`): [`OPERATIONS.md` § The launcher script](OPERATIONS.md)
