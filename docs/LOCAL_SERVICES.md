# Local Services

Local Services discovers listening development servers and provides a
machine-wide System modal tab to open, copy URLs, stop, pin, and group services
by project. It uses the `GET /api/services` and `DELETE /api/services/:pid`
endpoints and the preview proxy for Live Preview links.

The read-only service list shows listening local ports and maps each to its
process, working directory, and framework. Available actions include opening a
service URL, copying it, stopping the process, and pinning the service.

## Provenance

The discovery implementation uses TypeScript and Arco's existing HTTP server.
Framework signatures, web-process markers, port rules, and project-name
heuristics are preserved from the earlier implementation. The Python/FastAPI
server, GTK application, launcher, and `psutil` dependency are not part of Arco.

## Where it lives

| Layer | File |
|---|---|
| Discovery engine (socket enumeration + ported heuristics) | `server/src/services/discover.ts` |
| HTTP routes | `server/src/http/servicesRoutes.ts` (`GET /api/services`, `DELETE /api/services/:pid`) |
| Shared response types | `shared/src/protocol/services.ts` |
| Shared pin type | `shared/src/protocol/settings.ts` (`PinnedService` + `ArcoSettings.pinnedServices`) |
| Pin persistence | `server/src/settings.ts` (`sanitizePinnedServices` + `patchSettings`) |
| UI (L2 + L3) | `client/src/components/ServicesTab.tsx` (rendered in the System modal) |
| L3 preview-link wire | `client/src/App.tsx` -> `SystemHeader.tsx` -> `SystemModal.tsx` -> `ServicesTab.tsx` (`onSetPreviewPort`); `client/src/components/RightPanel/index.tsx` (`arco:open-preview` listener) |
| Smoke | `scripts/smoke/services-discovery.ts` (`npm run smoke:services-discovery`) |

The engine is the single source of discovery logic. The route is a thin wrapper
(mirrors `diagnosticsRoutes.ts`).

## L1, Discovery mechanism (load-bearing + cross-platform)

There is no `psutil` in Node, so socket enumeration is built on OS tools. The
mechanism must run on **both Linux and macOS**, so the primary path avoids
Linux-only tools.

1. **List listening sockets:** `lsof -nP -iTCP -sTCP:LISTEN`, present on both
   Linux and macOS. We use `lsof`, **not** Linux-only `ss` / `/proc/net/tcp`
   parsing, as the primary path. Parses each row's `COMMAND PID ... NAME` columns;
   `NAME` (`127.0.0.1:5173 (LISTEN)`, `*:8080 (LISTEN)`, `[::1]:3001 (LISTEN)`)
   yields the bind host:port. `*` -> `0.0.0.0`; bracketed IPv6 literals are
   unwrapped.
2. **Resolve process name + cmdline per pid:** `/proc/<pid>/cmdline`
   (NUL-separated argv) on Linux, a fast no-spawn fast-path, with a `ps -p
   <pid> -o comm=,args=` fallback (macOS / when `/proc` is absent). Linux is
   detected via `process.platform === 'linux'` **and** the actual presence of
   `/proc`.
3. **Resolve cwd per pid:** `/proc/<pid>/cwd` symlink `readlink` on Linux, with a
   `lsof -a -p <pid> -d cwd -Fn` fallback elsewhere.

All subprocess calls go through `execFile` (argv array, **never** `shell:true`)
with a 5 s timeout and a bounded `maxBuffer`. Metadata is resolved **once per
unique pid** (not per socket) to bound spawns; resolvers run concurrently.

### Filtering / dedup / sort (ported verbatim)

- **Local-only:** keep loopback / wildcard / private bind addresses
  (`127.0.0.1` / `::1` / `0.0.0.0` / `::` / `127.*`); these are **listed**, not
  filtered out.
- **Privileged-port skip:** drop ports `< 1024` (`scanner.py` line ~230).
- **Dedup** by `(pid, host, port)`.
- **Sort:** port asc, then `processName`, then `pid`.

### Heuristics (ported verbatim from `scanner.py`)

- **Framework table**, a 27-entry `(substring, label, emoji)` list
  (`vite`->Vite ⚡, `next`->Next.js ▲, `flask`->Flask 🐍, `tsx`->TSX 📘, ...). First-match
  substring search over `"{processName} {cmdline}".toLowerCase()`.
- **`likelyWeb`**, true if the cmdline/name matches a web-process marker, OR the
  port is in the common web-port set (`3000, 3001, 4173, 4321, 5000, 5173, 5174,
  5180, 5181, 5182, 8000, 8080, 8081, 8088, 8787, 8888, 9000`), OR the port is a
  registered unprivileged port (1024-49151) whose cmdline carries a web keyword
  (`server` / `dev` / `preview` / `start`).
- **`friendlyName`**, title-cased project-folder basename (`-`/`_` -> space) +
  framework label, e.g. `Seedbank · Vite`; falls back to the process name (when
  uninformative process names like `node` / `python3` are excluded) and finally
  to `Service on port <port>`.

## The `GET /api/services` contract

**Operator-triggered** (the L2 tab calls it on mount / Refresh; no daemon),
**read-only** (L1 only reads sockets/processes, kill is L2).

- Always **200** with a `ServicesResponse`; a genuine internal throw -> **500**
  with an empty list. `discoverServices()` itself never throws.
- `ServicesResponse` (`shared/src/protocol/services.ts`): `{ services:
  LocalService[], generatedAt: number, detail?: string }`. `services` is sorted
  by port, then processName, then pid. `detail` is **present only** when
  discovery couldn't run fully (e.g. `lsof` missing on PATH), the list may be
  empty; the UI shows the detail.
- `LocalService`: `{ pid: number|null, processName, cmdline, cwd: string|null,
  appName, host, port, url, framework: string|null, frameworkEmoji: string|null,
  friendlyName, likelyWeb }`.

### Degradation

- **Missing `lsof` (ENOENT):** empty `services` list + an explanatory `detail`
  ("lsof not found on PATH ..."). The endpoint never throws.
- **A single unreadable / exited process:** partial info, `cmdline` becomes `''`,
  `cwd` becomes `null`, and `processName` falls back to `lsof`'s COMMAND column.
  Never fails the whole scan.

### Secrets

`cmdline` and `cwd` are surfaced, that is the feature (it's the operator's own
machine, a live local readout). Unlike the support bundle (a shareable artifact),
this is **not** redacted. We do not log tokens.

## L2, Services tab (open / copy / kill / pin)

A `SERVICES` tab in the **System modal** (`client/src/components/ServicesTab.tsx`),
alongside Diagnostics / Model Health. **Machine-wide, not workflow-scoped**, it
takes no workflow props and shows the same list regardless of which workflow is
focused, which is exactly why it lives in the global System modal rather than the
per-workflow right panel (whose tabs + active-tab state are scoped to a workflow's
cwd). Cloned from `TasksPanel` for density. (Per-cwd grouping is L3.)

### UX, compact rows

Dense list rows (not cards), matching the existing panel density:

- **Row:** framework emoji (`frameworkEmoji`, falling back to a neutral `◦`),
  friendly name, a `:port` badge, the process name, and the trailing pid. 12px
  `var(--font-body)`, hairline bottom border.
- **Hover** reveals the quick actions **and the working directory** (left-truncated,
  home-collapsed to `~`, full path in the tooltip), the "what is this, really"
  signal when the friendly name is ambiguous; **click** a row to expand it to the
  full meta, `cmdline` (monospace, wrap/scroll), `cwd`, `pid`, `host`, plus the
  full action set.
- **Header:** `SERVICES · N running`, a `WEB`/`ALL` filter toggle, and a `↻`
  REFRESH button.
- **Empty state** ("No local web services detected · start a dev server and it
  appears here.") and an L1 `detail` notice (e.g. "lsof not found").

### Refresh + bounded auto-poll

Fetches `GET /api/services` on mount and on REFRESH (the UsageTab nonce pattern).
A `setInterval` re-triggers the fetch every **~5s**; because the System modal only
mounts this body while its tab is active (and unmounts it on tab-switch or close),
an unmount `clearInterval` is sufficient, no visibility tracking.

### Web-only filter

A header toggle, **default ON** (`likelyWeb` only); off shows every listener.
Local `useState`, not persisted in L2 (persisting it is optional).

### Actions

- **OPEN**, `window.open(service.url, '_blank')` (external tab; the in-app
  preview link is L3).
- **COPY URL**, `navigator.clipboard.writeText` with transient "COPIED!"
  feedback.
- **PIN / UNPIN**, toggles membership in `settings.pinnedServices` and persists
  via `POST /api/settings` with the full new array (mirrors ConfigTab's settings
  patches; the store is updated from the response).
- **KILL**, a two-step inline confirm (first click swaps to `CONFIRM?` + a
  `CANCEL`; never `window.confirm`). Confirm -> `DELETE /api/services/:pid`; on
  success it refetches after ~800ms so the row drops. Danger token
  (`--color-danger`).

### Pinned section + offline rows

Pinned services render first, under a `PINNED` sub-header. A pinned service
**not** in the current scan renders as a dimmed **OFFLINE** row
(`--color-fg-muted`), with every action except UNPIN disabled. Pinned<->discovered
matching is by the `(cwd, port)` identity.

### Pin persistence, end to end

Pins are a **machine-level inventory** (`ArcoSettings.pinnedServices:
PinnedService[]`, `{ cwd: string | null, port, pinnedAt }`), keyed by
`(cwd, port)`. The client sends the **full new array** on each pin/unpin via
`POST /api/settings`; `server/src/settings.ts` `sanitizePinnedServices()` drops
entries lacking a finite integer `port` / `pinnedAt`, dedups on `(cwd, port)`,
caps at 100, and `patchSettings()` **replaces the array wholesale** (same as
`tabOrder`, a sequence, not a deep-merged map). No alias/rename in L2 (the
discovery source has no label persistence).

### Kill route, `DELETE /api/services/:pid`

The one mutating action, guarded hard in `server/src/http/servicesRoutes.ts`
(`killService`). Rationale (the fences exist to bound blast radius):

1. **pid shape**, a positive integer `> 1`; non-integer / `pid <= 1` -> **400**
   (keeps us away from init / negative process-group signals).
2. **self-kill refusal**, `pid === process.pid` -> **400** ("refusing to kill
   the Arco server itself"), the tab lists Arco's own listeners, and
   signalling them would brick the session.
3. **re-scan blast-radius bound**, re-runs `discoverServices()` and confirms
   the pid currently owns a listening socket; otherwise **404** ("no listening
   service with that pid"). The tab can only kill **what it actually shows**; a
   stale or forged pid never reaches the signal.

Then `process.kill(pid, 'SIGTERM')`, the **Node primitive**, never a shelled-out
`kill` (no subprocess, no shell). **SIGTERM only, no SIGKILL escalation.** Error
mapping: `ESRCH` -> **404** (already gone), `EPERM` -> **403** (permission denied),
success -> **200** `{ ok: true, pid, signal: 'SIGTERM' }`. The handler never throws.

The L1 GET handler and this DELETE handler share the one `tryHandleServicesRoutes`
entry; GET matches only the bare `/api/services`, DELETE matches the `:pid`
suffix, so there is no collision.

## L3, Preview-proxy link + health + grouping

Three **client-only** additions, every piece reuses existing surface; no
server / shared change. All three pass the four-question test (operator-armed,
bounded, reversible).

### Open in Live Preview

A `PREVIEW` action button (first in the row's action cluster, the primary
in-app action) binds a discovered service's port to the **focused workflow's**
preview proxy and switches that workflow's right panel to PREVIEW.

The Services tab is machine-wide and can't call `useWebSocket()` itself (that
would double-connect), so the raw 3-arg `set_preview_port` dispatch is threaded
down `App -> SystemHeader -> SystemModal -> ServicesTab` as `onSetPreviewPort`
(NOT pre-bound to a workflow id, the tab supplies the focused `activeJobId` at
click time). On click it: (1) `onSetPreviewPort(activeJobId, port, framework)`
(the same `set_preview_port` message the per-workflow PreviewTab uses, hitting
the existing `/api/preview/<workflowId>/` proxy); (2) dispatches an
`arco:open-preview` CustomEvent, `RightPanel` listens for it (sibling to the
H6 `arco:reveal-in-files` handler) and flips its tab to PREVIEW for the
matching workflow; (3) closes the System modal. Manual port binds deliberately
don't auto-switch (only a fresh auto-detect does), but this explicit operator
action should.

**Disabled** when the service is offline (pinned-not-running), when no workflow
is focused (title: "Focus a workflow tab to preview here"), or when the dispatch
wasn't threaded.

### Health dot (operator-toggled, default OFF)

A `HEALTH` header toggle (next to `WEB`/`ALL`) arms a per-service liveness dot,
**default OFF** because probing spawns a network request per listed port. When
armed, each currently-listed **non-offline** port is probed via the existing
`GET /api/preview/probe?port=<port>` -> `{ alive: boolean }` (800ms loopback
probe) on every poll tick (the existing nonce/5s cycle + REFRESH). A small dot
renders next to the `:port` badge: green (`--color-accent-primary`) responding,
red (`--color-danger`) not responding, dim (`--color-fg-muted`) probing/unknown.
An `AbortController` cancels in-flight probes on toggle-off / unmount / poll
supersede so a dead cycle never writes state. Local UI state, not persisted.

### Per-cwd grouping (display-only)

When a workflow is focused, a `THIS WORKFLOW · <cwd-basename>` group floats at
the very top (above PINNED / DISCOVERED), containing discovered services whose
`cwd` **exactly** matches the focused workflow's cwd (both absolute paths).
Those services are excluded from DISCOVERED so a row never double-renders. A
service that's also pinned still appears under PINNED (the pinned-offline
contract is load-bearing), THIS WORKFLOW shows only matching *unpinned
discovered* rows; this keeps the dedup simple and correct. Omitted entirely
(no empty header) when there's no focused workflow or nothing matches. Fully
display-only / reversible.
