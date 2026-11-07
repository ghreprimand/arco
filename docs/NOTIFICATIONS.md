# Workbench notifications

Workbench notifications surface selected events in the Arco UI and can forward
muted-category-filtered notices through an optional external transport. They
inform users and never accept commands. The only inbound notification control
changes category mute preferences. Remote actions use the authenticated
[Remote Management](REMOTE_MANAGEMENT.md) console.

## The event contract (`shared/src/protocol/notifications.ts`)

A `WorkbenchNotice` is `{ id, category, severity, title, body?, ts, workflowId?, provider? }`.

**Categories** (`WorkbenchNoticeCategory`, mute is per-category):

| category | when | severity (typical) |
|---|---|---|
| `turn-finished` | a primary turn completed in another tab | info |
| `attention` | a turn failed or is waiting on the operator in another tab | info / error |
| `quota-recovered` | a throttled provider became available again | success |
| `auth-expired` | a provider's auth needs re-login | warning |
| `terminal-exited` | a terminal session exited non-zero | warning |
| `preview-failed` | a preview health check failed | error |
| `pr-status` | a PR / CI check status changed | info |
| `backup` | a backup completed or failed | success / error |

**Severity** (`WorkbenchNoticeSeverity`): `info` / `success` / `warning` / `error`
, drives the toast/notice accent and maps to the existing app toast strip's
`info` / `error` levels on the client.

## Attention alerts (desktop and phone)

Desktop and phone alerts are opt-in per event and off by default. BELL notices for another tab, or for a cluster member that is not in view, are shown by default and controlled by SHOW IN BELL. These alerts never create an in-app toast.

| event | raised when |
|---|---|
| finished | a primary turn ends (`primary_turn_ended`); desktop and phone alerts require at least 15 seconds and in a cluster only the director unless `clusterFinished` is `all` |
| failed | a `worker_error` or a `primary_refusal` passes through either path, or a workflow-scoped `error` passes through `broadcastWorkflow` |
| waiting | an `operator_question` becomes pending or a `gate_required` is parked (each id once) |

`server/src/attention.ts` watches workflow messages from both fan-out paths in
`server/src/server/broadcast.ts`: `send()`, which carries the start and end of
every operator, auto-pickup and peer-mail turn, and `broadcastWorkflow`
(Incognito workflows are skipped; a plain request `error` sent through `send()`
is not a failed turn), applies the switches, allows one alert per
workflow and event every 3 seconds, and does three things:

- **BELL:** sends an `attention_event` with no message text. Each browser adds a quiet notice when the matching BELL category is shown and the workflow is not the one in view: a different tab, or in a cluster tab any member other than the chosen one (the first member when none is chosen).
- Notice titles name the tab, or the member and cluster for a cluster tab. Each BELL notice stays on one line; hover to read its full text. Scoped desktop and phone alerts use the same source. Machine-wide notices name the event or provider.
- **This computer:** uses the same `attention_event`. Each browser
  shows a system notification only when its switch is on, permission is granted
  and the window is unfocused or hidden; the event id is the notification tag so
  one event shows once, and a click focuses the window and opens the tab
  (`client/src/alerts/desktopAlerts.ts`).
- **Phone:** POSTs to the ntfy topic itself (no hub, no client, no REMOTE
  switch). Title is `<tab name> finished | hit an error | is waiting for you`; the
  body is generic unless `phoneText` is on, then the question, error or first
  200 characters of the reply. An address from `ARCO_NTFY_URL` / `ARCO_NTFY_TOKEN`
  is used when none is saved, unless the Arco home is inside the system
  temporary folder (see "Temporary homes" below). While the phone "finished" switch is on, the older
  `turn-finished` notice transport skips that category so it is not sent twice.

Preferences live in `~/.arco/notification-channels.json` (mode 0600; the ntfy
token is stored there and never returned to the browser). `GET`/`PUT
/api/notification-channels` and `POST /api/notification-channels/test` serve
Settings > Notifications, where REQUEST PERMISSION and TEST DESKTOP check the browser permission and notification path. TEST DESKTOP asks for permission itself when the browser has not been asked, then shows its result beside the button: Sent (the system took the notification; if nothing appears, check the system notification service and do-not-disturb), Blocked (allow notifications in the site settings, in the browser profile the Arco window uses, then reload), Not allowed (the request was closed), Not supported or Failed. Normal desktop alerts require an unfocused window; finished turns must last at least 15 seconds. The window title shows `(N) ` before the page title
while N tabs hold an unanswered question or approval (`client/src/alerts/waiting.ts`,
the same definition any per-tab status uses).

## Wire messages

- **`workbench_notice`** (server -> all clients), a fresh notice. Broadcast to
 every connected client (NOT workflow-scoped: several categories are
 machine-global). The server applies mute suppression *before* broadcasting, so
 any notice that reaches a client is one the operator wants.
- **`notification_mutes`** (server -> all clients), the current muted-category
 set. Sent on connect and after every change, keeping every client's
 notice-center in sync.
- **`set_notification_mutes`** (client -> server), replace the muted set. The
 *only* inbound message the notification path services. Persisted server-side
 (so the suppression also covers external transports and survives a restart) and
 re-broadcast as `notification_mutes`.

## Server, the hub (`server/src/notifications.ts`)

One chokepoint so every source is a one-liner and external transports can use the same
`emit()`:

- `initNotifications(broadcastFn)`, inject the global all-clients sender +
 load persisted mutes from `~/.arco/notification-mutes.json`. Called once at
 boot (`index.ts`), wired to `for (const ws of sessions.keys()) send(ws, msg)`.
- `emit(notice)`, mint `id` + `ts`, **suppress if the category is muted**
 (returns `null`, nothing broadcast), else broadcast `workbench_notice`.
- `setMutes(cats)`, replace + persist + re-broadcast the snapshot. Serviced
 from the `set_notification_mutes` handler.
- Source helpers: `onTurnStarted` / `onTurnEnded` (legacy external transport only after 60 seconds), `notifyQuotaRecovered(provider)`.

### Wired sources

- **`turn-finished`**, `broadcast.ts` special-cases
 `primary_turn_started` / `primary_turn_ended` on both `send()` and `broadcastWorkflow`; `onTurnStarted` /
 `onTurnEnded` keep the 60-second legacy transport path. BELL uses the attention event for every finished turn in an unviewed tab.
- **`quota-recovered`**, `index.ts`'s quota change-listener: `markAvailable`
 only fires the listener on a real throttled->available flip, so a non-throttled
 state there is a recovery -> `notifyQuotaRecovered`.
- **`terminal-exited`**, `index.ts`'s `setTerminalExitHook`: a non-zero shell
 exit emits a `terminal-exited` notice (a clean `exit 0` stays quiet).

### Contract-ready sources (follow-up)

`auth-expired`, `preview-failed`, `pr-status`, and `backup` are first-class
categories with copy + severity conventions in the hub; wiring each is an
additive `emit({ category, ... })` at the corresponding source (auth-status flip,
preview health check, GitHub PR/check poll, backup CLI completion). No contract
or UI change needed, they already render + mute like the wired three. ntfy reuses
the identical `emit()`.

## Client

- **`stores/notificationStore.ts`**, standalone Zustand store (out of
 `appStore`, like `recallStore`): `notices` history (cap 50, newest first),
 the server-authoritative `muted` set, and a `lastSeenTs` marker for the unread
 badge. Attention events are filtered by this mute set in each browser.
- **`ws/handleServerMessage.ts`**, `workbench_notice` -> `pushNotice` (history)
 **and** a transient toast via the existing app strip
 (`appStore.pushNotification`, error/warning -> `error`, else `info`).
 `notification_mutes` -> `setMutedFromServer`.
- **`components/NotificationCenter.tsx`**, the header bell (`◔ BELL`) with an
 unread badge; the dropdown shows the notice history + a per-category SHOW IN BELL grid (checked means shown)
 (checkbox -> `set_notification_mutes` via `onSetMutes`, threaded App ->
 SystemHeader -> useWebSocket). Always visible, even in I3 focus mode, since
 notices are exactly the "agent finished / something broke" signal focus mode
 is for.
- Transient toasts reuse the existing top-right strip
 (`components/NotificationToasts.tsx`), not a second stack.

## Smoke (`scripts/smoke/notifications.ts`)

Pure, no WS/server boot. Injects a capture-broadcast into the hub and asserts:
every category emits a `workbench_notice`; a muted category is suppressed before
broadcast (`emit` returns `null`, zero wire messages); `setMutes` persists to
disk + re-broadcasts `notification_mutes` and a fresh `init` reloads it (survives
a restart); the long-turn helper sends only to legacy transports past its threshold; `notifyQuotaRecovered`
emits. `npm run smoke:notifications` (26 asserts).

## External transport (ntfy)

ntfy reuses the in-app event contract over external channels. The optional ntfy transport carries
title/body/priority + a tap-link to the management console; nothing inbound is read.

### The transport seam (`server/src/notifications.ts`)

- `registerNoticeTransport(fn)`, register a fire-and-forget sink.
- `emit()` fans out to every transport **after** the in-app broadcast and **only
 for surviving (non-muted) notices**, so muting a category suppresses the push
 for free. A slow/throwing transport never delays or breaks the in-app path
 (sync throws caught; async rejections swallowed). `_resetTransportsForTest()`
 clears the list for smokes.

### ntfy transport (`server/src/ntfyTransport.ts`)

- **Inert** unless `ARCO_NTFY_URL` is set (mirrors `hubLink` gating, an
 ordinary `npm run dev` is unchanged). `initNtfyTransport({instanceLabel})` is
 called from `index.ts` after `initNotifications`, labeled with the friendly
 instance name (`loadFriendlyName()`).
- Env: `ARCO_NTFY_URL` (full topic URL, required to activate) /
 `ARCO_NTFY_TOKEN` (optional bearer) / console tap-link from
 `ARCO_CONSOLE_URL`, else **derived** from `ARCO_HUB_URL`
 (`deriveConsoleUrl`: `ws->http` / `wss->https`, path dropped).
- `buildNtfyRequest(notice, cfg)` (pure, exported for the smoke) -> `{url, headers,
 body}`. Headers: `Title` (ascii-safe, em/en-dashes + smart quotes
 transliterated, remaining non-ascii stripped, whitespace collapsed, <=200 chars,
 since ntfy headers are latin-1/single-line), `Priority` (error/warning->`high`,
 success->`default`, info->`low`; `urgent` deliberately unused so it can't bypass
 DnD), `Tags` (severity emoji), `Click` (console), `Authorization` (bearer).
 Body: `[instance]` line first, then the notice body, then an 8-char workflow
 hint when scoped.
- **Smoke** `scripts/smoke/ntfy.ts` (7 steps, pure, temp mutes + injected fake
 fetch): `deriveConsoleUrl` mapping; `buildNtfyRequest` header/body shape +
 priority-by-severity; the chokepoint fans out to a transport for surviving
 notices and **suppresses muted ones**; `initNtfyTransport` inert-without-env /
 active-with-env drives exactly one POST. `npm run smoke:ntfy`.

### Temporary homes

A server whose Arco home is the system temporary folder or inside it (both
compared after resolving symbolic links) is a test or throwaway instance. It
does not use phone settings it inherited from the environment: the ntfy
transport stays inert, the phone alerts ignore `ARCO_NTFY_URL` and
`ARCO_NTFY_TOKEN`, and no console link is derived from `ARCO_HUB_URL`. One log
line per process says so. A phone address saved in that home's Settings >
Notifications is not inherited and still works, so a check of the phone
feature against a local fake ntfy server keeps working. The settings page says
when `ARCO_NTFY_URL` is set but not used (`ntfyEnvironmentHeldBack` in the
view). `ARCO_ALLOW_TEMP_HOME=1` lifts the rule, for the hub link as well; the
older name `ARCO_HUB_ALLOW_TEMP_HOME=1` is still accepted. The decision is
`environmentNtfyAllowed()` in `server/src/management/hubGuard.ts`, used by
`ntfyTransport.ts` and `attention.ts`. Homes outside the temporary folder are
unchanged.

### Per-workflow gate (Remote Management opt-in)

The ntfy transport takes an injected `isRemoteEnabled(workflowId)` predicate
(wired from `index.ts` against the live `workflows` map). A notice carrying a
`workflowId` pushes to the phone **only when that workflow is opted in to remote**
(`WorkflowConfig.remoteEnabled`, which is disabled by default).
Instance-level notices (no `workflowId`: `quota-recovered`, server events) are
unaffected and always push. The gate lives in the transport closure, *after* the
in-app category-mute chokepoint, so a muted category is still suppressed first. Smoke:
`npm run smoke:remote-optin`.

### Configure a private ntfy server

The ntfy server must be reachable only through a private network. Configure
`ARCO_NTFY_URL` with the server URL and topic. Keep the topic and any access
token out of tracked files and logs. Set `ARCO_NTFY_TOKEN` when the server
requires bearer authentication. `ARCO_CONSOLE_URL` can provide an explicit
console link; otherwise the link is derived from `ARCO_HUB_URL`.

The optional upstream wakeup service can carry an opaque notification ID, while
notice content remains on the configured private server. Category mutes and the
per-workflow remote-access setting are applied before the transport sends a
notice.

### ntfy client setup

Configure the ntfy client to use the private server URL and subscribe to the
configured topic. The tap link opens the management console when a console URL
is available. Do not put the topic URL or access token in public documentation,
source control, or screenshots.

## Related links

- [Remote management](REMOTE_MANAGEMENT.md)
- [Documentation style](STYLE.md)
